import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";
import { generateChunks, discover } from "../src/discover.ts";
import {
  initDb,
  insertAccountSnapshots,
  getSnapshotsAtBlock,
  upsertBorrower,
  setCheckpoint,
  getCheckpoint,
  getStatus,
  getBorrowers,
  type AccountSnapshot,
} from "../src/db.ts";
import { snapshot } from "../src/snapshot.ts";
import { formatWad4, formatBaseCurrency, runCli } from "../src/cli.ts";
import { redactUrls } from "../src/config.ts";

const execFileAsync = promisify(execFile);

const UINT256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

test("Unit 1: Chunking covers [from, to] exactly with no gaps or overlap", () => {
  const chunks = generateChunks(100n, 125n, 10n);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { from: 100n, to: 109n });
  assert.deepEqual(chunks[1], { from: 110n, to: 119n });
  assert.deepEqual(chunks[2], { from: 120n, to: 125n });

  // Verify contiguous invariants
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.equal(chunks[i + 1].from, chunks[i].to + 1n, `Gap between chunk ${i} and ${i + 1}`);
    assert.ok(chunks[i].from <= chunks[i].to, `Inverted chunk at index ${i}`);
  }

  // Edge cases
  assert.deepEqual(generateChunks(100n, 100n, 10n), [{ from: 100n, to: 100n }]);
  assert.deepEqual(generateChunks(100n, 109n, 10n), [{ from: 100n, to: 109n }]);
  assert.deepEqual(generateChunks(105n, 100n, 10n), []);
});

test("Unit 2: Decimal-string round trip for values above 2^53 and uint256.max", () => {
  const db = initDb(":memory:");
  const valAbove2to53 = 1152921504606846976n; // 2^60
  const blockNumber = 500000000n;

  const sampleSnapshot: AccountSnapshot = {
    address: "0x1234567890123456789012345678901234567890",
    blockNumber,
    blockHash: "0xabcdef1234567890",
    totalCollateralBase: valAbove2to53,
    totalDebtBase: 1000000000n,
    availableBorrowsBase: 0n,
    currentLiquidationThreshold: 8500n,
    ltv: 8000n,
    healthFactor: UINT256_MAX,
  };

  insertAccountSnapshots(db, [sampleSnapshot]);

  const rows = getSnapshotsAtBlock(db, blockNumber);
  assert.equal(rows.length, 1);
  const r = rows[0];

  assert.equal(r.totalCollateralBase, valAbove2to53);
  assert.equal(r.totalCollateralBase?.toString(), valAbove2to53.toString());
  assert.equal(r.healthFactor, UINT256_MAX);
  assert.equal(r.healthFactor?.toString(), UINT256_MAX.toString());
  assert.equal(r.blockNumber, blockNumber);
});

test("Unit 3: at-risk filtering and sorting with fixture rows", () => {
  const db = initDb(":memory:");
  const blockNumber = 520000000n;
  const blockHash = "0xhash520";

  const rows: AccountSnapshot[] = [
    {
      address: "0xaaaa000000000000000000000000000000000001",
      blockNumber,
      blockHash,
      healthFactor: 1000000000000000000n, // 1.00 WAD
      totalDebtBase: 50000000n,
      totalCollateralBase: 60000000n,
    },
    {
      address: "0xbbbb000000000000000000000000000000000002",
      blockNumber,
      blockHash,
      healthFactor: 950000000000000000n, // 0.95 WAD
      totalDebtBase: 100000000n,
      totalCollateralBase: 100000000n,
    },
    {
      address: "0xcccc000000000000000000000000000000000003",
      blockNumber,
      blockHash,
      healthFactor: 1040000000000000000n, // 1.04 WAD
      totalDebtBase: 20000000n,
      totalCollateralBase: 30000000n,
    },
    {
      address: "0xdddd000000000000000000000000000000000004",
      blockNumber,
      blockHash,
      healthFactor: 1200000000000000000n, // 1.20 WAD (above filter)
      totalDebtBase: 10000000n,
      totalCollateralBase: 20000000n,
    },
    {
      address: "0xeeee000000000000000000000000000000000005",
      blockNumber,
      blockHash,
      healthFactor: UINT256_MAX, // No debt (above filter)
      totalDebtBase: 0n,
      totalCollateralBase: 10000000n,
    },
    {
      address: "0xffff000000000000000000000000000000000006",
      blockNumber,
      blockHash,
      error: "multicall call reverted",
    },
  ];

  insertAccountSnapshots(db, rows);

  // Filter below 1.05e18
  const threshold = 1050000000000000000n;
  const filtered = getSnapshotsAtBlock(db, blockNumber, threshold);

  // Must only include B (0.95), A (1.00), C (1.04) sorted ascending by HF
  assert.equal(filtered.length, 3);
  assert.equal(filtered[0].address, "0xbbbb000000000000000000000000000000000002");
  assert.equal(filtered[0].healthFactor, 950000000000000000n);
  assert.equal(formatWad4(filtered[0].healthFactor!), "0.9500");

  assert.equal(filtered[1].address, "0xaaaa000000000000000000000000000000000001");
  assert.equal(filtered[1].healthFactor, 1000000000000000000n);
  assert.equal(formatWad4(filtered[1].healthFactor!), "1.0000");

  assert.equal(filtered[2].address, "0xcccc000000000000000000000000000000000003");
  assert.equal(filtered[2].healthFactor, 1040000000000000000n);
  assert.equal(formatWad4(filtered[2].healthFactor!), "1.0400");
});

