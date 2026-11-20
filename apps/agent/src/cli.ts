import { runDecisionPipeline, getDatabase } from "./pipeline.ts";
import { redactUrls } from "./config.ts";

function parseArgs(args: string[]): {
  command: string;
  subcommand?: string;
  block?: bigint;
  head?: bigint;
  policy?: string;
  db?: string;
  from?: bigint;
  to?: bigint;
  chunkSize?: bigint;
  csv?: string;
} {
  const command = args[0] || "help";
  let subcommand: string | undefined;
  let block: bigint | undefined;
  let head: bigint | undefined;
  let policy: string | undefined;
  let db: string | undefined;
  let from: bigint | undefined;
  let to: bigint | undefined;
  let chunkSize: bigint | undefined;
  let csv: string | undefined;

  let startIdx = 1;
  if (command === "dataset" && args.length > 1) {
    subcommand = args[1];
    startIdx = 2;
  }

  for (let i = startIdx; i < args.length; i++) {
    if (args[i] === "--block" && i + 1 < args.length) {
      block = BigInt(args[++i]);
    } else if (args[i] === "--head" && i + 1 < args.length) {
      head = BigInt(args[++i]);
    } else if (args[i] === "--policy" && i + 1 < args.length) {
      policy = args[++i];
    } else if (args[i] === "--db" && i + 1 < args.length) {
      db = args[++i];
    } else if (args[i] === "--from" && i + 1 < args.length) {
      from = BigInt(args[++i]);
    } else if (args[i] === "--to" && i + 1 < args.length) {
      to = BigInt(args[++i]);
    } else if (args[i] === "--chunk-size" && i + 1 < args.length) {
      chunkSize = BigInt(args[++i]);
    } else if (args[i] === "--csv" && i + 1 < args.length) {
      csv = args[++i];
    }
  }

  return { command, subcommand, block, head, policy, db, from, to, chunkSize, csv };
}

async function main() {
  const { command, subcommand, block, head, policy, db, from, to, chunkSize, csv } = parseArgs(process.argv.slice(2));

  if (command === "decide") {
    if (block === undefined) {
      console.error("Error: --block <block_number> is required for decide");
      process.exit(1);
    }

    const decision = await runDecisionPipeline({
      blockNumber: block,
      headBlockNumber: head,
      policyPath: policy,
      dbPath: db
    });

    console.log("=== Decision Summary ===");
    console.log("Verdict:", decision.verdict);
    if (decision.reason) {
      console.log("Reason:", decision.reason);
    }
    console.log("Opportunity ID:", decision.opportunity_id);
    console.log("Block Number:", decision.block_number);
    console.log("Direction:", `Buy ${decision.pool_buy} -> Sell ${decision.pool_sell}`);
    console.log("Gap (bps):", decision.gap_bps);
    console.log("Trade Size (raw):", decision.size_raw);
    console.log("Sim Profit (raw):", decision.sim_profit_raw);
    console.log("L2 Gas:", decision.l2_gas, "| L1 Gas:", decision.l1_gas);
    console.log("Gas Cost Wei:", decision.gas_cost_wei, "| Gas Cost USDC (raw):", decision.gas_cost_usdc_raw);
    console.log("Intent Hash:", decision.intent_hash);
    console.log("Policy Hash:", decision.policy_hash);
  } else if (command === "show") {
    const database = getDatabase(db);
    let rows: any[];
    if (block !== undefined) {
      rows = database.prepare("SELECT * FROM decisions WHERE block_number = ? ORDER BY created_at DESC").all(block.toString());
    } else {
      rows = database.prepare("SELECT * FROM decisions ORDER BY created_at DESC").all();
    }

    console.log(`=== Recorded Decisions (${rows.length}) ===`);
    for (const r of rows) {
      console.log(`[${r.created_at}] Block: ${r.block_number} | Verdict: ${r.verdict}${r.reason ? ` (${r.reason})` : ""} | Size: ${r.size_raw} | Profit: ${r.sim_profit_raw} | Intent: ${r.intent_hash.slice(0, 10)}...`);
    }
  } else if (command === "dataset") {
    const { buildDataset, crosscheckDataset } = await import("./dataset.ts");
    if (subcommand === "build") {
      const res = await buildDataset({
        fromBlock: from,
        toBlock: to,
        chunkSize: chunkSize,
        outCsv: csv
      });
      console.log("=== Dataset Build Complete ===");
      console.log(`Total Chunks: ${res.totalChunks}`);
      console.log(`Total Logs: ${res.totalLogs}`);
      console.log(`Total Candidates: ${res.totalCandidates}`);
      console.log(`Sampled Candidates: ${res.sampledCandidates} (Rate: ${res.samplingRate})`);
      console.log(`Positives: ${res.positives}`);
      console.log(`CSV: ${res.csvPath}`);
    } else if (subcommand === "crosscheck") {
      const results = await crosscheckDataset(csv);
      console.log("=== Crosscheck Results ===");
      for (const r of results) {
        console.log(
          `Block ${r.blockNumber} (${r.pair}): Dataset size ${r.datasetSize}, profit ${r.datasetProfit} (y=${r.datasetY}) vs Pipeline size ${r.pipelineSize}, profit ${r.pipelineProfit} (${r.pipelineVerdict}) -> Size Match: ${r.sizeMatch}, Profit Match: ${r.profitMatch}, Verdict Match: ${r.verdictMatch}`
        );
      }
      const allMatched = results.every((r) => r.profitMatch && r.verdictMatch && r.sizeMatch);
      if (!allMatched) {
        console.error("Crosscheck failed: mismatch between dataset and pipeline");
        process.exit(1);
      }
      console.log("All crosschecks passed successfully.");
    } else {
      console.error("Unknown dataset subcommand. Usage: dataset <build|crosscheck>");
      process.exit(1);
    }
  } else {
    console.log("Usage: node src/cli.ts <decide|show|dataset build|dataset crosscheck>");
  }
}

main().catch((err) => {
  const safeMessage = redactUrls(err?.message || String(err));
  console.error("Fatal:", safeMessage);
  process.exit(1);
});
