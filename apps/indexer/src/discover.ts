import type { PublicClient } from "viem";
import { type DatabaseSync } from "node:sqlite";
import { POOL, borrowEventAbi, DEFAULT_LOG_CHUNK_BLOCKS, redactUrls } from "./config.ts";
import { getCheckpoint, upsertBorrowersBatch } from "./db.ts";

export interface Chunk {
  from: bigint;
  to: bigint;
}

export function generateChunks(fromBlock: bigint, toBlock: bigint, chunkSize: bigint): Chunk[] {
  if (chunkSize <= 0n) {
    throw new Error("chunkSize must be greater than 0");
  }
  if (fromBlock > toBlock) {
    return [];
  }

  const chunks: Chunk[] = [];
  let currentFrom = fromBlock;

  while (currentFrom <= toBlock) {
    let currentTo = currentFrom + chunkSize - 1n;
    if (currentTo > toBlock) {
      currentTo = toBlock;
    }
    chunks.push({ from: currentFrom, to: currentTo });
    currentFrom = currentTo + 1n;
  }

  return chunks;
}

export async function discover(
  fromBlock: bigint,
  toBlock: bigint,
  db: DatabaseSync,
  clients: { discoveryClient: PublicClient; stateClient: PublicClient },
  chunkSize: bigint = DEFAULT_LOG_CHUNK_BLOCKS,
  onProgress?: (chunk: Chunk, discoveredCount: number) => void
): Promise<{ totalDiscovered: number; chunksProcessed: number }> {
  // 1. Refuse if toBlock > finalized
  const finalizedBlock = await clients.stateClient.getBlock({ blockTag: "finalized" });
  if (toBlock > finalizedBlock.number) {
    throw new Error(
      `Refusing to discover unfinalized block: requested toBlock ${toBlock} > finalized block ${finalizedBlock.number}`
    );
  }

  // 2. Restart & integrity check (D-021)
  let actualFrom = fromBlock;
  const storedCheckpoint = getCheckpoint(db, "discovery");
  if (storedCheckpoint) {
    const chainBlock = await clients.stateClient.getBlock({
      blockNumber: storedCheckpoint.blockNumber,
    });
    if (chainBlock.hash.toLowerCase() !== storedCheckpoint.blockHash.toLowerCase()) {
      throw new Error(
        `Checkpoint mismatch: stored hash ${storedCheckpoint.blockHash} for block ${storedCheckpoint.blockNumber} does not match chain hash ${chainBlock.hash}. Halting.`
      );
    }

    // Gap check: refuse if fromBlock > checkpoint.blockNumber + 1
    const nextExpected = storedCheckpoint.blockNumber + 1n;
    if (fromBlock > nextExpected) {
      throw new Error(
        `Discovery gap refused: requested fromBlock ${fromBlock} is greater than checkpoint + 1 (${nextExpected}). An unindexed gap of ${fromBlock - nextExpected} blocks would exist between ${nextExpected} and ${fromBlock - 1n}.`
      );
    }

    if (actualFrom <= storedCheckpoint.blockNumber) {
      actualFrom = storedCheckpoint.blockNumber + 1n;
    }
  }

  if (actualFrom > toBlock) {
    return { totalDiscovered: 0, chunksProcessed: 0 };
  }

  const chunks = generateChunks(actualFrom, toBlock, chunkSize);
  let totalDiscovered = 0;
  let chunksProcessed = 0;

  for (const chunk of chunks) {
    let logs: any = null;
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      try {
        attempts++;
        logs = await clients.discoveryClient.getLogs({
          address: POOL,
          event: borrowEventAbi,
          fromBlock: chunk.from,
          toBlock: chunk.to,
        });
        break;
      } catch (err: any) {
        if (attempts >= maxAttempts) {
          throw new Error(
            `Failed to fetch logs for chunk [${chunk.from}, ${chunk.to}] after ${maxAttempts} attempts: ${redactUrls(err.message || String(err))}`
          );
        }
        // Exponential backoff
        const delayMs = 250 * Math.pow(2, attempts - 1);
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }

    const discoveredBorrowers: { address: string; blockNumber: bigint }[] = [];
    if (logs && Array.isArray(logs)) {
      for (const log of logs) {
        if (log.args && log.args.onBehalfOf) {
          discoveredBorrowers.push({
            address: log.args.onBehalfOf.toLowerCase(),
            blockNumber: BigInt(log.blockNumber.toString()),
          });
        }
      }
    }

    // Read block hash of chunk.to from state client
    const chunkToBlock = await clients.stateClient.getBlock({ blockNumber: chunk.to });

    upsertBorrowersBatch(db, discoveredBorrowers, {
      name: "discovery",
      blockNumber: chunk.to,
      blockHash: chunkToBlock.hash,
      coverageStartBlock: storedCheckpoint ? storedCheckpoint.coverageStartBlock : fromBlock,
    });

    totalDiscovered += discoveredBorrowers.length;
    chunksProcessed++;

    if (onProgress) {
      onProgress(chunk, discoveredBorrowers.length);
    }
  }

  return { totalDiscovered, chunksProcessed };
}