test("Unit 4: Idempotency of discovery and snapshot insertions", () => {
  const db = initDb(":memory:");

  // Insert borrowers twice
  upsertBorrower(db, "0x1111111111111111111111111111111111111111", 500n);
  upsertBorrower(db, "0x1111111111111111111111111111111111111111", 500n);
  assert.equal(getBorrowers(db).length, 1);

  // Insert snapshots twice
  const item: AccountSnapshot = {
    address: "0x1111111111111111111111111111111111111111",
    blockNumber: 500n,
    blockHash: "0x500",
    totalCollateralBase: 100n,
    totalDebtBase: 50n,
    healthFactor: 2000000000000000000n,
  };

  insertAccountSnapshots(db, [item]);
  const rows1 = getSnapshotsAtBlock(db, 500n);

  insertAccountSnapshots(db, [item]);
  const rows2 = getSnapshotsAtBlock(db, 500n);

  assert.deepEqual(rows1, rows2);
  assert.equal(rows2.length, 1);
});

test("Unit 5: Checkpoint mismatch halts startup without modifying DB file", async () => {
  const tempDbPath = `/tmp/test_indexer_mismatch_${Date.now()}.sqlite`;
  try {
    const db = initDb(tempDbPath);
    setCheckpoint(db, "discovery", 1000n, "0xexpectedhash1000");
    db.close();

    const fileHashBefore = crypto
      .createHash("sha256")
      .update(fs.readFileSync(tempDbPath))
      .digest("hex");

    const reOpenedDb = initDb(tempDbPath);

    // Stub state client returning mismatched hash
    const stubClients = {
      stateClient: {
        getBlock: async ({ blockTag, blockNumber }: any) => {
          if (blockTag === "finalized") return { number: 2000n, hash: "0xfinalized" };
          if (blockNumber === 1000n) return { number: 1000n, hash: "0xdifferenthash1000" };
          return { number: blockNumber || 0n, hash: "0xdefault" };
        },
      } as any,
      discoveryClient: {} as any,
    };

    await assert.rejects(
      async () => {
        await discover(1001n, 1010n, reOpenedDb, stubClients, 10n);
      },
      (err: Error) => {
        return err.message.includes("Checkpoint mismatch") && err.message.includes("Halting");
      }
    );

    reOpenedDb.close();

    const fileHashAfter = crypto
      .createHash("sha256")
      .update(fs.readFileSync(tempDbPath))
      .digest("hex");

    assert.equal(fileHashAfter, fileHashBefore, "Database file was modified despite mismatch error");
  } finally {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  }
});

test("Unit 6: Refusal on discovery or snapshot above finalized block", async () => {
  const db = initDb(":memory:");

  const stubClients = {
    stateClient: {
      getBlock: async ({ blockTag }: any) => {
        if (blockTag === "finalized") return { number: 5000n, hash: "0xfinalized" };
        return { number: 0n, hash: "0x0" };
      },
    } as any,
    discoveryClient: {} as any,
  };

  // Attempt discovery toBlock 5001n > 5000n
  await assert.rejects(
    async () => {
      await discover(4990n, 5001n, db, stubClients, 10n);
    },
    (err: Error) => {
      return err.message.includes("Refusing to discover unfinalized block");
    }
  );

  // Attempt snapshot at 5001n > 5000n
  await assert.rejects(
    async () => {
      await snapshot(5001n, db, stubClients.stateClient);
    },
    (err: Error) => {
      return err.message.includes("Refusing to snapshot unfinalized block");
    }
  );
});

