# @nexus-zkvm/agent

Simulate-only decision pipeline for Nexus-ZKVM (Phase 4).

## Overview
Evaluates arbitrage opportunities at pinned, finalized Arbitrum One blocks using a local Anvil fork simulation.
**Simulate-only**: Never submits any live transaction to the remote chain. All state-mutating calls are strictly enforced to loopback (`127.0.0.1` / `localhost`).

## Commands
```bash
# Evaluate an opportunity at block N
node src/cli.ts decide --block 521208669 [--head <H>]

# Inspect recorded decisions
node src/cli.ts show [--block <N>]
```

## Testing
```bash
# Unit tests (offline)
npm test

# Integration tests (live RPC + local Anvil)
# Optionally set ANVIL_BIN to custom anvil executable path (defaults to "anvil" on PATH)
npm run test:integration
```
