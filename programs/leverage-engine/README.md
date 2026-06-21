# leverage-engine — Anchor reference (M1 only)

> **Not the mainnet program.** Production deploys use
> [`pinocchio-programs/leverage-engine`](../../pinocchio-programs/leverage-engine/)
> (`J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe`), which CPIs into **real Raydium
> CP-Swap pool vaults** for deposit, withdraw, and rebalance. **This Anchor crate is
> a smaller IDL-driven reference** kept for surfpool dev and math shims — it still uses
> **protocol-held token accounts** as reserves (M1).

A faithful, on-chain implementation of the design doc: a **Token-2022 receipt token whose transfer
hook drives elastic "mint the loser" rebalancing** of a synthetic pair (`MINTA` / `MINTB`), with a
triangle of three **Raydium CP-Swap** pools as the price surface.

> ⚠️ **This is an experimental, high-risk primitive.** "Mint the loser" has no restoring force:
> minting more of the underperforming synthetic into a constant-product reserve pushes its price
> toward zero, and arbitrage drains the USDC anchor pools. The per-rebalance cap, circuit breaker,
> and elastic leverage decay *bound* the bleed; they do not eliminate it. Do not deploy with real
> value without an audit and a hard understanding of the failure modes.

## How it maps to the design doc

| Design doc concept | This Anchor crate (M1) | Pinocchio mainnet |
|---|---|---|
| Receipt token (Token-2022, transfer hooks) | ✅ | ✅ |
| "Transferrer pays" rebalancing | ✅ | ✅ |
| Elastic mint/burn, 2x–5x variable leverage | ✅ | ✅ |
| "Mint the loser" | ✅ | ✅ |
| Three CPMM pools (triangle) | pool ids in `Config` only | ✅ real vault CPI |
| TWAP oracle | admin `update_oracle` push | ⏳ not Raydium TWAP; oracle-free ratio or optional PumpSwap |
| Circuit breakers / caps | ✅ | ✅ |

## The math (was "TBD" in the doc — now concrete)

`MINTA` = leveraged-long exposure to an underlying `U`; `MINTB` = inverse. Between rebalances `U`
moves by `r = (p_now − p_last)/p_last`.

- **Loser:** `r < 0` → long side `A` loses; `r > 0` → inverse side `B` loses.
- **Mint amount:** minting `m` into a reserve `R` moves its price by `m/(R+m) ≈ m/R`, so to realise
  leverage `L` against move `|r|` we mint `m ≈ R · L · |r|`, clamped to `max_mint_bps` and zeroed
  by the circuit breaker.
- **Elastic leverage:** `L` floats in `[L_min, L_max]` (default 2x–5x) and decays from `L_max`
  toward `L_min` as the loser's already-minted supply grows relative to its reserve. This damping
  is what prevents a first-move runaway to zero.

All ratios/leverage are in basis points (`10_000 == 1.0`). Pure functions, fully unit-tested:

```
cargo test -p leverage-engine --lib
```

## Instructions (Anchor M1)

| ix | who | what |
|---|---|---|
| `initialize_config` | admin | record mints, reserves, pool ids, oracle, leverage params |
| `set_paused` | admin | emergency pause |
| `update_oracle` | admin (M1) | push reference price; shifts `price_now → price_last` |
| `deposit` | anyone | USDC → receipt 1:1 + seed **protocol-held** reserves 50/50 |
| `rebalance` | anyone | permissionless crank; applies the elastic mint step |
| `initialize_extra_account_meta_list` | admin | wire the receipt hook's extra accounts |
| `transfer_hook` / `fallback` | Token-2022 CPI | apply the same rebalance on receipt transfer |

The hook **soft no-ops** (returns `Ok`) when paused / flat / inside the rebalance interval, so a
receipt transfer never fails for a benign reason.

## Milestones

- **M1 (this crate):** state + concrete math + `deposit` + admin oracle crank +
  permissionless `rebalance` + receipt hook. Reserves are **protocol-held token accounts**.
  Builds for SBF; math unit-tested. **Do not confuse with mainnet.**
- **M2 (Pinocchio — shipped on mainnet):** Raydium CP-Swap pool vaults — add-liquidity CPI on
  `deposit`, mint-the-loser into pool vaults on `rebalance`, `register_triangle` introspection.
  Rebalance price signal is **oracle-free** (implied A/B ratio from vault balances), not Raydium
  `observation_state` TWAP.
- **M3 (open):** formal audit, keeper bot, Raydium TWAP as optional price input, dashboard hardening.

## Build

```
anchor build -p leverage_engine     # SBF build (requires Solana 3.1.10 active — see repo wiki)
cargo test -p leverage-engine --lib # host-side math tests
```