test("Unit 7: Secret redaction in SQLite error rows, discover chunk errors, and CLI process stderr", async () => {
  const db = initDb(":memory:");
  const testBlock = 500000000n;
  upsertBorrower(db, "0x1111111111111111111111111111111111111111", testBlock);

  // A viem client with secret URL
  const fakeSecretClient = createPublicClient({
    chain: arbitrum,
    transport: http("http://127.0.0.1:9/v2/FAKESECRET123", { retryCount: 0, timeout: 200 }),
  });

  // Client where getBlock succeeds (so snapshot reaches multicall) but multicall fails via fakeSecretClient
  const clientWithFakeTransport: any = {
    getBlock: async ({ blockTag, blockNumber }: any) => {
      if (blockTag === "finalized") return { number: 600000000n, hash: "0xfinalized" };
      return { number: blockNumber || testBlock, hash: "0xtestblock" };
    },
    multicall: async (args: any) => {
      // Delegate to real viem client which attempts HTTP request to the fake URL and fails
      return await fakeSecretClient.multicall(args);
    },
  };

  const res = await snapshot(testBlock, db, clientWithFakeTransport);
  assert.equal(res.failedCalls, 1);

  const snapshotRows = getSnapshotsAtBlock(db, testBlock);
  assert.equal(snapshotRows.length, 1);
  assert.ok(snapshotRows[0].error !== null, "Error row should be populated");
  assert.equal(
    snapshotRows[0].error!.includes("FAKESECRET123"),
    false,
    "Stored error row must NOT contain FAKESECRET123"
  );
  assert.ok(
    snapshotRows[0].error!.includes("<redacted-url>"),
    "Stored error row must contain <redacted-url>"
  );

  // Discover chunk failure redaction check (discovery client always fails)
  const failingDiscoveryClient = {
    getLogs: async () => {
      throw new Error("Connection failed to http://127.0.0.1:9/v2/FAKESECRET_DISCOVER: ECONNREFUSED");
    },
  } as any;
  const mockStateClient = {
    getBlock: async ({ blockTag, blockNumber }: any) => {
      if (blockTag === "finalized") return { number: 2000n, hash: "0xfinalized" };
      return { number: blockNumber || 0n, hash: "0xhash" };
    },
  } as any;

  await assert.rejects(
    async () => {
      await discover(
        100n,
        105n,
        db,
        {
          discoveryClient: failingDiscoveryClient,
          stateClient: mockStateClient,
        },
        10n
      );
    },
    (err: Error) => {
      assert.ok(
        err.message.includes("<redacted-url>"),
        `discover error must contain <redacted-url>, got: ${err.message}`
      );
      assert.equal(
        err.message.includes("FAKESECRET_DISCOVER"),
        false,
        "discover error must NOT contain FAKESECRET_DISCOVER"
      );
      return true;
    }
  );

  // Real CLI process spawn check from an isolated temp cwd
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-cli-test-"));
  try {
    const cliPath = path.resolve(import.meta.dirname, "../src/cli.ts");
    let childErr: any = null;
    try {
      await execFileAsync(
        process.execPath,
        [cliPath, "discover", "--from", "1", "--to", "2"],
        {
          cwd: tempCwd,
          env: {
            ...process.env,
            ARBITRUM_RPC_URL: "http://127.0.0.1:9/v2/FAKESECRET_CLI_789",
            DISCOVERY_RPC_URL: "http://127.0.0.1:9/v2/FAKESECRET_CLI_789",
          },
        }
      );
    } catch (err: any) {
      childErr = err;
    }

    assert.ok(childErr !== null, "CLI process must fail when connecting to fake secret RPC");
    const stderr = childErr.stderr || "";
    const stdout = childErr.stdout || "";
    assert.ok(
      stderr.includes("<redacted-url>"),
      `CLI stderr must contain <redacted-url>, got: ${stderr}`
    );
    assert.equal(
      stderr.includes("FAKESECRET"),
      false,
      "CLI stderr must NOT contain FAKESECRET"
    );
    assert.equal(
      stdout.includes("FAKESECRET"),
      false,
      "CLI stdout must NOT contain FAKESECRET"
    );
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("Unit 8: Refusal on discovery gap when fromBlock > checkpoint + 1", async () => {
  const db = initDb(":memory:");
  setCheckpoint(db, "discovery", 1000n, "0xhash1000", 500n);

  const stubClients = {
    stateClient: {
      getBlock: async ({ blockTag, blockNumber }: any) => {
        if (blockTag === "finalized") return { number: 5000n, hash: "0xfinalized" };
        if (blockNumber === 1000n) return { number: 1000n, hash: "0xhash1000" };
        return { number: blockNumber || 0n, hash: "0x0" };
      },
    } as any,
    discoveryClient: {} as any,
  };

  // Gap: checkpoint is 1000, requested fromBlock is 1005 (expected 1001)
  await assert.rejects(
    async () => {
      await discover(1005n, 1010n, db, stubClients, 10n);
    },
    (err: Error) => {
      return (
        err.message.includes("Discovery gap refused") &&
        err.message.includes("1005") &&
        err.message.includes("1001") &&
        err.message.includes("gap of 4 blocks")
      );
    }
  );

  // Exact contiguous continuation (fromBlock == 1001n) is accepted
  stubClients.discoveryClient = {
    getLogs: async () => [],
  } as any;

  const result = await discover(1001n, 1005n, db, stubClients, 10n);
  assert.equal(result.chunksProcessed, 1);
  const updatedCheckpoint = getCheckpoint(db, "discovery");
  assert.equal(updatedCheckpoint?.blockNumber, 1005n);
  assert.equal(updatedCheckpoint?.coverageStartBlock, 500n);
});

test("Unit 9: Status command prints coverage: blocks <start>..<checkpoint>", async () => {
  const tempDbPath = `/tmp/test_indexer_status_${Date.now()}.sqlite`;
  try {
    const db = initDb(tempDbPath);
    setCheckpoint(db, "discovery", 1000n, "0xhash1000", 500n);
    db.close();

    let output = "";
    const originalConsoleLog = console.log;
    console.log = (msg: string) => {
      output += msg + "\n";
    };

    try {
      await runCli(["status"], tempDbPath);
    } finally {
      console.log = originalConsoleLog;
    }

    assert.ok(
      output.includes("coverage: blocks 500..1000"),
      `Expected status to print 'coverage: blocks 500..1000', got:\n${output}`
    );
  } finally {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  }
});

test("Unit 10: Legacy checkpoint with null coverage_start_block remains unknown after discovery", async () => {
  const db = initDb(":memory:");

  // Simulate a legacy pre-fix checkpoint where coverage_start_block is NULL
  db.prepare(`
    INSERT INTO checkpoints (name, block_number, block_hash, coverage_start_block)
    VALUES ('discovery', '1000', '0xhash1000', NULL)
  `).run();

  const legacyCheckpoint = getCheckpoint(db, "discovery");
  assert.equal(legacyCheckpoint?.coverageStartBlock, undefined);

  const stubClients = {
    stateClient: {
      getBlock: async ({ blockTag, blockNumber }: any) => {
        if (blockTag === "finalized") return { number: 5000n, hash: "0xfinalized" };
        if (blockNumber === 1000n) return { number: 1000n, hash: "0xhash1000" };
        if (blockNumber === 1005n) return { number: 1005n, hash: "0xhash1005" };
        return { number: blockNumber || 0n, hash: "0x0" };
      },
    } as any,
    discoveryClient: {
      getLogs: async () => [],
    } as any,
  };

  // Run discover from 1001 to 1005
  const result = await discover(1001n, 1005n, db, stubClients, 10n);
  assert.equal(result.chunksProcessed, 1);

  // Checkpoint block advanced to 1005, but coverageStartBlock MUST remain undefined (never filled in)
  const updatedCheckpoint = getCheckpoint(db, "discovery");
  assert.equal(updatedCheckpoint?.blockNumber, 1005n);
  assert.equal(
    updatedCheckpoint?.coverageStartBlock,
    undefined,
    "Legacy checkpoint must not have coverageStartBlock populated"
  );

  // Status must continue to show unknown
  const status = getStatus(db);
  assert.equal(status.checkpoint?.coverageStartBlock, undefined);
});
