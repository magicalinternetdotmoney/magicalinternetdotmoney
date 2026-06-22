/**
 * The searchergap: the three arbitrage surfaces on a leverage market.
 *
 *  1. triangleGap — pure on-chain cyclic arb across the AQ / AB / BQ pools.
 *     Always present from organic flow (a degen buying a leg on Jupiter moves
 *     only one pool). Riskless, atomic, bundle-shaped.
 *  2. crankSim — what a receipt-transfer / crank would MINT (donate) and the
 *     resulting loser-price drop. Models the (recommended) one-crank-per-slot
 *     guard so a searcher's sim returns 0 when already cranked this slot.
 *  3. pegGap — leg pool price vs an externally-supplied fair price (the protocol
 *     lags the true levered target; this is the load-bearing peg arb). Pluggable
 *     because "fair" needs a real-underlying feed the searcher brings.
 */

import { getAmountOut, optimalInput, donatePriceEffect, DEFAULT_FEE_BPS } from "./cpswap";
import {
  impliedMarket,
  planFromMarket,
  Side,
  WAD,
  type ImpliedMarket,
  type RebalancePlan,
} from "./leverage-math";
import type { TriangleReserves } from "./markets";

export type TriangleDirection = "AQ→AB→BQ" | "BQ→AB→AQ";

export interface TriangleGap {
  /** profitable cycle direction, or null if neither cycle profits. */
  direction: TriangleDirection | null;
  /** optimal USDC input (atoms). */
  inputUsdc: bigint;
  /** USDC out at the optimal input (atoms). */
  outputUsdc: bigint;
  /** outputUsdc − inputUsdc (atoms). */
  profitUsdc: bigint;
  /** profit / input, in bps. */
  profitBps: number;
  /** price-coherence deviation between the AB pool and the implied cross, bps.
   *  Sign-free magnitude; ~0 means the triangle is coherent. */
  deviationBps: number;
}

/** Forward cycle: USDC →(AQ) A →(AB) B →(BQ) USDC. */
function cycleForward(r: TriangleReserves, feeBps: bigint) {
  return (dx: bigint): bigint => {
    const a = getAmountOut(dx, r.aqUsdc, r.aqA, feeBps); // USDC→A
    const b = getAmountOut(a, r.abA, r.abB, feeBps); // A→B
    return getAmountOut(b, r.bqB, r.bqUsdc, feeBps); // B→USDC
  };
}
/** Reverse cycle: USDC →(BQ) B →(AB) A →(AQ) USDC. */
function cycleReverse(r: TriangleReserves, feeBps: bigint) {
  return (dx: bigint): bigint => {
    const b = getAmountOut(dx, r.bqUsdc, r.bqB, feeBps); // USDC→B
    const a = getAmountOut(b, r.abB, r.abA, feeBps); // B→A
    return getAmountOut(a, r.aqA, r.aqUsdc, feeBps); // A→USDC
  };
}

/** Compute the best triangular arbitrage across the three pools. */
export function triangleGap(r: TriangleReserves, feeBps: bigint = DEFAULT_FEE_BPS): TriangleGap {
  // price coherence: implied cross (B per A from USDC pools) vs direct AB pool.
  // priceA = aqUsdc/aqA, priceB = bqUsdc/bqB → A-in-B = priceA/priceB.
  let deviationBps = 0;
  if (r.aqA > 0n && r.bqB > 0n && r.abA > 0n) {
    const priceA = Number(r.aqUsdc) / Number(r.aqA);
    const priceB = Number(r.bqUsdc) / Number(r.bqB);
    const impliedAinB = priceB > 0 ? priceA / priceB : 0; // B per A
    const directAinB = Number(r.abB) / Number(r.abA);
    if (directAinB > 0) deviationBps = Math.abs((impliedAinB / directAinB - 1) * 10_000);
  }

  const fwd = optimalInput(cycleForward(r, feeBps), r.aqUsdc > 0n ? r.aqUsdc : 1n);
  const rev = optimalInput(cycleReverse(r, feeBps), r.bqUsdc > 0n ? r.bqUsdc : 1n);

  const best = fwd.profit >= rev.profit ? { d: "AQ→AB→BQ" as const, x: fwd } : { d: "BQ→AB→AQ" as const, x: rev };
  if (best.x.profit <= 0n) {
    return { direction: null, inputUsdc: 0n, outputUsdc: 0n, profitUsdc: 0n, profitBps: 0, deviationBps };
  }
  const profitBps = best.x.input > 0n ? Number((best.x.profit * 10_000n) / best.x.input) : 0;
  return {
    direction: best.d,
    inputUsdc: best.x.input,
    outputUsdc: best.x.output,
    profitUsdc: best.x.profit,
    profitBps,
    deviationBps,
  };
}

