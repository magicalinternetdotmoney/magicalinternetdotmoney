#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
anchor test --skip-deploy --skip-build -- --grep "pinocchio price crawl" "$@" \
  harness/tests/pinocchio-price-crawl.ts 2>/dev/null \
  || npx ts-mocha -p ./tsconfig.json -t 600000 harness/tests/pinocchio-price-crawl.ts "$@"