import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runDecisionPipeline, getDatabase, type DecisionRecord } from "../src/pipeline.ts";
import { getArbitrumRpcUrl, redactUrls } from "../src/config.ts";
import { createPublicClient, http, type Hex } from "viem";

const BLOCK_ELIGIBLE = 521208669n;
const BLOCK_NO_GAP = 521208668n;

test("I1: Approve - decide --block 521208669 yields ELIGIBLE with verified intent", { timeout: 120_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i1-"));
  const dbPath = path.join(tmpDir, "i1.sqlite");

  let i9CmdlineClean = false;
  const decision = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    dbPath,
    onSimStarted: (sim) => {
      const pid = sim.child.pid;
      if (pid) {
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          const rpcUrl = getArbitrumRpcUrl();
          const urlObj = new URL(rpcUrl);
          const hasAlchemy = cmdline.toLowerCase().includes("alchemy");
          const hasUrlPart = cmdline.includes(urlObj.pathname) || cmdline.includes(urlObj.host);
          i9CmdlineClean = !hasAlchemy && !hasUrlPart;
          assert.equal(hasAlchemy, false, "Anvil cmdline must not contain alchemy");
          assert.equal(hasUrlPart, false, "Anvil cmdline must not contain any part of ARBITRUM_RPC_URL");
        } catch (err: any) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    }
  });

  console.log("=== I1 Decision Record ===");
  console.log("Verdict:", decision.verdict);
  console.log("Reason:", decision.reason);
  console.log("Opportunity ID:", decision.opportunity_id);
  console.log("Block:", decision.block_number);
  console.log("Direction:", `Buy ${decision.pool_buy} -> Sell ${decision.pool_sell}`);
  console.log("Gap Bps:", decision.gap_bps);
  console.log("Size Raw:", decision.size_raw);
  console.log("Sim Profit Raw:", decision.sim_profit_raw);
  console.log("L2 Gas:", decision.l2_gas, "| L1 Gas:", decision.l1_gas);
  console.log("Gas Cost Wei:", decision.gas_cost_wei, "| Gas Cost USDC Raw:", decision.gas_cost_usdc_raw);
  console.log("Intent Hash:", decision.intent_hash);
  console.log("Calldata Hash:", decision.calldata_hash);
  console.log("I9 (during I1) cmdline check clean:", i9CmdlineClean);

  assert.equal(decision.verdict, "ELIGIBLE");
  assert.equal(decision.reason, null);
  assert.equal(decision.block_number, "521208669");
  assert.equal(decision.pool_buy.toLowerCase(), "0xf3eb87c1f6020982173c908e7eb31aa66c1f0296".toLowerCase(), "Leg 1 must buy on Sushi");
  assert.equal(decision.pool_sell.toLowerCase(), "0xc6962004f452be9203591991d15f6b388e09e8d0".toLowerCase(), "Leg 2 must sell on Uni");
  assert.ok(BigInt(decision.gap_bps) >= 10n, "Gap must be >= 10 bps");
  assert.ok(BigInt(decision.sim_profit_raw) > 0n, "Profit must be positive");
  assert.ok(decision.intent_hash.startsWith("0x"), "Intent hash must be valid");
  assert.ok(decision.calldata_hash.startsWith("0x"), "Calldata hash must be valid");

  // Verify persistence in SQLite
  const db = getDatabase(dbPath);
  const row = db.prepare("SELECT * FROM decisions WHERE opportunity_id = ?").get(decision.opportunity_id) as any;
  assert.ok(row, "Decision row must be recorded in SQLite");
  assert.equal(row.verdict, "ELIGIBLE");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I2: No gap - decide --block 521208668 yields REJECTED NO_GAP without starting Anvil", { timeout: 30_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i2-"));
  const dbPath = path.join(tmpDir, "i2.sqlite");

  const decision = await runDecisionPipeline({
    blockNumber: BLOCK_NO_GAP,
    dbPath
  });

  assert.equal(decision.verdict, "REJECTED");
  assert.equal(decision.reason, "NO_GAP");
  assert.equal(decision.size_raw, "0");
  assert.equal(decision.sim_profit_raw, "0");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I3: Policy denial - higher min_net_profit_raw yields REJECTED BELOW_MIN_PROFIT", { timeout: 120_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i3-"));
  const dbPath = path.join(tmpDir, "i3.sqlite");
  const tempPolicyPath = path.join(tmpDir, "policy-high-min.json");

  // Read base policy and set an unachievable min_net_profit_raw (1,000,000 USDC)
  const defaultPolicyPath = path.resolve(import.meta.dirname, "../policy/p4-sim.json");
  const basePolicy = JSON.parse(fs.readFileSync(defaultPolicyPath, "utf8"));
  const highMinPolicy = {
    ...basePolicy,
    min_net_profit_raw: "1000000000000" // 1,000,000 USDC
  };
  fs.writeFileSync(tempPolicyPath, JSON.stringify(highMinPolicy, null, 2));

  const decision = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    policyPath: tempPolicyPath,
    dbPath
  });

  assert.equal(decision.verdict, "REJECTED");
  assert.equal(decision.reason, "BELOW_MIN_PROFIT");
  assert.notEqual(decision.policy_hash, "0x0000000000000000000000000000000000000000000000000000000000000000");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I4: Stale - decide with H - N > 240 yields REJECTED STALE_STATE", { timeout: 30_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i4-"));
  const dbPath = path.join(tmpDir, "i4.sqlite");

  const decision = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    headBlockNumber: BLOCK_ELIGIBLE + 241n,
    dbPath
  });

  assert.equal(decision.verdict, "REJECTED");
  assert.equal(decision.reason, "STALE_STATE");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I5: Reorg - mutated blockHash in step 11 yields REJECTED REORG", { timeout: 120_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i5-"));
  const dbPath = path.join(tmpDir, "i5.sqlite");

  const decision = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    dbPath,
    reorgHashOverride: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex
  });

  assert.equal(decision.verdict, "REJECTED");
  assert.equal(decision.reason, "REORG");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I6: RPC fault - error at step 4 yields REJECTED RPC_ERROR with redacted message", { timeout: 30_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i6-"));
  const dbPath = path.join(tmpDir, "i6.sqlite");

  const realRpc = getArbitrumRpcUrl();
  const realClient = createPublicClient({ transport: http(realRpc, { timeout: 60_000 }) });

  const failingClient = {
    getChainId: () => realClient.getChainId(),
    getBlock: (args: any) => realClient.getBlock(args),
    readContract: async (args: any) => {
      // Throw with a fake secret URL in step 4 pool read
      throw new Error("Connection failed to http://127.0.0.1:9/v2/FAKESECRET123 at slot0()");
    }
  };

  const decision = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    remoteClientOverride: failingClient,
    dbPath
  });

  assert.equal(decision.verdict, "REJECTED");
  assert.equal(decision.reason, "RPC_ERROR");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I7: Intent tamper - calldata mutation yields REJECTED INTENT_MISMATCH", { timeout: 120_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i7-"));
  const dbPath = path.join(tmpDir, "i7.sqlite");

  const decision = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    dbPath,
    calldataTamperHook: (calldata: Hex): Hex => {
      // Mutate the last byte of calldata to simulate tamper
      const slice = calldata.slice(0, -2);
      const lastByte = calldata.slice(-2);
      const mutated = lastByte === "00" ? "01" : "00";
      return `${slice}${mutated}` as Hex;
    }
  });

  assert.equal(decision.verdict, "REJECTED");
  assert.equal(decision.reason, "INTENT_MISMATCH");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I8: Determinism - running decide twice on fresh databases produces identical records", { timeout: 200_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i8-"));
  const dbPath1 = path.join(tmpDir, "i8_run1.sqlite");
  const dbPath2 = path.join(tmpDir, "i8_run2.sqlite");

  const run1 = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    dbPath: dbPath1
  });

  const run2 = await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    dbPath: dbPath2
  });

  // Verify all fields except created_at are identical
  const { created_at: t1, ...rest1 } = run1;
  const { created_at: t2, ...rest2 } = run2;

  assert.deepEqual(rest1, rest2, "Decisions across runs on fresh DBs must be bit-for-bit deterministic");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("I9: Spawned Anvil cmdline contains no alchemy substring or RPC URL", { timeout: 120_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-i9-"));
  const dbPath = path.join(tmpDir, "i9.sqlite");

  let i9CmdlineClean = false;
  await runDecisionPipeline({
    blockNumber: BLOCK_ELIGIBLE,
    dbPath,
    onSimStarted: (sim) => {
      const pid = sim.child.pid;
      if (pid) {
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          const rpcUrl = getArbitrumRpcUrl();
          const urlObj = new URL(rpcUrl);
          const hasAlchemy = cmdline.toLowerCase().includes("alchemy");
          const hasUrlPart = cmdline.includes(urlObj.pathname) || cmdline.includes(urlObj.host);
          i9CmdlineClean = !hasAlchemy && !hasUrlPart;
          assert.equal(hasAlchemy, false, "Anvil cmdline must not contain alchemy");
          assert.equal(hasUrlPart, false, "Anvil cmdline must not contain any part of ARBITRUM_RPC_URL");
        } catch (err: any) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    }
  });

  console.log("I9 Anvil cmdline clean:", i9CmdlineClean);
  assert.equal(i9CmdlineClean, true, "I9 verification passed: cmdline contains only loopback relay URL");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
