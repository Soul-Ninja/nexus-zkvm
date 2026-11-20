import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
  parseAbi
} from "viem";
import { arbitrum } from "viem/chains";
import {
  assertKillSwitch,
  getArbitrumRpcUrl,
  redactUrls
} from "./config.ts";
import {
  loadPolicy,
  computeIntentHash,
  evaluateRiskGate,
  type RiskPolicy
} from "./policy.ts";
import {
  startAnvilSim,
  USDC_ADDRESS,
  WETH_ADDRESS,
  ANVIL_DEFAULT_ACCOUNT,
  TWO_POOL_ARB_ABI,
  ERC20_ABI,
  type AnvilSimInstance
} from "./sim.ts";

export const SUSHI_POOL: Address = "0xf3Eb87C1F6020982173C908E7eB31aA66c1f0296";
export const UNI_POOL: Address = "0xC6962004f452bE9203591991D15f6b388e09E8D0";
export const AAVE_ORACLE: Address = "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7";
export const NODE_INTERFACE: Address = "0x00000000000000000000000000000000000000C8";

const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
]);

const AAVE_ORACLE_ABI = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)"
]);

const NODE_INTERFACE_ABI = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) external returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"
]);

export interface DecisionRecord {
  opportunity_id: string;
  block_number: string;
  block_hash: string;
  head_block: string;
  policy_version: string;
  policy_hash: string;
  pool_buy: string;
  pool_sell: string;
  gap_bps: string;
  size_raw: string;
  calldata_hash: string;
  intent_hash: string;
  sim_profit_raw: string;
  l2_gas: string;
  l1_gas: string;
  gas_cost_wei: string;
  gas_cost_usdc_raw: string;
  verdict: "ELIGIBLE" | "REJECTED";
  reason: string | null;
  created_at: string;
}

export interface PipelineOptions {
  blockNumber: bigint;
  headBlockNumber?: bigint;
  policyPath?: string;
  killSwitchPath?: string;
  dbPath?: string;
  remoteRpcUrl?: string;
  remoteClientOverride?: any;
  reorgHashOverride?: Hex;
  calldataTamperHook?: (calldata: Hex) => Hex;
  onSimStarted?: (sim: AnvilSimInstance) => void;
}

