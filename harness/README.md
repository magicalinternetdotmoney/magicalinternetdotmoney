# Mainnet-fork harness (surfpool + Raydium CP-Swap)

Runs the `leverage-engine` program against a **mainnet fork** so we CPI into the
real Raydium CP-Swap (CPMM) program instead of a mock. `surfpool` lazily clones
any account a transaction touches from the datasource RPC, and auto-deploys the
workspace Anchor programs.

## Run

```bash
# fast datasource (recommended): your Helius key — kept out of git
export SURFPOOL_DATASOURCE_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..."
./harness/run-surfpool.sh          # forks mainnet on http://localhost:8899
```

Verified: the fork reports `solana-core 3.1.6`, clones
`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` (executable) and
`amm_config[0]` on first access, and airdrops the dev wallet.

## Artifacts

| file | what |
|---|---|
| `artifacts/raydium_cp_swap.json` | live on-chain IDL (`anchor idl fetch`) — 14 ix incl. `initialize`, `deposit`, `withdraw`, `swap_base_input/output` |
| `artifacts/raydium_cp_swap.so` | dumped program binary (gitignored; surfpool auto-clones it) |
| `fixtures.json` | resolved mainnet addresses (program, amm_config PDAs, authority PDA, PDA seeds, USDC) |

## CP-Swap `initialize` (what we CPI three times)

Args: `init_amount_0`, `init_amount_1`, `open_time`. 20 accounts; the pool-derived
ones are PDAs (`pool_state`, `lp_mint`, `token_{0,1}_vault`, `observation_state`).
`observation_state` holds CP-Swap's on-chain TWAP accumulator — **not wired into
rebalance today** (see Status).

**Atomic triangle:** all three pools (A/B, A/USDC, B/USDC) are created in one tx.
Our wrapper uses instruction introspection (the Instructions sysvar) to assert the
three `initialize` CPIs are present in the same transaction before recording the
config, so a half-built triangle can't exist.

## Status

**Mainnet target:** `pinocchio-programs/leverage-engine` (not the Anchor crate in
`programs/leverage-engine`, which is still M1 with protocol-held reserves).

| Area | Status |
|------|--------|
| surfpool fork + CP-Swap cloning | ✅ verified |
| economics (`leverage-math`) | ✅ unit-tested |
| CP-Swap `initialize` ×3 + `register_triangle` introspection | ✅ Pinocchio + browser launch |
| CP-Swap `deposit` / `withdraw` CPI (real pool vaults) | ✅ Pinocchio mainnet |
| `rebalance` / transfer-hook (mint loser into **Raydium vaults**) | ✅ oracle-free via implied A/B ratio from vault balances |
| TS integration tests on fork | ✅ `pinocchio-deposit`, `pinocchio-rebalance`, `pinocchio-triangle`, `pinocchio-hook`, … |
| Pinocchio mainnet deploy | ✅ `J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe` |
| Raydium `observation_state` TWAP as rebalance input | ⏳ not implemented — ratio comes from live vault balances, not TWAP |
| Optional PumpSwap oracle (MEME / non-Raydium underlying) | ✅ partial — vault read on rebalance; Raydium USDC anchor still primary |
| Anchor `programs/leverage-engine` CP-Swap port | ⏳ stale M1 reference only |