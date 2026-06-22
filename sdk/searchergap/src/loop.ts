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
import { jupiterFairVsUsdc, type JupiterOpts } from "./jupiter";
import { buildCrossVenueArb, buildCrankArbBundle, buildCrankCaptureBundle } from "./crossvenue";
import { planTwoPoolFromOracleWad, Side } from "./leverage-math";

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
  /** log sink. default console.log. */
  log?: (msg: string) => void;
  /** also hunt the cross-venue surface: price each leg vs Jupiter's best route.
   *  set `{}` for free Lite, or `{ apiKey }` (dev.jup.ag) for Ultra limits. */
  jupiter?: JupiterOpts & { enabled?: boolean };
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
  log: (m: string) => void,
  label: string,
  build: (amountInUsdc: bigint) => Promise<VersionedTransaction | null>,
  start: bigint,
  floor: bigint,
  maxTries = 8,
): Promise<{ ok: boolean; amount?: bigint; txid?: string }> {
  let amount = start;
  for (let i = 0; i < maxTries && amount >= floor; i++) {
    let tx: VersionedTransaction | null = null;
    try { tx = await build(amount); } catch (e) { log(`  ${label} @ ${usd(amount)}: build err ${(e as Error).message.slice(0, 60)}`); amount /= 2n; continue; }
    if (!tx) { amount /= 2n; continue; }
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (!sim.value.err) {
      if (opts.live && opts.keeper) {
        tx.sign([opts.keeper]);
        const txid = await connection.sendRawTransaction(tx.serialize());
        log(`  ${label}: ✓ PROFIT at ${usd(amount)} → sent ${txid}`);
        return { ok: true, amount, txid };
      }
      log(`  ${label}: ✓ PROFIT at ${usd(amount)} (dry-run — would send)`);
      return { ok: true, amount };
    }
    log(`  ${label} @ ${usd(amount)}: reverts → halving`);
    amount /= 2n;
  }
  log(`  ${label}: no profitable size down to ${usd(floor)} — skip`);
  return { ok: false };
}

