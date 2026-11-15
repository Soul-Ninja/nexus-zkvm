import test from "node:test";
import assert from "node:assert/strict";
import { initDb, getBorrowers, getSnapshotsAtBlock, upsertBorrower } from "../src/db.ts";
import { createClients, getConfig, POOL, borrowEventAbi } from "../src/config.ts";
import { discover } from "../src/discover.ts";
import { snapshot } from "../src/snapshot.ts";

test("Integration 7: Discovery & Snapshot for Phase 0 Borrower at 521878426", async () => {
  const db = initDb(":memory:");
  const clients = await createClients();

  const fromBlock = 521878395n;
  const toBlock = 521878426n;
  const borrower = "0xaf18232ba591ba9eb8ef179b3869565a50b56790";

  // 1. Discover
  const discResult = await discover(fromBlock, toBlock, db, clients, 10n);
  assert.ok(discResult.chunksProcessed > 0, "No chunks processed");

  const knownBorrowers = getBorrowers(db);
  assert.ok(
    knownBorrowers.includes(borrower),
    `Borrower ${borrower} not found in discovered list: ${JSON.stringify(knownBorrowers)}`
  );

  // 2. Snapshot
  const snapResult = await snapshot(toBlock, db, clients.stateClient);
  assert.ok(snapResult.snapshotsTaken > 0, "No snapshots taken");

  const snapshots = getSnapshotsAtBlock(db, toBlock);
  const borrowerSnap = snapshots.find((s) => s.address === borrower);
  assert.ok(borrowerSnap, "Snapshot for borrower not found");

  // Assert exact equality with Phase 0 constants
  assert.equal(borrowerSnap.totalCollateralBase, 222685005n, "totalCollateralBase mismatch");
  assert.equal(borrowerSnap.totalDebtBase, 99987830n, "totalDebtBase mismatch");
  assert.equal(borrowerSnap.availableBorrowsBase, 80387024n, "availableBorrowsBase mismatch");
  assert.equal(borrowerSnap.currentLiquidationThreshold, 8400n, "currentLiquidationThreshold mismatch");
  assert.equal(borrowerSnap.ltv, 8100n, "ltv mismatch");
  assert.equal(borrowerSnap.healthFactor, 1870781716134853611n, "healthFactor mismatch");
  assert.equal(borrowerSnap.error, null, "Snapshot contained unexpected error");
});

test("Integration 8: Flow at 521749898 & Snapshot at 521749897 for Liquidatable Borrower", async () => {
  const db = initDb(":memory:");
  const clients = await createClients();

  const fromBlock = 521749890n;
  const toBlock = 521749900n;
  const liqBorrower = "0x452ec9e1cd041843034fa1a5e61e0496253f174b";
  const preLiqBlock = 521749897n;

  // Run discovery across range containing liquidation call block
  await discover(fromBlock, toBlock, db, clients, 10n);

  // Per spec §7 item 8: the borrower's debt-opening Borrow event predates block 521749890.
  // Seed explicitly as permitted by specification.
  upsertBorrower(db, liqBorrower, preLiqBlock);

  const snapResult = await snapshot(preLiqBlock, db, clients.stateClient);
  assert.ok(snapResult.snapshotsTaken > 0);

  const snapshots = getSnapshotsAtBlock(db, preLiqBlock);
  const snap = snapshots.find((s) => s.address === liqBorrower);
  assert.ok(snap, `Snapshot for ${liqBorrower} at ${preLiqBlock} not found`);

  assert.equal(snap.totalCollateralBase, 100636136n, "totalCollateralBase mismatch");
  assert.equal(snap.totalDebtBase, 78496785n, "totalDebtBase mismatch");
  assert.equal(snap.availableBorrowsBase, 0n, "availableBorrowsBase mismatch");
  assert.equal(snap.currentLiquidationThreshold, 7800n, "currentLiquidationThreshold mismatch");
  assert.equal(snap.ltv, 0n, "ltv mismatch");
  assert.equal(snap.healthFactor, 999992370133375526n, "healthFactor mismatch");
  assert.equal(snap.error, null);
});

