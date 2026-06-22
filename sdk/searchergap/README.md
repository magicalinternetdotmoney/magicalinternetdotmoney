# @magicalinternet/searchergap

Searcher SDK for [Magical Internet Money](https://magicalinternet.money) — the
leveraged-synthetic CP-Swap **triangle**:

```
        +leg ───────── −leg        (AB pool)
          │             │
          └── USDC ──────┘          (AQ pool, BQ pool)
```

A market is three Raydium CP-Swap pools. It's **oracle-free** (`price_X =
usdc_reserve / token_reserve`) and rebalances by **minting the loser** —
fired by a Token-2022 receipt-transfer hook. This SDK gives a bot exact,
BigInt, on-chain-faithful math to find and size the gaps.

> Experimental. Unaudited. Mainnet-alpha. Nothing here is financial advice.

## Status — early / pre-liquidity (this is a demo today)

Be straight about where this is: the live markets are **paper-thin and already
coherent**, so a scan right now finds **$0** — every triangle reports no
profitable cycle, and the SDK even proves the crank leaves no gap
(`crankThenTriangleGap → 0`). That's the tool telling the truth, not failing.

**This ships now so it's battle-ready for when liquidity deepens and real
opportunities emerge** — a fat underlying move, a deeper pool, a burst of
organic flow. The math is exact and the bundle builders work today; what's
missing is the liquidity, not the SDK. Treat v0.x as the reference
implementation of the surface, wired and waiting.

## Install

```bash
npm i @magicalinternet/searchergap @solana/web3.js
```

## The gaps (more than three)

Computable on-chain today vs. surfaces that open up as the protocol gets used:

| gap | what it is | status |
| --- | --- | --- |
| **triangle** | riskless cyclic arb across AQ→AB→BQ (or reverse); opens whenever organic flow hits one pool. atomic, bundle-shaped | ✅ `triangleGap` |
| **crank** | what a receipt-transfer / crank mints (donates) + the loser drop. *donation only — quote untouched, and it's coherent → no arb from a self-fired crank* | ✅ `simulateCrank` / `crankThenTriangleGap` |
| **peg / external** | leg pool price vs a fair value you bring (another venue, or the underlying-implied −Nx). the protocol can't mark a winner up, so its pool lags | ✅ `pegGap` / `externalGap` (bring a feed) |
| **post-crank external** | the crank keeps the triangle coherent but shoves the loser's *protocol* price down vs the outside world — the **deposit→crank→arb-external** number, sized | ✅ `crankExternalGap` |
| **JIT liquidity** | add one/two legs right before a fat swap, collect its fee, remove | ✅ `cpAddLiquidityIx`/`cpRemoveLiquidityIx` |
| **hook-backrun** | every receipt transfer cranks → backrun any deposit / withdraw | 🔜 |
| **price-crawl timing** | whoever advances the crawl picks when the protocol "sees" price → times the rebalance | 🔜 |
| **launch snipe** | initial triangle liquidity on a freshly created market | 🔜 |
| **buy_burn** | the protocol's flywheel buys + burns — predictable, front/back-runnable | 🔜 |
| **receipt ↔ LP NAV** | receipt is 1:1 with LP; any secondary price ≠ redemption value → mint/redeem arb | 🔜 |

The crank is arb-tight *inside* the triangle (`crankThenTriangleGap → 0`), so the
real edge it creates is **external**: `crankExternalGap` simulates the crank,
applies the donation, then prices the dislocated legs against your fair feed and
returns the executable trade + profit. That's the "if/when you fire the crank it
opens arbs" surface — outside the triangle, where it actually lives.

## Quick start

```ts
import { Connection } from "@solana/web3.js";
import { scanAll, simulateCrank, pegGap } from "@magicalinternet/searchergap";

const conn = new Connection(process.env.RPC_URL!, "confirmed");

// 1. Triangle gaps across every market (pure on-chain)
for (const s of await scanAll(conn)) {
  if (s.triangle.direction)
    console.log(s.market.config.toBase58(), s.triangle.direction,
      "profit", s.triangle.profitUsdc.toString(), "atoms", s.triangle.profitBps, "bps");
}
```

### CLI

```bash
RPC_URL=https://… npx searchergap scan        # human table
RPC_URL=https://… npx searchergap scan --json  # machine-readable
```

### Simulate a crank (what your dust receipt-transfer would do)

```ts
import { discoverMarkets, readTriangle, simulateCrank } from "@magicalinternet/searchergap";

const m = (await discoverMarkets(conn))[0];
const reserves = await readTriangle(conn, m);

const sim = simulateCrank({
  reserves,
  lastRatioWad: /* Config.last_ratio_wad */ 0n,
  lMinBps: 20_000n, lMaxBps: 50_000n,   // 2x – 5x band
  maxMintBps: 2_000n,                    // 20% per-rebalance cap
  breakerBps: 5_000n,                    // pause minting on >=50% moves
  // optional: model the recommended one-crank-per-slot guard
  currentSlot: await conn.getSlot().then(BigInt),
  lastCrankSlot: /* Config.last_crank_slot */ 0n,
});

if (sim.noop) console.log("crank no-ops:", sim.noop); // flat | breaker | same-slot | no-market
else console.log("loser", sim.plan!.side,
  "drops", (Number(sim.loserUsdcPool!.dropFracWad) / 1e9 * 100).toFixed(2) + "%");
```

## How the rebalance actually moves price (read the source, not the doc-comment)

The on-chain `run_rebalance` **`MintTo`s the loser straight into the pool
vaults** — there is **no swap**, the quote reserve is never touched (the
program's own `drain_sim` test asserts this). So price moves purely by
dilution: minting `m` into reserve `R` drops that side's price by `m/(R+m)`.
`donatePriceEffect()` reproduces this exactly.

The loser is minted into **both** its pools (the AB pair pool and its USDC
pool) by the **same fraction**, so the rebalance opens **no** gap between those
two venues (the anti-arb invariant). The exploitable gaps are therefore:
(1) organic triangle imbalance, (2) the crank's loser-drop you can pre-position
for, and (3) the peg lag vs the real underlying.

### Anti-abuse: the one-crank-per-slot guard

Because the crank is permissionless and self-triggerable, the dangerous play is
**stacking** cranks in one Jito bundle to absorb a whole move atomically. The
recommended mitigation is a `last_crank_slot` guard (one effective crank per
slot, second is a soft no-op). `simulateCrank` models it via
`currentSlot`/`lastCrankSlot` so your sim returns `same-slot` instead of a
phantom gap. (The guard is a protocol recommendation; check whether your target
deployment enforces it.)

## Executor — build the bundle (you sign + send)

The SDK builds **unsigned** instructions / transactions. It never signs and never
sends — that's the keeper *you* run.

```ts
import {
  discoverMarkets, readTriangle, loadAmmConfigs, triangleGap,
  buildTriangleArbIxs, buildCrankIx, priceCrawlPda, jitoTipIx, buildUnsignedTx,
} from "@magicalinternet/searchergap";

const m = (await discoverMarkets(conn))[0];
const reserves = await readTriangle(conn, m);
const gap = triangleGap(reserves, m.tradeFeeBps);

if (gap.direction) {
  const ammConfigs = await loadAmmConfigs(conn, m);
  const arb = buildTriangleArbIxs({
    owner: searcherPubkey, market: m, ammConfigs, reserves,
    direction: gap.direction, amountIn: gap.inputUsdc,
    minProfit: 1n, // final hop reverts unless it clears this
  });
  // optional: trigger the rebalance first, then arb, then tip
  const crank = buildCrankIx({ market: m, priceCrawl: priceCrawlPda(m.config) });
  const tip = jitoTipIx(searcherPubkey, 10_000);
  const tx = await buildUnsignedTx(conn, searcherPubkey, [crank, ...arb, tip]);
  // → tx.sign([keeper]); send as a Jito bundle. NOT done by this SDK.
}
```

The final hop's `min_out` is set to `amountIn + minProfit`, so the **whole bundle
reverts unless it clears profit** — the searcher-safe property (no partial fills,
no inventory left behind).

> `buildCrankIx` fires a real rebalance (mints the loser into the pools) when
> sent. In simulation it's harmless; live, it changes state. The recommended
> one-crank-per-slot guard makes a second crank in the same slot a soft no-op.

### Profitable routes in a ≤5-tx Jito bundle

| route | bundle | risk |
| --- | --- | --- |
| **triangle arb** | 1 tx, 3 hops, profit-guarded final | **atomic-riskless, zero inventory** |
| **crank → triangle** | crank, then arb | crank mints into *both* loser pools by the same fraction → opens no triangle gap; weak alone |
| **short→crank→cover** | sell loser, crank, buy back | needs loser inventory; thin pools eat it |
| **peg arb** | (crank), buy/sell leg, hedge real underlying | directional, needs an external feed; not atomic |
| **JIT liquidity** | `cpAddLiquidityIx` before a fat swap → collect its fee → `cpRemoveLiquidityIx` | competitive, small; the direct-to-Raydium LP edge |
| **backrun deposit/withdraw** | — | protocol deposits/withdraws are balanced → price-flat → no edge |

Only the **triangle** is genuinely atomic-riskless. The rest trade risk for a
fatter, conditional prize.

**Proven, not asserted:** `crankThenTriangleGap(reserves, plan, fee)` applies the
crank's donation to the reserves then runs the triangle finder — it returns **0**
(the loser drops by the *same fraction* in both its pools, so the triangle stays
coherent). `applyLegBuyToReserves(...)` shows an organic leg-buy *does* leave a
real gap. So: don't waste a bundle self-firing the crank to arb it — there's
nothing there. Hunt organic flow and the peg lag.

## Run it (the profit loop)

The keeper ships **inside the package** — run it straight from npm, no
boilerplate:

```bash
# DRY-RUN: scan → build → SIMULATE. never sends. safe right now.
npx @magicalinternet/searchergap run --rpc https://your-rpc

# LIVE: signs with your keeper + sends. you run this; the SDK only signs when you ask.
npx @magicalinternet/searchergap run --live --keypair ~/keeper.json --min-profit 50000 --rpc https://your-rpc
```

Or drive it from code:

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { runLoop, scanOnce } from "@magicalinternet/searchergap";

const conn = new Connection(process.env.RPC_URL!, "confirmed");
const { stop } = runLoop(conn, {
  live: true,
  keeper: Keypair.fromSecretKey(/* your secret */),
  minProfitUsdcAtoms: 50_000n,
});
// scanOnce(conn, opts) for a single pass.
```

The arb's final hop is profit-guarded (`min_out = amountIn + minProfit`), so a
live send **reverts unless it clears min-profit** — you never eat a bad fill. In
production, submit as a Jito bundle (atomic, no revert cost). Today it prints
"no gaps" (thin, coherent markets) — the honest state; it's wired for when
opportunities arrive. A copy-paste version is in
[`examples/searcher-loop.mjs`](./examples/searcher-loop.mjs).

> The `$0.0246` figure you may have seen in dev was a **unit test with synthetic
> inputs** (a hand-set ratio gap + a hand-set external fair price) proving the
> math — not a live opportunity. Live scans return `$0` until a real gap exists.

## API

- `discoverMarkets(connection, programId?)` → `Market[]`
- `readTriangle(connection, market)` → `TriangleReserves` (six vault balances + two supplies, BigInt)
- `scanMarket` / `scanAll` → reserves + `impliedMarket` + `triangleGap`
- `triangleGap(reserves, feeBps?)` → optimal cyclic arb (direction, input, profit, bps, deviation)
- `simulateCrank(args)` → `RebalancePlan` + loser price effect, or a `noop` reason
- `pegGap(reserves, fairPriceAUsdc, fairPriceBUsdc)` → per-leg deviation + the trade to close it
- `impliedMarket`, `planFromMarket`, `elasticLeverageBps`, `loserMintAmount`, … — the raw on-chain math
- `getAmountOut` / `getAmountIn` / `donatePriceEffect` / `optimalInput` — CP-Swap primitives

All amounts are `bigint` atoms. Prices/ratios are WAD-scaled (`1e9`).

## License

MIT © magicalinternetmoney
