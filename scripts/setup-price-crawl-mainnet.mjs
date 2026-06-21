#!/usr/bin/env node
/**
 * Mainnet: upgrade program (if needed), init LUT + price_crawl per pair,
 * set oracle_kind=crawl, patch hook metas, seed first crawl sample.
 *
 * Usage: node scripts/setup-price-crawl-mainnet.mjs [--dry-run] [--pair <receiptMint>]
 * Env: ADMIN_KEY (default ~/levered.json), RPC_URL
 */
import fs from "fs";
import web3 from "@solana/web3.js";
import txbuild from "../site/txbuild.js";

const RPC = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=dc8a996c-1c31-4960-b000-c4586d54f4bb";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const KEY = process.env.ADMIN_KEY || process.env.HOME + "/levered.json";
const ALT = new web3.PublicKey("AddressLookupTab1e1111111111111111111111111");
const SYS = web3.SystemProgram.programId;
const PRICE_CRAWL_SIZE = 423;
const ORACLE_CRAWL = 2;
const LAYOUT_CPSWAP = 1;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pairFilter = args.includes("--pair") ? args[args.indexOf("--pair") + 1] : null;

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => {
  const b = Buffer.alloc(16);
  const v = BigInt(n);
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n));
  b.writeBigUInt64LE(v >> 64n, 8);
  return b;
};
const k = (pk, w, s = false) => ({ pubkey: pk, isSigner: s, isWritable: w });
const rdPk = (buf, o) => new web3.PublicKey(buf.subarray(o, o + 32));
const ZERO = new web3.PublicKey("11111111111111111111111111111111");
const O_LOOKUP = 316;

