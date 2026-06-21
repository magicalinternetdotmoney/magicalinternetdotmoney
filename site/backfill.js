#!/usr/bin/env node
// Init on-chain metadata for a pair: MINTA (+), MINTB (−), receipt (LP).
// MINTA/MINTB → Metaplex (TAG 13). Receipt → Token-2022 on-mint (TAG 14). Pair admin signs.
"use strict";
const fs = require("fs");
const web3 = require("@solana/web3.js");
const txbuild = require("./txbuild.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const KEY = process.env.ADMIN_KEY || process.argv.find((a) => a.endsWith(".json")) || "";

// Known pairs when receipt on-chain metadata isn't set yet (grandfathered config, etc.)
const PAIR_HINTS = {
  "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB": { sym: "3xSOL", name: "3x SOL LP", underlyingSymbol: "SOL" },
  "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG": { sym: "5xBTC", name: "5x BTC LP", underlyingSymbol: "cbBTC" },
};

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes("--" + name); }

function pairLabels(pair, hints) {
  const h = hints || PAIR_HINTS[pair.receiptMint] || {};
  const u = arg("underlying", h.underlyingSymbol) || pair.underlyingSymbol || "asset";
  const lev = pair.levMax || h.levMax || 5;
  const sym = arg("sym", h.sym) || pair.sym || (Math.round(lev) + "x" + u);
  const name = arg("name", h.name) || pair.name || (sym + " LP");
  return Object.assign({}, pair, { sym, name, underlyingSymbol: u });
}

async function metadataStatus(conn, pair) {
  const [rec, ma, mb] = await Promise.all([
    txbuild.mintHasMetadata(conn, pair.receiptMint, true),
    txbuild.mintHasMetadata(conn, pair.mintA, false),
    txbuild.mintHasMetadata(conn, pair.mintB, false),
  ]);
  return { receipt: rec, mintA: ma, mintB: mb, complete: rec && ma && mb };
}

async function sendPair(conn, admin, pair, origin) {
  const labeled = pairLabels(pair);
  const st = await metadataStatus(conn, labeled);
  console.log("pair", labeled.sym, labeled.receiptMint, "metadata:", st);
  if (st.complete) { console.log("skip — all three tokens already have metadata"); return; }
  const { txs } = await txbuild.buildBackfillMetadata(conn, {
    programId: PROGRAM, user: admin.publicKey.toBase58(), pair: labeled, siteOrigin: origin, skipExisting: true,
  });
  if (!txs.length) { console.log("skip — nothing to send"); return; }
  const only = arg("only", "");
  const filt = new Set(only ? only.split(",").map((s) => s.trim().toLowerCase()) : []);
  const want = (label) => {
    if (!filt.size) return true;
    const l = label.toLowerCase();
    if (filt.has("receipt") || filt.has("lp") || filt.has("t22")) return l.includes("receipt");
    if (filt.has("minta") || filt.has("+") || filt.has("long")) return l.includes("minta");
    if (filt.has("mintb") || filt.has("-") || filt.has("inv")) return l.includes("mintb");
    return filt.has(l);
  };
  for (const t of txs) {
    if (!want(t.label)) { console.log("skip", t.label); continue; }
    if (hasFlag("dry-run")) { console.log("dry-run", t.label); continue; }
    const raw = Buffer.from(t.tx, "base64");
    const vtx = web3.VersionedTransaction.deserialize(raw);
    vtx.sign([admin]);
    const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
    console.log(t.label, sig);
    await conn.confirmTransaction(sig, "confirmed");
  }
  console.log("done —", labeled.sym);
}

async function main() {
  const origin = arg("origin", process.env.SITE_ORIGIN || "https://magicalinternet.money");
  if (!KEY || !fs.existsSync(KEY)) {
    console.error("usage: node backfill.js [--all | --receipt <mint>] [--sym 5xBTC] [--name '5x BTC LP'] [--underlying cbBTC] [--only receipt|minta|mintb] [--dry-run] <admin-key.json>");
    process.exit(1);
  }
  const conn = new web3.Connection(RPC, "confirmed");
  const admin = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY, "utf8"))));

  if (hasFlag("all")) {
    const pairs = await txbuild.listPairs(conn, PROGRAM);
    for (const p of pairs) await sendPair(conn, admin, p, origin);
    return;
  }

  const receipt = arg("receipt", "");
  if (!receipt) {
    console.error("pass --receipt <mint> or --all");
    process.exit(1);
  }
  const chain = await txbuild.loadPairFromReceipt(conn, PROGRAM, receipt);
  await sendPair(conn, admin, chain, origin);
}

main().catch((e) => { console.error(e); process.exit(1); });