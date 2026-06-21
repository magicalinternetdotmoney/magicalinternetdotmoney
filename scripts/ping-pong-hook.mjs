#!/usr/bin/env node
/**
 * Ping-pong receipt transfers between admin + test wallet to fire hook repeatedly.
 * Prints oracle/crawl snapshots and program logs each leg.
 */
import fs from "fs";
import { createRequire } from "module";
import web3 from "@solana/web3.js";
import txbuild from "../site/txbuild.js";

const require = createRequire(import.meta.url);
const splToken = require("@solana/spl-token");

const {
  PublicKey, Keypair, Connection, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} = web3;
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction, TOKEN_2022_PROGRAM_ID, getMint,
  getAccount,
} = splToken;

const RPC = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=dc8a996c-1c31-4960-b000-c4586d54f4bb";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const ADMIN_KEY = process.env.ADMIN_KEY || process.env.HOME + "/levered.json";
const TEST_KEY = process.env.TEST_KEY || process.env.HOME + "/leveredtest.json";
const RECEIPT = process.env.RECEIPT_MINT || "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB";
const ROUNDS = Number(process.env.ROUNDS || 3);
const O_ORACLE_LAST = 415;

function readU128LE(buf, off) {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) + lo;
}

async function snapshot(conn, pair) {
  const cfgPk = new PublicKey(pair.config);
  const [crawlPk] = txbuild.priceCrawlPda(PROGRAM, pair.config);
  const [cfg, crawl] = await Promise.all([
    conn.getAccountInfo(cfgPk, "confirmed"),
    conn.getAccountInfo(crawlPk, "confirmed"),
  ]);
  const crawlState = txbuild.parsePriceCrawl(crawl?.data);
  const oracleLast = cfg && cfg.data.length >= O_ORACLE_LAST + 16
    ? readU128LE(cfg.data, O_ORACLE_LAST).toString()
    : "0";
  return { crawlState, oracleLast };
}

function rbLogs(tx) {
  return (tx?.meta?.logMessages || []).filter((l) =>
    l.includes("Program log: rb ") || l.includes("Program log: crawl "),
  );
}

async function sendHookTransfer(conn, { from, to, receipt, decimals, amount, ensureDstAta }) {
  const src = getAssociatedTokenAddressSync(receipt, from.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dst = getAssociatedTokenAddressSync(receipt, to.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    conn, src, receipt, dst, from.publicKey, amount, decimals, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
  ];
  if (ensureDstAta) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      from.publicKey, dst, to.publicKey, receipt, TOKEN_2022_PROGRAM_ID,
    ));
  }
  ixs.push(transferIx);
  const msg = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const signers = from.publicKey.equals(to.publicKey) ? [from] : [from];
  tx.sign(signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  const confirmed = await conn.getTransaction(sig, {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  return { sig, tx: confirmed };
}

async function main() {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KEY, "utf8"))));
  const test = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(TEST_KEY, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const pair = await txbuild.loadPairFromReceipt(conn, PROGRAM, RECEIPT);
  const receipt = new PublicKey(pair.receiptMint);

  console.log("admin", admin.publicKey.toBase58());
  console.log("test ", test.publicKey.toBase58());
  console.log("pair ", pair.receiptMint, "rounds", ROUNDS);

  // fund test wallet for ATA + hook CU
  const testBal = await conn.getBalance(test.publicKey, "confirmed");
  if (testBal < 0.015 * LAMPORTS_PER_SOL) {
    const fundIx = SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: test.publicKey,
      lamports: Math.floor(0.02 * LAMPORTS_PER_SOL),
    });
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const fundMsg = new TransactionMessage({
      payerKey: admin.publicKey,
      recentBlockhash: blockhash,
      instructions: [fundIx],
    }).compileToV0Message();
    const fundTx = new VersionedTransaction(fundMsg);
    fundTx.sign([admin]);
    const fundSig = await conn.sendRawTransaction(fundTx.serialize());
    await conn.confirmTransaction(fundSig, "confirmed");
    console.log("funded test wallet", fundSig);
  }

  const mintInfo = await getMint(conn, receipt, "confirmed", TOKEN_2022_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  const amount = 1n;

  const adminAta = getAssociatedTokenAddressSync(receipt, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const adminAcct = await getAccount(conn, adminAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("admin receipt balance (base units):", adminAcct.amount.toString());
  if (adminAcct.amount < BigInt(ROUNDS)) {
    throw new Error("admin needs more receipts for " + ROUNDS + " round trips");
  }

  let snap = await snapshot(conn, pair);
  console.log("\n--- START ---");
  console.log("oracle_last:", snap.oracleLast);
  console.log("crawl pass:", snap.crawlState?.pass, "agg:", snap.crawlState?.aggregateWad);

  for (let r = 1; r <= ROUNDS; r++) {
    console.log(`\n=== ROUND ${r} admin → test ===`);
    const out = await sendHookTransfer(conn, {
      from: admin, to: test, receipt, decimals, amount, ensureDstAta: r === 1,
    });
    snap = await snapshot(conn, pair);
    console.log("tx", out.sig);
    console.log("oracle_last:", snap.oracleLast, "agg:", snap.crawlState?.aggregateWad);
    for (const l of rbLogs(out.tx)) console.log(l);

    console.log(`\n=== ROUND ${r} test → admin ===`);
    const back = await sendHookTransfer(conn, {
      from: test, to: admin, receipt, decimals, amount, ensureDstAta: false,
    });
    snap = await snapshot(conn, pair);
    console.log("tx", back.sig);
    console.log("oracle_last:", snap.oracleLast, "agg:", snap.crawlState?.aggregateWad);
    for (const l of rbLogs(back.tx)) console.log(l);
  }

  console.log("\nDONE — oracle_last now", snap.oracleLast);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });