import fs from "node:fs";
import { keccak256, encodeAbiParameters, type Hex, type Address } from "viem";

export interface RiskPolicy {
  policy_version: string;
  chain_id: number;
  execution_mode: string;
  allowed_strategies: string[];
  allowed_assets: string[];
  allowed_targets: string[];
  max_notional_per_trade: string;
  size_ladder: string[];
  min_gap_bps: number;
  min_net_profit_raw: string;
  max_gas_cost_wei: string;
  max_state_age_blocks: number;
  max_attempts_per_opportunity: number;
}

export interface LoadedPolicy {
  policy: RiskPolicy;
  rawBytes: Buffer;
  policyHash: Hex;
}

const REQUIRED_EVALUATED_FIELDS: (keyof RiskPolicy)[] = [
  "policy_version",
  "chain_id",
  "execution_mode",
  "allowed_strategies",
  "allowed_assets",
  "allowed_targets",
  "max_notional_per_trade",
  "size_ladder",
  "min_gap_bps",
  "min_net_profit_raw",
  "max_gas_cost_wei",
  "max_state_age_blocks",
  "max_attempts_per_opportunity"
];

/**
 * Validates that an object contains all evaluated policy fields and execution_mode === "simulate".
 */
export function validatePolicy(data: any): RiskPolicy {
  if (!data || typeof data !== "object") {
    throw new Error("POLICY_INVALID");
  }

  for (const field of REQUIRED_EVALUATED_FIELDS) {
    if (data[field] === undefined || data[field] === null) {
      throw new Error("POLICY_INVALID");
    }
  }

  if (data.execution_mode !== "simulate") {
    throw new Error("POLICY_INVALID");
  }

  if (!Array.isArray(data.allowed_strategies) || !data.allowed_strategies.includes("arbitrage")) {
    throw new Error("POLICY_INVALID");
  }

  if (!Array.isArray(data.allowed_assets) || !Array.isArray(data.allowed_targets)) {
    throw new Error("POLICY_INVALID");
  }

  if (!Array.isArray(data.size_ladder) || data.size_ladder.length === 0) {
    throw new Error("POLICY_INVALID");
  }

  return data as RiskPolicy;
}

/**
 * Loads a policy JSON file from disk, computes its SHA3/keccak256 hash, and validates it.
 */
export function loadPolicy(filePath: string): LoadedPolicy {
  let rawBytes: Buffer;
  try {
    rawBytes = fs.readFileSync(filePath);
  } catch (err: any) {
    throw new Error("POLICY_INVALID");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch (err: any) {
    throw new Error("POLICY_INVALID");
  }

  const policy = validatePolicy(parsed);
  const policyHash = keccak256(rawBytes);

  return { policy, rawBytes, policyHash };
}

/**
 * Computes the deterministic intentHash per spec §6.5:
 * keccak256(abi.encode(uint256 chainId, address target, bytes32 calldataHash, uint256 blockNumber, bytes32 blockHash, bytes32 policyHash))
 */
export function computeIntentHash(params: {
  chainId: bigint;
  target: Address;
  calldataHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  policyHash: Hex;
}): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" }
    ],
    [
      params.chainId,
      params.target,
      params.calldataHash,
      params.blockNumber,
      params.blockHash,
      params.policyHash
    ]
  );
  return keccak256(encoded);
}

/**
 * Evaluates the deterministic final risk gate per spec §6.1 step 10 (D-012).
 * First failure wins.
 */
export function evaluateRiskGate(params: {
  simProfitRaw: bigint;
  minNetProfitRaw: bigint;
  gasCostUsdcRaw: bigint;
  gasCostWei: bigint;
  maxGasCostWei: bigint;
  sizeRaw: bigint;
  maxNotionalPerTrade: bigint;
  wethBalAfter: bigint;
}): { passed: boolean; reason?: string } {
  if (params.simProfitRaw < params.minNetProfitRaw + params.gasCostUsdcRaw) {
    return { passed: false, reason: "BELOW_MIN_PROFIT" };
  }
  if (params.gasCostWei > params.maxGasCostWei) {
    return { passed: false, reason: "GAS_TOO_HIGH" };
  }
  if (params.sizeRaw > params.maxNotionalPerTrade) {
    return { passed: false, reason: "AMOUNT_TOO_HIGH" };
  }
  if (params.wethBalAfter !== 0n) {
    return { passed: false, reason: "BALANCE_MISMATCH" };
  }
  return { passed: true };
}
