import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  POOLS,
  reconstructBlockEndStates,
  calculatePairGap,
  findCandidates,
  fetchSwapLogsChunk,
  quoteArbProfit,
  labelCandidate,
  type SwapLogItem,
  type PoolState
} from "../src/dataset.ts";
import { getArbitrumRpcUrl, redactUrls } from "../src/config.ts";
import { createPublicClient, http, type Address } from "viem";
import { arbitrum } from "viem/chains";

test("D1: Block-end reconstruction on a fixture of 5 blocks with carry-forward", async () => {
  const poolA: Address = POOLS[0].address;
  const poolB: Address = POOLS[1].address;

  // 5 blocks: 100..104
  // Block 100: Pool A has two swaps (first p=1000, second p=1050). Last swap should win.
  // Block 101: Pool B has one swap (p=2000). Pool A does not swap (should carry forward p=1050).
  // Block 102: Pool A swaps (p=1100). Pool B carries forward p=2000.
  // Block 103: Both swap (Pool A p=1150, Pool B p=2050).
  // Block 104: Neither swap in input logs (no entry).

  const mockLogs: SwapLogItem[] = [
    {
      blockNumber: 100n,
      transactionIndex: 0,
      logIndex: 0,
      poolAddress: poolA,
      sqrtPriceX96: 1000n,
      liquidity: 50000n,
      tick: 10
    },
    {
      blockNumber: 100n,
      transactionIndex: 1,
      logIndex: 0,
      poolAddress: poolA,
      sqrtPriceX96: 1050n,
      liquidity: 51000n,
      tick: 15
    },
    {
      blockNumber: 101n,
      transactionIndex: 0,
      logIndex: 0,
      poolAddress: poolB,
      sqrtPriceX96: 2000n,
      liquidity: 80000n,
      tick: 25
    },
    {
      blockNumber: 102n,
      transactionIndex: 0,
      logIndex: 0,
      poolAddress: poolA,
      sqrtPriceX96: 1100n,
      liquidity: 52000n,
      tick: 20
    },
    {
      blockNumber: 103n,
      transactionIndex: 0,
      logIndex: 0,
      poolAddress: poolA,
      sqrtPriceX96: 1150n,
      liquidity: 53000n,
      tick: 22
    },
    {
      blockNumber: 103n,
      transactionIndex: 1,
      logIndex: 0,
      poolAddress: poolB,
      sqrtPriceX96: 2050n,
      liquidity: 82000n,
      tick: 28
    }
  ];

  const states = reconstructBlockEndStates(mockLogs);

  // Check Block 100
  const b100 = states.get(100n)!;
  assert.ok(b100);
  const a100 = b100.get(poolA.toLowerCase())!;
  assert.equal(a100.sqrtPriceX96, 1050n, "Block 100 last swap must be 1050");
  assert.equal(a100.tick, 15);
  assert.equal(a100.lastSwapBlock, 100n);

  // Check Block 101: Pool A carried forward from 100, Pool B updated
  const b101 = states.get(101n)!;
  assert.ok(b101);
  const a101 = b101.get(poolA.toLowerCase())!;
  assert.equal(a101.sqrtPriceX96, 1050n, "Block 101 must carry forward Pool A state from 100");
  assert.equal(a101.lastSwapBlock, 100n);
  const bState101 = b101.get(poolB.toLowerCase())!;
  assert.equal(bState101.sqrtPriceX96, 2000n);
  assert.equal(bState101.lastSwapBlock, 101n);

  // Check Block 102: Pool A updated, Pool B carried forward
  const b102 = states.get(102n)!;
  const a102 = b102.get(poolA.toLowerCase())!;
  assert.equal(a102.sqrtPriceX96, 1100n);
  const bState102 = b102.get(poolB.toLowerCase())!;
  assert.equal(bState102.sqrtPriceX96, 2000n, "Block 102 must carry forward Pool B state from 101");

  // Check Block 103: Both updated
  const b103 = states.get(103n)!;
  assert.equal(b103.get(poolA.toLowerCase())!.sqrtPriceX96, 1150n);
  assert.equal(b103.get(poolB.toLowerCase())!.sqrtPriceX96, 2050n);
});

test("D2: Gap math in integer bps matches §3 values for blocks 521208669 (130) and 521208668 (0)", async () => {
  // Pinned sqrtPriceX96 from Phase 4 at block 521208669:
  // Uni 500: 3898315058101465043779590
  // Sushi 500: 3873099955431606115998188 (approx, giving 130 bps)
  const uniSqrtP_669 = 3898315058101465043779590n;
  const sushiSqrtP_669 = 3873099955431606115998188n;

  const stateSushi669: PoolState = {
    sqrtPriceX96: sushiSqrtP_669,
    liquidity: 1000000n,
    tick: 0,
    lastSwapBlock: 521208669n
  };
  const stateUni669: PoolState = {
    sqrtPriceX96: uniSqrtP_669,
    liquidity: 1000000n,
    tick: 0,
    lastSwapBlock: 521208669n
  };

  const gap669 = calculatePairGap(stateSushi669, stateUni669);
  assert.equal(gap669.buyIsA, true, "Sushi has lower price, so buy on Sushi");
  assert.equal(gap669.gapBps, 130n, "Block 521208669 gap must be exactly 130 bps");

  // At block 521208668: prices equal or difference < 1 bps
  const state668A: PoolState = {
    sqrtPriceX96: 3898315058101465043779590n,
    liquidity: 1000000n,
    tick: 0,
    lastSwapBlock: 521208668n
  };
  const state668B: PoolState = {
    sqrtPriceX96: 3898315058101465043779590n,
    liquidity: 1000000n,
    tick: 0,
    lastSwapBlock: 521208668n
  };

  const gap668 = calculatePairGap(state668A, state668B);
  assert.equal(gap668.gapBps, 0n, "Block 521208668 gap must be 0 bps");
});

