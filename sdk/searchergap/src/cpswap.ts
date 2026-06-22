/**
 * Raydium CP-Swap constant-product math (x·y=k) in BigInt, plus the
 * mint-into-vault "donation" price effect the rebalance uses.
 */

/** Default CP-Swap trade fee on these pools (bps). Read tradeFeeBps from the
 *  pool when you have it; 25 bps is the Raydium CP default. */
export const DEFAULT_FEE_BPS = 25n;

/**
 * Output of a single CP-Swap hop. `out = Rout·dx·(1−f) / (Rin + dx·(1−f))`.
 * Fee is taken on the input. Returns 0n for non-positive / empty inputs.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint = DEFAULT_FEE_BPS,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  // Guard nonsense fees (>=100%) so a bad input can never produce a negative
  // "in after fee" and fabricate phantom output.
  const fee = feeBps < 0n ? 0n : feeBps >= 10_000n ? 9_999n : feeBps;
  const inAfterFee = amountIn * (10_000n - fee);
  const num = reserveOut * inAfterFee;
  const den = reserveIn * 10_000n + inAfterFee;
  return num / den;
}

/** Input required to receive `amountOut` from a CP-Swap hop (inverse of above). */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint = DEFAULT_FEE_BPS,
): bigint {
  if (amountOut <= 0n || amountOut >= reserveOut || reserveIn <= 0n) return 0n;
  const num = reserveIn * amountOut * 10_000n;
  const den = (reserveOut - amountOut) * (10_000n - feeBps);
  return num / den + 1n;
}

/**
 * Spot mid price of `token` priced in the other reserve (WAD-scaled), ignoring
 * fees/slippage. price = otherReserve / tokenReserve.
 */
export function spotPriceWad(tokenReserve: bigint, otherReserve: bigint, wad: bigint = 1_000_000_000n): bigint {
  if (tokenReserve === 0n) return 0n;
  return (otherReserve * wad) / tokenReserve;
}

/**
 * The rebalance does NOT swap — it MintTo's `minted` of the loser straight into
 * the pool vault (reserveIn grows, the other reserve is untouched). This returns
 * the post-donation price of the donated side and the fractional drop, matching
 * the on-chain dilution exactly.
 *
 * priceBefore = other / reserve ; priceAfter = other / (reserve + minted)
 * dropFracWad = minted / (reserve + minted)  (WAD-scaled)
 */
export function donatePriceEffect(
  reserve: bigint,
  otherReserve: bigint,
  minted: bigint,
  wad: bigint = 1_000_000_000n,
): { priceBeforeWad: bigint; priceAfterWad: bigint; dropFracWad: bigint } {
  const priceBeforeWad = spotPriceWad(reserve, otherReserve, wad);
  const newReserve = reserve + minted;
  const priceAfterWad = newReserve === 0n ? 0n : (otherReserve * wad) / newReserve;
  const dropFracWad = newReserve === 0n ? 0n : (minted * wad) / newReserve;
  return { priceBeforeWad, priceAfterWad, dropFracWad };
}

/**
 * Ternary-search the input that maximises profit (out − in) for a monotone-then-
 * unimodal payoff (true for a chain of CP-Swap hops). `payoff(dx)` returns the
 * final output for input `dx`; profit = payoff(dx) − dx. Searches [0, hi].
 */
export function optimalInput(
  payoff: (dx: bigint) => bigint,
  hi: bigint,
  iterations = 200,
): { input: bigint; output: bigint; profit: bigint } {
  let lo = 0n;
  let hiB = hi;
  const profitAt = (dx: bigint): bigint => payoff(dx) - dx;
  for (let i = 0; i < iterations && hiB - lo > 1n; i++) {
    const m1 = lo + (hiB - lo) / 3n;
    const m2 = hiB - (hiB - lo) / 3n;
    if (profitAt(m1) < profitAt(m2)) lo = m1 + 1n;
    else hiB = m2 - 1n;
  }
  // scan the small remaining window for the exact max
  let best = lo;
  let bestProfit = profitAt(lo);
  for (let dx = lo; dx <= hiB; dx++) {
    const p = profitAt(dx);
    if (p > bestProfit) {
      bestProfit = p;
      best = dx;
    }
  }
  return { input: best, output: payoff(best), profit: bestProfit };
}
