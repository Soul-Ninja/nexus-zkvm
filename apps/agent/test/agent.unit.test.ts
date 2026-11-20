import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeHttp from "node:http";
import {
  loadPolicy,
  validatePolicy,
  computeIntentHash,
  evaluateRiskGate,
  type RiskPolicy
} from "../src/policy.ts";
import {
  redactUrls,
  isLoopbackUrl,
  assertLoopbackUrl,
  checkKillSwitch,
  assertKillSwitch
} from "../src/config.ts";
import {
  runDecisionPipeline,
  getDatabase
} from "../src/pipeline.ts";
import {
  startRpcRelay,
  getFreePort
} from "../src/sim.ts";

const VALID_POLICY: RiskPolicy = {
  policy_version: "p4-sim-1",
  chain_id: 42161,
  execution_mode: "simulate",
  allowed_strategies: ["arbitrage"],
  allowed_assets: [
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
  ],
  allowed_targets: [
    "0xC6962004f452bE9203591991D15f6b388e09E8D0",
    "0xf3Eb87C1F6020982173C908E7eB31aA66c1f0296"
  ],
  max_notional_per_trade: "20000000000",
  size_ladder: [
    "1000000000",
    "2500000000",
    "5000000000",
    "10000000000",
    "20000000000"
  ],
  min_gap_bps: 10,
  min_net_profit_raw: "1000000",
  max_gas_cost_wei: "1000000000000000",
  max_state_age_blocks: 240,
  max_attempts_per_opportunity: 1
};

test("U1: Policy loader validates evaluated fields and rejects live execution_mode", () => {
  // 1. Valid policy succeeds
  const validated = validatePolicy(VALID_POLICY);
  assert.equal(validated.policy_version, "p4-sim-1");

  // 2. execution_mode = "live" fails POLICY_INVALID
  assert.throws(
    () => validatePolicy({ ...VALID_POLICY, execution_mode: "live" }),
    /POLICY_INVALID/
  );

  // 3. Each evaluated field missing in turn fails POLICY_INVALID
  const evaluatedFields: (keyof RiskPolicy)[] = [
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

  for (const field of evaluatedFields) {
    const copy: any = { ...VALID_POLICY };
    delete copy[field];
    assert.throws(
      () => validatePolicy(copy),
      /POLICY_INVALID/,
      `Missing field ${field} should throw POLICY_INVALID`
    );
  }
});

test("U2: Policy hash is stable and changes when content changes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-u2-"));
  const p1 = path.join(tmpDir, "policy1.json");
  const p2 = path.join(tmpDir, "policy2.json");

  fs.writeFileSync(p1, JSON.stringify(VALID_POLICY, null, 2));
  fs.writeFileSync(p2, JSON.stringify({ ...VALID_POLICY, min_gap_bps: 11 }, null, 2));

  const l1a = loadPolicy(p1);
  const l1b = loadPolicy(p1);
  const l2 = loadPolicy(p2);

  assert.equal(l1a.policyHash, l1b.policyHash, "Policy hash must be stable for identical bytes");
  assert.notEqual(l1a.policyHash, l2.policyHash, "Policy hash must change when contents change");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("U3: Intent hash is deterministic and changes when any input changes", () => {
  const baseParams = {
    chainId: 42161n,
    target: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    calldataHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
    blockNumber: 521208669n,
    blockHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
    policyHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as `0x${string}`
  };

  const hash1 = computeIntentHash(baseParams);
  const hash2 = computeIntentHash(baseParams);
  assert.equal(hash1, hash2, "Intent hash must be deterministic");

  // Change each of the 6 inputs in turn and assert hash changes
  assert.notEqual(computeIntentHash({ ...baseParams, chainId: 1n }), hash1);
  assert.notEqual(
    computeIntentHash({ ...baseParams, target: "0x2222222222222222222222222222222222222222" }),
    hash1
  );
  assert.notEqual(
    computeIntentHash({
      ...baseParams,
      calldataHash: "0x0000000000000000000000000000000000000000000000000000000000000001"
    }),
    hash1
  );
  assert.notEqual(computeIntentHash({ ...baseParams, blockNumber: 521208670n }), hash1);
  assert.notEqual(
    computeIntentHash({
      ...baseParams,
      blockHash: "0x0000000000000000000000000000000000000000000000000000000000000002"
    }),
    hash1
  );
  assert.notEqual(
    computeIntentHash({
      ...baseParams,
      policyHash: "0x0000000000000000000000000000000000000000000000000000000000000003"
    }),
    hash1
  );
});