/** One pass over all markets. Returns the hits that cleared `minProfit`. */
export async function scanOnce(connection: Connection, opts: LoopOpts = {}): Promise<ScanHit[]> {
  const minProfit = opts.minProfitUsdcAtoms ?? 50_000n;
  const log = opts.log ?? ((m) => console.log(m));
  const keeper = opts.keeper ?? null;
  if (opts.live && !keeper) throw new Error("live mode requires a keeper Keypair");
  const payerOf = (m: Market) => keeper?.publicKey ?? m.config; // dry-run: never signed

  const hits: ScanHit[] = [];
  const markets = await discoverMarkets(connection);
  log(`— scanning ${markets.length} markets —`);
  for (const m of markets) {
    const id = m.config.toBase58().slice(0, 8);
    let reserves;
    try { reserves = await readTriangle(connection, m); } catch { log(`· ${id}: unreadable, skip`); continue; }
    const gap = triangleGap(reserves, m.tradeFeeBps);
    log(`· ${id}  tvl≈$${((Number(reserves.aqUsdc) + Number(reserves.bqUsdc)) / 1e6).toFixed(0)}  triangle:${gap.direction ? "$" + (Number(gap.profitUsdc) / 1e6).toFixed(4) + " " + gap.direction : "coherent"}`);

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
          log(`CRANK-CAP? ${id} loser${loser} oracleMove=${plan.absReturnBps}bps → sell→crank→buyback`);
          const r = await searchAndSend(
            connection, opts, log, `crank-cap ${loser}`,
            async (sold) => (await buildCrankCaptureBundle({
              connection, owner: keeper.publicKey, market: m, soldAtoms: sold,
              minProfitUsdc: minProfit, tipLamports: opts.tipLamports,
            })).tx ?? null,
            loserRes / 40n, loserRes / 4000n,
          );
          if (r.ok) hits.push({ market: m.config.toBase58(), direction: `crank-cap:${loser}`, inputUsdc: r.amount ?? 0n, profitUsdc: minProfit, profitBps: Number(plan.absReturnBps), txid: r.txid });
        }
      } catch (e) { log(`  crank-cap skipped: ${(e as Error).message.slice(0, 80)}`); }
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
          // candidate only — the analytic est ignores slippage; simulation decides.
          log(`XVENUE? ${m.config.toBase58().slice(0, 8)} leg${leg.leg} ${leg.action} ${leg.devBps.toFixed(0)}bps vs Jupiter (candidate, est ${usd(leg.profitUsdc)})`);
          // SELL side is the hard-guarded one: Jupiter buy → protocol sell (last).
          if (leg.action === "sell" && keeper) {
            const start = BigInt(Math.max(1, Math.floor(Number(leg.optimalIn) * fairFor(leg.leg))));
            const legId = leg.leg;
            const r = await searchAndSend(
              connection, opts, log, `xvenue ${legId}`,
              async (amt) => (await buildCrossVenueArb({
                connection, owner: keeper.publicKey, market: m, leg: legId,
                amountInUsdc: amt, minProfitUsdc: minProfit, jupiter: opts.jupiter, tipLamports: opts.tipLamports,
              })).tx,
              start, 100_000n, // floor $0.10
            );
            if (r.ok) hits.push({ market: m.config.toBase58(), direction: `xvenue:${legId}:sell`, inputUsdc: r.amount!, profitUsdc: leg.profitUsdc, profitBps: Math.round(leg.devBps), txid: r.txid });
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
          log(`CRANK-ARB? ${m.config.toBase58().slice(0, 8)} loser${ca.loser} in=${usd(ca.amountInUsdc!)} (candidate, est ${usd(ca.estProfitUsdc!)})`);
          const r = await searchAndSend(
            connection, opts, log, `crank-arb ${ca.loser}`,
            async (amt) => (await buildCrankArbBundle({
              connection, owner: keeper.publicKey, market: m,
              minProfitUsdc: minProfit, amountInUsdc: amt, jupiter: opts.jupiter, tipLamports: opts.tipLamports,
            })).tx ?? null,
            ca.amountInUsdc!, 100_000n,
          );
          if (r.ok) hits.push({ market: m.config.toBase58(), direction: `crank-arb:${ca.loser}`, inputUsdc: r.amount!, profitUsdc: ca.estProfitUsdc!, profitBps: 0, txid: r.txid });
        }
      } catch { /* skip this market this tick */ }
    }

    if (!gap.direction || gap.profitUsdc < minProfit) continue;

    log(`TRIANGLE? ${id} ${gap.direction} in=${usd(gap.inputUsdc)} (candidate, est ${usd(gap.profitUsdc)} / ${gap.profitBps}bps)`);

    const ammConfigs = await loadAmmConfigs(connection, m);
    const payer = payerOf(m);
    const dir = gap.direction;
    const r = await searchAndSend(
      connection, opts, log, `triangle ${dir}`,
      async (amt) => buildUnsignedTx(connection, payer, [
        ...buildTriangleArbIxs({ owner: payer, market: m, ammConfigs, reserves, direction: dir, amountIn: amt, minProfit }),
        jitoTipIx(payer, opts.tipLamports ?? 10_000),
      ]),
      gap.inputUsdc, 100_000n,
    );
    if (r.ok) hits.push({ market: m.config.toBase58(), direction: dir, inputUsdc: r.amount!, profitUsdc: gap.profitUsdc, profitBps: gap.profitBps, txid: r.txid });
  }
  return hits;
}

/** Poll `scanOnce` on an interval. Returns a `{ stop }` handle. */
export function runLoop(connection: Connection, opts: LoopOpts = {}): { stop: () => void } {
  const log = opts.log ?? ((m) => console.log(m));
  const pollMs = opts.pollMs ?? 4000;
  log(`searchergap loop · ${opts.live ? "LIVE (signs+sends)" : "DRY-RUN"} · min profit ${Number(opts.minProfitUsdcAtoms ?? 50_000n) / 1e6} USDC · poll ${pollMs}ms`);
  const tick = () => scanOnce(connection, opts).catch((e) => log(`tick error: ${e.message}`));
  tick();
  const id = setInterval(tick, pollMs);
  return { stop: () => clearInterval(id) };
}
