#!/usr/bin/env node
// Assert config mint_a = long (+), mint_b = inverse (−) on every live pair.
"use strict";
const web3 = require("@solana/web3.js");
const txbuild = require("./txbuild.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";

const PAIR_HINTS = {
  "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB": { sym: "3xSOL", name: "3x SOL LP", underlyingSymbol: "SOL" },
  "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG": { sym: "5xBTC", name: "5x BTC LP", underlyingSymbol: "cbBTC" },
};

function signOk(symbol, want) {
  if (!symbol) return { ok: false, reason: "missing symbol" };
  const s = symbol.trim();
  if (want === "+") return s.startsWith("+") ? { ok: true } : { ok: false, reason: "expected +" + " prefix, got " + s };
  return (s.startsWith("-") || s.startsWith("−")) ? { ok: true } : { ok: false, reason: "expected − prefix, got " + s };
}

async function verifyPair(conn, pair) {
  const h = PAIR_HINTS[pair.receiptMint] || {};
  const labeled = Object.assign({}, pair, {
    sym: h.sym || pair.sym || (Math.round(pair.levMax || 5) + "x" + (h.underlyingSymbol || "asset")),
    name: h.name || pair.name,
    underlyingSymbol: h.underlyingSymbol || pair.underlyingSymbol,
  });
  const [ma, mb, mr] = await Promise.all([
    txbuild.readMintMeta(conn, pair.mintA, false),
    txbuild.readMintMeta(conn, pair.mintB, false),
    txbuild.readMintMeta(conn, pair.receiptMint, true),
  ]);
  const canon = txbuild.canonicalPairMeta(labeled, process.env.SITE_ORIGIN || "https://magicalinternet.money");
  const issues = [];
  const chk = (role, mint, meta, wantSign, want) => {
    const sign = signOk(meta && meta.symbol, wantSign);
    if (!sign.ok) issues.push(role + " " + mint.slice(0, 8) + "…: " + sign.reason);
    if (meta && want && (meta.symbol !== want.symbol || meta.name !== want.name)) {
      issues.push(role + " metadata drift: on-chain " + JSON.stringify(meta) + " vs canonical " + JSON.stringify(want));
    }
  };
  chk("mint_a (long)", pair.mintA, ma, "+", canon.mintA);
  chk("mint_b (inverse)", pair.mintB, mb, "-", canon.mintB);
  if (!mr || !mr.symbol) issues.push("receipt " + pair.receiptMint.slice(0, 8) + "…: missing metadata");
  else if (mr.symbol !== canon.receipt.symbol) {
    issues.push("receipt symbol drift: on-chain " + mr.symbol + " vs " + canon.receipt.symbol);
  }
  return {
    sym: labeled.sym,
    receiptMint: pair.receiptMint,
    mintA: pair.mintA,
    mintB: pair.mintB,
    onchain: { mintA: ma, mintB: mb, receipt: mr },
    canonical: canon,
    ok: issues.length === 0,
    issues,
  };
}

async function main() {
  const conn = new web3.Connection(RPC, "confirmed");
  const pairs = await txbuild.listPairs(conn, PROGRAM);
  if (!pairs.length) { console.error("no pairs found"); process.exit(1); }
  let failed = 0;
  for (const pair of pairs) {
    const r = await verifyPair(conn, pair);
    console.log("\n" + r.sym + " (" + r.receiptMint + ")");
    console.log("  mint_a (long)    " + r.mintA + "  " + (r.onchain.mintA && r.onchain.mintA.symbol || "—"));
    console.log("  mint_b (inverse) " + r.mintB + "  " + (r.onchain.mintB && r.onchain.mintB.symbol || "—"));
    console.log("  receipt          " + r.receiptMint + "  " + (r.onchain.receipt && r.onchain.receipt.symbol || "—"));
    if (r.ok) console.log("  ✓ leg mapping OK");
    else { failed++; r.issues.forEach((i) => console.log("  ✗ " + i)); }
  }
  console.log("\n" + (failed ? failed + " pair(s) FAILED" : "all " + pairs.length + " pair(s) OK"));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });