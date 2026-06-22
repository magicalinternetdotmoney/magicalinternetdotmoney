/**
 * Faithful BigInt port of the on-chain rebalance economics
 * (crates/leverage-math). Integer semantics match the Rust u64/u128 math
 * exactly — no floating point — so a searcher's simulation equals what the
 * program will do on-chain.
 *
 * Key model facts (verified against pinocchio-programs/leverage-engine):
 *  - Prices are oracle-free: price_X = usdc_reserve / token_reserve in its
 *    USDC pool. ratio = price_A / price_B is the leverage signal.
 *  - "Mint the loser" is a DONATION: the program MintTo's the loser straight
 *    into the pool vaults (no swap, quote untouched). Price moves purely by
 *    dilution: minting m into reserve R drops that side's price by m/(R+m).
 *  - Each crank absorbs only CRANK_ABSORB_BPS (30%) of the gap and sizes the
 *    move within [CRANK_MOVE_FLOOR_BPS, CRANK_MOVE_CAP_BPS].
 */

export const BPS_DENOM = 10_000n;
/** Fraction of the ratio gap absorbed per crank (hook transfer or manual). */
export const CRANK_ABSORB_BPS = 3_000n;
/** Move window for mint sizing. */
export const CRANK_MOVE_FLOOR_BPS = 75n; // 0.75%
export const CRANK_MOVE_CAP_BPS = 200n; // 2.0%
/** WAD fixed-point scale for prices/ratios (1e9). */
export const WAD = 1_000_000_000n;

