#!/usr/bin/env node
/**
 * E2E: advance_crawl (cursor + aggregate) → receipt transfer → hook rebalance
 * must read price_crawl.aggregate_wad (oracle_kind=2).
 */
import fs from "fs";
import { createRequire } from "module";
import web3 from "@solana/web3.js";
import txbuild from "../site/txbuild.js";

const require = createRequire(import.meta.url);
const splToken = require("@solana/spl-token");

const {
  PublicKey, Keypair, Connection, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram,
} = web3;
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction, TOKEN_2022_PROGRAM_ID, getMint,
} = splToken;

const RPC = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=dc8a996c-1c31-4960-b000-c4586d54f4bb";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const KEY = process.env.ADMIN_KEY || process.env.HOME + "/levered.json";
const RECEIPT = process.env.RECEIPT_MINT || "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB";
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
  return {
    crawlPk: crawlPk.toBase58(),
    crawlState,
    oracleLast,
    oracleKind: cfg?.data[414] ?? 0,
  };
}

function accountKeysFromTx(tx) {
  const msg = tx?.transaction?.message;
  if (!msg) return [];
  const staticKeys = msg.staticAccountKeys || msg.accountKeys || [];
  const loaded = tx.meta?.loadedAddresses || {};
  const writable = (loaded.writable || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
  const readonly = (loaded.readonly || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
  return [
    ...staticKeys.map((k) => (typeof k === "string" ? k : k.toBase58())),
    ...writable,
    ...readonly,
  ];
}

function txUsesProgram(tx, prog) {
  const keys = accountKeysFromTx(tx);
  const pid = keys.findIndex((k) => k === prog);
  if (pid >= 0) {
    const msg = tx.transaction.message;
    const top = msg.compiledInstructions || msg.instructions || [];
    if (top.some((ix) => ix.programIdIndex === pid)) return true;
    for (const grp of tx.meta?.innerInstructions || []) {
      for (const ix of grp.instructions || []) {
        if (ix.programIdIndex === pid) return true;
      }
    }
  }
  return (tx.meta?.logMessages || []).some((l) => l.includes(`Program ${prog} invoke`));
}

function countMintTo(tx) {
  let n = 0;
  for (const log of tx.meta?.logMessages || []) {
    if (/MintTo|mint_to|Instruction: MintTo/i.test(log)) n++;
    if (log.includes("Program J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe invoke")) n += 0;
  }
  const inner = tx.meta?.innerInstructions || [];
  for (const grp of inner) {
    for (const ix of grp.instructions || []) {
      // legacy token mint ix data tag 7
      const msg = tx.transaction.message;
      const keys = (msg.accountKeys || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
      const prog = keys[ix.programIdIndex];
      if (prog === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && ix.data) {
        const d = Buffer.from(ix.data, "base64");
        if (d[0] === 7) n++;
      }
    }
  }
  return n;
}

async function main() {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const pair = await txbuild.loadPairFromReceipt(conn, PROGRAM, RECEIPT);
  const receipt = new PublicKey(pair.receiptMint);

  console.log("pair", pair.receiptMint, "config", pair.config);
  console.log("admin", admin.publicKey.toBase58());

  const before = await snapshot(conn, pair);
  console.log("\n--- BEFORE ---");
  console.log(JSON.stringify(before, null, 2));
  if (before.oracleKind !== 2) throw new Error("oracle_kind != crawl (2)");

  // 1) crank crawl — cursor rotates, aggregate refreshes on wrap
  const built = await txbuild.buildAdvanceCrawl(conn, {
    programId: PROGRAM, payer: admin.publicKey.toBase58(), pair,
  });
  console.log("\nadvance_crawl venue", built.venue, "cursor", built.cursor);
  let advSig;
  if (built.tx) {
    const vtx = VersionedTransaction.deserialize(Buffer.from(built.tx, "base64"));
    vtx.sign([admin]);
    advSig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(advSig, "confirmed");
    console.log("advance_crawl tx", advSig);
  }

  const mid = await snapshot(conn, pair);
  console.log("\n--- AFTER advance_crawl ---");
  console.log(JSON.stringify(mid, null, 2));

  const agg = BigInt(mid.crawlState?.aggregateWad || 0);
  if (agg === 0n) throw new Error("aggregate still zero — crawl not seeded");

  // 2) receipt transfer → hook must consume aggregate
  const mintInfo = await getMint(conn, receipt, "confirmed", TOKEN_2022_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  const amount = 1n; // smallest unit — enough to fire hook

  const recipient = Keypair.generate();
  const src = getAssociatedTokenAddressSync(receipt, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dst = getAssociatedTokenAddressSync(receipt, recipient.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    conn, src, receipt, dst, admin.publicKey, amount, decimals, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: admin.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey, dst, recipient.publicKey, receipt, TOKEN_2022_PROGRAM_ID,
      ),
      transferIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([admin]);

  const hookSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("\nhook transfer tx", hookSig);
  await conn.confirmTransaction(hookSig, "confirmed");

  const hookTx = await conn.getTransaction(hookSig, {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  if (hookTx?.meta?.err) throw new Error("hook tx failed: " + JSON.stringify(hookTx.meta.err));
  const programLogs = (hookTx.meta?.logMessages || []).filter(
    (l) => l.includes("rb ") || l.includes("crawl ") || l.includes("Program log:"),
  );
  if (programLogs.length) {
    console.log("\n--- PROGRAM LOGS (hook #1) ---");
    for (const l of programLogs) console.log(l);
  }

  const after = await snapshot(conn, pair);
  console.log("\n--- AFTER hook transfer ---");
  console.log(JSON.stringify(after, null, 2));

  const oracleMoved = after.oracleLast !== before.oracleLast;
  const hookRan = txUsesProgram(hookTx, PROGRAM);
  const mints = countMintTo(hookTx);
  const absorbBps = 3000n;
  const expectedPartial = (agg * absorbBps) / 10000n;
  const oracleAfter = BigInt(after.oracleLast || 0);
  const oracleMatchesCrawlPartial =
    before.oracleLast === "0"
      ? oracleAfter === expectedPartial
      : oracleAfter > BigInt(before.oracleLast);

  console.log("\n--- ASSERTIONS ---");
  console.log("advance_crawl landed:", !!advSig);
  console.log("aggregate > 0:", agg > 0n);
  console.log("hook invoked J345:", hookRan);
  console.log("legacy MintTo inner ix count:", mints);
  console.log("oracle_price_last moved:", oracleMoved, before.oracleLast, "→", after.oracleLast);
  console.log("expected 30% of aggregate:", expectedPartial.toString());
  console.log("oracle tracks crawl partial:", oracleMatchesCrawlPartial);
  console.log("aggregate_wad:", mid.crawlState.aggregateWad);

  if (!hookRan) throw new Error("FAIL: hook did not invoke program");
  if (!oracleMatchesCrawlPartial) {
    throw new Error(
      `FAIL: oracle_last ${after.oracleLast} != expected crawl partial ${expectedPartial}`,
    );
  }

  // 3) second transfer — oracle_last seeded; hook should plan mint if ratio gap exists
  const transferIx2 = await createTransferCheckedWithTransferHookInstruction(
    conn, src, receipt, dst, admin.publicKey, amount, decimals, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  const { blockhash: bh2 } = await conn.getLatestBlockhash("confirmed");
  const msg2 = new TransactionMessage({
    payerKey: admin.publicKey,
    recentBlockhash: bh2,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      transferIx2,
    ],
  }).compileToV0Message();
  const tx2 = new VersionedTransaction(msg2);
  tx2.sign([admin]);
  const hookSig2 = await conn.sendRawTransaction(tx2.serialize(), { skipPreflight: false });
  console.log("\nsecond hook transfer tx", hookSig2);
  await conn.confirmTransaction(hookSig2, "confirmed");
  const hookTx2 = await conn.getTransaction(hookSig2, {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  if (hookTx2?.meta?.err) throw new Error("second hook tx failed: " + JSON.stringify(hookTx2.meta.err));

  const after2 = await snapshot(conn, pair);
  const mints2 = countMintTo(hookTx2);
  const hookRan2 = txUsesProgram(hookTx2, PROGRAM);
  console.log("\n--- AFTER second hook transfer ---");
  console.log("oracle_price_last:", after.oracleLast, "→", after2.oracleLast);
  console.log("hook invoked:", hookRan2, "mints:", mints2);

  console.log("\nPASS: crawl aggregate wired into hook path");
  console.log("Solscan transfer #1:", "https://solscan.io/tx/" + hookSig);
  console.log("Solscan transfer #2:", "https://solscan.io/tx/" + hookSig2);
  if (advSig) {
    const advTx = await conn.getTransaction(advSig, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    });
    const crawlLogs = (advTx?.meta?.logMessages || []).filter(
      (l) => l.includes("crawl ") || l.includes("Program log:"),
    );
    if (crawlLogs.length) {
      console.log("\n--- PROGRAM LOGS (advance_crawl) ---");
      for (const l of crawlLogs) console.log(l);
    }
    console.log("crawl:", "https://solscan.io/tx/" + advSig);
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });