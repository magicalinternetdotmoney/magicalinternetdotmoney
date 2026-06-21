# No Oracles

**How Magical Internet Money rebalances leveraged synthetic pairs on Solana mainnet without Pyth, Switchboard, Raydium TWAP, or any off-chain price feed.**

Program: [`J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe`](https://solscan.io/account/J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe)  
Site: [magicalinternet.money](https://magicalinternet.money)  
Stress run: 2026-06-21 — **100 receipt transfers** across **4 live LP pairs** after **~$39 USDC deposit each** (1/5 of wallet per pair).

---

## TL;DR

| Layer | Price source | Oracle? |
|-------|----------------|---------|
| **Triangle rebalance** (always) | Implied +/− ratio from **our own** Raydium vault balances + synth supplies | **No** |
| **External leg** (optional `price_crawl`) | Spot from **boxed AMM reserve token accounts** (`quote/base` WAD) | **No** — reads on-chain reserves, not a feed |
| **Transfer hook** | `TransferChecked` → program samples crawl → mints loser into Raydium | **No** |

There is no oracle network. There is no crank paying for a quote. Every number the program acts on is already on-chain in accounts the transaction passes in.

---

## What “oracle-free” means here

Colloquially people say “oracle” for any price input. We mean something stricter:

1. **No third-party price protocol** (Pyth, Switchboard, etc.).
2. **No Raydium `observation_state` TWAP** from the CP-Swap program.
3. **No HTTP/API/indexer** in the hot path — wallets build txs from RPC + our site API; the program only sees account data.
4. **No privileged signer** required for rebalance — any receipt **transfer** can fire the hook.

What we *do* use:

- **Reserve math** on SPL token accounts (`amount` at offset 64).
- **Pool layout deserialization** only on the permissionless `advance_crawl` crank (to discover vault addresses), not on every wallet transfer.
- **Median over crawl samples** stored in the `price_crawl` PDA when multiple venues exist.

---

## Two price signals, one hook

### 1. Triangle ratio (oracle_kind = 0 behavior, always available)

From config + 6 Raydium vault token accounts + 2 mint supplies:

```
market_ratio_wad ≈ f(res_ab_a, res_ab_b, res_ausdc_a, res_busdc_b, supply_a, supply_b)
```

This is the **levered pair’s internal anchor** — how expensive + is vs − in terms of the triangle’s on-chain state. No external venue.

### 2. Price crawl (oracle_kind = 2)

For pairs whose “truth” leg is an external Raydium CP-Swap pool (e.g. WSOL/USDC, cbBTC/USDC):

- A **`price_crawl` PDA** holds a rotating index over venues (today: 1 entry per pair, the anchor A/USDC pool).
- Each sample stores `price_wad = quote_reserve × WAD / base_reserve`.
- On cursor wrap, **`aggregate_wad`** = median of samples.

The crawl is an **on-chain multivendor index**, not an oracle. It’s literally vault balances we read ourselves.

---

## Why we don’t pass pool + LUT + 3 vaults on every transfer

Early hook designs passed **16 extra accounts** (rebalance set + crawl + LUT + pool + 2 vaults). Token-2022’s transfer-hook resolver **OOM’d** before our program ran:

```
Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
Program log: Error: memory allocation failed, out of memory
```

Constant-product AMMs (Raydium CP-Swap, PumpSwap) **do not store executable price in the pool account** — they store vault *addresses*. The price is in the **two vault token balances**.

So the hook only needs:

| Accounts | Role |
|----------|------|
| 11 | Rebalance (config, authority, mints, 6 vaults, token program) |
| 1 | `price_crawl` (writable — samples + cursor) |
| 2 | **Base + quote reserve token accounts** (discriminator-2 from crawl box) |

**14 resolved metas total.** Pool and LUT stay on the `advance_crawl` crank, which writes vault pubkeys into the crawl box via `set_hook_reserves`.

### Layout modes (venue tag in `price_crawl`)

| Tag | Hook accounts | Price |
|-----|---------------|-------|
| `LAYOUT_CPSWAP` / `LAYOUT_PUMPSWAP` | 2 reserve token accounts | `quote_res × WAD / base_res` |
| `LAYOUT_AMM_POOL` (future CLMM) | 1 pool account | Deserialize sqrt price from pool state |

Rule of thumb: **2 accounts → reserve math; 1 account → deserialize AMM; pool pubkey zero in box means reserves path.**

### Account boxing (discriminator-2)

Vault pubkeys live in `price_crawl` at offsets 91 and 123. ExtraAccountMeta entries 12–13 use spl-token **PubkeyData** resolution:

```
discriminator 2, address_config [2, account_index=16, data_offset=91|123]
```

Account index 16 = `price_crawl` in the Execute instruction (5 standard + 11 rebalance embeds + crawl at embed 11). Wallets don’t hard-code venue vaults; they read the box after `advance_crawl` seeds it.

---

## Transfer hook flow (one receipt send)

```
User: TransferChecked(receipt)
  └─ Token-2022 resolves 14 extra accounts from ExtraAccountMetaList
       └─ J345… hook_execute
            ├─ crawl_sample_reserves: read 2 vault amounts → sample_wad
            ├─ advance cursor, refresh median → aggregate_wad
            ├─ plan_two_pool_from_oracle_wad(oracle_last, sample/median, …)
            └─ MintTo loser into Raydium vaults (legacy SPL, no T22 re-entry)
```

Program logs you should see on a healthy transfer:

```
Program log: crawl cur=0→0 pass=N sample_wad=… agg_wad=… slot=0
Program log: rb plan side=… mint_pair=… mint_usdc=…
Program log: rb oracle kind=2 hook=1 last=… now=… new_oracle=…
```

`pass` increments on **every transfer** that samples (not only on standalone cranks).

---

## Mainnet stress test (2026-06-21)

Script: `scripts/no-oracle-stress.mjs`  
Wallets: admin `CnkHq3w…`, test `E8dJrFHJ…`

| Pair | Receipt | Deposits | Transfers | Crawl logs | Rebalance mints | crawl pass Δ |
|------|---------|----------|-----------|------------|-----------------|--------------|
| **3xSOL** | `2P7Aiby…pTvB` | ~$49 + existing | 25 | 23/25 | plan-only* | +26 |
| **5xBTC** | `EJf2gAc…8KVG` | ~$39 | 25 | 22/25 | 21/25 | +26 |
| **10xSPCXx** | `CQzeyux…ehnM` | ~$39 | 25 | 17/25 | 16/25 | +26 |
| **LEV 3X** | `GjtNtUv…Sqi2` | ~$39 | 25 | 23/25 | 22/25 | +26 |
| 10xSPCXx (dup) | `2X5XkVT…WgWk` | — | skipped | LUT empty | — | — |

\*3xSOL later legs often logged crawl without `mint_pair` when the plan was already near equilibrium — still sampled and advanced `pass`.

**Totals:** 100/100 transfers succeeded, **0 errors**, **85** crawl log lines, **59** rebalance mint legs.

Sample txs (Solscan):

- [3xSOL transfer + crawl](https://solscan.io/tx/2gqnE1AhrmmKpp58qmE3RReauwnR2zjyqeb4aTKrat8NwTCHz38k2MfAXZcYU78YyoaCQxyGJ3DBoiuaCqz972QT)
- [5xBTC transfer + mint](https://solscan.io/tx/3PPr1QurjeKn7RgQhjwKrZytkwaARYjjmDUzmawm7JMpSswdYKv59LvR6av4WafYxKL8XF6xDHt4CnXgx21gNWRD)
- [10xSPCXx deposit+transfer](https://solscan.io/tx/23AwSqezmQNvziMeJ9RgnLWcp27mZUukYsh8DrXjynZhfNMsWjdiinnxQT6JoiNM4cRD3kU6aZT4K6K7mjNDCyJr)
- [LEV 3X transfer + mint](https://solscan.io/tx/3P3CQaEmhuPdMg5w48H7RnVqPoCU2pC6MabCUA3n6FkETfpdLYja43LCdyBm6iHCeiUkphWXspQvDrH8fmYPd1Ry)

Full machine-readable log: `scripts/no-oracle-stress-results.json`

### Reproduce

```bash
# One pair migrate + patch boxed hook
RECEIPT_MINT=2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB node scripts/migrate-hook-crawl-one.mjs

# Ping-pong
ROUNDS=10 node scripts/ping-pong-hook.mjs

# Full stress (deposit 1/5 USDC each + 25 transfers × 4 pairs)
USDC_FRACTION=5 TRANSFERS_PER_PAIR=25 node scripts/no-oracle-stress.mjs
```

---

## Instructions map

| IX | Who | Purpose |
|----|-----|---------|
| `advance_crawl` (16) | anyone | LUT + pool → find vaults → sample → **seed box** |
| `patch_hook_metas` (19) | admin | Write 14-meta boxed ExtraAccountMetaList |
| `migrate_price_crawl` (20) | admin | Grow PDA 423 → 519 bytes |
| Transfer hook Execute | any receipt transfer | Sample reserves → rebalance |

---

## BPF / stack notes

Heavy paths use `#[inline(never)]` on `crawl_sample_reserves`, `run_rebalance`, `hook_execute` to keep the 8 KiB BPF stack under control when Token-2022 CPIs in with 14 accounts.

---

## Honest limits

1. **Not audited.** Mainnet-alpha research software.
2. **Reserve price ≠ manipulation-free.** Thin pools can be moved; we enforce `MIN_BASE_RESERVE` and use median when ≥2 venues exist.
3. **Token-2022 account budget is real.** 16 metas OOM’d; 14 works. CLMM single-account path targets 13.
4. **One pair (`2X5XkVT…`) has an empty LUT** — needs triangle re-registration before crawl works.
5. **Deposit/withdraw don’t rebalance** — only **receipt transfers** fire the hook. LPs must *move* receipt to crank (or someone sends to them).

---

## Mental model

```
         ┌─────────────────────────────────────┐
         │  Raydium triangle (our vaults)      │
         │  ratio = purely on-chain            │
         └──────────────┬──────────────────────┘
                        │
         ┌──────────────▼──────────────────────┐
         │  price_crawl (optional)             │
         │  spot = reserve_b / reserve_a       │
         │  vault pubkeys boxed in PDA       │
         └──────────────┬──────────────────────┘
                        │
         ┌──────────────▼──────────────────────┐
         │  receipt transfer hook              │
         │  14 accounts, no oracle network   │
         └─────────────────────────────────────┘
```

**No oracles. Just accounts you already have to pass to swap anyway.**