export enum Side {
  /** Leveraged-long synthetic (mintA). */
  A = "A",
  /** Inverse synthetic (mintB). */
  B = "B",
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** (price_now - price_last)/price_last in bps. null if price_last == 0. */
export function signedReturnBps(priceLast: bigint, priceNow: bigint): bigint | null {
  if (priceLast === 0n) return null;
  return ((priceNow - priceLast) * BPS_DENOM) / priceLast;
}

/** The loser side + |move| in bps. null = flat (mint nothing). */
export function loserAndAbsBps(
  priceLast: bigint,
  priceNow: bigint,
): { side: Side; absBps: bigint } | null {
  const r = signedReturnBps(priceLast, priceNow);
  if (r === null || r === 0n) return null;
  // U fell → long side A loses; U rose → inverse side B loses.
  return { side: r < 0n ? Side.A : Side.B, absBps: abs(r) };
}

/** ratio = reserve / (reserve + supply); leverage decays L_max→L_min as supply grows. */
export function elasticLeverageBps(
  lMinBps: bigint,
  lMaxBps: bigint,
  loserReserve: bigint,
  loserSupply: bigint,
): bigint {
  const lo = lMinBps < lMaxBps ? lMinBps : lMaxBps;
  const hi = lMinBps < lMaxBps ? lMaxBps : lMinBps;
  const denom = loserReserve + loserSupply;
  if (denom === 0n) return lo;
  const ratioBps = (loserReserve * BPS_DENOM) / denom;
  const span = hi - lo;
  const add = (span * ratioBps) / BPS_DENOM;
  const lev = lo + add;
  return lev < hi ? lev : hi;
}

/**
 * Amount of the loser to mint into a reserve of size `loserReserve`.
 * m = reserve · (absBps · levBps / 1e4), clamped to maxMintBps, 0 if the move
 * is >= breakerBps (circuit breaker). Returns null on overflow (cannot in JS
 * BigInt, kept for parity).
 */
export function loserMintAmount(
  loserReserve: bigint,
  absReturnBps: bigint,
  leverageBps: bigint,
  maxMintBps: bigint,
  breakerBps: bigint,
): bigint {
  if (absReturnBps === 0n || loserReserve === 0n) return 0n;
  if (breakerBps !== 0n && absReturnBps >= breakerBps) return 0n;
  let fracBps = (absReturnBps * leverageBps) / BPS_DENOM;
  if (maxMintBps !== 0n && fracBps > maxMintBps) fracBps = maxMintBps;
  return (loserReserve * fracBps) / BPS_DENOM;
}

/** Effective realised leverage of a mint (for telemetry). */
export function effectiveLeverageBps(
  loserReserve: bigint,
  minted: bigint,
  absReturnBps: bigint,
): bigint | null {
  if (absReturnBps === 0n) return null;
  const denom = loserReserve + minted;
  if (denom === 0n) return 0n;
  const impliedMoveBps = (minted * BPS_DENOM) / denom;
  return (impliedMoveBps * BPS_DENOM) / absReturnBps;
}

export function clampLeverageBps(userBps: bigint, lMinBps: bigint, lMaxBps: bigint): bigint {
  const lo = lMinBps < lMaxBps ? lMinBps : lMaxBps;
  const hi = lMinBps < lMaxBps ? lMaxBps : lMinBps;
  return userBps < lo ? lo : userBps > hi ? hi : userBps;
}

export function clampCrankMoveBps(absBps: bigint): bigint {
  if (absBps < CRANK_MOVE_FLOOR_BPS) return CRANK_MOVE_FLOOR_BPS;
  if (absBps > CRANK_MOVE_CAP_BPS) return CRANK_MOVE_CAP_BPS;
  return absBps;
}

/** Advance `last` toward `now` by absorbBps/1e4 of the gap (signed). */
export function partialRatioAdvance(lastWad: bigint, nowWad: bigint, absorbBps: bigint): bigint {
  if (absorbBps === 0n) return lastWad;
  if (absorbBps >= BPS_DENOM) return nowWad;
  const gap = nowWad - lastWad;
  const delta = (gap * absorbBps) / BPS_DENOM;
  const next = lastWad + delta;
  return next <= 0n ? lastWad : next;
}

export function ratioReturnBps(lastWad: bigint, nowWad: bigint): bigint | null {
  if (lastWad === 0n) return null;
  return ((nowWad - lastWad) * BPS_DENOM) / lastWad;
}

export interface ImpliedMarket {
  /** USDC per A, WAD-scaled. */
  priceAWad: bigint;
  /** USDC per B, WAD-scaled. */
  priceBWad: bigint;
  /** supply_a · price_a (USDC units). */
  mcapA: bigint;
  /** supply_b · price_b. */
  mcapB: bigint;
  /** price_a / price_b, WAD-scaled — the leverage signal. */
  ratioWad: bigint;
}

/** Implied market from the four USDC-pool reserves + the two supplies. */
export function impliedMarket(
  aReserveInAUsdc: bigint,
  usdcReserveInAUsdc: bigint,
  bReserveInBUsdc: bigint,
  usdcReserveInBUsdc: bigint,
  supplyA: bigint,
  supplyB: bigint,
): ImpliedMarket | null {
  if (aReserveInAUsdc === 0n || bReserveInBUsdc === 0n) return null;
  const priceA = (usdcReserveInAUsdc * WAD) / aReserveInAUsdc;
  const priceB = (usdcReserveInBUsdc * WAD) / bReserveInBUsdc;
  if (priceB === 0n) return null;
  const ratioWad = (priceA * WAD) / priceB;
  const mcapA = (supplyA * priceA) / WAD;
  const mcapB = (supplyB * priceB) / WAD;
  return { priceAWad: priceA, priceBWad: priceB, mcapA, mcapB, ratioWad };
}

export interface RebalancePlan {
  side: Side;
  /** Loser to mint into the A/B (pair) pool. */
  amountPairPool: bigint;
  /** Loser to mint into the loser/USDC pool. */
  amountUsdcPool: bigint;
  /** Effective (clamped) leverage used, bps. */
  leverageBps: bigint;
  /** Absolute ratio move, bps (un-clamped — what trips the breaker). */
  absReturnBps: bigint;
  /** True when the circuit breaker zeroed the mint. */
  breakerTripped: boolean;
}

/**
 * Plan a rebalance from the implied market — the oracle-free path the hook +
 * crank take (plan_from_market in the program). Loser = whichever side the A/B
 * ratio moved against since `lastRatioWad`. Returns null on a flat ratio.
 */
export function planFromMarket(args: {
  lastRatioWad: bigint;
  market: ImpliedMarket;
  reserveAInPair: bigint;
  reserveBInPair: bigint;
  reserveAInAUsdc: bigint;
  reserveBInBUsdc: bigint;
  supplyA: bigint;
  supplyB: bigint;
  userLeverageBps: bigint;
  lMinBps: bigint;
  lMaxBps: bigint;
  maxMintBps: bigint;
  breakerBps: bigint;
}): RebalancePlan | null {
  const r = ratioReturnBps(args.lastRatioWad, args.market.ratioWad);
  if (r === null || r === 0n) return null;
  const side = r < 0n ? Side.A : Side.B;
  const absBps = abs(r);
  const sizedBps = clampCrankMoveBps(absBps);

  const pairReserve = side === Side.A ? args.reserveAInPair : args.reserveBInPair;
  const usdcPoolReserve = side === Side.A ? args.reserveAInAUsdc : args.reserveBInBUsdc;
  const supply = side === Side.A ? args.supplyA : args.supplyB;

  // 0 ⇒ full band (hook/crank default), clamped then elastically capped.
  const pick = args.userLeverageBps === 0n ? args.lMaxBps : args.userLeverageBps;
  const user = clampLeverageBps(pick, args.lMinBps, args.lMaxBps);
  const elastic = elasticLeverageBps(args.lMinBps, args.lMaxBps, pairReserve, supply);
  const leverageBps = user < elastic ? user : elastic;

  if (args.breakerBps !== 0n && absBps >= args.breakerBps) {
    return { side, amountPairPool: 0n, amountUsdcPool: 0n, leverageBps, absReturnBps: absBps, breakerTripped: true };
  }

  const amountPairPool = loserMintAmount(pairReserve, sizedBps, leverageBps, args.maxMintBps, 0n);
  const amountUsdcPool = loserMintAmount(usdcPoolReserve, sizedBps, leverageBps, args.maxMintBps, 0n);
  return { side, amountPairPool, amountUsdcPool, leverageBps, absReturnBps: absBps, breakerTripped: false };
}
