# Magical Internet Money — Frontend / App Wiki

Companion to the program wiki. This file = the **app** (`Magical Internet Money.dc.html`), a
Design Component. Mobile-first, responsive desktop. Cypherpunk void aesthetic (Space Grotesk +
IBM Plex Mono; mint `#2fe6c0` / violet `#a06bff` / amber `#f2c14e` on near-black `#07070b`).

## Identity
- Domain/brand: **magicalinternet.money** / "Magical Internet Money".
- Receipt token is **creator-named per pair** (default symbol `TRI`; e.g. `SOLE`, `BWIF`).
  Never call it "MIM" — that was explicitly rejected. The receipt's metadata is set by the
  creating user at launch.
- MINTA/MINTB metadata is **derived from "the facts"** the creator enters and resolved
  dynamically by the metadata API (`/api/meta`) — the UI only lets you name the receipt.

## Flows (all behind a fake wallet connect)
1. **Launch a pair** (`view: create`) — 2 steps: (1) set the facts + receipt metadata
   (symbol, icon, name, colorway) with a live 3-token preview; (2) seed liquidity + max
   leverage band, then deploy. Deploy = one tx: receipt mint + metadata + **three CP-Swap
   pools created atomically** ("tx introspection enforces all-or-nothing" — matches program's
   Instructions-sysvar check + mandatory LUT).
2. **Provide liquidity** (`view: provide`) — per-pair. Two tabs:
   - **Provide**: swap-style Deposit/Withdraw (quote ⇄ receipt), live NAV, position, earned.
   - **Charts**: analytics (see data contract below).
   Plus a **Contracts** disclosure (both tabs) listing the mints + pools, click/tap-to-copy.
3. Home: TVL/pairs/APR stat band, the two action cards, a live-pairs list.

## UI ↔ program alignment (from program wiki, reflect in copy/visuals)
- **Leverage is user-specified per deposit**, clamped to `[l_min, l_max]` as a guardrail — NOT
  protocol-derived. The deposit flow's multiplier selector is the source of truth for this.
- **Mint the loser into BOTH pools** (the MINTA/MINTB pool AND the loser/quote pool) so there's
  no cross-venue price gap for arbs to drain. The triangle viz + crank log should read as
  minting into both edges the loser lives on, not just the pair pool.
- Receipt mint = **Token-2022 + transfer hook**; MINTA/MINTB = SPL. Surface this in Contracts.
- Quote asset is **USDC by default but configurable** (`quoteToken` prop). All pool pairs,
  balances, and the deposit/withdraw asset follow it.

## Charts data contract (what the indexer DB must serve per pair, per timeframe)
Timeframes: `1H / 1D / 1W / 1M / ALL`. Each point needs:
- `nav` — redeemable quote value backing one receipt (the bid/redeem reference).
- `mint` (ask) and `redeem` (bid) quote cost per receipt — the spread band is `mint - redeem`.
- `va`, `vb` — the **per-constituent** USD-equiv value backing one receipt (MINTA side, MINTB
  side); `va + vb ≈ nav`. This is the "constituent redeemable/mintable quote cost over time"
  the user asked for; the divergence between them visualizes mint-the-loser drift.
- Series are currently **mocked deterministically** in-app (seeded PRNG by `sym|tf`) as a stand-in
  for the DB. Replace `buildSeries`/`genAddr` reads with real API calls when wired.
- **APY shown in USD-equivalent regardless of the configured quote asset.** Displayed as a total
  + breakdown (swap fees / arb capture). Yields normalize to USD even when quote ≠ USDC.

## Contracts disclosure
Lists: Receipt mint (`sym`), MINTA mint, MINTB mint, Pool MINTA/MINTB, Pool MINTA/quote,
Pool MINTB/quote. Addresses are mocked (seeded base58) — swap for indexer-served addresses.
Each row is tap/click-to-copy (`navigator.clipboard`), shows a transient "copied ✓".

## Notes
- This is a **design/marketing app mock**, not the on-chain program. cargo/anchor/surfpool/Pinocchio
  work lives in the Solana repo, not here.
- DC rules: inline styles only; charts are SVG path strings computed in `renderVals()`; hover
  crosshair uses a live `hoverF` fraction (the one legit runtime style-hole, `left:{{hoverPct}}`).
