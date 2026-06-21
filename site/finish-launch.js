#!/usr/bin/env node
// Finish partial browser launches that stalled on init transfer-hook extras (step 9/10).
// Safe to re-run: skips pairs whose ExtraAccountMetaList PDA already exists.
"use strict";
const fs = require("fs");
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const txbuild = require("./txbuild.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const CP = new web3.PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM = new web3.PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const MEME = process.env.MEME_MINT || "CNBuoZWcqAvVZJCrPFF1XQXeeXJsZKj7SUKZoE6Vpump";
const KEY = process.env.PAYER_KEY || process.argv.find((a) => a.endsWith(".json")) || "";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes("--" + name); }

function memePoolPda(mintA, mintB) {
  const ord = (x, y) => (Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x]);
  const o = ord(new web3.PublicKey(mintA), new web3.PublicKey(mintB));
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), AMM.toBuffer(), o[0].toBuffer(), o[1].toBuffer()], CP,
  )[0];
}

async function pairStatus(conn, pair) {
  const hook = await txbuild.hookMetaExists(conn, PROGRAM, pair.receiptMint);
  const am = memePoolPda(pair.mintA, MEME);
  const bm = memePoolPda(pair.mintB, MEME);
  const [amAi, bmAi, recMeta] = await Promise.all([
    conn.getAccountInfo(am, "confirmed"),
    conn.getAccountInfo(bm, "confirmed"),
    spl.getTokenMetadata(conn, new web3.PublicKey(pair.receiptMint), "confirmed", spl.TOKEN_2022_PROGRAM_ID).catch(() => null),
  ]);
  const embeds = await txbuild.buildHookEmbeds(conn, PROGRAM, pair);
  return {
    receipt: pair.receiptMint,
    config: pair.config,
    hook,
    hookEmbeds: embeds.length,
    oracleKind: pair.oracleKind || 0,
    oraclePool: pair.oraclePool || null,
    memePools: { am: am.toBase58(), amLive: !!amAi, bm: bm.toBase58(), bmLive: !!bmAi },
    receiptMeta: recMeta ? { name: recMeta.name, symbol: recMeta.symbol } : null,
  };
}

async function finishPair(conn, payer, pair) {
  const st = await pairStatus(conn, pair);
  console.log("pair", JSON.stringify(st, null, 2));
  if (st.hook) {
    console.log("  skip — transfer-hook extras already initialized");
    return { receipt: pair.receiptMint, skipped: true };
  }
  const { tx, metaList, skipped } = await txbuild.buildInitHookMetas(conn, {
    programId: PROGRAM, user: payer.publicKey.toBase58(), pair,
  });
  if (skipped || !tx) {
    console.log("  skip — nothing to send");
    return { receipt: pair.receiptMint, skipped: true };
  }
  if (hasFlag("dry-run")) {
    console.log("  dry-run would create hook meta list", metaList, "with", st.hookEmbeds, "embeds");
    return { receipt: pair.receiptMint, dryRun: true, metaList };
  }
  const vtx = web3.VersionedTransaction.deserialize(Buffer.from(tx, "base64"));
  vtx.sign([payer]);
  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  console.log("  init transfer-hook extras", sig);
  await conn.confirmTransaction(sig, "confirmed");
  const ok = await txbuild.hookMetaExists(conn, PROGRAM, pair.receiptMint);
  if (!ok) throw new Error("hook meta list not visible after init for " + pair.receiptMint);
  console.log("  verified", metaList);
  return { receipt: pair.receiptMint, metaList, sig };
}

async function main() {
  if (!KEY || !fs.existsSync(KEY)) {
    console.error("usage: node finish-launch.js [--scan | --receipt <mint>] [--dry-run] <payer-key.json>");
    process.exit(1);
  }
  const conn = new web3.Connection(RPC, "confirmed");
  const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY, "utf8"))));
  console.log("payer", payer.publicKey.toBase58());

  if (hasFlag("scan")) {
    const incomplete = await txbuild.findIncompletePairs(conn, PROGRAM);
    console.log("incomplete launches:", incomplete.length);
    if (!incomplete.length) return;
    for (const p of incomplete) await finishPair(conn, payer, p);
    return;
  }

  const receipt = arg("receipt", "");
  if (!receipt) {
    console.error("pass --receipt <mint> or --scan");
    process.exit(1);
  }
  await finishPair(conn, payer, await txbuild.loadPairFromReceipt(conn, PROGRAM, receipt));
}

main().catch((e) => { console.error(e); process.exit(1); });