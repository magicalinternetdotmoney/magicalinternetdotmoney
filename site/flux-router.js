// Universal FluxBeam router — direct + 2-hop via WSOL/USDC; transfer-hook remaining accounts.
"use strict";

const {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { FLUX_PROGRAM_ID, WSOL, USDC } = require("./flux-indexer.js");

const HUBS = [WSOL, USDC];
const PRIORITY = Number(process.env.PRIORITY_FEE || "500000");

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

function feeCeil(amount, num, den) {
  if (!den || den === 0n || !num) return 0n;
  return (amount * num + den - 1n) / den;
}

function swapOut(amountIn, reserveIn, reserveOut, pool) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  let x = amountIn;
  x -= feeCeil(x, pool.tradeFeeNumerator, pool.tradeFeeDenominator);
  x -= feeCeil(x, pool.ownerTradeFeeNumerator, pool.ownerTradeFeeDenominator);
  x -= feeCeil(x, pool.hostFeeNumerator, pool.hostFeeDenominator);
  if (x <= 0n) return 0n;
  return (x * reserveOut) / (reserveIn + x);
}

function poolSide(pool, inputMint) {
  if (pool.mintA === inputMint) {
    return {
      reserveIn: pool.reserveA,
      reserveOut: pool.reserveB,
      poolSource: pool.vaultA,
      poolDest: pool.vaultB,
      srcMint: pool.mintA,
      dstMint: pool.mintB,
    };
  }
  if (pool.mintB === inputMint) {
    return {
      reserveIn: pool.reserveB,
      reserveOut: pool.reserveA,
      poolSource: pool.vaultB,
      poolDest: pool.vaultA,
      srcMint: pool.mintB,
      dstMint: pool.mintA,
    };
  }
  return null;
}

function scorePool(pool) {
  let s = Number(pool.reserveA + pool.reserveB);
  if (pool.thook) s *= 1.25;
  return s;
}

function pickPool(indexer, inputMint, outputMint) {
  const pools = indexer.poolsForPair(inputMint, outputMint).filter((p) => {
    const side = poolSide(p, inputMint);
    return side && side.reserveIn > 0n && side.reserveOut > 0n;
  });
  if (!pools.length) return null;
  return pools.slice().sort((a, b) => scorePool(b) - scorePool(a))[0];
}

function quoteLeg(pool, inputMint, amountIn) {
  const side = poolSide(pool, inputMint);
  if (!side) return 0n;
  return swapOut(amountIn, side.reserveIn, side.reserveOut, pool);
}

function quoteDirect(indexer, inputMint, outputMint, amountIn) {
  const pool = pickPool(indexer, inputMint, outputMint);
  if (!pool) return null;
  const out = quoteLeg(pool, inputMint, amountIn);
  if (out <= 0n) return null;
  return { hops: [{ pool, inputMint, outputMint, amountIn, amountOut: out }], amountOut: out };
}

function quoteViaHub(indexer, inputMint, outputMint, amountIn, hub) {
  if (inputMint === hub || outputMint === hub) return null;
  const p1 = pickPool(indexer, inputMint, hub);
  const mid = p1 ? quoteLeg(p1, inputMint, amountIn) : 0n;
  if (mid <= 0n) return null;
  const p2 = pickPool(indexer, hub, outputMint);
  if (!p2) return null;
  const out = quoteLeg(p2, hub, mid);
  if (out <= 0n) return null;
  return {
    hops: [
      { pool: p1, inputMint, outputMint: hub, amountIn, amountOut: mid },
      { pool: p2, inputMint: hub, outputMint, amountIn: mid, amountOut: out },
    ],
    amountOut: out,
    hub,
  };
}

function quoteRoute(indexer, inputMint, outputMint, amountIn) {
  if (amountIn <= 0n) return null;
  if (inputMint === outputMint) return null;
  const candidates = [];
  const direct = quoteDirect(indexer, inputMint, outputMint, amountIn);
  if (direct) candidates.push(direct);
  for (const hub of HUBS) {
    const via = quoteViaHub(indexer, inputMint, outputMint, amountIn, hub);
    if (via) candidates.push(via);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    const ta = a.hops.some((h) => h.pool.thook) ? 1 : 0;
    const tb = b.hops.some((h) => h.pool.thook) ? 1 : 0;
    return tb - ta;
  });
  const best = candidates[0];
  return {
    inputMint,
    outputMint,
    amountIn: amountIn.toString(),
    amountOut: best.amountOut.toString(),
    hops: best.hops.map((h) => ({
      pool: h.pool.pool,
      inputMint: h.inputMint,
      outputMint: h.outputMint,
      amountIn: h.amountIn.toString(),
      amountOut: h.amountOut.toString(),
      thook: h.pool.thook,
    })),
    hub: best.hub || null,
  };
}

async function hookRemainingAccounts(conn, mint, source, destination, owner, amount, decimals) {
  const m = new PublicKey(mint);
  const prog = mintProgram(mint);
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      conn,
      source,
      m,
      destination,
      owner,
      amount,
      decimals,
      [],
      "confirmed",
      prog,
    );
    return ix.keys.slice(4);
  } catch {
    return [];
  }
}

