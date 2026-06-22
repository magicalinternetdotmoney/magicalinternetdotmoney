/**
 * The searcher loop, as a first-class SDK function (not a copy-paste example).
 * `scanOnce` does one pass; `runLoop` polls. Dry-run builds + simulates and
 * NEVER sends; live signs with the keeper you pass and sends. The SDK only
 * signs when YOU hand it a Keypair and set `live: true`.
 */

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { discoverMarkets, readTriangle, type Market } from "./markets";
import { triangleGap, externalGap } from "./gap";
import { loadAmmConfigs, buildTriangleArbIxs, jitoTipIx, buildUnsignedTx } from "./executor";
import { jupiterFairVsUsdc, type JupiterOpts } from "./jupiter";
import { buildCrossVenueArb, buildCrankArbBundle } from "./crossvenue";

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
 * Simulate first, ALWAYS — only send a profit-guarded bundle if the simulation
 * actually clears. A reverting sim means the (slippage-blind) detection
 * over-estimated; we skip instead of burning a fee on a guaranteed revert.
 */
async function settle(
  connection: Connection,
  tx: VersionedTransaction,
  opts: LoopOpts,
  log: (m: string) => void,
  label: string,
): Promise<{ ok: boolean; err?: unknown; txid?: string }> {
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    log(`  ${label}: not profitable at size — guard reverts, skip`);
    return { ok: false, err: sim.value.err };
  }
  if (opts.live && opts.keeper) {
    tx.sign([opts.keeper]);
    const txid = await connection.sendRawTransaction(tx.serialize());
    log(`  ${label}: ✓ sim-confirmed PROFIT → sent ${txid}`);
    return { ok: true, txid };
  }
  log(`  ${label}: ✓ sim-confirmed PROFIT (dry-run — would send)`);
  return { ok: true };
}

/** One pass over all markets. Returns the hits that cleared `minProfit`. */
export async function scanOnce(connection: Connection, opts: LoopOpts = {}): Promise<ScanHit[]> {
  const minProfit = opts.minProfitUsdcAtoms ?? 50_000n;
  const log = opts.log ?? ((m) => console.log(m));
  const keeper = opts.keeper ?? null;
  if (opts.live && !keeper) throw new Error("live mode requires a keeper Keypair");
  const payerOf = (m: Market) => keeper?.publicKey ?? m.config; // dry-run: never signed

  const hits: ScanHit[] = [];
  for (const m of await discoverMarkets(connection)) {
    let reserves;
    try { reserves = await readTriangle(connection, m); } catch { continue; }

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
            try {
              const amountInUsdc = BigInt(Math.max(1, Math.floor(Number(leg.optimalIn) * fairFor(leg.leg))));
              const arb = await buildCrossVenueArb({
                connection, owner: keeper.publicKey, market: m, leg: leg.leg,
                amountInUsdc, minProfitUsdc: minProfit, jupiter: opts.jupiter, tipLamports: opts.tipLamports,
              });
              const r = await settle(connection, arb.tx, opts, log, `xvenue ${leg.leg}`);
              if (r.ok) hits.push({ market: m.config.toBase58(), direction: `xvenue:${leg.leg}:${leg.action}`, inputUsdc: amountInUsdc, profitUsdc: leg.profitUsdc, profitBps: Math.round(leg.devBps), txid: r.txid });
            } catch (e) { log(`  xvenue build skipped: ${(e as Error).message.slice(0, 120)}`); }
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
          const r = await settle(connection, ca.tx, opts, log, `crank-arb ${ca.loser}`);
          if (r.ok) hits.push({ market: m.config.toBase58(), direction: `crank-arb:${ca.loser}`, inputUsdc: ca.amountInUsdc!, profitUsdc: ca.estProfitUsdc!, profitBps: 0, txid: r.txid });
        }
      } catch { /* skip this market this tick */ }
    }

    const gap = triangleGap(reserves, m.tradeFeeBps);
    if (!gap.direction || gap.profitUsdc < minProfit) continue;

    log(`TRIANGLE? ${m.config.toBase58().slice(0, 8)} ${gap.direction} in=${usd(gap.inputUsdc)} (candidate, est ${usd(gap.profitUsdc)} / ${gap.profitBps}bps)`);

    const ammConfigs = await loadAmmConfigs(connection, m);
    const payer = payerOf(m);
    const ixs = [
      ...buildTriangleArbIxs({
        owner: payer, market: m, ammConfigs, reserves,
        direction: gap.direction, amountIn: gap.inputUsdc, minProfit,
      }),
      jitoTipIx(payer, opts.tipLamports ?? 10_000),
    ];
    const tx = await buildUnsignedTx(connection, payer, ixs);
    const r = await settle(connection, tx, opts, log, `triangle ${gap.direction}`);
    if (r.ok) hits.push({ market: m.config.toBase58(), direction: gap.direction, inputUsdc: gap.inputUsdc, profitUsdc: gap.profitUsdc, profitBps: gap.profitBps, txid: r.txid });
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
