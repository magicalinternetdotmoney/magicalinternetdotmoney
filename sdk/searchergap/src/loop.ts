/**
 * The searcher loop, as a first-class SDK function (not a copy-paste example).
 * `scanOnce` does one pass; `runLoop` polls. Dry-run builds + simulates and
 * NEVER sends; live signs with the keeper you pass and sends. The SDK only
 * signs when YOU hand it a Keypair and set `live: true`.
 */

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { discoverMarkets, readTriangle, readConfig, readCrawlAggregate, type Market } from "./markets";
import { triangleGap, externalGap } from "./gap";
import { loadAmmConfigs, buildTriangleArbIxs, jitoTipIx, buildUnsignedTx, priceCrawlPda } from "./executor";
import { jupiterFairVsUsdc, setJupiterRatePerSec, type JupiterOpts } from "./jupiter";
import { buildCrossVenueArb, buildCrankArbBundle, buildCrankCaptureBundle } from "./crossvenue";
import { planTwoPoolFromOracleWad, Side } from "./leverage-math";
import { createDashboard, type DashboardSink } from "./dashboard";
import { pLimit } from "./limit";

export interface LoopOpts {
  /** minimum USDC profit (atoms) to act on. default 50_000 ($0.05). */
  minProfitUsdcAtoms?: bigint;
  /** sign with `keeper` and send. default false (dry-run: simulate only). */
  live?: boolean;
  /** required when live. */
  keeper?: Keypair | null;
  /** Jito tip lamports. default 10_000. */
  tipLamports?: number;
  /** poll interval for runLoop. default 4000ms. */
  pollMs?: number;
  /** log sink. default console.log (or dashboard when TTY). */
  log?: (msg: string) => void;
  /** in-place terminal dashboard (default on when stdout is a TTY). --plain disables. */
  dashboard?: boolean;
  /** internal: shared dashboard instance across ticks (set by runLoop). */
  dash?: DashboardSink;
  /** also hunt the cross-venue surface: price each leg vs Jupiter's best route.
   *  set `{}` for free Lite, or `{ apiKey }` (dev.jup.ag) for Ultra limits. */
  jupiter?: JupiterOpts & { enabled?: boolean; ratePerSec?: number };
  /** how many markets to scan in parallel. default 4. RPC fan-out is bounded by
   *  this; Jupiter QPS is bounded separately by `jupiter.ratePerSec`. */
  concurrency?: number;
}

export interface ScanHit {
  market: string;
  direction: string;
  inputUsdc: bigint;
  profitUsdc: bigint;
  profitBps: number;
  /** dry-run: the simulate error (null = would succeed). live: undefined. */
  simErr?: unknown;
  /** live: the sent tx signature. */
  txid?: string;
}

const usd = (n: bigint) => "$" + (Number(n) / 1e6).toFixed(4);

/**
 * Size search: the analytic "optimal" ignores Jupiter/route slippage and
 * over-sizes, so a bundle reverts. Try `start`, then halve, halve, halve down
 * to `floor`, SIMULATING each, and take the largest size that actually clears
 * the profit guard. Then send (live) the sim-confirmed winner. Never sends a
 * reverting tx.
 */
