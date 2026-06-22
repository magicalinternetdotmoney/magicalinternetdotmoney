/**
 * @magicalinternet/searchergap
 *
 * Searcher SDK for Magical Internet Money — the leveraged-synthetic CP-Swap
 * triangle (+leg/USDC, −leg/USDC, +leg/−leg) with an oracle-free, "mint-the-
 * loser" rebalance fired by a Token-2022 receipt transfer hook.
 *
 * This SDK gives a bot everything it needs to find and size the gaps:
 *  - discoverMarkets / readTriangle — on-chain state
 *  - triangleGap — riskless cyclic arb across the three pools
 *  - simulateCrank — what a receipt-transfer / crank would mint + the price drop
 *  - pegGap — leg vs an external fair price (pluggable feed)
 *
 * All amount math is BigInt and matches the on-chain integer semantics exactly.
 */

import { Connection } from "@solana/web3.js";
import { discoverMarkets, readTriangle, type Market, type TriangleReserves } from "./markets";
import { triangleGap, pegGap, simulateCrank, type TriangleGap } from "./gap";
import { impliedMarket, type ImpliedMarket } from "./leverage-math";

export * from "./leverage-math";
export * from "./cpswap";
export * from "./markets";
export * from "./gap";
export * from "./executor";
export * from "./loop";
export * from "./jupiter";

export interface MarketScan {
  market: Market;
  reserves: TriangleReserves;
  implied: ImpliedMarket | null;
  triangle: TriangleGap;
}

/** Read a market's triangle and compute its pure-on-chain gaps (triangle + implied market). */
export async function scanMarket(connection: Connection, market: Market): Promise<MarketScan> {
  const reserves = await readTriangle(connection, market);
  const implied = impliedMarket(
    reserves.aqA, reserves.aqUsdc, reserves.bqB, reserves.bqUsdc, reserves.supplyA, reserves.supplyB,
  );
  return { market, reserves, implied, triangle: triangleGap(reserves, market.tradeFeeBps) };
}

/** Discover + scan every market. Markets whose reserves can't be read (thin /
 *  partially-created pools) are skipped rather than failing the whole scan. */
export async function scanAll(connection: Connection): Promise<MarketScan[]> {
  const markets = await discoverMarkets(connection);
  const settled = await Promise.allSettled(markets.map((m) => scanMarket(connection, m)));
  return settled
    .filter((r): r is PromiseFulfilledResult<MarketScan> => r.status === "fulfilled")
    .map((r) => r.value);
}

export { triangleGap, pegGap, simulateCrank };