test("Integration 9: Provider cross-check on three 10-block windows", async () => {
  const clients = await createClients();

  // Test windows (within 10-block range for Alchemy Free compatibility)
  const windows = [
    { from: 521878400n, to: 521878409n }, // contains borrow at 521878404
    { from: 521878410n, to: 521878419n },
    { from: 521878420n, to: 521878426n },
  ];

  for (const w of windows) {
    const logsDiscovery = await clients.discoveryClient.getLogs({
      address: POOL,
      event: borrowEventAbi,
      fromBlock: w.from,
      toBlock: w.to,
    });

    const logsState = await clients.stateClient.getLogs({
      address: POOL,
      event: borrowEventAbi,
      fromBlock: w.from,
      toBlock: w.to,
    });

    assert.equal(
      logsDiscovery.length,
      logsState.length,
      `Log count mismatch for window [${w.from}, ${w.to}]`
    );

    for (let i = 0; i < logsDiscovery.length; i++) {
      assert.equal(
        logsDiscovery[i].transactionHash,
        logsState[i].transactionHash,
        `TxHash mismatch at index ${i}`
      );
      assert.equal(
        logsDiscovery[i].logIndex,
        logsState[i].logIndex,
        `LogIndex mismatch at index ${i}`
      );
    }
  }
});

test("Integration 10: Idempotency of integration test 7 run twice", async () => {
  const db = initDb(":memory:");
  const clients = await createClients();

  const fromBlock = 521878395n;
  const toBlock = 521878426n;

  // Run 1
  await discover(fromBlock, toBlock, db, clients, 10n);
  await snapshot(toBlock, db, clients.stateClient);

  const borrowers1 = getBorrowers(db);
  const snapshots1 = getSnapshotsAtBlock(db, toBlock);

  // Run 2 (same range and block)
  await discover(fromBlock, toBlock, db, clients, 10n);
  await snapshot(toBlock, db, clients.stateClient);

  const borrowers2 = getBorrowers(db);
  const snapshots2 = getSnapshotsAtBlock(db, toBlock);

  assert.deepEqual(borrowers1, borrowers2, "Borrowers list changed on second run");
  assert.deepEqual(snapshots1, snapshots2, "Snapshots changed on second run");
});

test("Measured metric: Discovery throughput and backfill projection", async () => {
  const db = initDb(":memory:");
  const config = getConfig();
  const clients = await createClients(config);

  const span = 50n;
  const fromBlock = 521878370n;
  const toBlock = fromBlock + span - 1n;

  const start = Date.now();
  const res = await discover(fromBlock, toBlock, db, clients, config.logChunkBlocks);
  const elapsedMs = Date.now() - start;

  const blocksPerSec = (Number(span) * 1000) / elapsedMs;
  const blocksPerMin = blocksPerSec * 60;

  console.log(`=== Throughput Measurement ===`);
  console.log(`Discovered ${res.totalDiscovered} borrows over ${span} blocks in ${elapsedMs}ms (chunk size: ${config.logChunkBlocks})`);
  console.log(`Discovery throughput: ${blocksPerMin.toFixed(2)} blocks/min (${blocksPerSec.toFixed(2)} blocks/sec)`);

  // Deployment block analysis:
  // Conservative lower bound from aave/protocol-subgraphs config/arbitrum-v3.json:
  // PoolAddressesProviderRegistryStartBlock: 7,736,400.
  // Oracle start block: 7,740,000.
  // Current finalized block: ~524,400,000.
  const totalBlocks = 524400000n - 7736400n;
  const minutesNeeded = Number(totalBlocks) / blocksPerMin;
  const hoursNeeded = minutesNeeded / 60;

  console.log(`Total blocks from registry start (7.736M to 524.4M): ~${totalBlocks.toLocaleString()} blocks`);
  console.log(`Projected backfill time on discovery RPC: ~${hoursNeeded.toFixed(1)} hours`);
});
