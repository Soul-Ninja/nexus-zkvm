# Nexus-ZKVM — Borrower Indexer (`apps/indexer`)

A minimal, deterministic Aave V3 borrower indexer targeting Arbitrum One (Phase 1).

## Objective

Discovers Aave V3 accounts that open debt (`Borrow` events) and takes batched, deterministic health-factor snapshots via Multicall3 at pinned **finalized** blocks.

## Architecture

- **Runtime:** Node.js 24 LTS running `.ts` files directly via native type stripping (no compilation step, no `tsc` artifacts).
- **Library:** `viem` (pinned exact version `2.57.19`) for Multicall3 and event decoding.
- **Storage:** Built-in `node:sqlite` (`DatabaseSync`). Stored at `data/indexer.sqlite` (git-ignored).
- **Numeric Precision:** All amounts, health factors, and block numbers are held strictly as `bigint` in memory and stored as decimal strings in SQLite. No binary floating-point numbers are used.
- **Dual-RPC Model (D-019):**
  - `DISCOVERY_RPC_URL`: Official public Arbitrum endpoint (`https://arb1.arbitrum.io/rpc`) for `eth_getLogs` discovery over chunked block ranges.
  - `ARBITRUM_RPC_URL`: Primary archive endpoint (from `contracts/.env`) for all state reads, block headers, and Multicall3 queries.

## Commands

```bash
# Display indexer checkpoint, borrower counts, and snapshot blocks
node src/cli.ts status

# Discover borrowers from Aave V3 Borrow events over a block range
node src/cli.ts discover --from <block> --to <block|finalized>

# Take batched getUserAccountData snapshots for known borrowers
node src/cli.ts snapshot --block <block|finalized>

# List at-risk positions below a health factor threshold (default 1.05e18 WAD)
node src/cli.ts at-risk --block <block> [--below <hf_wad>]
```

## Testing

```bash
# Run unit tests (6 offline tests: chunking, decimal roundtrip, at-risk sorting, idempotency, restart mismatch, finalized guard)
npm test

# Run integration tests against pinned Arbitrum One blocks (Tests 7, 8, 9, 10 + throughput measurement)
npm run test:integration
```
