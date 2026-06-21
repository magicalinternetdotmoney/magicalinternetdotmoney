// Universal FluxBeam router — direct + multi-hop; transfer-hook remaining accounts; SOL arb.
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
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { FLUX_PROGRAM_ID, WSOL, USDC, THOOK_MINTS, toBigInt } = require("./flux-indexer.js");
const { formatUi } = require("./amounts.js");

const HUBS = [WSOL, USDC];
const PRIORITY = Number(process.env.PRIORITY_FEE || "500000");

/** Tokens with transfer fees break Flux minOut checks — never route arb through these. */
const BLOCKED_MINTS = new Set([
  "PFireKhT5WG7axMSLBmMRpvYH7cgHx9CRWHU8F8HNbr", // PFIRE 5% transfer fee
]);

const TRANSFER_FEE_MSG =
  "Route uses a Token-2022 mint with transfer fees — Flux swap minOut will fail on-chain. Pick another pool/token.";

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
  const n = typeof num === "bigint" ? num : BigInt(num || 0);
  const d = typeof den === "bigint" ? den : BigInt(den || 0);
  if (!d || d === 0n || !n) return 0n;
  return (amount * n + d - 1n) / d;
}

/** Token-2022 transfer fee withheld on each transfer (bps of amount). */
function netAfterTransferFee(amount, feeBps) {
  if (!feeBps || amount <= 0n) return amount;
  const fee = feeCeil(amount, BigInt(feeBps), 10000n);
  return amount - fee;
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
      reserveIn: toBigInt(pool.reserveA),
      reserveOut: toBigInt(pool.reserveB),
      poolSource: pool.vaultA,
      poolDest: pool.vaultB,
      srcMint: pool.mintA,
      dstMint: pool.mintB,
    };
  }
  if (pool.mintB === inputMint) {
    return {
      reserveIn: toBigInt(pool.reserveB),
      reserveOut: toBigInt(pool.reserveA),
      poolSource: pool.vaultB,
      poolDest: pool.vaultA,
      srcMint: pool.mintB,
      dstMint: pool.mintA,
    };
  }
  return null;
}

function scorePool(pool) {
  let s = Number(toBigInt(pool.reserveA) + toBigInt(pool.reserveB));
  if (pool.thook) s *= 1.25;
  return s;
}

function livePools(indexer, inputMint, outputMint) {
  return indexer.poolsForPair(inputMint, outputMint).filter((p) => {
    const side = poolSide(p, inputMint);
    return side && side.reserveIn > 0n && side.reserveOut > 0n;
  });
}

function pickPool(indexer, inputMint, outputMint) {
  const pools = livePools(indexer, inputMint, outputMint);
  if (!pools.length) return null;
  return pools.slice().sort((a, b) => scorePool(b) - scorePool(a))[0];
}

function quoteLeg(indexer, pool, inputMint, outputMint, amountIn) {
  const side = poolSide(pool, inputMint);
  if (!side) return 0n;
  const effectiveIn = netAfterTransferFee(amountIn, indexer.transferFeeBps(inputMint));
  if (effectiveIn <= 0n) return 0n;
  const rawOut = swapOut(effectiveIn, side.reserveIn, side.reserveOut, pool);
  return netAfterTransferFee(rawOut, indexer.transferFeeBps(outputMint));
}

function quoteBestLeg(indexer, inputMint, outputMint, amountIn) {
  const pools = livePools(indexer, inputMint, outputMint);
  let best = null;
  for (const pool of pools) {
    const out = quoteLeg(indexer, pool, inputMint, outputMint, amountIn);
    if (out <= 0n) continue;
    if (!best || out > best.amountOut) {
      best = { pool, amountOut: out };
    }
  }
  if (!best) return null;
  return {
    hops: [{ pool: best.pool, inputMint, outputMint, amountIn, amountOut: best.amountOut }],
    amountOut: best.amountOut,
  };
}

function quoteDirect(indexer, inputMint, outputMint, amountIn) {
  return quoteBestLeg(indexer, inputMint, outputMint, amountIn);
}

function quoteViaHub(indexer, inputMint, outputMint, amountIn, hub) {
  if (inputMint === hub || outputMint === hub) return null;
  const leg1 = quoteBestLeg(indexer, inputMint, hub, amountIn);
  if (!leg1) return null;
  const leg2 = quoteBestLeg(indexer, hub, outputMint, leg1.amountOut);
  if (!leg2) return null;
  return {
    hops: [...leg1.hops, ...leg2.hops],
    amountOut: leg2.amountOut,
    hub,
  };
}