test("U4: Risk gate reaches all reason codes and enforces precedence", () => {
  const base = {
    simProfitRaw: 50_000_000n, // 50 USDC
    minNetProfitRaw: 1_000_000n, // 1 USDC
    gasCostUsdcRaw: 100_000n, // 0.1 USDC
    gasCostWei: 100_000_000_000_000n, // 0.0001 ETH
    maxGasCostWei: 1_000_000_000_000_000n, // 0.001 ETH
    sizeRaw: 5_000_000_000n, // 5,000 USDC
    maxNotionalPerTrade: 20_000_000_000n, // 20,000 USDC
    wethBalAfter: 0n
  };

  // Base passes
  assert.deepEqual(evaluateRiskGate(base), { passed: true });

  // 1. BELOW_MIN_PROFIT
  assert.deepEqual(
    evaluateRiskGate({ ...base, simProfitRaw: 1_099_999n }),
    { passed: false, reason: "BELOW_MIN_PROFIT" }
  );

  // 2. GAS_TOO_HIGH
  assert.deepEqual(
    evaluateRiskGate({ ...base, gasCostWei: 1_000_000_000_000_001n }),
    { passed: false, reason: "GAS_TOO_HIGH" }
  );

  // 3. AMOUNT_TOO_HIGH
  assert.deepEqual(
    evaluateRiskGate({ ...base, sizeRaw: 20_000_000_001n }),
    { passed: false, reason: "AMOUNT_TOO_HIGH" }
  );

  // 4. BALANCE_MISMATCH
  assert.deepEqual(
    evaluateRiskGate({ ...base, wethBalAfter: 1n }),
    { passed: false, reason: "BALANCE_MISMATCH" }
  );

  // Precedence test: BELOW_MIN_PROFIT wins over GAS_TOO_HIGH when both fail
  assert.deepEqual(
    evaluateRiskGate({
      ...base,
      simProfitRaw: 500n,
      gasCostWei: 2_000_000_000_000_000n
    }),
    { passed: false, reason: "BELOW_MIN_PROFIT" }
  );
});

test("U5: Kill switch triggers KILL_SWITCH with zero remote calls", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-u5-"));
  const killFile = path.join(tmpDir, "KILL");
  fs.writeFileSync(killFile, "halt");

  let remoteCallsCount = 0;
  const stubRemoteClient = {
    getChainId: async () => {
      remoteCallsCount++;
      return 42161;
    }
  };

  const decision = await runDecisionPipeline({
    blockNumber: 521208669n,
    killSwitchPath: killFile,
    remoteClientOverride: stubRemoteClient,
    dbPath: path.join(tmpDir, "u5.sqlite")
  });

  assert.equal(decision.verdict, "REJECTED");
  assert.equal(decision.reason, "KILL_SWITCH");
  assert.equal(remoteCallsCount, 0, "Kill switch must abort before ANY remote RPC call");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("U6: Loopback guard allows 127.0.0.1 / localhost and refuses remote hosts", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8545"), true);
  assert.equal(isLoopbackUrl("http://localhost:8546"), true);
  assert.equal(isLoopbackUrl("https://example.com"), false);
  assert.equal(isLoopbackUrl("https://arb-mainnet.g.alchemy.com/v2/<key>"), false);

  assert.doesNotThrow(() => assertLoopbackUrl("http://127.0.0.1:8545"));
  assert.doesNotThrow(() => assertLoopbackUrl("http://localhost:8546"));

  assert.throws(
    () => assertLoopbackUrl("https://example.com"),
    /Remote write prohibited/
  );
  assert.throws(
    () => assertLoopbackUrl("https://arb1.arbitrum.io/rpc"),
    /Remote write prohibited/
  );
});

