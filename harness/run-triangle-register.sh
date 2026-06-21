#!/usr/bin/env bash
# Boot surfpool fork, deploy leverage_engine, run the positive-path triangle test.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${SURFPOOL_DATASOURCE_RPC_URL:-https://api.mainnet-beta.solana.com}"
DEPLOYER="$HOME/.config/solana/id.json"; FORK_URL="http://localhost:8899"
ln -sfn ~/.local/share/solana/install/releases/3.1.10/solana-release ~/.local/share/solana/install/active_release
cleanup() { pkill -9 -f surfpool 2>/dev/null || true; }; trap cleanup EXIT; cleanup; sleep 1
PUB="$(solana address -k "$DEPLOYER")"
echo "==> booting surfpool fork"
surfpool start --rpc-url "$RPC" --port 8899 --slot-time 100 --no-tui --no-deploy -y --airdrop "$PUB" >/tmp/surfpool.log 2>&1 &
sleep 14
solana airdrop 1000 "$PUB" -u "$FORK_URL" >/dev/null 2>&1 || true
echo "==> deploy leverage_engine"
solana program deploy target/deploy/leverage_engine.so --program-id target/deploy/leverage_engine-keypair.json -u "$FORK_URL" -k "$DEPLOYER" 2>&1 | tail -1
echo "==> run positive-path triangle test"
ANCHOR_PROVIDER_URL="$FORK_URL" ANCHOR_WALLET="$DEPLOYER" yarn run ts-mocha -p ./tsconfig.json -t 1000000 harness/tests/triangle-register.ts
