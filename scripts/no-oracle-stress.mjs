#!/usr/bin/env node
/**
 * Deposit ~1/N USDC into each live pair, patch boxed crawl hooks, run M transfers
 * admin↔test per pair. Writes results JSON for NO-ORACLES.md.
 *
 * Env: TRANSFERS_PER_PAIR (default 20), USDC_FRACTION (default 5 = 1/5 each)
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
  createTransferCheckedWithTransferHookInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getMint, getAccount,
} = splToken;

const RPC = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=dc8a996c-1c31-4960-b000-c4586d54f4bb";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const ADMIN_KEY = process.env.ADMIN_KEY || process.env.HOME + "/levered.json";
const TEST_KEY = process.env.TEST_KEY || process.env.HOME + "/leveredtest.json";
const USDC_FRACTION = Number(process.env.USDC_FRACTION || 5);
const TRANSFERS_PER_PAIR = Number(process.env.TRANSFERS_PER_PAIR || 20);
const OUT = process.env.OUT || "scripts/no-oracle-stress-results.json";
const O_ORACLE_LAST = 415;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SYS = SystemProgram.programId;
const META_COUNT = txbuild.CRAWL_HOOK_META_COUNT;
const k = (p, w, s = false) => ({ pubkey: p, isSigner: s, isWritable: w });

function readU128LE(buf, off) {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) + lo;
}

function rbLogs(tx) {
  return (tx?.meta?.logMessages || []).filter((l) =>
    l.includes("Program log: crawl ") || l.includes("Program log: rb "),
  );
}

async function snapshot(conn, pair) {
  const cfgPk = new PublicKey(pair.config);
  const [crawlPk] = txbuild.priceCrawlPda(PROGRAM, pair.config);
  const [cfg, crawl] = await Promise.all([
    conn.getAccountInfo(cfgPk, "confirmed"),
    conn.getAccountInfo(crawlPk, "confirmed"),
  ]);
  return {
    crawl: txbuild.parsePriceCrawl(crawl?.data),
    oracleLast: cfg && cfg.data.length >= O_ORACLE_LAST + 16
      ? readU128LE(cfg.data, O_ORACLE_LAST).toString()
      : "0",
    oracleKind: cfg?.data?.[408] ?? null,
  };
}

async function sendVtx(conn, vtx, signers) {
  vtx.sign(signers);
  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { sig, tx, err: tx?.meta?.err };
}

async function patchHook(conn, admin, pair) {
  const PROGRAM_PK = new PublicKey(PROGRAM);
  const config = new PublicKey(pair.config);
  const receipt = new PublicKey(pair.receiptMint);
  const [metaList] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), receipt.toBuffer()], PROGRAM_PK,
  );
  const embeds = await txbuild.buildHookEmbeds(conn, PROGRAM, pair);
  const mask = txbuild.hookWritableMask(META_COUNT);
  const metaAi = await conn.getAccountInfo(metaList, "confirmed");
  const need = 16 + META_COUNT * 35;
  const top = metaAi ? Math.max(0, (await conn.getMinimumBalanceForRentExemption(need)) - metaAi.lamports) : 0;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
  if (top > 0) ixs.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: metaList, lamports: top }));
  ixs.push(new web3.TransactionInstruction({
    programId: PROGRAM_PK,
    keys: [k(admin.publicKey, true, true), k(config, false), k(metaList, true), k(receipt, false), k(SYS, false), ...embeds.map((p) => k(p, false))],
    data: Buffer.from([19, META_COUNT, mask & 0xff, (mask >> 8) & 0xff]),
  }));
  const { blockhash } = await conn.getLatestBlockhash();
  const vtx = new VersionedTransaction(new TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message());
  return sendVtx(conn, vtx, [admin]);
}

async function seedCrawl(conn, admin, pair) {
  const built = await txbuild.buildAdvanceCrawl(conn, {
    programId: PROGRAM, payer: admin.publicKey.toBase58(), pair,
  });
  if (!built.tx) return null;
  const vtx = VersionedTransaction.deserialize(Buffer.from(built.tx, "base64"));
  return sendVtx(conn, vtx, [admin]);
}

async function depositPair(conn, admin, pair, usdcRaw) {
  const built = await txbuild.buildDeposit(conn, {
    programId: PROGRAM, user: admin.publicKey.toBase58(), pair, usdcAmount: usdcRaw.toString(),
  });
  const vtx = VersionedTransaction.deserialize(Buffer.from(built.tx, "base64"));
  const r = await sendVtx(conn, vtx, [admin]);
  return { ...r, receiptMinted: built.receiptMinted };
}

async function transfer(conn, { from, to, receipt, decimals, amount, ensureDstAta }) {
  const src = getAssociatedTokenAddressSync(receipt, from.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dst = getAssociatedTokenAddressSync(receipt, to.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    conn, src, receipt, dst, from.publicKey, amount, decimals, [], "confirmed", TOKEN_2022_PROGRAM_ID,
  );
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 })];
  if (ensureDstAta) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(
      from.publicKey, dst, to.publicKey, receipt, TOKEN_2022_PROGRAM_ID,
    ));
  }
  ixs.push(transferIx);
  const vtx = new VersionedTransaction(new TransactionMessage({
    payerKey: from.publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message());
  return sendVtx(conn, vtx, [from]);
}

async function main() {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KEY, "utf8"))));
  const test = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(TEST_KEY, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const pairs = await txbuild.listPairs(conn, PROGRAM);

  const usdcAta = getAssociatedTokenAddressSync(USDC, admin.publicKey);
  const usdcAcct = await getAccount(conn, usdcAta, "confirmed", TOKEN_PROGRAM_ID);
  const totalUsdc = usdcAcct.amount;
  // Each pair gets 1/USDC_FRACTION of wallet USDC (e.g. 1/5 ≈ $49 on ~$246).
  const depositEach = totalUsdc / BigInt(USDC_FRACTION);

  console.log("pairs", pairs.length, "usdc total", Number(totalUsdc) / 1e6);
  console.log("deposit each", Number(depositEach) / 1e6, "USDC (1/" + USDC_FRACTION + " split)");
  console.log("transfers per pair", TRANSFERS_PER_PAIR);

  if (await conn.getBalance(test.publicKey) < 0.02 * LAMPORTS_PER_SOL) {
    const fundIx = SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: test.publicKey, lamports: Math.floor(0.03 * LAMPORTS_PER_SOL),
    });
    const { blockhash } = await conn.getLatestBlockhash();
    const vtx = new VersionedTransaction(new TransactionMessage({
      payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: [fundIx],
    }).compileToV0Message());
    await sendVtx(conn, vtx, [admin]);
    console.log("funded test wallet");
  }

  const report = {
    startedAt: new Date().toISOString(),
    program: PROGRAM,
    admin: admin.publicKey.toBase58(),
    test: test.publicKey.toBase58(),
    usdcFraction: USDC_FRACTION,
    transfersPerPair: TRANSFERS_PER_PAIR,
    pairs: [],
  };

  const skipMints = new Set((process.env.SKIP_RECEIPTS || "2X5XkVTKbxZye87Xw8iu4uuCFjV7uqkQ9jBXG8GpWgWk").split(",").filter(Boolean));

  for (const pair of pairs) {
    if (skipMints.has(pair.receiptMint)) {
      console.log("\nSKIP (broken LUT)", pair.receiptMint);
      report.pairs.push({ sym: pair.sym, receiptMint: pair.receiptMint, skipped: true });
      continue;
    }
    const sym = pair.sym || pair.receiptMint.slice(0, 8);
    console.log("\n========", sym, pair.receiptMint, "========");
    const row = {
      sym, receiptMint: pair.receiptMint, config: pair.config,
      transfers: [], errors: [],
    };
    try {
      const before = await snapshot(conn, pair);
      row.before = before;

      console.log("patch hook…");
      const patch = await patchHook(conn, admin, pair);
      row.patchSig = patch.sig;
      try {
        const seed = await seedCrawl(conn, admin, pair);
        if (seed) row.seedSig = seed.sig;
      } catch (e) {
        row.seedError = e.message?.slice(0, 120);
      }

      const receiptPk = new PublicKey(pair.receiptMint);
      const adminRec = getAssociatedTokenAddressSync(receiptPk, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
      let existingRec = 0n;
      try { existingRec = (await getAccount(conn, adminRec, "confirmed", TOKEN_2022_PROGRAM_ID)).amount; } catch { /* no ata */ }

      if (depositEach >= 1_000_000n && existingRec < 20n) {
        console.log("deposit", Number(depositEach) / 1e6, "USDC");
        const dep = await depositPair(conn, admin, pair, depositEach);
        row.depositSig = dep.sig;
        row.receiptMinted = dep.receiptMinted;
      } else {
        row.depositSkipped = existingRec >= 20n ? "already has receipts" : "depositEach too small";
        row.existingReceipts = existingRec.toString();
      }

      const receipt = new PublicKey(pair.receiptMint);
      const mintInfo = await getMint(conn, receipt, "confirmed", TOKEN_2022_PROGRAM_ID);
      const decimals = mintInfo.decimals;
      const xferAmt = 1n;
      let dstReady = false;

      const rounds = Math.ceil(TRANSFERS_PER_PAIR / 2);
      for (let r = 0; r < rounds && row.transfers.length < TRANSFERS_PER_PAIR; r++) {
        for (const [label, from, to] of [
          ["admin→test", admin, test],
          ["test→admin", test, admin],
        ]) {
          if (row.transfers.length >= TRANSFERS_PER_PAIR) break;
          try {
            const res = await transfer(conn, {
              from, to, receipt, decimals, amount: xferAmt,
              ensureDstAta: !dstReady && label === "admin→test",
            });
            if (!dstReady && label === "admin→test") dstReady = true;
            const logs = rbLogs(res.tx);
            row.transfers.push({
              n: row.transfers.length + 1,
              label,
              sig: res.sig,
              err: res.err,
              crawl: logs.find((l) => l.includes("crawl ")) || null,
              rb: logs.filter((l) => l.includes("rb ")).map((l) => l.replace("Program log: ", "")),
            });
            process.stdout.write(".");
          } catch (e) {
            row.errors.push({ label, round: r, message: e.message?.slice(0, 200) });
            console.log("\nERR", sym, label, e.message?.slice(0, 120));
            break;
          }
        }
      }

      const after = await snapshot(conn, pair);
      row.after = after;
      row.transferCount = row.transfers.length;
      row.crawlPassDelta = (after.crawl?.pass ?? 0) - (before.crawl?.pass ?? 0);
      row.hookCrawlLogs = row.transfers.filter((t) => t.crawl).length;
      row.rbMintLogs = row.transfers.filter((t) => t.rb?.some((l) => l.includes("mint_pair"))).length;
      console.log("\n", sym, "xfers", row.transferCount, "crawlΔ", row.crawlPassDelta, "hook crawl logs", row.hookCrawlLogs);
    } catch (e) {
      row.fatal = e.message;
      console.error("FATAL", sym, e);
    }
    report.pairs.push(row);
  }

  report.finishedAt = new Date().toISOString();
  report.totalTransfers = report.pairs.reduce((s, p) => s + (p.transferCount || 0), 0);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log("\nWrote", OUT, "total transfers", report.totalTransfers);
}

main().catch((e) => { console.error(e); process.exit(1); });