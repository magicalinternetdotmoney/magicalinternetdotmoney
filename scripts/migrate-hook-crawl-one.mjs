#!/usr/bin/env node
/** Migrate price_crawl + patch boxed crawl hook metas (13 embeds → 16 disc-2 metas) for one pair. */
import fs from "fs";
import web3 from "@solana/web3.js";
import txbuild from "../site/txbuild.js";

const RPC = process.env.RPC_URL || "https://mainnet.helius-rpc.com/?api-key=dc8a996c-1c31-4960-b000-c4586d54f4bb";
const PROGRAM = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const KEY = process.env.ADMIN_KEY || process.env.HOME + "/levered.json";
const RECEIPT = process.env.RECEIPT_MINT || "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB";
const META_COUNT = txbuild.CRAWL_HOOK_META_COUNT;
const SYS = web3.SystemProgram.programId;
const k = (p, w, s = false) => ({ pubkey: p, isSigner: s, isWritable: w });

async function main() {
  const admin = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEY, "utf8"))));
  const conn = new web3.Connection(RPC, "confirmed");
  const pair = await txbuild.loadPairFromReceipt(conn, PROGRAM, RECEIPT);
  const PROGRAM_PK = new web3.PublicKey(PROGRAM);
  const config = new web3.PublicKey(pair.config);
  const receipt = new web3.PublicKey(pair.receiptMint);
  const [metaList] = web3.PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), receipt.toBuffer()], PROGRAM_PK);
  const [priceCrawl] = txbuild.priceCrawlPda(PROGRAM, pair.config);
  const embeds = await txbuild.buildHookEmbeds(conn, PROGRAM, pair);
  console.log("patch embeds", embeds.length, "meta count", META_COUNT);

  const crawlAi = await conn.getAccountInfo(priceCrawl, "confirmed");
  if (crawlAi && crawlAi.data.length < 519) {
    const top = Math.max(0, (await conn.getMinimumBalanceForRentExemption(519)) - crawlAi.lamports);
    const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })];
    if (top > 0) ixs.push(web3.SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: priceCrawl, lamports: top }));
    ixs.push(new web3.TransactionInstruction({
      programId: PROGRAM_PK,
      keys: [k(admin.publicKey, true, true), k(config, false), k(priceCrawl, true), k(SYS, false)],
      data: Buffer.from([20]),
    }));
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new web3.VersionedTransaction(new web3.TransactionMessage({
      payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: ixs,
    }).compileToV0Message());
    tx.sign([admin]);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    console.log("migrate", sig);
  }

  const built = await txbuild.buildAdvanceCrawl(conn, { programId: PROGRAM, payer: admin.publicKey.toBase58(), pair });
  if (built.tx) {
    const vtx = web3.VersionedTransaction.deserialize(Buffer.from(built.tx, "base64"));
    vtx.sign([admin]);
    const sig = await conn.sendRawTransaction(vtx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    console.log("seed box advance_crawl", sig);
  }

  const mask = txbuild.hookWritableMask(META_COUNT);
  const metaAi = await conn.getAccountInfo(metaList, "confirmed");
  const need = 16 + META_COUNT * 35;
  const top = metaAi ? Math.max(0, (await conn.getMinimumBalanceForRentExemption(need)) - metaAi.lamports) : 0;
  const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
  if (top > 0) ixs.push(web3.SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: metaList, lamports: top }));
  ixs.push(new web3.TransactionInstruction({
    programId: PROGRAM_PK,
    keys: [k(admin.publicKey, true, true), k(config, false), k(metaList, true), k(receipt, false), k(SYS, false), ...embeds.map((p) => k(p, false))],
    data: Buffer.from([19, META_COUNT, mask & 0xff, (mask >> 8) & 0xff]),
  }));
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new web3.VersionedTransaction(new web3.TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message());
  tx.sign([admin]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  console.log("patch boxed hook metas", sig);
}

main().catch((e) => { console.error(e); process.exit(1); });