export type CrankNoop = "flat" | "breaker" | "same-slot" | "no-market";

export interface CrankSim {
  /** null = the crank would mint (see `plan`); otherwise why it no-ops. */
  noop: CrankNoop | null;
  plan: RebalancePlan | null;
  market: ImpliedMarket | null;
  /** price effect on the loser's USDC pool (the one a searcher can monetize). */
  loserUsdcPool: { priceBeforeWad: bigint; priceAfterWad: bigint; dropFracWad: bigint } | null;
}

export interface CrankSimArgs {
  reserves: TriangleReserves;
  /** ratio recorded at the last rebalance (Config.last_ratio_wad). */
  lastRatioWad: bigint;
  lMinBps: bigint;
  lMaxBps: bigint;
  maxMintBps: bigint;
  breakerBps: bigint;
  /** 0 ⇒ full band (the hook/crank default). */
  userLeverageBps?: bigint;
  /** Optional one-crank-per-slot guard (recommended anti-abuse, see README).
   *  If currentSlot === lastCrankSlot the crank soft-no-ops. */
  currentSlot?: bigint;
  lastCrankSlot?: bigint;
}

/**
 * Simulate what a receipt-transfer / crank would do RIGHT NOW. Faithful to
 * plan_from_market (oracle-free path). Set currentSlot+lastCrankSlot to also
 * model the recommended same-slot guard.
 */
export function simulateCrank(args: CrankSimArgs): CrankSim {
  if (
    args.currentSlot !== undefined &&
    args.lastCrankSlot !== undefined &&
    args.currentSlot === args.lastCrankSlot
  ) {
    return { noop: "same-slot", plan: null, market: null, loserUsdcPool: null };
  }
  const r = args.reserves;
  const market = impliedMarket(r.aqA, r.aqUsdc, r.bqB, r.bqUsdc, r.supplyA, r.supplyB);
  if (!market) return { noop: "no-market", plan: null, market: null, loserUsdcPool: null };

  const plan = planFromMarket({
    lastRatioWad: args.lastRatioWad,
    market,
    reserveAInPair: r.abA,
    reserveBInPair: r.abB,
    reserveAInAUsdc: r.aqA,
    reserveBInBUsdc: r.bqB,
    supplyA: r.supplyA,
    supplyB: r.supplyB,
    userLeverageBps: args.userLeverageBps ?? 0n,
    lMinBps: args.lMinBps,
    lMaxBps: args.lMaxBps,
    maxMintBps: args.maxMintBps,
    breakerBps: args.breakerBps,
  });
  if (!plan) return { noop: "flat", plan: null, market, loserUsdcPool: null };
  if (plan.breakerTripped) return { noop: "breaker", plan, market, loserUsdcPool: null };

  // The loser is donated into its USDC pool — this is the price a searcher can act on.
  const loserUsdcPool =
    plan.side === Side.A
      ? donatePriceEffect(r.aqA, r.aqUsdc, plan.amountUsdcPool)
      : donatePriceEffect(r.bqB, r.bqUsdc, plan.amountUsdcPool);
  return { noop: null, plan, market, loserUsdcPool };
}

export interface PegGap {
  /** signed deviation of the pool price from fair, in bps, per leg. */
  legADevBps: number;
  legBDevBps: number;
  /** which leg is most mispriced and the trade to close it. */
  worst: { leg: "A" | "B"; devBps: number; action: "buy" | "sell" } | null;
}

/**
 * Leg-vs-fair gap. The caller supplies a fair USDC price per leg from their own
 * underlying feed (the protocol can't push a winner up, so its pool lags the
 * true levered target — that lag is the arb). Positive devBps = pool rich
 * (sell); negative = pool cheap (buy).
 */
