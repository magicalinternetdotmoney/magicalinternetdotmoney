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
`observation_state` is CP-Swap's on-chain TWAP — our M2 oracle source.

**Atomic triangle:** all three pools (A/B, A/USDC, B/USDC) are created in one tx.
Our wrapper uses instruction introspection (the Instructions sysvar) to assert the
three `initialize` CPIs are present in the same transaction before recording the
config, so a half-built triangle can't exist.

## Status

- ✅ surfpool fork + CP-Swap cloning verified
- ✅ economics: "mint the loser into both pools" + user-specified leverage, unit-tested
- ⏳ next: CP-Swap `initialize` ×3 CPI + introspection guard; `deposit` add-liquidity;
  `rebalance` swap-the-loser-into-both-pools; on-chain TWAP read from `observation_state`
- ⏳ then: TS integration tests on the fork; Pinocchio port for mainnet deploy
