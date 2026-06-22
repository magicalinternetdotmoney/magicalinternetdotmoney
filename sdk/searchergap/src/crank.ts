/**
 * Permissionless rebalance crank bot — fires instruction tag 0 on a loop or cron.
 * Simulates first (oracle-crawl + triangle paths) so we don't burn fees on no-ops.
 */

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  discoverMarkets,
  readTriangle,
  readConfig,
  readCrawlAggregate,
  type Market,
} from "./markets";
import { simulateCrank } from "./gap";
import { planTwoPoolFromOracleWad } from "./leverage-math";
import { buildCrankIx, buildUnsignedTx, computeBudgetIxs, priceCrawlPda } from "./executor";

const ORACLE_CRAWL = 2;

export interface CrankOpts {
  /** 0 ⇒ config l_max. */
  leverageBps?: bigint;
  /** fire even when sim says flat. */
  force?: boolean;
  /** skip send when sim predicts a no-op (default true). */
  onlyWhenNeeded?: boolean;
  log?: (msg: string) => void;
}

export interface CrankResult {
  config: string;
  receiptMint: string;
  sent: boolean;
  noop?: string;
  txid?: string;
  err?: string;
}

async function crankWouldFire(
  connection: Connection,
  market: Market,
  opts: CrankOpts,
): Promise<{ fire: boolean; reason: string }> {
  const cfg = await readConfig(connection, market);
  if (cfg.paused) return { fire: false, reason: "paused" };

  const reserves = await readTriangle(connection, market);
  const lev = opts.leverageBps ?? 0n;

  if (cfg.oracleKind === ORACLE_CRAWL) {
    const crawl = priceCrawlPda(market.config);
    const agg = await readCrawlAggregate(connection, crawl);
    if (agg === 0n) return { fire: false, reason: "crawl-agg-zero" };
    const plan = planTwoPoolFromOracleWad({
      oracleLastWad: cfg.oraclePriceLastWad,
      oracleNowWad: agg,
      reserveAInPair: reserves.abA,
      reserveBInPair: reserves.abB,
      reserveAInAUsdc: reserves.aqA,
      reserveBInBUsdc: reserves.bqB,
      supplyA: reserves.supplyA,
      supplyB: reserves.supplyB,
      userLeverageBps: lev,
      lMinBps: cfg.lMinBps,
      lMaxBps: cfg.lMaxBps,
      maxMintBps: cfg.maxMintBps,
      breakerBps: cfg.breakerBps,
    });
    if (!plan) return { fire: false, reason: "flat-oracle" };
    if (plan.breakerTripped) return { fire: false, reason: "breaker" };
    if (plan.amountPairPool === 0n && plan.amountUsdcPool === 0n) return { fire: false, reason: "zero-mint" };
    return { fire: true, reason: `oracle-move-${plan.absReturnBps}bps-side-${plan.side}` };
  }

  const sim = simulateCrank({
    reserves,
    lastRatioWad: cfg.lastRatioWad,
    lMinBps: cfg.lMinBps,
    lMaxBps: cfg.lMaxBps,
    maxMintBps: cfg.maxMintBps,
    breakerBps: cfg.breakerBps,
    userLeverageBps: lev,
  });
  if (sim.noop) return { fire: false, reason: sim.noop };
  return { fire: true, reason: "ratio-gap" };
}

/** Sim-only preview — no tx built or sent. */
export async function previewCrank(
  connection: Connection,
  market: Market,
  opts: CrankOpts = {},
): Promise<CrankResult> {
  const base: CrankResult = {
    config: market.config.toBase58(),
    receiptMint: market.receiptMint.toBase58(),
    sent: false,
  };
  try {
    const { fire, reason } = await crankWouldFire(connection, market, opts);
    return fire ? { ...base, noop: `would-fire:${reason}` } : { ...base, noop: reason };
  } catch (e) {
    return { ...base, err: (e as Error).message || String(e) };
  }
}

export async function previewCrankAll(
  connection: Connection,
  opts: CrankOpts = {},
): Promise<CrankResult[]> {
  const markets = await discoverMarkets(connection);
  return Promise.all(markets.map((m) => previewCrank(connection, m, opts)));
}

/** Fire one rebalance crank for a single market. Signs with `keeper`. */
export async function crankMarket(
  connection: Connection,
  keeper: Keypair,
  market: Market,
  opts: CrankOpts = {},
): Promise<CrankResult> {
  const log = opts.log ?? console.log;
  const base: CrankResult = {
    config: market.config.toBase58(),
    receiptMint: market.receiptMint.toBase58(),
    sent: false,
  };

  try {
    if (!opts.force) {
      const { fire, reason } = await crankWouldFire(connection, market, opts);
      if (!fire && opts.onlyWhenNeeded !== false) {
        return { ...base, noop: reason };
      }
    }

    const cfg = await readConfig(connection, market);
    const crawl = cfg.oracleKind === ORACLE_CRAWL ? priceCrawlPda(market.config) : undefined;
    const crankIx = buildCrankIx({
      market,
      leverageBps: opts.leverageBps ?? 0n,
      priceCrawl: crawl,
    });
    const tx = await buildUnsignedTx(connection, keeper.publicKey, [
      ...computeBudgetIxs(1_400_000),
      crankIx,
    ]);

    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (sim.value.err) {
      return { ...base, err: JSON.stringify(sim.value.err) };
    }

    tx.sign([keeper]);
    const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(txid, "confirmed");
    log(`crank ok ${market.receiptMint} ${txid}`);
    return { ...base, sent: true, txid };
  } catch (e) {
    return { ...base, err: (e as Error).message || String(e) };
  }
}

/** One pass over every discovered market. */
export async function crankAll(
  connection: Connection,
  keeper: Keypair,
  opts: CrankOpts = {},
): Promise<CrankResult[]> {
  const markets = await discoverMarkets(connection);
  const out: CrankResult[] = [];
  for (const m of markets) {
    out.push(await crankMarket(connection, keeper, m, opts));
  }
  return out;
}

/** Long-running loop (or call once from cron via crankAll). */
export function runCrankLoop(
  connection: Connection,
  keeper: Keypair,
  opts: CrankOpts & { pollMs?: number } = {},
): void {
  const pollMs = opts.pollMs ?? 60_000;
  const log = opts.log ?? console.log;

  const tick = async () => {
    try {
      const rs = await crankAll(connection, keeper, opts);
      const sent = rs.filter((r) => r.sent).length;
      const skipped = rs.filter((r) => r.noop).length;
      const failed = rs.filter((r) => r.err).length;
      log(`crank tick · ${sent} sent · ${skipped} skip · ${failed} err · ${rs.length} markets`);
      for (const r of rs) {
        if (r.sent) log(`  ✓ ${r.receiptMint} ${r.txid}`);
        else if (r.err) log(`  ✗ ${r.receiptMint} ${r.err}`);
        else if (r.noop) log(`  – ${r.receiptMint} ${r.noop}`);
      }
    } catch (e) {
      log(`crank tick error: ${(e as Error).message}`);
    }
  };

  tick();
  setInterval(tick, pollMs);
}