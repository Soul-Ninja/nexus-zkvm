import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CheckpointRow {
  name: string;
  blockNumber: bigint;
  blockHash: string;
  coverageStartBlock?: bigint;
}

export interface BorrowerRow {
  address: string;
  firstSeenBlock: bigint;
  lastSeenBlock: bigint;
}

export interface AccountSnapshot {
  address: string;
  blockNumber: bigint;
  blockHash: string;
  totalCollateralBase?: bigint;
  totalDebtBase?: bigint;
  availableBorrowsBase?: bigint;
  currentLiquidationThreshold?: bigint;
  ltv?: bigint;
  healthFactor?: bigint;
  error?: string;
}

export interface AccountSnapshotRow {
  address: string;
  blockNumber: bigint;
  blockHash: string;
  totalCollateralBase: bigint | null;
  totalDebtBase: bigint | null;
  availableBorrowsBase: bigint | null;
  currentLiquidationThreshold: bigint | null;
  ltv: bigint | null;
  healthFactor: bigint | null;
  error: string | null;
}

export function initDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      name TEXT PRIMARY KEY,
      block_number TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      coverage_start_block TEXT
    );

    CREATE TABLE IF NOT EXISTS borrowers (
      address TEXT PRIMARY KEY,
      first_seen_block TEXT NOT NULL,
      last_seen_block TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_snapshots (
      address TEXT NOT NULL,
      block_number TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      total_collateral_base TEXT,
      total_debt_base TEXT,
      available_borrows_base TEXT,
      current_liquidation_threshold TEXT,
      ltv TEXT,
      health_factor TEXT,
      error TEXT,
      PRIMARY KEY (address, block_number)
    );
  `);

  try {
    db.exec("ALTER TABLE checkpoints ADD COLUMN coverage_start_block TEXT;");
  } catch {
    // Column already exists
  }

  return db;
}

export function getCheckpoint(db: DatabaseSync, name: string): CheckpointRow | null {
  const stmt = db.prepare(
    "SELECT name, block_number, block_hash, coverage_start_block FROM checkpoints WHERE name = ?"
  );
  const row = stmt.get(name) as
    | { name: string; block_number: string; block_hash: string; coverage_start_block?: string | null }
    | undefined;
  if (!row) return null;
  return {
    name: row.name,
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash,
    coverageStartBlock: row.coverage_start_block ? BigInt(row.coverage_start_block) : undefined,
  };
}

export function setCheckpoint(
  db: DatabaseSync,
  name: string,
  blockNumber: bigint,
  blockHash: string,
  coverageStartBlock?: bigint
): void {
  const stmt = db.prepare(`
    INSERT INTO checkpoints (name, block_number, block_hash, coverage_start_block)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      block_number = excluded.block_number,
      block_hash = excluded.block_hash
  `);
  stmt.run(
    name,
    blockNumber.toString(),
    blockHash,
    coverageStartBlock !== undefined ? coverageStartBlock.toString() : null
  );
}

export function upsertBorrower(db: DatabaseSync, address: string, blockNumber: bigint): void {
  const normalized = address.toLowerCase();
  const blockStr = blockNumber.toString();
  const stmt = db.prepare(`
    INSERT INTO borrowers (address, first_seen_block, last_seen_block)
    VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      last_seen_block = CASE
        WHEN CAST(excluded.last_seen_block AS INTEGER) > CAST(borrowers.last_seen_block AS INTEGER)
        THEN excluded.last_seen_block
        ELSE borrowers.last_seen_block
      END
  `);
  stmt.run(normalized, blockStr, blockStr);
}

export function upsertBorrowersBatch(
  db: DatabaseSync,
  borrowers: { address: string; blockNumber: bigint }[],
  checkpoint?: { name: string; blockNumber: bigint; blockHash: string; coverageStartBlock?: bigint }
): void {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(`
      INSERT INTO borrowers (address, first_seen_block, last_seen_block)
      VALUES (?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        last_seen_block = CASE
          WHEN CAST(excluded.last_seen_block AS INTEGER) > CAST(borrowers.last_seen_block AS INTEGER)
          THEN excluded.last_seen_block
          ELSE borrowers.last_seen_block
        END
    `);

    for (const b of borrowers) {
      const addr = b.address.toLowerCase();
      const bStr = b.blockNumber.toString();
      stmt.run(addr, bStr, bStr);
    }

    if (checkpoint) {
      const cpStmt = db.prepare(`
        INSERT INTO checkpoints (name, block_number, block_hash, coverage_start_block)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          block_number = excluded.block_number,
          block_hash = excluded.block_hash
      `);
      cpStmt.run(
        checkpoint.name,
        checkpoint.blockNumber.toString(),
        checkpoint.blockHash,
        checkpoint.coverageStartBlock !== undefined ? checkpoint.coverageStartBlock.toString() : null
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getBorrowers(db: DatabaseSync): string[] {
  const stmt = db.prepare("SELECT address FROM borrowers ORDER BY address ASC");
  const rows = stmt.all() as { address: string }[];
  return rows.map((r) => r.address);
}

export function getBorrowerCount(db: DatabaseSync): bigint {
  const stmt = db.prepare("SELECT COUNT(*) as count FROM borrowers");
  const row = stmt.get() as { count: number | bigint };
  return BigInt(row.count.toString());
}

export function insertAccountSnapshots(db: DatabaseSync, snapshots: AccountSnapshot[]): void {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO account_snapshots (
        address, block_number, block_hash,
        total_collateral_base, total_debt_base,
        available_borrows_base, current_liquidation_threshold,
        ltv, health_factor, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of snapshots) {
      stmt.run(
        s.address.toLowerCase(),
        s.blockNumber.toString(),
        s.blockHash,
        s.totalCollateralBase !== undefined ? s.totalCollateralBase.toString() : null,
        s.totalDebtBase !== undefined ? s.totalDebtBase.toString() : null,
        s.availableBorrowsBase !== undefined ? s.availableBorrowsBase.toString() : null,
        s.currentLiquidationThreshold !== undefined ? s.currentLiquidationThreshold.toString() : null,
        s.ltv !== undefined ? s.ltv.toString() : null,
        s.healthFactor !== undefined ? s.healthFactor.toString() : null,
        s.error || null
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getSnapshotsAtBlock(
  db: DatabaseSync,
  blockNumber: bigint,
  hfBelow?: bigint
): AccountSnapshotRow[] {
  const blockStr = blockNumber.toString();
  const stmt = db.prepare(`
    SELECT
      address, block_number, block_hash,
      total_collateral_base, total_debt_base,
      available_borrows_base, current_liquidation_threshold,
      ltv, health_factor, error
    FROM account_snapshots
    WHERE block_number = ?
    ORDER BY address ASC
  `);

  const rows = stmt.all(blockStr) as {
    address: string;
    block_number: string;
    block_hash: string;
    total_collateral_base: string | null;
    total_debt_base: string | null;
    available_borrows_base: string | null;
    current_liquidation_threshold: string | null;
    ltv: string | null;
    health_factor: string | null;
    error: string | null;
  }[];

  const parsed: AccountSnapshotRow[] = rows.map((r) => ({
    address: r.address,
    blockNumber: BigInt(r.block_number),
    blockHash: r.block_hash,
    totalCollateralBase: r.total_collateral_base !== null ? BigInt(r.total_collateral_base) : null,
    totalDebtBase: r.total_debt_base !== null ? BigInt(r.total_debt_base) : null,
    availableBorrowsBase: r.available_borrows_base !== null ? BigInt(r.available_borrows_base) : null,
    currentLiquidationThreshold:
      r.current_liquidation_threshold !== null ? BigInt(r.current_liquidation_threshold) : null,
    ltv: r.ltv !== null ? BigInt(r.ltv) : null,
    healthFactor: r.health_factor !== null ? BigInt(r.health_factor) : null,
    error: r.error,
  }));

  if (hfBelow !== undefined) {
    return parsed
      .filter((s) => s.healthFactor !== null && s.healthFactor < hfBelow)
      .sort((a, b) => {
        if (a.healthFactor! < b.healthFactor!) return -1;
        if (a.healthFactor! > b.healthFactor!) return 1;
        return 0;
      });
  }

  return parsed;
}

export function getSnapshotBlocks(db: DatabaseSync): bigint[] {
  const stmt = db.prepare("SELECT DISTINCT block_number FROM account_snapshots ORDER BY CAST(block_number AS INTEGER) ASC");
  const rows = stmt.all() as { block_number: string }[];
  return rows.map((r) => BigInt(r.block_number));
}

export function getStatus(db: DatabaseSync): {
  checkpoint: CheckpointRow | null;
  borrowerCount: bigint;
  snapshotBlocks: bigint[];
} {
  return {
    checkpoint: getCheckpoint(db, "discovery"),
    borrowerCount: getBorrowerCount(db),
    snapshotBlocks: getSnapshotBlocks(db),
  };
}
