#!/usr/bin/env node
// Initialize ExtraAccountMetaList for receipt mints so wallet transfers work.
// Pair admin signs. Safe to re-run (skips pairs that already have the PDA).
"use strict";
const fs = require("fs");
const web3 = require("@solana/web3.js");
const txbuild = require("./txbuild.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const KEY = process.env.ADMIN_KEY || process.argv.find((a) => a.endsWith(".json")) || "";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes("--" + name); }

async function initPair(conn, admin, pair) {
  const exists = await txbuild.hookMetaExists(conn, PROGRAM, pair.receiptMint);
  console.log("pair", pair.receiptMint, "config", pair.config, "hook meta list:", exists ? "exists" : "missing");
  if (exists) { console.log("  skip — already initialized"); return; }
  const { tx, metaList, skipped } = await txbuild.buildInitHookMetas(conn, {
    programId: PROGRAM, user: admin.publicKey.toBase58(), pair,
  });
  if (skipped || !tx) { console.log("  skip — nothing to send"); return; }
  if (hasFlag("dry-run")) { console.log("  dry-run would create", metaList); return; }
  const vtx = web3.VersionedTransaction.deserialize(Buffer.from(tx, "base64"));
  vtx.sign([admin]);
  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  console.log("  init transfer-hook extras", sig);
  await conn.confirmTransaction(sig, "confirmed");
  const ok = await txbuild.hookMetaExists(conn, PROGRAM, pair.receiptMint);
  if (!ok) throw new Error("meta list not visible after init for " + pair.receiptMint);
  console.log("  verified", metaList);
}

async function main() {
  if (!KEY || !fs.existsSync(KEY)) {
    console.error("usage: node init-hook-metas.js [--all | --receipt <mint>] [--dry-run] <admin-key.json>");
    process.exit(1);
  }
  const conn = new web3.Connection(RPC, "confirmed");
  const admin = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY, "utf8"))));
  console.log("admin", admin.publicKey.toBase58());

  if (hasFlag("all")) {
    const pairs = await txbuild.listPairs(conn, PROGRAM);
    console.log("found", pairs.length, "pair(s)");
    for (const p of pairs) await initPair(conn, admin, p);
    return;
  }

  const receipt = arg("receipt", "");
  if (!receipt) { console.error("pass --receipt <mint> or --all"); process.exit(1); }
  await initPair(conn, admin, await txbuild.loadPairFromReceipt(conn, PROGRAM, receipt));
}

main().catch((e) => { console.error(e); process.exit(1); });