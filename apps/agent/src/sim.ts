import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import nodeHttp from "node:http";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Address,
  type Hex,
  parseAbi
} from "viem";
import { arbitrum } from "viem/chains";
import { assertLoopbackUrl, redactUrls } from "./config.ts";

export const USDC_ADDRESS: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const WETH_ADDRESS: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
export const ANVIL_DEFAULT_ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export const TWO_POOL_ARB_ABI = parseAbi([
  "function arb(address poolBuy, address poolSell, address tokenIn, address tokenMid, uint256 amountIn, uint256 minProfit) external",
  "function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external",
  "function withdraw(address token, address to, uint256 amount) external",
  "function OWNER() view returns (address)",
  "function expectedPool() view returns (address)",
  "event Arbitraged(address indexed poolBuy, address indexed poolSell, uint256 amountIn, uint256 midOut, uint256 receivedOut, uint256 profit)",
  "error Unauthorized()",
  "error PoolTokenMismatch()",
  "error PartialFill()",
  "error InsufficientProfit(uint256 actual, uint256 minProfit)",
  "error UnexpectedCaller()",
  "error ZeroAddress()",
  "error SafeTransferFailed()"
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
]);

/**
 * Finds an available TCP port on 127.0.0.1.
 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * Locates the compiled TwoPoolArb JSON artifact.
 */