async function searchAndSend(
  connection: Connection,
  opts: LoopOpts,
  dash: DashboardSink,
  marketId: string,
  label: string,
  build: (amountInUsdc: bigint) => Promise<VersionedTransaction | null>,
  start: bigint,
  floor: bigint,
  maxTries = 8,
  /** how to render the search amount — usd for USDC sizes, raw for token atoms. */
  fmt: (a: bigint) => string = usd,
): Promise<{ ok: boolean; amount?: bigint; txid?: string }> {
  let amount = start;
  for (let i = 0; i < maxTries && amount >= floor; i++) {
    dash.setProbe(label, `${fmt(amount)} · try ${i + 1}/${maxTries}`);
    let tx: VersionedTransaction | null = null;
    try { tx = await build(amount); } catch (e) {
      dash.setProbe(label, `build err · ${(e as Error).message.slice(0, 40)}`);
      amount /= 2n;
      continue;
    }
    if (!tx) { amount /= 2n; continue; }
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (!sim.value.err) {
      dash.clearProbe();
      if (opts.live && opts.keeper) {
        tx.sign([opts.keeper]);
        const txid = await connection.sendRawTransaction(tx.serialize());
        dash.recordSend(marketId, label, txid);
        return { ok: true, amount, txid };
      }
      dash.recordSend(marketId, label);
      return { ok: true, amount };
    }
    dash.setProbe(label, `${fmt(amount)} reverts · halving`);
    amount /= 2n;
  }
  dash.noteSkip(label, `no size ≥ ${fmt(floor)}`);
  return { ok: false };
}

let scanTick = 0;

