#!/usr/bin/env node
// Patch on-chain metadata URIs/names for MINTA (+), MINTB (−), receipt (LP).
"use strict";
const fs = require("fs");
const web3 = require("@solana/web3.js");
const txbuild = require("./txbuild.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const KEY = process.env.ADMIN_KEY || process.argv.find((a) => a.endsWith(".json")) || "";

const PAIR_HINTS = {
  "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB": { sym: "3xSOL", name: "3x SOL LP", underlyingSymbol: "SOL" },
  "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG": { sym: "5xBTC", name: "5x BTC LP", underlyingSymbol: "cbBTC" },
};

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes("--" + name); }

function pairLabels(pair) {
  const h = PAIR_HINTS[pair.receiptMint] || {};
  const u = arg("underlying", h.underlyingSymbol) || pair.underlyingSymbol || "asset";
  const sym = arg("sym", h.sym) || pair.sym || (Math.round(pair.levMax || 5) + "x" + u);
  const name = arg("name", h.name) || pair.name || (sym + " LP");
  return Object.assign({}, pair, { sym, name, underlyingSymbol: u });
}

async function patchPair(conn, admin, pair, origin) {
  const labeled = pairLabels(pair);
  const { txs, want, current } = await txbuild.buildPatchMetadata(conn, {
    programId: PROGRAM, user: admin.publicKey.toBase58(), pair: labeled, siteOrigin: origin, force: hasFlag("force"),
  });
  console.log("pair", labeled.sym, labeled.receiptMint);
  console.log("  current", JSON.stringify(current));
  console.log("  target ", JSON.stringify(want));
  if (!txs.length) { console.log("  skip — already canonical"); return; }
  for (const t of txs) {
    if (hasFlag("dry-run")) { console.log("  dry-run", t.label); continue; }
    const vtx = web3.VersionedTransaction.deserialize(Buffer.from(t.tx, "base64"));
    vtx.sign([admin]);
    const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
    console.log(" ", t.label, sig);
    await conn.confirmTransaction(sig, "confirmed");
  }
  console.log("  done —", labeled.sym);
}

async function main() {
  const origin = arg("origin", process.env.SITE_ORIGIN || "https://magicalinternet.money");
  if (!KEY || !fs.existsSync(KEY)) {
    console.error("usage: node patch-metadata.js [--all | --receipt <mint>] [--force] [--dry-run] <admin-key.json>");
    process.exit(1);
  }
  const conn = new web3.Connection(RPC, "confirmed");
  const admin = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY, "utf8"))));
  if (hasFlag("all")) {
    for (const p of await txbuild.listPairs(conn, PROGRAM)) await patchPair(conn, admin, p, origin);
    return;
  }
  const receipt = arg("receipt", "");
  if (!receipt) { console.error("pass --receipt <mint> or --all"); process.exit(1); }
  await patchPair(conn, admin, await txbuild.loadPairFromReceipt(conn, PROGRAM, receipt), origin);
}

main().catch((e) => { console.error(e); process.exit(1); });