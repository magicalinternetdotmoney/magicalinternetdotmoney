#!/usr/bin/env node
// Drain all FluxBeam LP positions held by payer keypair (KEYPAIR env or CLI arg).
"use strict";

const fs = require("fs");
const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { FLUX_PROGRAM_ID, parsePoolPubkey, WSOL, USDC } = require("./flux-indexer.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const KEYPAIR = process.env.KEYPAIR || process.argv.find((a) => a.endsWith(".json")) || "";
const PRIORITY = Number(process.env.PRIORITY_FEE || "500000");

const POOLS = [
  { pool: "8G9fDqV6e5eMWYnnFaNN5YhuuNUZU9xkkAvrQym6RUC1", label: "3xSOL / SOL" },
  { pool: "Hb1JtjwHHmvvN9tau7YU8gX55UQqezbNgNvei27rFr56", label: "3xSOL / USDC" },
  { pool: "CLsj54K1ku4UGt5M5fSmynZ9XCZE5rgqnCB6cuuvvT8b", label: "5xBTC / SOL" },
  { pool: "C9MH8gTPhYTbsJrcQM6LMu1XaceuVvn3Y83KU7ZKPqx4", label: "5xBTC / USDC" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mintProgram(mint) {
  return mint === WSOL || mint === USDC ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

function userAta(owner, mint) {
  const prog = mintProgram(mint);
  let off = false;
  try {
    getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, prog);
  } catch {
    off = true;
  }
  return getAssociatedTokenAddressSync(new PublicKey(mint), owner, off, prog);
}

function quoteMint(pool) {
  if (pool.mintA === WSOL || pool.mintA === USDC) return pool.mintA;
  if (pool.mintB === WSOL || pool.mintB === USDC) return pool.mintB;
  return pool.mintB;
}

async function poolReserves(conn, pool) {
  const [vA, vB, lpMint] = await conn.getMultipleAccountsInfo([
    new PublicKey(pool.vaultA),
    new PublicKey(pool.vaultB),
    new PublicKey(pool.lpMint),
  ]);
  if (!vA || !vB || !lpMint) throw new Error("pool accounts missing");
  return {
    reserveA: AccountLayout.decode(vA.data).amount,
    reserveB: AccountLayout.decode(vB.data).amount,
    lpSupply: lpMint.data.readBigUInt64LE(36),
  };
}

function quoteOutAmount(lpAmount, quoteRes, lpSupply) {
  if (lpSupply === 0n) throw new Error("empty LP supply");
  return (lpAmount * quoteRes * 9999n) / (lpSupply * 10000n);
}

/** Single-sided withdraw — quote only, avoids receipt transfer-hook CPI. */
function buildWithdrawQuoteIx(pool, owner, lpAmount, destAmount) {
  const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const auth = new PublicKey(pool.authority);
  const lpProg = new PublicKey(pool.poolTokenProgram);
  const lpAta = getAssociatedTokenAddressSync(new PublicKey(pool.lpMint), ownerPk, false, lpProg);
  const dstMint = quoteMint(pool);
  const dest = userAta(ownerPk, dstMint);
  const dstProg = mintProgram(dstMint);

  const data = Buffer.alloc(17);
  data[0] = 5; // withdrawSingleTokenTypeExactAmountOut
  data.writeBigUInt64LE(destAmount, 1);
  data.writeBigUInt64LE(lpAmount, 9);

  const keys = [
    { pubkey: new PublicKey(pool.pool), isSigner: false, isWritable: false },
    { pubkey: auth, isSigner: false, isWritable: false },
    { pubkey: ownerPk, isSigner: true, isWritable: false },
    { pubkey: new PublicKey(pool.lpMint), isSigner: false, isWritable: true },
    { pubkey: lpAta, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultA), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.vaultB), isSigner: false, isWritable: true },
    { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.feeAccount), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(dstMint), isSigner: false, isWritable: false },
    { pubkey: lpProg, isSigner: false, isWritable: false },
    { pubkey: dstProg, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: FLUX_PROGRAM_ID, keys, data });
}

async function loadPool(conn, poolPk) {
  const ai = await conn.getAccountInfo(new PublicKey(poolPk));
  if (!ai) throw new Error(`pool missing: ${poolPk}`);
  const parsed = parsePoolPubkey(poolPk, ai.data);
  if (!parsed) throw new Error(`bad pool layout: ${poolPk}`);
  return parsed;
}

async function lpBalance(conn, owner, pool) {
  const lpProg = new PublicKey(pool.poolTokenProgram);
  const ata = getAssociatedTokenAddressSync(new PublicKey(pool.lpMint), owner, false, lpProg);
  const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
  return { ata, raw: bal ? BigInt(bal.value.amount) : 0n, ui: bal?.value?.uiAmount || 0 };
}

async function buildDrainTx(conn, payer, pool, lpAmount) {
  const owner = payer.publicKey;
  const dstMint = quoteMint(pool);
  const wsolAta = userAta(owner, WSOL);
  const { reserveA, reserveB, lpSupply } = await poolReserves(conn, pool);
  const quoteRes = dstMint === pool.mintA ? reserveA : reserveB;
  const destAmount = quoteOutAmount(lpAmount, quoteRes, lpSupply);
  if (destAmount <= 0n) throw new Error("quote out rounds to zero");

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }),
    createAssociatedTokenAccountIdempotentInstruction(
      owner, userAta(owner, dstMint), owner, new PublicKey(dstMint), mintProgram(dstMint),
    ),
  ];

  ixs.push(buildWithdrawQuoteIx(pool, owner, lpAmount, destAmount));

  if (dstMint === WSOL) {
    ixs.push(createCloseAccountInstruction(wsolAta, owner, owner, [], TOKEN_PROGRAM_ID));
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

async function sendTx(conn, tx, label) {
  const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "processed" });
  if (sim.value.err) {
    const tail = sim.value.logs ? sim.value.logs.slice(-15).join("\n") : "";
    throw new Error(`${label} sim: ${JSON.stringify(sim.value.err)}${tail ? "\n" + tail : ""}`);
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, preflightCommitment: "processed" });
  for (let i = 0; i < 45; i++) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(`${label}: ${JSON.stringify(v.err)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") {
      console.log(`  ✓ ${label}: ${sig}`);
      return sig;
    }
    await sleep(2000);
  }
  throw new Error(`${label} not confirmed: ${sig}`);
}

async function main() {
  const secret = JSON.parse(fs.readFileSync(KEYPAIR, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const conn = new Connection(RPC, "confirmed");
  console.log("payer:", payer.publicKey.toBase58());

  for (const spec of POOLS) {
    const pool = await loadPool(conn, spec.pool);
    const { raw, ui } = await lpBalance(conn, payer.publicKey, pool);
    console.log(`\n${spec.label} (${spec.pool})`);
    console.log(`  LP balance: ${ui} (${raw} raw)`);
    if (raw <= 1000n) {
      console.log("  skip — no LP");
      continue;
    }
    for (let pass = 1; pass <= 5; pass++) {
      const { raw: left } = await lpBalance(conn, payer.publicKey, pool);
      if (left <= 1000n) break;
      const tx = await buildDrainTx(conn, payer, pool, left);
      await sendTx(conn, tx, `drain ${spec.label}${pass > 1 ? ` (#${pass})` : ""}`);
      await sleep(1500);
    }
  }
  console.log("\ndone");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});