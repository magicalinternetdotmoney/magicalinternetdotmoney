#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${SURFPOOL_DATASOURCE_RPC_URL:-https://api.mainnet-beta.solana.com}"
DEPLOYER="$HOME/.config/solana/id.json"; FORK_URL="http://localhost:8899"
ln -sfn ~/.local/share/solana/install/releases/3.1.10/solana-release ~/.local/share/solana/install/active_release
cleanup() { pkill -9 -f surfpool 2>/dev/null || true; }; trap cleanup EXIT; cleanup; sleep 1
PUB="$(solana address -k "$DEPLOYER")"
echo "==> build pinocchio"
cargo build-sbf --manifest-path pinocchio-programs/leverage-engine/Cargo.toml 2>&1 | grep -iE "Finished|error" | tail -1
echo "==> booting surfpool fork"
surfpool start --rpc-url "$RPC" --port 8899 --slot-time 100 --no-tui --no-deploy -y --airdrop "$PUB" >/tmp/surfpool.log 2>&1 &
sleep 14
solana airdrop 100 "$PUB" -u "$FORK_URL" >/dev/null 2>&1 || true
echo "==> deploy pinocchio program"
solana program deploy target/deploy/leverage_engine_pinocchio.so --program-id target/deploy/leverage_engine_pinocchio-keypair.json -u "$FORK_URL" -k "$DEPLOYER" 2>&1 | tail -1
echo "==> run pinocchio CPI test"
ANCHOR_PROVIDER_URL="$FORK_URL" ANCHOR_WALLET="$DEPLOYER" yarn run ts-mocha -p ./tsconfig.json -t 1000000 harness/tests/pinocchio-cpi.ts