function formatHop(h, indexer) {
  const decIn = indexer.decimalsFor(h.inputMint);
  const decOut = indexer.decimalsFor(h.outputMint);
  return {
    pool: h.pool.pool,
    inputMint: h.inputMint,
    outputMint: h.outputMint,
    amountIn: formatUi(h.amountIn, decIn),
    amountOut: formatUi(h.amountOut, decOut),
    thook: h.pool.thook,
  };
}

function formatRoute(indexer, inputMint, outputMint, amountIn, raw) {
  const decIn = indexer.decimalsFor(inputMint);
  const decOut = indexer.decimalsFor(outputMint);
  return {
    inputMint,
    outputMint,
    amountIn: formatUi(amountIn, decIn),
    amountOut: formatUi(raw.amountOut, decOut),
    hops: raw.hops.map((h) => formatHop(h, indexer)),
    hub: raw.hub || null,
  };
}

function quoteRouteRaw(indexer, inputMint, outputMint, amountIn) {
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
  return candidates[0];
}

function quoteRoute(indexer, inputMint, outputMint, amountIn) {
  const raw = quoteRouteRaw(indexer, inputMint, outputMint, amountIn);
  if (!raw) return null;
  return formatRoute(indexer, inputMint, outputMint, amountIn, raw);
}

function mintBlocked(indexer, mint) {
  return (
    BLOCKED_MINTS.has(mint) ||
    THOOK_MINTS.has(mint) ||
    indexer.hasHook(mint) ||
    indexer.hasTransferFee(mint)
  );
}

function solBridgeMints(indexer) {
  const mids = new Set();
  for (const p of indexer.pools) {
    if (p.mintA === WSOL && p.mintB !== WSOL) mids.add(p.mintB);
    if (p.mintB === WSOL && p.mintA !== WSOL) mids.add(p.mintA);
  }
  return [...mids].filter((m) => !BLOCKED_MINTS.has(m)).sort((a, b) => {
    const ta = mintBlocked(indexer, a) ? 1 : 0;
    const tb = mintBlocked(indexer, b) ? 1 : 0;
    if (ta !== tb) return tb - ta;
    return a < b ? -1 : 1;
  });
}

function assertRoutableMints(indexer, hops) {
  for (const h of hops) {
    for (const m of [h.inputMint, h.outputMint]) {
      if (mintBlocked(indexer, m)) throw new Error(TRANSFER_FEE_MSG);
    }
  }
}

const ARB_BRIDGE_LIMIT = +(process.env.ARB_BRIDGE_LIMIT || 800);

async function quoteSolArb(indexer, amountIn) {
  if (amountIn <= 0n) return null;
  const bridges = solBridgeMints(indexer).slice(0, ARB_BRIDGE_LIMIT);
  let best = null;
  for (const mid of bridges) {
    if (BLOCKED_MINTS.has(mid) || THOOK_MINTS.has(mid) || indexer.hasHook(mid)) continue;
    if (indexer.hasTransferFee(mid)) continue;
    const leg1 = quoteBestLeg(indexer, WSOL, mid, amountIn);
    if (!leg1) continue;
    const leg2 = quoteBestLeg(indexer, mid, WSOL, leg1.amountOut);
    if (!leg2) continue;
    const out = leg2.amountOut;
    const profit = out - amountIn;
    const hops = [...leg1.hops, ...leg2.hops];
    if (!best || profit > best.profit) {
      best = { profit, amountIn, amountOut: out, hops, via: mid };
    }
  }
  if (!best) return null;
  return {
    kind: "sol-arb",
    amountIn: formatUi(best.amountIn, 9),
    amountOut: formatUi(best.amountOut, 9),
    profit: formatUi(best.profit, 9),
    profitBps: Number((best.profit * 10000n) / best.amountIn),
    via: best.via,
    hops: best.hops.map((h) => formatHop(h, indexer)),
    profitable: best.profit > 0n,
    _raw: best,
  };
}

/** Flux swap is spl-token-swap layout: acct #15 = optional host-fee ATA, not hook extras. */
function legNeedsHook(indexer, pool, inputMint, outputMint) {
  if (pool.thook || pool.thookMint) return true;
  if (indexer.hasHook(inputMint) || indexer.hasHook(outputMint)) return true;
  return false;
}

