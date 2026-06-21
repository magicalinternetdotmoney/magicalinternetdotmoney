#!/usr/bin/env bash
# Start a surfpool mainnet fork for the leverage-engine harness.
#
# surfpool forks mainnet from a datasource RPC and lazily clones any account a
# transaction touches (the Raydium CP-Swap program, amm_config, mints, etc.), and
# auto-deploys the workspace Anchor programs. So we get a real CP-Swap to CPI into
# without dumping/replaying fixtures by hand.
#
# Set a fast datasource (recommended — your Helius key) via env:
#   export SURFPOOL_DATASOURCE_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..."
# Falls back to public mainnet-beta (rate-limited) if unset.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${SURFPOOL_DATASOURCE_RPC_URL:-https://api.mainnet-beta.solana.com}"

# Dev wallet to airdrop on the fork (does NOT touch real mainnet SOL).
# Set DEV_WALLET_KEY to a local keypair path, or ANCHOR_WALLET from ~/.config/solana/id.json.
DEV_WALLET_KEY="${DEV_WALLET_KEY:-${ANCHOR_WALLET:-}}"
DEV_WALLET=""
if [ -n "$DEV_WALLET_KEY" ] && [ -f "$DEV_WALLET_KEY" ]; then
  DEV_WALLET="$(solana address -k "$DEV_WALLET_KEY" 2>/dev/null || true)"
fi
AIRDROP_ARGS=()
[ -n "$DEV_WALLET" ] && AIRDROP_ARGS=(--airdrop "$DEV_WALLET")

echo "surfpool: forking mainnet via $RPC"
echo "airdropping: ${DEV_WALLET:-<none>}"
exec surfpool start \
  --rpc-url "$RPC" \
  --port 8899 \
  --slot-time 100 \
  --no-tui \
  "${AIRDROP_ARGS[@]}"