test("D3: Label at block 521208669, pair Sushi500->Uni500, size 10,000 USDC -> Profit 59503988 exactly", { timeout: 30_000 }, async () => {
  const rpcUrl = getArbitrumRpcUrl();
  const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl, { timeout: 30_000 }) });

  const sushi500 = POOLS[4]; // sushi_500
  const uni500 = POOLS[1];   // uni_500

  const { midWeth, finalUSDC, profit } = await quoteArbProfit(
    client,
    sushi500,
    uni500,
    10000_000000n, // 10,000 USDC
    521208669n
  );

  assert.equal(midWeth, 4148566374738957436n, "Quoted WETH out from Sushi QuoterV2 must match spec §3");
  assert.equal(finalUSDC, 10059503988n, "Quoted USDC out from Uni QuoterV2 must match spec §3");
  assert.equal(profit, 59503988n, "Quoted profit must equal 59503988 exactly");
});

test("D4: Chunk halving on simulated range error and cache reuse", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p5-d4-"));
  const poolAddresses = [POOLS[0].address];

  let callCount = 0;
  const mockClient = {
    getLogs: async (args: any) => {
      callCount++;
      // Fail on full range 100..200 with range error
      if (args.fromBlock === 100n && args.toBlock === 200n) {
        throw new Error("Log response size exceeded. Use a smaller range.");
      }
      // Succeed on halves
      return [
        {
          blockNumber: args.fromBlock,
          transactionIndex: 0n,
          logIndex: 0n,
          address: poolAddresses[0],
          args: {
            sqrtPriceX96: 1000n,
            liquidity: 50000n,
            tick: 10
          }
        }
      ];
    }
  };

  // Run 1: Halves into [100..150] and [151..200]
  const logs = await fetchSwapLogsChunk(
    mockClient,
    100n,
    200n,
    poolAddresses,
    tmpDir
  );

  assert.equal(logs.length, 2, "Should return 2 logs from combined halves");
  assert.equal(callCount, 3, "Should call 1 full + 2 halves = 3 calls");

  // Run 2: Cache hit, 0 network calls
  const beforeSecondCall = callCount;
  const cachedLogs = await fetchSwapLogsChunk(
    mockClient,
    100n,
    200n,
    poolAddresses,
    tmpDir
  );

  assert.equal(callCount, beforeSecondCall, "Cache hit must not make RPC calls");
  assert.equal(cachedLogs.length, 2, "Cached logs must match");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("D5: Redaction: quoting error with a fake key URL is redacted", async () => {
  const fakeError = new Error("Connection failed to http://127.0.0.1:9/v2/FAKESECRET123 at quoteExactInputSingle");
  const redacted = redactUrls(fakeError.message);

  assert.equal(redacted.includes("FAKESECRET123"), false, "Must not contain secret key");
  assert.equal(redacted.includes("<redacted-url>"), true, "Must contain <redacted-url>");
});

test("D6: Block 521208669 candidate selection and label (§6.2b)", { timeout: 30_000 }, async () => {
  const cacheFile = path.resolve(import.meta.dirname, "../../../ml/data/logs/chunk_521200000_521209999.json");
  assert.ok(fs.existsSync(cacheFile), "Log chunk 521200000_521209999 must exist in cache");
  const rawLogs = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const logs: SwapLogItem[] = rawLogs
    .map((l: any) => ({
      blockNumber: BigInt(l.blockNumber),
      transactionIndex: l.transactionIndex,
      logIndex: l.logIndex,
      poolAddress: l.poolAddress as Address,
      sqrtPriceX96: BigInt(l.sqrtPriceX96),
      liquidity: BigInt(l.liquidity),
      tick: l.tick
    }))
    .filter((l: SwapLogItem) => l.blockNumber <= 521208669n);

  const blockStates = reconstructBlockEndStates(logs);
  const candidates = findCandidates(blockStates, 10n);
  const cand669 = candidates.find((c) => c.blockNumber === 521208669n);

  assert.ok(cand669, "Block 521208669 must be selected as a candidate");
  assert.equal(cand669.poolBuy.name, "sushi_500", "Buy pool must be sushi_500");
  assert.equal(cand669.poolSell.name, "uni_500", "Sell pool must be uni_500");

  const rpcUrl = getArbitrumRpcUrl();
  const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl, { timeout: 30_000 }) });
  const uni500 = blockStates.get(521208669n)?.get(POOLS[1].address.toLowerCase());
  const uniSqrtP = uni500?.sqrtPriceX96 ?? 0n;

  const labeled = await labelCandidate(client, cand669, uniSqrtP);
  assert.ok(
    labeled.profitRaw >= 59503988n,
    `Profit raw must be >= 59503988 (got ${labeled.profitRaw})`
  );
  assert.equal(labeled.bestSize, 10000_000000n, "Best size must be 10,000 USDC");
  assert.equal(labeled.y, 1, "Label y must be 1");
});
