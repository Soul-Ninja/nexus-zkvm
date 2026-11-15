import type { PublicClient } from "viem";
import { type DatabaseSync } from "node:sqlite";
import { POOL, poolAccountDataAbi, redactUrls } from "./config.ts";
import { getBorrowers, insertAccountSnapshots, type AccountSnapshot } from "./db.ts";

export async function snapshot(
  blockNumber: bigint,
  db: DatabaseSync,
  stateClient: PublicClient,
  batchSize = 200,
  onProgress?: (processed: number, total: number) => void
): Promise<{ snapshotsTaken: number; failedCalls: number }> {
  // 1. Verify blockNumber <= finalized
  const finalizedBlock = await stateClient.getBlock({ blockTag: "finalized" });
  if (blockNumber > finalizedBlock.number) {
    throw new Error(
      `Refusing to snapshot unfinalized block: requested block ${blockNumber} > finalized block ${finalizedBlock.number}`
    );
  }

  // 2. Read block header
  const targetBlock = await stateClient.getBlock({ blockNumber });
  const blockHash = targetBlock.hash;

  // 3. Get known borrowers
  const borrowers = getBorrowers(db);
  if (borrowers.length === 0) {
    return { snapshotsTaken: 0, failedCalls: 0 };
  }

  const allSnapshots: AccountSnapshot[] = [];
  let failedCalls = 0;

  for (let i = 0; i < borrowers.length; i += batchSize) {
    const batch = borrowers.slice(i, i + batchSize);

    const calls = batch.map((address) => ({
      address: POOL,
      abi: poolAccountDataAbi,
      functionName: "getUserAccountData" as const,
      args: [address as `0x${string}`],
    }));

    try {
      const results = await stateClient.multicall({
        contracts: calls,
        blockNumber,
        allowFailure: true,
      });

      for (let j = 0; j < batch.length; j++) {
        const addr = batch[j];
        const res = results[j];

        if (res.status === "success" && Array.isArray(res.result)) {
          const [
            totalCollateralBase,
            totalDebtBase,
            availableBorrowsBase,
            currentLiquidationThreshold,
            ltv,
            healthFactor,
          ] = res.result as [bigint, bigint, bigint, bigint, bigint, bigint];

          allSnapshots.push({
            address: addr,
            blockNumber,
            blockHash,
            totalCollateralBase,
            totalDebtBase,
            availableBorrowsBase,
            currentLiquidationThreshold,
            ltv,
            healthFactor,
          });
        } else {
          failedCalls++;
          allSnapshots.push({
            address: addr,
            blockNumber,
            blockHash,
            error: redactUrls(res.error?.message || "multicall call failed"),
          });
        }
      }
    } catch (batchErr: any) {
      failedCalls += batch.length;
      for (const addr of batch) {
        allSnapshots.push({
          address: addr,
          blockNumber,
          blockHash,
          error: redactUrls(batchErr.message || String(batchErr)),
        });
      }
    }

    if (onProgress) {
      onProgress(Math.min(i + batchSize, borrowers.length), borrowers.length);
    }
  }

  insertAccountSnapshots(db, allSnapshots);

  return {
    snapshotsTaken: allSnapshots.length,
    failedCalls,
  };
}