/** One pass over all markets. Returns the hits that cleared `minProfit`. */
export async function scanOnce(connection: Connection, opts: LoopOpts = {}): Promise<ScanHit[]> {
  const minProfit = opts.minProfitUsdcAtoms ?? 50_000n;
  const keeper = opts.keeper ?? null;
  if (opts.live && !keeper) throw new Error("live mode requires a keeper Keypair");
  const payerOf = (m: Market) => keeper?.publicKey ?? m.config; // dry-run: never signed

  const useDash = opts.dashboard ?? process.stdout.isTTY;
  const dash = opts.dash ?? createDashboard({
    plain: !useDash,
    connection: useDash ? connection : null,
    owner: keeper?.publicKey.toBase58() ?? null,
  });

  const hits: ScanHit[] = [];
  const markets = await discoverMarkets(connection);
  scanTick++;
  dash.scanStart(markets.length, scanTick);

  // Scan every market in parallel, bounded by `concurrency` (RPC fan-out). Each
  // market's Jupiter calls funnel through the shared QPS gate in jupiter.ts, so
  // raising concurrency never breaches your Jupiter rate limit.
  const limit = pLimit(opts.concurrency ?? 4);
  const scanMarket = async (m: Market): Promise<ScanHit[]> => {
    const localHits: ScanHit[] = [];
    const id = m.config.toBase58().slice(0, 8);
    const fullId = m.config.toBase58();
    let reserves;
    try { reserves = await readTriangle(connection, m); } catch {
      dash.setMarket(id, 0, "unreadable");
      return localHits;
    }
    const gap = triangleGap(reserves, m.tradeFeeBps);
    const tvl = (Number(reserves.aqUsdc) + Number(reserves.bqUsdc)) / 1e6;
    const tri = gap.direction ? `$${(Number(gap.profitUsdc) / 1e6).toFixed(4)} ${gap.direction}` : "coherent";
    dash.setMarket(id, tvl, tri);

    // WITHIN-PROTOCOL crank capture: the oracle-driven crank (oracleKind=2) fires
    // off the UNDERLYING move. Sell loser → crank (mints loser, price drops) → buy
    // back cheap, profit-guarded, using inventory you hold. No external venue.
    if (keeper) {
      try {
        const cfg = await readConfig(connection, m);
        const oracleNow = await readCrawlAggregate(connection, priceCrawlPda(m.config));
        const plan = oracleNow > 0n ? planTwoPoolFromOracleWad({
          oracleLastWad: cfg.oraclePriceLastWad, oracleNowWad: oracleNow,
          reserveAInPair: reserves.abA, reserveBInPair: reserves.abB,
          reserveAInAUsdc: reserves.aqA, reserveBInBUsdc: reserves.bqB,
          supplyA: reserves.supplyA, supplyB: reserves.supplyB,
          userLeverageBps: 0n, lMinBps: cfg.lMinBps, lMaxBps: cfg.lMaxBps,
          maxMintBps: cfg.maxMintBps, breakerBps: cfg.breakerBps,
        }) : null;
        if (plan && plan.amountUsdcPool > 0n) {
          const loser = plan.side === Side.A ? "A" : "B";
          const loserRes = loser === "A" ? reserves.aqA : reserves.bqB;
          dash.setProbe(`crank-cap ${loser}`, `${id} oracle ${plan.absReturnBps}bps`);
          const r = await searchAndSend(
            connection, opts, dash, fullId, `crank-cap ${loser}`,
            async (sold) => (await buildCrankCaptureBundle({
              connection, owner: keeper.publicKey, market: m, soldAtoms: sold,
              minProfitUsdc: minProfit, tipLamports: opts.tipLamports,
            })).tx ?? null,
            loserRes / 40n, loserRes / 4000n, 8,
            (a) => `${a.toString()} atoms`,
          );
          if (r.ok) localHits.push({ market: fullId, direction: `crank-cap:${loser}`, inputUsdc: r.amount ?? 0n, profitUsdc: minProfit, profitBps: Number(plan.absReturnBps), txid: r.txid });
        }
      } catch (e) { dash.noteSkip("crank-cap", (e as Error).message.slice(0, 40)); }
    }

    // cross-venue surface: each leg's protocol price vs Jupiter's best route.
    if (opts.jupiter?.enabled) {
      try {
        const probe = (r: bigint) => (r > 100n ? r / 100n : r); // ~1% of pool
        const [fairA, fairB] = await Promise.all([
          jupiterFairVsUsdc(m.mintA, m.quoteMint, probe(reserves.aqA), opts.jupiter).catch(() => 0),
          jupiterFairVsUsdc(m.mintB, m.quoteMint, probe(reserves.bqB), opts.jupiter).catch(() => 0),
        ]);
        const ext = externalGap(reserves, { fairPriceA: fairA || undefined, fairPriceB: fairB || undefined }, m.tradeFeeBps);
        const fairFor = (l: "A" | "B") => (l === "A" ? fairA : fairB);
        for (const leg of [ext.legA, ext.legB]) {
          if (!leg?.action || leg.profitUsdc < minProfit) continue;
          if (leg.action === "sell" && keeper) {
            const start = BigInt(Math.max(1, Math.floor(Number(leg.optimalIn) * fairFor(leg.leg))));
            const legId = leg.leg;
            dash.setProbe(`xvenue ${legId}`, `${id} ${leg.devBps.toFixed(0)}bps est ${usd(leg.profitUsdc)}`);
            const r = await searchAndSend(
              connection, opts, dash, fullId, `xvenue ${legId}`,
              async (amt) => (await buildCrossVenueArb({
                connection, owner: keeper.publicKey, market: m, leg: legId,
                amountInUsdc: amt, minProfitUsdc: minProfit, jupiter: opts.jupiter, tipLamports: opts.tipLamports,
              })).tx,
              start, 100_000n, // floor $0.10
            );
            if (r.ok) localHits.push({ market: fullId, direction: `xvenue:${legId}:sell`, inputUsdc: r.amount!, profitUsdc: leg.profitUsdc, profitBps: Math.round(leg.devBps), txid: r.txid });
          }
        }
      } catch { /* jup rate-limit / no route — skip this tick */ }
    }

    // manufacture-and-capture: fire the crank + arb the deterministic post-crank
    // state vs Jupiter, one bundle (needs a keeper to build for + Jupiter).
    if (keeper && opts.jupiter?.enabled) {
      try {
        const ca = await buildCrankArbBundle({
          connection, owner: keeper.publicKey, market: m,
          minProfitUsdc: minProfit, jupiter: opts.jupiter, tipLamports: opts.tipLamports,
        });
        if (!ca.noop && ca.tx) {
          dash.setProbe(`crank-arb ${ca.loser}`, `${id} est ${usd(ca.estProfitUsdc!)}`);
          const r = await searchAndSend(
            connection, opts, dash, fullId, `crank-arb ${ca.loser}`,
            async (amt) => (await buildCrankArbBundle({
              connection, owner: keeper.publicKey, market: m,
              minProfitUsdc: minProfit, amountInUsdc: amt, jupiter: opts.jupiter, tipLamports: opts.tipLamports,
            })).tx ?? null,
            ca.amountInUsdc!, 100_000n,
          );
          if (r.ok) localHits.push({ market: fullId, direction: `crank-arb:${ca.loser}`, inputUsdc: r.amount!, profitUsdc: ca.estProfitUsdc!, profitBps: 0, txid: r.txid });
        }
      } catch { /* skip this market this tick */ }
    }

    if (!gap.direction || gap.profitUsdc < minProfit) return localHits;

    dash.setProbe(`triangle ${gap.direction}`, `${id} est ${usd(gap.profitUsdc)}`);

    const ammConfigs = await loadAmmConfigs(connection, m);
    const payer = payerOf(m);
    const dir = gap.direction;
    const r = await searchAndSend(
      connection, opts, dash, fullId, `triangle ${dir}`,
      async (amt) => buildUnsignedTx(connection, payer, [
        ...buildTriangleArbIxs({ owner: payer, market: m, ammConfigs, reserves, direction: dir, amountIn: amt, minProfit }),
        jitoTipIx(payer, opts.tipLamports ?? 10_000),
      ]),
      gap.inputUsdc, 100_000n,
    );
    if (r.ok) localHits.push({ market: fullId, direction: dir, inputUsdc: r.amount!, profitUsdc: gap.profitUsdc, profitBps: gap.profitBps, txid: r.txid });
    return localHits;
  };

  const perMarket = await Promise.all(
    markets.map((m) => limit(() => scanMarket(m).catch((e) => { dash.setError((e as Error).message.slice(0, 60)); return [] as ScanHit[]; }))),
  );
  for (const hs of perMarket) hits.push(...hs);
  dash.clearProbe();
  dash.flush();
  return hits;
}