function buildSwapIx(pool, owner, inputMint, outputMint, amountIn, minOut, extraKeys = []) {
  const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const side = poolSide(pool, inputMint);
  if (!side) throw new Error("mint not in pool");
  const auth = new PublicKey(pool.authority);
  const userSrc = userAta(ownerPk, inputMint);
  const userDst = userAta(ownerPk, outputMint);
  const srcProg = mintProgram(inputMint);
  const dstProg = mintProgram(outputMint);
  const lpProg = new PublicKey(pool.poolTokenProgram);

  const data = Buffer.alloc(17);
  data[0] = 1;
  data.writeBigUInt64LE(amountIn, 1);
  data.writeBigUInt64LE(minOut, 9);

  const keys = [
    { pubkey: new PublicKey(pool.pool), isSigner: false, isWritable: false },
    { pubkey: auth, isSigner: false, isWritable: false },
    { pubkey: ownerPk, isSigner: true, isWritable: false },
    { pubkey: userSrc, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(side.poolSource), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(side.poolDest), isSigner: false, isWritable: true },
    { pubkey: userDst, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.lpMint), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(pool.feeAccount), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(side.srcMint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(side.dstMint), isSigner: false, isWritable: false },
    { pubkey: srcProg, isSigner: false, isWritable: false },
    { pubkey: dstProg, isSigner: false, isWritable: false },
    { pubkey: lpProg, isSigner: false, isWritable: false },
    ...extraKeys.map((k) => ({
      pubkey: k.pubkey,
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
  ];

  return new TransactionInstruction({ programId: FLUX_PROGRAM_ID, keys, data });
}

function hookMintForLeg(indexer, pool, inputMint, outputMint) {
  if (indexer.hasHook(inputMint)) return inputMint;
  if (indexer.hasHook(outputMint)) return outputMint;
  if (pool.thookMint && (pool.thookMint === inputMint || pool.thookMint === outputMint)) return pool.thookMint;
  return null;
}

async function swapIxForLeg(conn, indexer, pool, owner, inputMint, outputMint, amountIn, minOut) {
  const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const side = poolSide(pool, inputMint);
  const extras = [];
  const hookMint = hookMintForLeg(indexer, pool, inputMint, outputMint);
  if (hookMint) {
    const dec = hookMint === pool.mintA ? pool.decimalsA : pool.decimalsB;
    const isOut = hookMint === side.dstMint;
    const source = isOut ? new PublicKey(side.poolSource) : userAta(ownerPk, hookMint);
    const dest = isOut ? userAta(ownerPk, hookMint) : new PublicKey(side.poolDest);
    const auth = isOut ? new PublicKey(pool.authority) : ownerPk;
    const rem = await hookRemainingAccounts(conn, hookMint, source, dest, auth, amountIn, dec);
    extras.push(...rem);
  }
  return buildSwapIx(pool, ownerPk, inputMint, outputMint, amountIn, minOut, extras);
}

async function buildSwapTx(conn, indexer, owner, inputMint, outputMint, amountIn, slippageBps = 50) {
  await indexer.ensureFresh();
  const route = quoteRoute(indexer, inputMint, outputMint, amountIn);
  if (!route) throw new Error("no route");
  const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const slip = BigInt(slippageBps);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 * route.hops.length }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }),
  ];

  const needsWsolIn = inputMint === WSOL;
  const needsWsolOut = outputMint === WSOL;
  const wsolAta = userAta(ownerPk, WSOL);

  if (needsWsolIn) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(ownerPk, wsolAta, ownerPk, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: wsolAta, lamports: Number(amountIn) }),
      createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
    );
  }

  const inMint = inputMint === WSOL ? WSOL : inputMint;
  const outMint = outputMint === WSOL ? WSOL : outputMint;
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(ownerPk, userAta(ownerPk, inMint), ownerPk, new PublicKey(inMint), mintProgram(inMint)),
    createAssociatedTokenAccountIdempotentInstruction(ownerPk, userAta(ownerPk, outMint), ownerPk, new PublicKey(outMint), mintProgram(outMint)),
  );

  for (let i = 0; i < route.hops.length; i++) {
    const h = route.hops[i];
    const pool = indexer.pools.find((p) => p.pool === h.pool);
    if (!pool) throw new Error("stale pool " + h.pool);
    const amtIn = BigInt(h.amountIn);
    const amtOut = BigInt(h.amountOut);
    const minOut = amtOut - (amtOut * slip) / 10000n;
    ixs.push(await swapIxForLeg(conn, indexer, pool, ownerPk, h.inputMint, h.outputMint, amtIn, minOut));
  }

  if (needsWsolOut) {
    ixs.push(createCloseAccountInstruction(wsolAta, ownerPk, ownerPk, [], TOKEN_PROGRAM_ID));
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: ownerPk,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  return {
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    route,
    bytes: tx.serialize().length,
  };
}

module.exports = {
  quoteRoute,
  buildSwapTx,
  swapOut,
  pickPool,
  HUBS,
};