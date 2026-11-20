#!/usr/bin/env bash
cd "$(dirname "$0")/.."
grep -rlE 'alchemy\.com/v2/[A-Za-z0-9]|alch_[A-Za-z0-9]|PRIVATE_KEY=0x[0-9a-fA-F]|MNEMONIC=[A-Za-z"]' \
  apps contracts scripts \
  --exclude='.env' --exclude='*.env' --exclude-dir=node_modules --exclude-dir=lib \
  --exclude-dir=out --exclude-dir=cache --exclude-dir=data || true
