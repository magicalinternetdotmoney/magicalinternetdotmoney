#!/usr/bin/env bash
# Boot a surfpool mainnet fork, deploy the workspace programs to it, and run the
# leverage-engine integration tests against real (cloned) Raydium CP-Swap + USDC.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${SURFPOOL_DATASOURCE_RPC_URL:-https://api.mainnet-beta.solana.com}"
DEPLOYER="$HOME/.config/solana/id.json"
FORK_URL="http://localhost:8899"

# Solana 3.1.10 must stay active (see .claude/wiki.md).
ln -sfn ~/.local/share/solana/install/releases/3.1.10/solana-release \
        ~/.local/share/solana/install/active_release

cleanup() { pkill -9 -f surfpool 2>/dev/null || true; }
trap cleanup EXIT
cleanup; sleep 1

echo "==> booting surfpool fork (datasource: ${RPC%%\?*}...)"
DEPLOYER_PUB="$(solana address -k "$DEPLOYER")"
surfpool start --rpc-url "$RPC" --port 8899 --slot-time 100 --no-tui --no-deploy -y \
  --airdrop "$DEPLOYER_PUB" >/tmp/surfpool.log 2>&1 &
sleep 14

echo "==> airdrop + deploy"
solana airdrop 100 "$DEPLOYER_PUB" -u "$FORK_URL" >/dev/null 2>&1 || true
solana program deploy target/deploy/leverage_engine.so \
  --program-id target/deploy/leverage_engine-keypair.json \
  -u "$FORK_URL" -k "$DEPLOYER" 2>&1 | tail -2

echo "==> run integration tests"
ANCHOR_PROVIDER_URL="$FORK_URL" ANCHOR_WALLET="$DEPLOYER" \
  yarn run ts-mocha -p ./tsconfig.json -t 1000000 harness/tests/integration.ts
