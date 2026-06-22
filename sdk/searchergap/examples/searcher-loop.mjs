#!/usr/bin/env node
// examples/searcher-loop.mjs — minimal searchergap profit loop.
//
//   DRY-RUN (default): scan → build → SIMULATE. Never sends. Safe to run now.
//     RPC_URL=https://… node searcher-loop.mjs
//
//   LIVE: signs with your keeper + sends. YOU run this; the SDK never signs.
//     RPC_URL=https://… KEYPAIR=~/keeper.json node searcher-loop.mjs --live
//
// The arb bundle's final hop is profit-guarded (min_out = amountIn + minProfit),
// so a live send REVERTS unless it actually clears profit — you don't buy a bad
// fill. For real MEV you'd submit as a Jito bundle (atomic, no revert cost);
// sendRawTransaction here is the simplest illustration.
//
// Honest note: today every live market is thin + coherent, so this prints
// "no gaps" — it's wired for WHEN liquidity and opportunities arrive.

import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import * as sg from "@magicalinternet/searchergap";

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const LIVE = process.argv.includes("--live");
const MIN_PROFIT = BigInt(process.env.MIN_PROFIT_USDC_ATOMS || "50000"); // $0.05
const POLL_MS = Number(process.env.POLL_MS || 4000);

const conn = new Connection(RPC, "confirmed");
const keeper = LIVE
  ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.KEYPAIR, "utf8"))))
  : null;
// dry-run needs *some* payer pubkey to build/serialize a tx; use the keeper if
// live, else any valid pubkey (the market config) — it's never signed in dry-run.
const payerFor = (m) => keeper?.publicKey ?? m.config;

async function tick() {
  for (const m of await sg.discoverMarkets(conn)) {
    let reserves;
    try { reserves = await sg.readTriangle(conn, m); } catch { continue; }

    const gap = sg.triangleGap(reserves, m.tradeFeeBps);
    if (!gap.direction || gap.profitUsdc < MIN_PROFIT) continue; // nothing worth it

    const usd = (n) => "$" + (Number(n) / 1e6).toFixed(4);
    console.log(`GAP ${m.config.toBase58().slice(0, 8)} ${gap.direction} ` +
      `in=${usd(gap.inputUsdc)} → profit=${usd(gap.profitUsdc)} (${gap.profitBps}bps)`);

    const ammConfigs = await sg.loadAmmConfigs(conn, m);
    const payer = payerFor(m);
    const ixs = [
      ...sg.buildTriangleArbIxs({
        owner: payer, market: m, ammConfigs, reserves,
        direction: gap.direction, amountIn: gap.inputUsdc, minProfit: MIN_PROFIT,
      }),
      sg.jitoTipIx(payer, 10_000),
    ];
    const tx = await sg.buildUnsignedTx(conn, payer, ixs);

    if (!LIVE) {
      const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      console.log("  dry-run sim err:", JSON.stringify(sim.value.err));
      continue;
    }
    // LIVE — you sign + send. (Prefer a Jito bundle in production.)
    tx.sign([keeper]);
    const txid = await conn.sendRawTransaction(tx.serialize());
    console.log("  sent:", txid);
  }
}

console.log(`searchergap loop · ${LIVE ? "LIVE (signs+sends)" : "DRY-RUN"} · ` +
  `min profit ${Number(MIN_PROFIT) / 1e6} USDC · poll ${POLL_MS}ms`);
const loop = () => tick().catch((e) => console.error("tick error:", e.message));
loop();
setInterval(loop, POLL_MS);