test("U7: Staleness and deduplication enforcement", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-u7-"));
  const dbPath = path.join(tmpDir, "u7.sqlite");

  const stubClient = {
    getChainId: async () => 42161,
    getBlock: async () => ({ number: 521208910n, hash: "0x1111", baseFeePerGas: 20000000n }),
    readContract: async () => [3900000000000000000000000n]
  };

  // 1. Staleness test: H - N = 241 > 240
  const staleDecision = await runDecisionPipeline({
    blockNumber: 521208669n,
    headBlockNumber: 521208669n + 241n,
    remoteClientOverride: stubClient,
    dbPath
  });

  assert.equal(staleDecision.verdict, "REJECTED");
  assert.equal(staleDecision.reason, "STALE_STATE");

  // 2. Dedupe test: duplicate opportunity check
  const db = getDatabase(dbPath);
  const oppId = "0x9999999999999999999999999999999999999999999999999999999999999999";
  db.prepare(`
    INSERT INTO decisions (
      opportunity_id, block_number, block_hash, head_block, policy_version,
      policy_hash, pool_buy, pool_sell, gap_bps, size_raw, calldata_hash,
      intent_hash, sim_profit_raw, l2_gas, l1_gas, gas_cost_wei, gas_cost_usdc_raw,
      verdict, reason, created_at
    ) VALUES (
      ?, '521208669', '0x1', '521208669', 'p4-sim-1', '0x2', '0x3', '0x4',
      '100', '1000', '0x5', '0x6', '100', '1', '1', '1', '1',
      'ELIGIBLE', null, '2026-11-16T00:00:00Z'
    )
  `).run(oppId);

  const check = db.prepare("SELECT opportunity_id FROM decisions WHERE opportunity_id = ?").get(oppId);
  assert.ok(check, "Record should exist in DB");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("U8: Secret redaction hides URLs and API keys in errors", () => {
  const secretUrl = "http://127.0.0.1:9/v2/FAKESECRET123456";
  const rawMsg = `Error connecting to ${secretUrl} while fetching state`;
  const redacted = redactUrls(rawMsg);

  assert.ok(!redacted.includes("FAKESECRET123456"), "Redacted message must not contain secret");
  assert.ok(redacted.includes("<redacted-url>"), "Redacted message must contain <redacted-url>");
});

test("U9: Loopback relay forwards queries, blocks eth_send, and redacts secrets", async () => {
  const upstreamPort = await getFreePort();
  const fakeServer = nodeHttp.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.method === "eth_blockNumber") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: "0x1234" }));
      } else {
        // Return an error message containing the upstream secret URL
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: {
              code: -32000,
              message: `Upstream failure at http://127.0.0.1:${upstreamPort}/v2/FAKESECRET`
            }
          })
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    fakeServer.listen(upstreamPort, "127.0.0.1", () => resolve());
    fakeServer.on("error", reject);
  });

  const fakeUpstreamUrl = `http://127.0.0.1:${upstreamPort}/v2/FAKESECRET`;
  const relay = await startRpcRelay(fakeUpstreamUrl);

  try {
    // 1. Forwarded call works
    const res1 = await fetch(relay.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })
    });
    assert.equal(res1.status, 200);
    const data1: any = await res1.json();
    assert.equal(data1.result, "0x1234");
    assert.ok(!JSON.stringify(data1).includes("FAKESECRET"));

    // 2. eth_sendRawTransaction refused
    const res2 = await fetch(relay.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x1234"] })
    });
    assert.equal(res2.status, 403);
    const data2: any = await res2.json();
    assert.ok(data2.error);
    assert.ok(data2.error.message.includes("eth_send"));
    assert.ok(!JSON.stringify(data2).includes("FAKESECRET"));

    // 3. Secret in upstream error is redacted
    const res3 = await fetch(relay.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "unknown_method", params: [] })
    });
    const text3 = await res3.text();
    assert.ok(!text3.includes("FAKESECRET"), "Upstream error response must not contain FAKESECRET");
    assert.ok(text3.includes("<redacted-url>"), "Upstream error response must contain <redacted-url>");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
  }
});
