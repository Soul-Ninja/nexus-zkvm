import path from "node:path";
import { initDb, getStatus, getSnapshotsAtBlock } from "./db.ts";
import { createClients, DEFAULT_DISPLAY_HF_BELOW, redactUrls } from "./config.ts";
import { discover } from "./discover.ts";
import { snapshot } from "./snapshot.ts";

export function formatWad4(wad: bigint): string {
  const WAD = 1000000000000000000n;
  const integerPart = wad / WAD;
  const remainder = wad >= 0n ? wad % WAD : (-wad) % WAD;
  const frac = remainder / 100000000000000n; // 4 decimals (1e14)
  return `${integerPart}.${frac.toString().padStart(4, "0")}`;
}

export function formatBaseCurrency(val: bigint): string {
  const UNIT = 100000000n; // 1e8
  const integerPart = val / UNIT;
  const remainder = val >= 0n ? val % UNIT : (-val) % UNIT;
  const frac = remainder / 10000n; // 4 decimals (1e4)
  return `${integerPart}.${frac.toString().padStart(4, "0")}`;
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

export async function runCli(args: string[], customDbPath?: string): Promise<void> {
  const dbPath = customDbPath || path.resolve(process.cwd(), "data/indexer.sqlite");
  const db = initDb(dbPath);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
Nexus-ZKVM Borrower Indexer (Aave V3, Arbitrum One)

Usage:
  node src/cli.ts discover --from <block> --to <block|finalized>
  node src/cli.ts snapshot --block <block|finalized>
  node src/cli.ts at-risk --block <block> [--below <hf_wad>]
  node src/cli.ts status
`);
    return;
  }

  if (command === "status") {
    const status = getStatus(db);
    console.log("=== Indexer Status ===");
    console.log(`Database: ${dbPath}`);
    if (status.checkpoint) {
      const start =
        status.checkpoint.coverageStartBlock !== undefined
          ? status.checkpoint.coverageStartBlock.toString()
          : "unknown";
      const end = status.checkpoint.blockNumber.toString();
      console.log(`coverage: blocks ${start}..${end}`);
      console.log(
        `Checkpoint (${status.checkpoint.name}): block ${status.checkpoint.blockNumber} (hash: ${status.checkpoint.blockHash})`
      );
    } else {
      console.log("coverage: None");
      console.log("Checkpoint: None");
    }
    console.log(`Known Borrowers: ${status.borrowerCount}`);
    if (status.snapshotBlocks.length > 0) {
      console.log(`Snapshots available at blocks: ${status.snapshotBlocks.join(", ")}`);
    } else {
      console.log("Snapshots: None");
    }
    return;
  }

  if (command === "discover") {
    const fromStr = parseArg(args, "--from");
    const toStr = parseArg(args, "--to");

    if (!fromStr || !toStr) {
      throw new Error("Missing required arguments: --from <block> --to <block|finalized>");
    }

    const { stateClient, discoveryClient } = await createClients();

    let toBlock: bigint;
    if (toStr === "finalized") {
      const b = await stateClient.getBlock({ blockTag: "finalized" });
      toBlock = b.number;
    } else {
      toBlock = BigInt(toStr);
    }

    const fromBlock = BigInt(fromStr);

    console.log(`Starting discovery from block ${fromBlock} to ${toBlock}...`);
    const result = await discover(fromBlock, toBlock, db, { stateClient, discoveryClient });
    console.log(`Discovery complete: ${result.totalDiscovered} borrow events found across ${result.chunksProcessed} chunks.`);
    return;
  }

  if (command === "snapshot") {
    const blockStr = parseArg(args, "--block");
    if (!blockStr) {
      throw new Error("Missing required argument: --block <block|finalized>");
    }

    const { stateClient } = await createClients();

    let targetBlock: bigint;
    if (blockStr === "finalized") {
      const b = await stateClient.getBlock({ blockTag: "finalized" });
      targetBlock = b.number;
    } else {
      targetBlock = BigInt(blockStr);
    }

    console.log(`Taking snapshot for known borrowers at block ${targetBlock}...`);
    const result = await snapshot(targetBlock, db, stateClient);
    console.log(`Snapshot complete: ${result.snapshotsTaken} accounts recorded (${result.failedCalls} multicall failures).`);
    return;
  }

  if (command === "at-risk") {
    const blockStr = parseArg(args, "--block");
    if (!blockStr) {
      throw new Error("Missing required argument: --block <block>");
    }

    const blockNumber = BigInt(blockStr);
    const belowStr = parseArg(args, "--below");
    const hfBelow = belowStr ? BigInt(belowStr) : DEFAULT_DISPLAY_HF_BELOW;

    const rows = getSnapshotsAtBlock(db, blockNumber, hfBelow);

    console.log(`=== At-Risk Positions at Block ${blockNumber} (HF < ${hfBelow} / ${formatWad4(hfBelow)}) ===`);
    if (rows.length === 0) {
      console.log("No accounts found below display threshold.");
    } else {
      console.log(
        `${"Address".padEnd(44)} | ${"Health Factor".padEnd(25)} | ${"Debt (USD)".padEnd(14)} | ${"Collateral (USD)".padEnd(18)} | Block Hash`
      );
      console.log("-".repeat(130));

      for (const r of rows) {
        const hfDisplay =
          r.healthFactor !== null
            ? `${formatWad4(r.healthFactor)} (${r.healthFactor})`
            : (r.error || "ERROR");
        const debtDisplay = r.totalDebtBase !== null ? formatBaseCurrency(r.totalDebtBase) : "N/A";
        const colDisplay = r.totalCollateralBase !== null ? formatBaseCurrency(r.totalCollateralBase) : "N/A";

        console.log(
          `${r.address.padEnd(44)} | ${hfDisplay.padEnd(25)} | ${debtDisplay.padEnd(14)} | ${colDisplay.padEnd(18)} | ${r.blockHash}`
        );
      }
    }

    // Print error rows at this block
    const allRows = getSnapshotsAtBlock(db, blockNumber);
    const errorRows = allRows.filter((r) => r.error !== null);
    if (errorRows.length > 0) {
      console.log(
        `\nError rows at block ${blockNumber}: ${errorRows.length} (${errorRows.map((r) => r.address).join(", ")})`
      );
    } else {
      console.log(`\nError rows at block ${blockNumber}: 0`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

// Execute if invoked directly from CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${redactUrls(err.message || String(err))}`);
    process.exit(1);
  });
}