async function send(conn, admin, ixs, label) {
  if (dryRun) { console.log("  [dry-run]", label, ixs.length, "ix(s)"); return null; }
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new web3.TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([admin]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log("  ", label, sig);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

function hookMask(count) {
  let mask = 0;
  for (let i = 0; i < count; i++) {
    if (i === 0 || i === 2 || i === 3 || (i >= 4 && i <= 9)) mask |= (1 << i);
  }
  return mask;
}

async function setupPair(conn, admin, pair) {
  console.log("\n=== pair", pair.receiptMint, "config", pair.config);
  const PROGRAM_PK = new web3.PublicKey(PROGRAM);
  const config = new web3.PublicKey(pair.config);
  const [authority] = web3.PublicKey.findProgramAddressSync([Buffer.from("authority")], PROGRAM_PK);
  const [priceCrawl, crawlBump] = txbuild.priceCrawlPda(PROGRAM, pair.config);
  const cfgAi = await conn.getAccountInfo(config, "confirmed");
  if (!cfgAi) throw new Error("config missing");
  const lutPk = cfgAi.data.length >= O_LOOKUP + 32 ? rdPk(cfgAi.data, O_LOOKUP) : ZERO;

  // 1. init LUT if unset
  if (lutPk.equals(ZERO)) {
    const slot = BigInt((await conn.getSlot("confirmed")) - 1);
    const slotBuf = u64(slot);
    const [lut, lutBump] = web3.PublicKey.findProgramAddressSync([authority.toBuffer(), slotBuf], ALT);
    await send(conn, admin, [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new web3.TransactionInstruction({
        programId: PROGRAM_PK,
        keys: [k(admin.publicKey, true, true), k(config, true), k(authority, false), k(lut, true), k(ALT, false), k(SYS, true)],
        data: Buffer.concat([Buffer.from([8]), slotBuf, Buffer.from([lutBump])]),
      }),
    ], "init_lut");
  }

  const cfg2 = await conn.getAccountInfo(config, "confirmed");
  const rootLut = rdPk(cfg2.data, O_LOOKUP);

  // 2. extend LUT with pool_a_usdc if not already present
  const lutAi = await conn.getAccountInfo(rootLut, "confirmed");
  const poolAq = new web3.PublicKey(pair.pools.aq.pool);
  let hasPool = false;
  if (lutAi) {
    for (let i = 0; i < Math.floor((lutAi.data.length - 56) / 32); i++) {
      if (rdPk(lutAi.data, 56 + i * 32).equals(poolAq)) hasPool = true;
    }
  }
  if (!hasPool) {
    await send(conn, admin, [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new web3.TransactionInstruction({
        programId: PROGRAM_PK,
        keys: [k(admin.publicKey, true, true), k(config, false), k(authority, false), k(rootLut, true), k(ALT, false), k(SYS, true)],
        data: Buffer.concat([Buffer.from([9]), poolAq.toBuffer()]),
      }),
    ], "extend_lut_poolAq");
  }

  // 3. init price_crawl PDA
  const crawlAi = await conn.getAccountInfo(priceCrawl, "confirmed");
  if (!crawlAi) {
    const rent = BigInt(await conn.getMinimumBalanceForRentExemption(PRICE_CRAWL_SIZE));
    const layouts = Buffer.alloc(12);
    layouts[0] = LAYOUT_CPSWAP;
    await send(conn, admin, [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new web3.TransactionInstruction({
        programId: PROGRAM_PK,
        keys: [k(admin.publicKey, true, true), k(config, false), k(priceCrawl, true), k(SYS, false)],
        data: Buffer.concat([Buffer.from([15, crawlBump, 1]), layouts, u128(0n), u64(rent)]),
      }),
    ], "init_price_crawl");
  }

  // 4. set oracle_kind = crawl (grows 400-byte configs → 432)
  const cfg3 = await conn.getAccountInfo(config, "confirmed");
  const kind = cfg3.data.length >= 415 ? cfg3.data[414] : 0;
  if (kind !== ORACLE_CRAWL) {
    const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })];
    if (cfg3.data.length < 432) {
      const need = await conn.getMinimumBalanceForRentExemption(432);
      const topUp = Math.max(0, need - cfg3.lamports);
      if (topUp > 0) ixs.push(web3.SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: config, lamports: topUp }));
    }
    ixs.push(new web3.TransactionInstruction({
      programId: PROGRAM_PK,
      keys: [k(admin.publicKey, true, true), k(config, true), k(SYS, false)],
      data: Buffer.from([18, ORACLE_CRAWL]),
    }));
    await send(conn, admin, ixs, "set_oracle_kind");
  }

  // 5. patch hook metas — 12 embeds (add price_crawl)
  const receipt = new web3.PublicKey(pair.receiptMint);
  const [metaList] = web3.PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), receipt.toBuffer()], PROGRAM_PK);
  const embeds = await txbuild.buildHookEmbeds(conn, PROGRAM, pair);
  const count = embeds.length;
  const mask = hookMask(count);
  const metaAi = await conn.getAccountInfo(metaList, "confirmed");
  const needPatch = !metaAi || metaAi.data.length !== 16 + count * 35;
  if (needPatch) {
    const extraRent = metaAi
      ? Math.max(0, (await conn.getMinimumBalanceForRentExemption(16 + count * 35)) - metaAi.lamports)
      : 0;
    const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })];
    if (extraRent > 0) ixs.push(web3.SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: metaList, lamports: extraRent }));
    ixs.push(new web3.TransactionInstruction({
      programId: PROGRAM_PK,
      keys: [k(admin.publicKey, true, true), k(config, false), k(metaList, true), k(receipt, false), k(SYS, false), ...embeds.map((p) => k(p, false))],
      data: Buffer.concat([Buffer.from([19, count]), Buffer.from([mask & 0xff, (mask >> 8) & 0xff])]),
    }));
    await send(conn, admin, ixs, "patch_hook_metas");
  }

  // 6. advance_crawl seed
  try {
    const built = await txbuild.buildAdvanceCrawl(conn, { programId: PROGRAM, payer: admin.publicKey.toBase58(), pair });
    if (!dryRun && built.tx) {
      const vtx = web3.VersionedTransaction.deserialize(Buffer.from(built.tx, "base64"));
      vtx.sign([admin]);
      const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
      console.log("   advance_crawl", sig);
      await conn.confirmTransaction(sig, "confirmed");
    } else {
      console.log("  [dry-run] advance_crawl cursor", built.cursor, "venue", built.venue);
    }
  } catch (e) {
    console.warn("  advance_crawl skipped:", e.message);
  }

  const final = await conn.getAccountInfo(priceCrawl, "confirmed");
  const parsed = txbuild.parsePriceCrawl(final?.data);
  console.log("  crawl state:", parsed);
}

async function main() {
  if (!fs.existsSync(KEY)) { console.error("missing ADMIN_KEY:", KEY); process.exit(1); }
  const conn = new web3.Connection(RPC, "confirmed");
  const admin = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY, "utf8"))));
  console.log("admin", admin.publicKey.toBase58(), dryRun ? "(dry-run)" : "");

  const bal = await conn.getBalance(admin.publicKey);
  console.log("balance", (bal / 1e9).toFixed(4), "SOL");
  if (bal < 0.05e9 && !dryRun) console.warn("low balance — upgrade + 5 pairs may need more SOL");

  let pairs = await txbuild.listPairs(conn, PROGRAM);
  if (pairFilter) pairs = pairs.filter((p) => p.receiptMint === pairFilter);
  console.log("pairs", pairs.length);
  for (const p of pairs) await setupPair(conn, admin, p);
  console.log("\ndone.");
}

main().catch((e) => { console.error(e); process.exit(1); });