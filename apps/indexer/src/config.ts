import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, parseAbiItem, type PublicClient } from "viem";
import { arbitrum } from "viem/chains";

export const CHAIN_ID = 42161n;
export const POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
export const DEFAULT_LOG_CHUNK_BLOCKS = 10n;
export const DEFAULT_DISPLAY_HF_BELOW = 1050000000000000000n; // 1.05e18 in WAD
export const BASE_CURRENCY_UNIT = 100000000n; // 1e8 for USD

export function redactUrls(str: string): string {
  if (!str) return str;
  return str.replace(/https?:\/\/[^\s"'`<>]+/gi, "<redacted-url>");
}

export const borrowEventAbi = parseAbiItem(
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
);

export const poolAccountDataAbi = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

export function loadEnv(startDir: string = process.cwd()): void {
  // Try local .env first, then ../../contracts/.env
  const candidatePaths = [
    path.resolve(startDir, ".env"),
    path.resolve(startDir, "../../contracts/.env"),
    path.resolve(startDir, "../contracts/.env"),
  ];

  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (key && !process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {
        // silent load
      }
    }
  }
}

export function getConfig() {
  loadEnv();

  const arbitrumRpcUrl = process.env.ARBITRUM_RPC_URL;
  if (!arbitrumRpcUrl) {
    throw new Error("Missing required environment variable ARBITRUM_RPC_URL");
  }

  const discoveryRpcUrl = process.env.DISCOVERY_RPC_URL || arbitrumRpcUrl;

  const logChunkBlocks = process.env.LOG_CHUNK_BLOCKS
    ? BigInt(process.env.LOG_CHUNK_BLOCKS)
    : DEFAULT_LOG_CHUNK_BLOCKS;

  return {
    arbitrumRpcUrl,
    discoveryRpcUrl,
    chainId: CHAIN_ID,
    pool: POOL,
    multicall3: MULTICALL3,
    logChunkBlocks,
  };
}

export async function createClients(config = getConfig()): Promise<{
  stateClient: PublicClient;
  discoveryClient: PublicClient;
}> {
  const stateClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.arbitrumRpcUrl),
  });

  const discoveryClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.discoveryRpcUrl),
  });

  // Verify chain IDs
  const stateChainId = BigInt(await stateClient.getChainId());
  if (stateChainId !== CHAIN_ID) {
    throw new Error(`Chain ID mismatch on state RPC: expected ${CHAIN_ID}, got ${stateChainId}`);
  }

  const discoveryChainId = BigInt(await discoveryClient.getChainId());
  if (discoveryChainId !== CHAIN_ID) {
    throw new Error(`Chain ID mismatch on discovery RPC: expected ${CHAIN_ID}, got ${discoveryChainId}`);
  }

  return { stateClient, discoveryClient };
}