export function getTwoPoolArbArtifact(): { bytecode: Hex; abi: any } {
  const candidatePaths = [
    path.resolve(process.cwd(), "contracts/out/TwoPoolArb.sol/TwoPoolArb.json"),
    path.resolve(process.cwd(), "../../contracts/out/TwoPoolArb.sol/TwoPoolArb.json"),
    path.resolve(import.meta.dirname, "../../../contracts/out/TwoPoolArb.sol/TwoPoolArb.json")
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      const bytecode = parsed.bytecode?.object || parsed.bytecode;
      if (bytecode && bytecode !== "0x") {
        return {
          bytecode: (bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`) as Hex,
          abi: parsed.abi || TWO_POOL_ARB_ABI
        };
      }
    }
  }

  throw new Error("TwoPoolArb artifact not found. Please run 'forge build' in contracts/");
}

export interface RpcRelay {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Starts an in-process HTTP JSON-RPC relay bound to 127.0.0.1 on a free port (§6.2a).
 * The relay forwards JSON-RPC POST bodies to upstreamRpcUrl, which is held in memory only.
 * Anvil forks from this relay, preventing upstream secrets from appearing in process listings.
 */
export async function startRpcRelay(upstreamRpcUrl: string): Promise<RpcRelay> {
  const port = await getFreePort();
  const server = nodeHttp.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // Second guard per §6.2a: refuse any JSON-RPC method starting with eth_send
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const call of calls) {
        if (typeof call?.method === "string" && call.method.startsWith("eth_send")) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: call.id ?? null,
              error: {
                code: -32600,
                message: "Remote write prohibited: method starting with eth_send refused"
              }
            })
          );
          return;
        }
      }

      try {
        const upstreamResp = await fetch(upstreamRpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body
        });

        const respText = await upstreamResp.text();
        const safeRespText = redactUrls(respText);

        res.writeHead(upstreamResp.status, {
          "Content-Type": upstreamResp.headers.get("content-type") || "application/json"
        });
        res.end(safeRespText);
      } catch (err: any) {
        const safeMsg = redactUrls(err?.message || "Relay upstream error");
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed?.id ?? null,
            error: {
              code: -32603,
              message: safeMsg
            }
          })
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const close = async () => {
    return new Promise<void>((resolve) => {
      try {
        (server as any).closeAllConnections?.();
      } catch {
        // ignore
      }
      server.close(() => resolve());
    });
  };

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close
  };
}

export interface AnvilSimInstance {
  port: number;
  rpcUrl: string;
  child: ChildProcess;
  relay: RpcRelay;
  publicClient: any;
  walletClient: any;
  deployedAddress: Address;
  stop: () => Promise<void>;
  snapshot: () => Promise<Hex>;
  revertTo: (id: Hex) => Promise<boolean>;
  fundUSDC: (recipient: Address, amountRaw: bigint) => Promise<void>;
}

/**
 * Starts a local Anvil fork instance of Arbitrum One at block N, with stdout/stderr completely ignored.
 * Anvil forks via the loopback relay (§6.2a), so the remote RPC URL is never in process arguments.
 * Deploys TwoPoolArb and funds it with USDC.
 */
export async function startAnvilSim(params: {
  forkRpcUrl: string;
  forkBlockNumber: bigint;
  maxNotionalUSDC: bigint;
}): Promise<AnvilSimInstance> {
  const relay = await startRpcRelay(params.forkRpcUrl);
  assertLoopbackUrl(relay.url);

  const port = await getFreePort();
  const loopbackRpcUrl = `http://127.0.0.1:${port}`;
  assertLoopbackUrl(loopbackRpcUrl);

  // Spawns Anvil with stdout and stderr ignored per spec §6.2 (D-035) to protect credentials
  // Anvil forks from loopback relay (§6.2a), so no process argument ever contains the real URL
  // D-038 carry-over: spawn anvil from PATH with optional ANVIL_BIN override (no hardcoded home path)
  const anvilBin = process.env.ANVIL_BIN || "anvil";
  const child = spawn(
    anvilBin,
    [
      "--fork-url",
      relay.url,
      "--fork-block-number",
      params.forkBlockNumber.toString(),
      "--port",
      port.toString(),
      "--quiet"
    ],
    {
      stdio: ["ignore", "ignore", "ignore"],
      detached: false
    }
  );

  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      try {
        await relay.close();
      } catch {
        // ignore
      }
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          setTimeout(resolve, 1000);
        });
      }
    }
  };

  // Wait for Anvil to accept RPC requests
  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(loopbackRpcUrl, { timeout: 60_000 })
  });

  const startTime = Date.now();
  let ready = false;
  while (Date.now() - startTime < 15000) {
    try {
      await publicClient.getBlockNumber();
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (!ready) {
    await stop();
    throw new Error("SIM_ERROR");
  }

  const walletClient = createWalletClient({
    chain: arbitrum,
    account: ANVIL_DEFAULT_ACCOUNT,
    transport: http(loopbackRpcUrl, { timeout: 60_000 })
  });

  // Snapshot & Revert helpers
  const snapshot = async (): Promise<Hex> => {
    return (await publicClient.request({ method: "evm_snapshot" as any })) as Hex;
  };

  const revertTo = async (id: Hex): Promise<boolean> => {
    return (await publicClient.request({
      method: "evm_revert" as any,
      params: [id] as any
    })) as boolean;
  };

  // Function to fund an account with USDC
  const fundUSDC = async (recipient: Address, amountRaw: bigint) => {
    assertLoopbackUrl(loopbackRpcUrl);
    // D-038 carry-over: attempt anvil_dealERC20 first; if unsupported or fails with "no slot found",
    // fall back to explicit slot 9 storage manipulation for Arbitrum One FiatTokenV2
    try {
      await publicClient.request({
        method: "anvil_dealERC20" as any,
        params: [USDC_ADDRESS, recipient, toHex(amountRaw)] as any
      });
      return;
    } catch {
      // FiatTokenV2 upgradeable proxy layout causes Anvil's automated slot search heuristic
      // to fail with "Unable to set ERC20 balance, no slot found". Explicit slot 9 is exact.
    }

    // Calculate storage slot location for mapping(address => uint256) at slot 9 (USDC on Arbitrum One)
    const slotLocation = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [recipient, 9n]
      )
    );
    const valHex = toHex(amountRaw, { size: 32 });

    await publicClient.request({
      method: "anvil_setStorageAt" as any,
      params: [USDC_ADDRESS, slotLocation, valHex] as any
    });
  };

  // Deploy TwoPoolArb
  let deployedAddress: Address;
  try {
    const { bytecode } = getTwoPoolArbArtifact();
    assertLoopbackUrl(loopbackRpcUrl);

    const txHash = await walletClient.sendTransaction({
      account: ANVIL_DEFAULT_ACCOUNT,
      data: bytecode
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (!receipt.contractAddress) {
      throw new Error("Failed to deploy TwoPoolArb");
    }
    deployedAddress = receipt.contractAddress;

    // Fund deployed contract with initial maxNotionalUSDC
    await fundUSDC(deployedAddress, params.maxNotionalUSDC);
  } catch (err: any) {
    await stop();
    throw new Error("SIM_ERROR");
  }

  return {
    port,
    rpcUrl: loopbackRpcUrl,
    child,
    relay,
    publicClient,
    walletClient,
    deployedAddress,
    stop,
    snapshot,
    revertTo,
    fundUSDC
  };
}