export function pegGap(r: TriangleReserves, fairPriceAUsdc: number, fairPriceBUsdc: number): PegGap {
  const poolA = r.aqA > 0n ? Number(r.aqUsdc) / Number(r.aqA) : 0;
  const poolB = r.bqB > 0n ? Number(r.bqUsdc) / Number(r.bqB) : 0;
  const legADevBps = fairPriceAUsdc > 0 ? (poolA / fairPriceAUsdc - 1) * 10_000 : 0;
  const legBDevBps = fairPriceBUsdc > 0 ? (poolB / fairPriceBUsdc - 1) * 10_000 : 0;
  let worst: PegGap["worst"] = null;
  const aAbs = Math.abs(legADevBps);
  const bAbs = Math.abs(legBDevBps);
  if (aAbs >= bAbs && aAbs > 0) worst = { leg: "A", devBps: legADevBps, action: legADevBps > 0 ? "sell" : "buy" };
  else if (bAbs > 0) worst = { leg: "B", devBps: legBDevBps, action: legBDevBps > 0 ? "sell" : "buy" };
  return { legADevBps, legBDevBps, worst };
}

/**
 * Apply a rebalance plan's donations to the reserves — the loser is MintTo'd
 * into the AB pool and its USDC pool (no swap; quote untouched; supply grows).
 * Returns the post-crank reserves.
 */
export function applyCrankToReserves(r: TriangleReserves, plan: RebalancePlan): TriangleReserves {
  const out: TriangleReserves = { ...r };
  if (plan.side === Side.A) {
    out.abA = r.abA + plan.amountPairPool;
    out.aqA = r.aqA + plan.amountUsdcPool;
    out.supplyA = r.supplyA + plan.amountPairPool + plan.amountUsdcPool;
  } else {
    out.abB = r.abB + plan.amountPairPool;
    out.bqB = r.bqB + plan.amountUsdcPool;
    out.supplyB = r.supplyB + plan.amountPairPool + plan.amountUsdcPool;
  }
  return out;
}

/**
 * The post-crank triangle gap: what a `buy → crank → sell` bundle could capture
 * AFTER the donation lands. By design this is ~0 (the donation moves both loser
 * pools by the same fraction → the triangle stays coherent), so this function
 * mostly proves there's nothing to take from a self-fired crank. A non-trivial
 * result means integer rounding on a thin pool, not a real edge.
 */
export function crankThenTriangleGap(
  r: TriangleReserves,
  plan: RebalancePlan,
  feeBps: bigint,
): TriangleGap {
  return triangleGap(applyCrankToReserves(r, plan), feeBps);
}

/**
 * Apply an external swap to one USDC pool (organic flow) — buy `usdcIn` of the
 * leg in its USDC pool. Unlike the crank, this moves ONE pool only, so it opens
 * a real triangle gap. Use to backtest "what gap does a degen's buy leave?".
 */
export function applyLegBuyToReserves(
  r: TriangleReserves,
  leg: "A" | "B",
  usdcIn: bigint,
  feeBps: bigint,
): TriangleReserves {
  const out: TriangleReserves = { ...r };
  if (leg === "A") {
    const aOut = getAmountOut(usdcIn, r.aqUsdc, r.aqA, feeBps);
    out.aqUsdc = r.aqUsdc + usdcIn;
    out.aqA = r.aqA - aOut;
  } else {
    const bOut = getAmountOut(usdcIn, r.bqUsdc, r.bqB, feeBps);
    out.bqUsdc = r.bqUsdc + usdcIn;
    out.bqB = r.bqB - bOut;
  }
  return out;
}

// ---------------------------------------------------------------------------
// External gap — the post-crank, cross-venue / vs-fair surface.
//
// The crank keeps the INTERNAL triangle coherent, but it moves the loser's
// price ONLY in the protocol pools — dislocating it vs every external
// reference. `externalGap` prices a protocol leg against a fair value the
// searcher brings (another venue's price, or the underlying-implied −Nx) and
// returns the executable in-protocol trade + profit to close the gap.
//
// UNITS: `fairPrice` is USDC-atoms per token-atom — the same ratio the pool
// gives as `Number(usdcReserve)/Number(tokenReserve)`. Profit is USDC atoms.
// ---------------------------------------------------------------------------

export interface ExternalArb {
  leg: "A" | "B";
  /** protocol pool price (usdc-atoms per token-atom). */
  poolPrice: number;
  /** caller-supplied fair price (same units). */
  fairPrice: number;
  /** (poolPrice/fair − 1) in bps. negative = protocol cheap (buy). */
  devBps: number;
  /** buy = protocol cheap (buy in-protocol, sell external); sell = protocol rich. */
  action: "buy" | "sell" | null;
  /** optimal input atoms — USDC for a buy, token for a sell. */
  optimalIn: bigint;
  /** estimated profit (USDC atoms) after the in-protocol fee. */
  profitUsdc: bigint;
}

