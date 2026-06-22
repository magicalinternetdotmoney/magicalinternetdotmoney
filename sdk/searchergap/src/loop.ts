/**
 * The searcher loop, as a first-class SDK function (not a copy-paste example).
 * `scanOnce` does one pass; `runLoop` polls. Dry-run builds + simulates and
 * NEVER sends; live signs with the keeper you pass and sends. The SDK only
 * signs when YOU hand it a Keypair and set `live: true`.
 */

import { Connection, Keypair } from "@solana/web3.js";
import { discoverMarkets, readTriangle, type Market } from "./markets";
import { triangleGap, externalGap } from "./gap";
import { loadAmmConfigs, buildTriangleArbIxs, jitoTipIx, buildUnsignedTx } from "./executor";
import { jupiterFairVsUsdc, type JupiterOpts } from "./jupiter";

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
        for (const leg of [ext.legA, ext.legB]) {
          if (leg?.action && leg.profitUsdc >= minProfit) {
            log(`XVENUE ${m.config.toBase58().slice(0, 8)} leg${leg.leg} ${leg.action} ${leg.devBps.toFixed(0)}bps vs Jupiter → est ${usd(leg.profitUsdc)}`);
            hits.push({
              market: m.config.toBase58(), direction: `xvenue:${leg.leg}:${leg.action}`,
              inputUsdc: leg.optimalIn, profitUsdc: leg.profitUsdc, profitBps: Math.round(leg.devBps),
            });
          }
        }
      } catch { /* jup rate-limit / no route — skip this tick */ }
    }

    const gap = triangleGap(reserves, m.tradeFeeBps);
    if (!gap.direction || gap.profitUsdc < minProfit) continue;

    log(`GAP ${m.config.toBase58().slice(0, 8)} ${gap.direction} in=${usd(gap.inputUsdc)} → profit=${usd(gap.profitUsdc)} (${gap.profitBps}bps)`);

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

    const hit: ScanHit = {
      market: m.config.toBase58(), direction: gap.direction,
      inputUsdc: gap.inputUsdc, profitUsdc: gap.profitUsdc, profitBps: gap.profitBps,
    };
    if (opts.live && keeper) {
      tx.sign([keeper]);
      hit.txid = await connection.sendRawTransaction(tx.serialize());
      log(`  sent: ${hit.txid}`);
    } else {
      const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      hit.simErr = sim.value.err;
      log(`  dry-run sim err: ${JSON.stringify(sim.value.err)}`);
    }
    hits.push(hit);
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