export function getDatabase(dbPath?: string): DatabaseSync {
  const defaultDir = path.resolve(import.meta.dirname, "../data");
  if (!dbPath) {
    fs.mkdirSync(defaultDir, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const resolvedPath = dbPath || path.join(defaultDir, "decisions.sqlite");
  const db = new DatabaseSync(resolvedPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      opportunity_id TEXT PRIMARY KEY,
      block_number TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      head_block TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      pool_buy TEXT NOT NULL,
      pool_sell TEXT NOT NULL,
      gap_bps TEXT NOT NULL,
      size_raw TEXT NOT NULL,
      calldata_hash TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      sim_profit_raw TEXT NOT NULL,
      l2_gas TEXT NOT NULL,
      l1_gas TEXT NOT NULL,
      gas_cost_wei TEXT NOT NULL,
      gas_cost_usdc_raw TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
  `);

  return db;
}

export function saveDecision(db: DatabaseSync, record: DecisionRecord): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO decisions (
      opportunity_id, block_number, block_hash, head_block,
      policy_version, policy_hash, pool_buy, pool_sell, gap_bps,
      size_raw, calldata_hash, intent_hash, sim_profit_raw,
      l2_gas, l1_gas, gas_cost_wei, gas_cost_usdc_raw,
      verdict, reason, created_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  stmt.run(
    record.opportunity_id,
    record.block_number,
    record.block_hash,
    record.head_block,
    record.policy_version,
    record.policy_hash,
    record.pool_buy,
    record.pool_sell,
    record.gap_bps,
    record.size_raw,
    record.calldata_hash,
    record.intent_hash,
    record.sim_profit_raw,
    record.l2_gas,
    record.l1_gas,
    record.gas_cost_wei,
    record.gas_cost_usdc_raw,
    record.verdict,
    record.reason,
    record.created_at
  );
}

/**
 * Execute the decision pipeline according to spec §6.1.
 */
export async function runDecisionPipeline(opts: PipelineOptions): Promise<DecisionRecord> {
  const db = getDatabase(opts.dbPath);

  // Partial record fields to preserve in case of early reject
  const N = opts.blockNumber;
  const H = opts.headBlockNumber !== undefined ? opts.headBlockNumber : N;

  let blockHash: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
  let policyVersion = "unknown";
  let policyHash: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
  let poolBuy: Address = "0x0000000000000000000000000000000000000000";
  let poolSell: Address = "0x0000000000000000000000000000000000000000";
  let gapBps: bigint = 0n;
  let bestSize: bigint = 0n;
  let calldataHash: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
  let intentHash: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
  let simProfitRaw: bigint = 0n;
  let l2Gas: bigint = 0n;
  let l1Gas: bigint = 0n;
  let gasCostWei: bigint = 0n;
  let gasCostUsdcRaw: bigint = 0n;

  const createRecord = (verdict: "ELIGIBLE" | "REJECTED", reason: string | null): DecisionRecord => {
    const oppId = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "address" }],
        [N, poolBuy, poolSell]
      )
    );
    const rec: DecisionRecord = {
      opportunity_id: oppId,
      block_number: N.toString(),
      block_hash: blockHash,
      head_block: H.toString(),
      policy_version: policyVersion,
      policy_hash: policyHash,
      pool_buy: poolBuy,
      pool_sell: poolSell,
      gap_bps: gapBps.toString(),
      size_raw: bestSize.toString(),
      calldata_hash: calldataHash,
      intent_hash: intentHash,
      sim_profit_raw: simProfitRaw.toString(),
      l2_gas: l2Gas.toString(),
      l1_gas: l1Gas.toString(),
      gas_cost_wei: gasCostWei.toString(),
      gas_cost_usdc_raw: gasCostUsdcRaw.toString(),
      verdict,
      reason,
      created_at: new Date().toISOString()
    };
    saveDecision(db, rec);
    return rec;
  };

  // Step 0: Kill Switch (checked BEFORE any RPC call)
  try {
    assertKillSwitch(opts.killSwitchPath);
  } catch (err: any) {
    return createRecord("REJECTED", "KILL_SWITCH");
  }

  // Step 1: Policy validation
  let policy: RiskPolicy;
  try {
    const policyFile = opts.policyPath || path.resolve(import.meta.dirname, "../policy/p4-sim.json");
    const loaded = loadPolicy(policyFile);
    policy = loaded.policy;
    policyVersion = policy.policy_version;
    policyHash = loaded.policyHash;
  } catch (err: any) {
    return createRecord("REJECTED", "POLICY_INVALID");
  }

  // Step 2: Remote checks
  let remoteClient = opts.remoteClientOverride;
  if (!remoteClient) {
    try {
      const rpcUrl = opts.remoteRpcUrl || getArbitrumRpcUrl();
      remoteClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl, { timeout: 60_000 }) });
    } catch (err: any) {
      return createRecord("REJECTED", "RPC_ERROR");
    }
  }

  let baseFee = 0n;
  try {
    const chainId = await remoteClient.getChainId();
    if (chainId !== policy.chain_id) {
      return createRecord("REJECTED", "CHAIN_MISMATCH");
    }

    const finalizedBlock = await remoteClient.getBlock({ blockTag: "finalized" });
    if (N > finalizedBlock.number) {
      return createRecord("REJECTED", "NOT_FINALIZED");
    }

    const targetBlock = await remoteClient.getBlock({ blockNumber: N });
    blockHash = targetBlock.hash;
    baseFee = targetBlock.baseFeePerGas || 0n;
  } catch (err: any) {
    return createRecord("REJECTED", "RPC_ERROR");
  }

  // Step 3: Staleness check
  if (H - N > BigInt(policy.max_state_age_blocks)) {
    return createRecord("REJECTED", "STALE_STATE");
  }

  // Step 4: Detect (pre-filter)
  try {
    const [uniSlot0, sushiSlot0] = await Promise.all([
      remoteClient.readContract({
        address: UNI_POOL,
        abi: V3_POOL_ABI,
        functionName: "slot0",
        blockNumber: N
      }),
      remoteClient.readContract({
        address: SUSHI_POOL,
        abi: V3_POOL_ABI,
        functionName: "slot0",
        blockNumber: N
      })
    ]);

    const uniSqrtP = uniSlot0[0];
    const sushiSqrtP = sushiSlot0[0];

    if (uniSqrtP > sushiSqrtP) {
      poolBuy = SUSHI_POOL;
      poolSell = UNI_POOL;
      gapBps = ((uniSqrtP * uniSqrtP - sushiSqrtP * sushiSqrtP) * 10000n) / (sushiSqrtP * sushiSqrtP);
    } else if (sushiSqrtP > uniSqrtP) {
      poolBuy = UNI_POOL;
      poolSell = SUSHI_POOL;
      gapBps = ((sushiSqrtP * sushiSqrtP - uniSqrtP * uniSqrtP) * 10000n) / (uniSqrtP * uniSqrtP);
    } else {
      gapBps = 0n;
    }

    if (gapBps < BigInt(policy.min_gap_bps)) {
      return createRecord("REJECTED", "NO_GAP");
    }
  } catch (err: any) {
    const safeMsg = redactUrls(err?.message || "");
    return createRecord("REJECTED", "RPC_ERROR");
  }

  // Step 5: Allowlists check
  const isStrategyAllowed = policy.allowed_strategies.includes("arbitrage");
  const assetsAllowed =
    policy.allowed_assets.map((a) => a.toLowerCase()).includes(USDC_ADDRESS.toLowerCase()) &&
    policy.allowed_assets.map((a) => a.toLowerCase()).includes(WETH_ADDRESS.toLowerCase());
  const targetsAllowed =
    policy.allowed_targets.map((t) => t.toLowerCase()).includes(poolBuy.toLowerCase()) &&
    policy.allowed_targets.map((t) => t.toLowerCase()).includes(poolSell.toLowerCase());

  if (!isStrategyAllowed || !assetsAllowed || !targetsAllowed) {
    return createRecord("REJECTED", "NOT_ALLOWED");
  }

  // Step 12 Pre-check: Dedupe
  const oppIdCheck = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }],
      [N, poolBuy, poolSell]
    )
  );
  const existing = db.prepare("SELECT opportunity_id FROM decisions WHERE opportunity_id = ?").get(oppIdCheck);
  if (existing) {
    return createRecord("REJECTED", "DUPLICATE");
  }

  // Step 6: Start Anvil Simulation
  let sim: AnvilSimInstance;
  try {
    const rpcUrl = opts.remoteRpcUrl || getArbitrumRpcUrl();
    sim = await startAnvilSim({
      forkRpcUrl: rpcUrl,
      forkBlockNumber: N,
      maxNotionalUSDC: BigInt(policy.max_notional_per_trade)
    });
    if (opts.onSimStarted) {
      opts.onSimStarted(sim);
    }
  } catch (err: any) {
    return createRecord("REJECTED", "SIM_ERROR");
  }

  try {
    // Step 7: Sizing
    const maxNotional = BigInt(policy.max_notional_per_trade);
    const sortedLadder = policy.size_ladder.map((s) => BigInt(s)).filter((s) => s <= maxNotional);

    let bestProfit = 0n;
    let candidateL2Gas = 0n;

    for (const size of sortedLadder) {
      const snap = await sim.snapshot();
      try {
        const calldataProbe = encodeFunctionData({
          abi: TWO_POOL_ARB_ABI,
          functionName: "arb",
          args: [poolBuy, poolSell, USDC_ADDRESS, WETH_ADDRESS, size, 0n]
        });

        const txHash = await sim.walletClient.sendTransaction({
          account: ANVIL_DEFAULT_ACCOUNT,
          to: sim.deployedAddress,
          data: calldataProbe
        });

        const receipt = await sim.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status === "success") {
          const balAfter = (await sim.publicClient.readContract({
            address: USDC_ADDRESS,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [sim.deployedAddress]
          })) as bigint;

          const profit = balAfter > maxNotional ? balAfter - maxNotional : 0n;
          if (profit > bestProfit) {
            bestProfit = profit;
            bestSize = size;
            candidateL2Gas = receipt.gasUsed;
          }
        }
      } catch {
        // Reverted probe; skip
      } finally {
        await sim.revertTo(snap);
      }
    }

    if (bestProfit <= 0n || bestSize === 0n) {
      return createRecord("REJECTED", "NO_PROFITABLE_SIZE");
    }

    // Step 8: Intent Building
    // Query L1 gas estimate from remote NodeInterface
    try {
      const dummyCall = encodeFunctionData({
        abi: TWO_POOL_ARB_ABI,
        functionName: "arb",
        args: [poolBuy, poolSell, USDC_ADDRESS, WETH_ADDRESS, bestSize, 0n]
      });
      const [estL1] = (await remoteClient.readContract({
        address: NODE_INTERFACE,
        abi: NODE_INTERFACE_ABI,
        functionName: "gasEstimateL1Component",
        args: [sim.deployedAddress, false, dummyCall],
        blockNumber: N
      })) as [bigint, bigint, bigint];
      l1Gas = estL1;
    } catch {
      l1Gas = 0n;
    }

    // Query Aave oracle asset prices
    const [usdcPrice, wethPrice] = await Promise.all([
      remoteClient.readContract({
        address: AAVE_ORACLE,
        abi: AAVE_ORACLE_ABI,
        functionName: "getAssetPrice",
        args: [USDC_ADDRESS],
        blockNumber: N
      }),
      remoteClient.readContract({
        address: AAVE_ORACLE,
        abi: AAVE_ORACLE_ABI,
        functionName: "getAssetPrice",
        args: [WETH_ADDRESS],
        blockNumber: N
      })
    ]);

    l2Gas = candidateL2Gas;
    gasCostWei = 2n * (l2Gas + l1Gas) * baseFee;
    gasCostUsdcRaw =
      (gasCostWei * wethPrice + (usdcPrice * 1000000000000n - 1n)) / (usdcPrice * 1000000000000n);

    const minProfit = BigInt(policy.min_net_profit_raw) + gasCostUsdcRaw;

    const calldata = encodeFunctionData({
      abi: TWO_POOL_ARB_ABI,
      functionName: "arb",
      args: [poolBuy, poolSell, USDC_ADDRESS, WETH_ADDRESS, bestSize, minProfit]
    });

    calldataHash = keccak256(calldata);
    intentHash = computeIntentHash({
      chainId: BigInt(policy.chain_id),
      target: sim.deployedAddress,
      calldataHash,
      blockNumber: N,
      blockHash,
      policyHash
    });

    // Test hook between steps 8 and 9 per spec §7 (I7 intent tamper)
    let calldataToSend = calldata;
    if (opts.calldataTamperHook) {
      calldataToSend = opts.calldataTamperHook(calldata);
    }

    // Step 9: Simulate the Intent
    const snapIntent = await sim.snapshot();
    let txHash: Hex;
    let receipt: any;
    let tx: any;
    let wethBalAfter: bigint = 0n;

    try {
      // Re-seed USDC balance to exactly maxNotional
      await sim.fundUSDC(sim.deployedAddress, maxNotional);

      txHash = await sim.walletClient.sendTransaction({
        account: ANVIL_DEFAULT_ACCOUNT,
        to: sim.deployedAddress,
        data: calldataToSend
      });

      receipt = await sim.publicClient.waitForTransactionReceipt({ hash: txHash });
      tx = await sim.publicClient.getTransaction({ hash: txHash });


      if (receipt.status === "success") {
        const usdcBalAfter = (await sim.publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [sim.deployedAddress]
        })) as bigint;

        wethBalAfter = (await sim.publicClient.readContract({
          address: WETH_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [sim.deployedAddress]
        })) as bigint;

        simProfitRaw = usdcBalAfter > maxNotional ? usdcBalAfter - maxNotional : 0n;
      }
    } catch {
      if (bestProfit < minProfit) {
        return createRecord("REJECTED", "BELOW_MIN_PROFIT");
      }
      return createRecord("REJECTED", "SIM_REVERTED");
    } finally {
      await sim.revertTo(snapIntent);
    }

    // Read back transaction from Anvil to verify input hash matches calldataHash
    const txInputHash = keccak256(tx.input);
    if (txInputHash !== calldataHash) {
      return createRecord("REJECTED", "INTENT_MISMATCH");
    }

    if (receipt.status === "reverted") {
      if (bestProfit < minProfit) {
        return createRecord("REJECTED", "BELOW_MIN_PROFIT");
      }
      return createRecord("REJECTED", "SIM_REVERTED");
    }

    // Measure simulation outcome
    l2Gas = receipt.gasUsed;
    gasCostWei = 2n * (l2Gas + l1Gas) * baseFee;
    gasCostUsdcRaw =
      (gasCostWei * wethPrice + (usdcPrice * 1000000000000n - 1n)) / (usdcPrice * 1000000000000n);

    // Find Arbitraged event in logs to record exact profit if emitted
    const arbLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === sim.deployedAddress.toLowerCase()
    );
    if (arbLogs.length > 0) {
      // Decode event Arbitraged(address poolBuy, address poolSell, uint256 amountIn, uint256 midOut, uint256 receivedOut, uint256 profit)
      const dataHex = arbLogs[0].data;
      const profitHex = "0x" + dataHex.slice(dataHex.length - 64);
      simProfitRaw = BigInt(profitHex);
    }

    // Step 10: Final Risk Gate (D-012)
    const gateResult = evaluateRiskGate({
      simProfitRaw,
      minNetProfitRaw: BigInt(policy.min_net_profit_raw),
      gasCostUsdcRaw,
      gasCostWei,
      maxGasCostWei: BigInt(policy.max_gas_cost_wei),
      sizeRaw: bestSize,
      maxNotionalPerTrade: maxNotional,
      wethBalAfter
    });

    if (!gateResult.passed) {
      return createRecord("REJECTED", gateResult.reason || "RISK_GATE_FAILED");
    }

    // Step 11: Reorg re-check
    const recheckBlock = await remoteClient.getBlock({ blockNumber: N });
    const recheckHash = opts.reorgHashOverride || recheckBlock.hash;
    if (recheckHash !== blockHash) {
      return createRecord("REJECTED", "REORG");
    }

    // Step 12: Dedupe check (again before final recording)
    const existingFinal = db.prepare("SELECT opportunity_id FROM decisions WHERE opportunity_id = ?").get(oppIdCheck);
    if (existingFinal) {
      return createRecord("REJECTED", "DUPLICATE");
    }

    // Step 13: All checks passed! Record ELIGIBLE
    return createRecord("ELIGIBLE", null);
  } finally {
    // Stop Anvil instance in finally block per spec §6.1 step 13
    await sim.stop();
  }
}