/** Poll `scanOnce` on an interval. Returns a `{ stop }` handle. */
export function runLoop(connection: Connection, opts: LoopOpts = {}): { stop: () => void } {
  const useDash = opts.dashboard ?? process.stdout.isTTY;
  const dash = createDashboard({
    plain: !useDash,
    connection: useDash ? connection : null,
    owner: opts.keeper?.publicKey.toBase58() ?? null,
  });
  const log = opts.log ?? ((m) => dash.plain(m));
  const pollMs = opts.pollMs ?? 4000;
  const minProfit = Number(opts.minProfitUsdcAtoms ?? 50_000n) / 1e6;
  const jupLabel = opts.jupiter?.enabled
    ? (opts.jupiter.apiKey ? "Jupiter Ultra" : "Jupiter Lite")
    : "no Jupiter";

  // Size the shared Jupiter QPS lane: keyed Ultra defaults to 10/s, free Lite to
  // ~1/s (override with jupiter.ratePerSec). Parallel scans share this one lane.
  if (opts.jupiter?.enabled) {
    setJupiterRatePerSec(opts.jupiter.ratePerSec ?? (opts.jupiter.apiKey ? 10 : 1));
  }

  if (!useDash) {
    log(`searchergap loop · ${opts.live ? "LIVE (signs+sends)" : "DRY-RUN"} · min profit ${minProfit} USDC · poll ${pollMs}ms`);
  }

  dash.setMeta({
    live: !!opts.live,
    keeper: opts.keeper?.publicKey.toBase58(),
    minProfitUsdc: minProfit,
    pollMs,
    jupiter: jupLabel,
  });
  dash.flush();

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    scanOnce(connection, { ...opts, dashboard: useDash, dash })
      .catch((e) => dash.setError(e.message))
      .finally(() => { running = false; });
  };
  tick();
  const id = setInterval(tick, pollMs);
  return {
    stop: () => {
      clearInterval(id);
      dash.stop();
    },
  };
}