function legExternalArb(
  leg: "A" | "B",
  tokenRes: bigint,
  usdcRes: bigint,
  fair: number,
  feeBps: bigint,
): ExternalArb {
  const poolPrice = tokenRes > 0n ? Number(usdcRes) / Number(tokenRes) : 0;
  const base: ExternalArb = { leg, poolPrice, fairPrice: fair, devBps: 0, action: null, optimalIn: 0n, profitUsdc: 0n };
  if (fair <= 0 || tokenRes <= 0n || usdcRes <= 0n) return base;
  base.devBps = (poolPrice / fair - 1) * 10_000;

  if (poolPrice < fair) {
    // protocol cheap → buy token in the pool, sell at `fair` externally.
    const payoff = (dxUsdc: bigint): bigint => {
      const tok = getAmountOut(dxUsdc, usdcRes, tokenRes, feeBps);
      return BigInt(Math.floor(Number(tok) * fair)); // USDC atoms at fair
    };
    const { input, profit } = optimalInput(payoff, usdcRes);
    if (profit <= 0n) return base;
    return { ...base, action: "buy", optimalIn: input, profitUsdc: profit };
  }
  // protocol rich → buy token externally at `fair`, sell it in the pool.
  const usdcOut = (dTok: bigint): bigint => getAmountOut(dTok, tokenRes, usdcRes, feeBps);
  const cost = (dTok: bigint): bigint => BigInt(Math.ceil(Number(dTok) * fair));
  let lo = 0n, hi = tokenRes, best = 0n, bestProfit = -(2n ** 62n);
  for (let i = 0; i < 200 && hi - lo > 1n; i++) {
    const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
    if (usdcOut(m1) - cost(m1) < usdcOut(m2) - cost(m2)) lo = m1 + 1n;
    else hi = m2 - 1n;
  }
  for (let d = lo; d <= hi; d++) {
    const p = usdcOut(d) - cost(d);
    if (p > bestProfit) { bestProfit = p; best = d; }
  }
  if (bestProfit <= 0n) return base;
  return { ...base, action: "sell", optimalIn: best, profitUsdc: bestProfit };
}

/** Price both legs against caller-supplied fair values (other venue / underlying feed). */
export function externalGap(
  r: TriangleReserves,
  fair: { fairPriceA?: number; fairPriceB?: number },
  feeBps: bigint = DEFAULT_FEE_BPS,
): { legA: ExternalArb | null; legB: ExternalArb | null } {
  return {
    legA: fair.fairPriceA != null ? legExternalArb("A", r.aqA, r.aqUsdc, fair.fairPriceA, feeBps) : null,
    legB: fair.fairPriceB != null ? legExternalArb("B", r.bqB, r.bqUsdc, fair.fairPriceB, feeBps) : null,
  };
}

export interface CrankExternalGap {
  noop: CrankNoop | null;
  plan: RebalancePlan | null;
  /** reserves after the crank's donation lands. */
  postReserves: TriangleReserves | null;
  /** external arb on the post-crank reserves (the deposit→crank→arb number). */
  legA: ExternalArb | null;
  legB: ExternalArb | null;
}

/**
 * The deposit→crank→arb-external number: simulate the crank, apply its donation,
 * then price the (now-dislocated) protocol legs against the caller's fair feed.
 * This is what firing the crank actually opens — externally, not inside the
 * coherent triangle.
 */
export function crankExternalGap(
  args: CrankSimArgs & { fairPriceA?: number; fairPriceB?: number; feeBps?: bigint },
): CrankExternalGap {
  const sim = simulateCrank(args);
  if (sim.noop || !sim.plan) {
    return { noop: sim.noop, plan: sim.plan, postReserves: null, legA: null, legB: null };
  }
  const post = applyCrankToReserves(args.reserves, sim.plan);
  const fee = args.feeBps ?? DEFAULT_FEE_BPS;
  const ext = externalGap(post, { fairPriceA: args.fairPriceA, fairPriceB: args.fairPriceB }, fee);
  return { noop: null, plan: sim.plan, postReserves: post, legA: ext.legA, legB: ext.legB };
}

export { WAD };
