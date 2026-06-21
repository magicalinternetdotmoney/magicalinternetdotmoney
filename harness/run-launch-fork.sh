#!/usr/bin/env bash
# Full launch on a surfpool mainnet fork (USDC stand-in). Proves the whole sequence
# before spending real money. Mainnet launch uses run-launch-mainnet.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${SURFPOOL_DATASOURCE_RPC_URL:-https://api.mainnet-beta.solana.com}"
DEPLOYER="$HOME/.config/solana/id.json"; FORK_URL="http://localhost:8899"
ln -sfn ~/.local/share/solana/install/releases/3.1.10/solana-release ~/.local/share/solana/install/active_release
cleanup() { pkill -9 -f surfpool 2>/dev/null || true; }; trap cleanup EXIT; cleanup; sleep 1
PUB="$(solana address -k "$DEPLOYER")"
echo "==> build"; cargo build-sbf --manifest-path pinocchio-programs/leverage-engine/Cargo.toml 2>&1 | grep -iE "Finished|error" | tail -1
echo "==> boot"; surfpool start --rpc-url "$RPC" --port 8899 --slot-time 100 --no-tui --no-deploy -y --airdrop "$PUB" >/tmp/surfpool.log 2>&1 &
sleep 14
solana airdrop 100 "$PUB" -u "$FORK_URL" >/dev/null 2>&1 || true
# program is already live on mainnet → surfpool clones it; (re)deploy is best-effort.
echo "==> program (cloned from mainnet fork; deploy best-effort)"; solana program deploy target/deploy/leverage_engine_pinocchio.so --program-id target/deploy/leverage_engine_pinocchio-keypair.json -u "$FORK_URL" -k "$DEPLOYER" 2>&1 | tail -1 || echo "  using cloned mainnet program"
echo "==> launch (fork, USDC stand-in)"
ANCHOR_PROVIDER_URL="$FORK_URL" ANCHOR_WALLET="$DEPLOYER" \
  L_MINT_USDC=1 L_MINT_MEME=1 L_MEME_PER_POOL="${L_MEME_PER_POOL:-1000000000}" \
  L_ASSET_USD="${L_ASSET_USD:-72}" L_SEED_USDC="${L_SEED_USDC:-10}" L_LEV="${L_LEV:-5}" L_SYM="${L_SYM:-3xSOL}" L_NAME="${L_NAME:-3x SOL LP}" \
  node_modules/.bin/ts-node harness/launch.ts