const HOOK_SWAP_MSG =
  "FluxBeam swap cannot execute transfer-hook tokens yet: the program does not forward " +
  "Token-2022 hook accounts (3xSOL/5xBTC receipt). Swaps that move hook receipts will fail on-chain. " +
  "Use magicalinternet.money deposit/withdraw for receipt tokens until Flux adds hook support.";

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
    ...extraKeys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
  ];

  return new TransactionInstruction({ programId: FLUX_PROGRAM_ID, keys, data });
}

async function swapIxForLeg(conn, indexer, pool, owner, inputMint, outputMint, amountIn, minOut) {
  if (legNeedsHook(indexer, pool, inputMint, outputMint)) {
    throw new Error(HOOK_SWAP_MSG);
  }
  const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
  return buildSwapIx(pool, ownerPk, inputMint, outputMint, amountIn, minOut, []);
}

/** Pull on-chain vault balances for route pools and re-chain hop amounts. */
async function refreshAndRequoteHops(indexer, hops, amountIn) {
  const pools = hops.map((h) => h.pool);
  await indexer.refreshReserves(pools);
  let currentIn = amountIn;
  const fresh = [];
  for (const h of hops) {
    const out = quoteLeg(indexer, h.pool, h.inputMint, h.outputMint, currentIn);
    if (out <= 0n) return null;
    fresh.push({ ...h, amountIn: currentIn, amountOut: out });
    currentIn = out;
  }
  return fresh;
}

async function buildTxFromHops(conn, indexer, owner, hops, amountIn, inputMint, outputMint, slippageBps = 50) {
  const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const slip = BigInt(slippageBps);
  const mints = hops.flatMap((h) => [h.inputMint, h.outputMint]);
  await indexer.ensureMintMeta(mints);
  assertRoutableMints(indexer, hops);
  const freshHops = await refreshAndRequoteHops(indexer, hops, amountIn);
  if (!freshHops) throw new Error("route dried up — pool reserves changed");
  assertRoutableMints(indexer, freshHops);

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 * Math.max(freshHops.length, 1) }),
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

  const touched = new Set();
  for (const h of freshHops) {
    for (const m of [h.inputMint, h.outputMint]) {
      if (m === WSOL) continue;
      if (touched.has(m)) continue;
      touched.add(m);
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          ownerPk, userAta(ownerPk, m), ownerPk, new PublicKey(m), mintProgram(m),
        ),
      );
    }
  }

  for (const h of freshHops) {
    const amtIn = h.amountIn;
    const amtOut = h.amountOut;
    const minOut = amtOut - (amtOut * slip) / 10000n;
    ixs.push(await swapIxForLeg(conn, indexer, h.pool, ownerPk, h.inputMint, h.outputMint, amtIn, minOut));
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
    bytes: tx.serialize().length,
  };
}

async function buildSwapTx(conn, indexer, owner, inputMint, outputMint, amountIn, slippageBps = 100) {
  await indexer.ensureFresh();
  const raw = quoteRouteRaw(indexer, inputMint, outputMint, amountIn);
  if (!raw) throw new Error("no route");
  const pools = raw.hops.map((h) => h.pool);
  await indexer.refreshReserves(pools);
  const fresh = quoteRouteRaw(indexer, inputMint, outputMint, amountIn);
  if (!fresh) throw new Error("no route after reserve refresh");
  const route = formatRoute(indexer, inputMint, outputMint, amountIn, fresh);
  const built = await buildTxFromHops(conn, indexer, owner, fresh.hops, amountIn, inputMint, outputMint, slippageBps);
  return { ...built, route };
}

async function buildSolArbTx(conn, indexer, owner, amountIn, slippageBps = 300) {
  await indexer.ensureFresh();
  let arb = await quoteSolArb(indexer, amountIn);
  if (!arb) throw new Error("no arb route");
  const pools = arb._raw.hops.map((h) => h.pool);
  await indexer.refreshReserves(pools);
  arb = await quoteSolArb(indexer, amountIn);
  if (!arb) throw new Error("no arb route after reserve refresh");
  const built = await buildTxFromHops(conn, indexer, owner, arb._raw.hops, amountIn, WSOL, WSOL, slippageBps);
  const { _raw, ...pub } = arb;
  return { ...built, route: pub };
}

module.exports = {
  quoteRoute,
  quoteRouteRaw,
  quoteSolArb,
  buildSwapTx,
  buildSolArbTx,
  swapOut,
  pickPool,
  legNeedsHook,
  HOOK_SWAP_MSG,
  HUBS,
  WSOL,
};