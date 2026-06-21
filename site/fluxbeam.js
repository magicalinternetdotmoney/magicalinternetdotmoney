// FluxBeam pool creation — patch hook, own LP/pool keypairs, per-pool LUT + direct 3-signer vtx.
"use strict";

const {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} = require("@solana/web3.js");
const {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const {
  buildPoolLutTxs,
  collectLutAddresses,
  localLutAccount,
  spawnPoolLut,
} = require("./fluxbeam-lut.js");

const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const FLUX_PROGRAM_ID = new PublicKey("FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X");
const TOKEN_CLASSIC = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const BEAM_AUTHORITY = new PublicKey("beamazjPnFT3JQoe16HjUxkpmHFfsHY6dTqf3VwBXzq");

function fluxPoolStatePda(poolPk) {
  return PublicKey.findProgramAddressSync([poolPk.toBuffer()], FLUX_PROGRAM_ID)[0];
}

const FLUX_API = process.env.FLUXBEAM_API || "https://api.fluxbeam.xyz/v1/token_pools";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function quoteTokenProgram(quoteMint) {
  return quoteMint === USDC || quoteMint === WSOL ? TOKEN_CLASSIC : TOKEN_2022_PROGRAM_ID;
}

const RECEIPTS = new Set([
  "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB",
  "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG",
]);

async function fluxCreatePool(payer, receiptMint, quoteMint, receiptRaw, quoteRaw) {
  const r = await fetch(FLUX_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payer,
      token_a: receiptMint,
      token_b: quoteMint,
      token_a_amount: receiptRaw.toString(),
      token_b_amount: quoteRaw.toString(),
    }),
  });
  const j = await r.json();
  if (!r.ok || j.error || !j.transaction) {
    throw new Error(j.error || j.message || `FluxBeam ${r.status}: ${JSON.stringify(j)}`);
  }
  return j;
}

async function decompileFluxTemplate(conn, b64) {
  const vtx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const lookups = vtx.message.addressTableLookups || [];
  const altAccounts = await Promise.all(lookups.map(async (l) => {
    const ai = await conn.getAccountInfo(l.accountKey);
    if (!ai) throw new Error("missing ALT " + l.accountKey.toBase58());
    return new AddressLookupTableAccount({
      key: l.accountKey,
      state: AddressLookupTableAccount.deserialize(ai.data),
    });
  }));
  const dec = TransactionMessage.decompile(vtx.message, { addressLookupTableAccounts: altAccounts });
  return { payerKey: dec.payerKey, instructions: [...dec.instructions] };
}

function cloneIx(ix) {
  return {
    programId: ix.programId,
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data),
  };
}

function remapPubkeys(instructions, fromPk, toPk) {
  const from = fromPk.toBase58();
  const to = toPk;
  for (const ix of instructions) {
    for (const k of ix.keys) {
      if (k.pubkey.toBase58() === from) k.pubkey = to;
    }
  }
}

/** Remap API-issued pool/LP/state pubkeys — preserves signer + writable flags from template. */
function applyRemap(instructions, remap) {
  if (!remap.size) return;
  for (const ix of instructions) {
    for (const k of ix.keys) {
      const next = remap.get(k.pubkey.toBase58());
      if (next) k.pubkey = next;
    }
  }
}

/** InitializeMint2 etc. embed pubkeys in ix data — account-key remap is not enough. */
function patchInstructionDataPubkeys(instructions, remap) {
  if (!remap.size) return;
  for (const ix of instructions) {
    if (ix.data.length < 32) continue;
    const data = Buffer.from(ix.data);
    let changed = false;
    for (const [oldB58, newPk] of remap) {
      const oldBuf = new PublicKey(oldB58).toBuffer();
      const newBuf = newPk.toBuffer();
      for (let i = 0; i <= data.length - 32; i++) {
        if (!data.subarray(i, i + 32).equals(oldBuf)) continue;
        newBuf.copy(data, i);
        changed = true;
      }
    }
    if (changed) ix.data = data;
  }
}

const WSOL_MINT = NATIVE_MINT;

function payerWsolAta(payer) {
  return getAssociatedTokenAddressSync(WSOL_MINT, payer, false, TOKEN_PROGRAM_ID);
}

function wsolQuoteAmountLamports(fundIxs) {
  for (const ix of fundIxs) {
    if (!ix.programId.equals(TOKEN_CLASSIC) || ix.data[0] !== 12) continue;
    if (!ix.keys[1].pubkey.equals(WSOL_MINT)) continue;
    return ix.data.readBigUInt64LE(1);
  }
  return 0n;
}

function stripWsolWrapFromSetup(setupIxs, payer) {
  const wsolAta = payerWsolAta(payer);
  return setupIxs.filter((ix) => {
    if (ix.programId.equals(ATA_PROGRAM_ID) && ix.keys[2]?.pubkey?.equals(payer) && ix.keys[3]?.pubkey?.equals(WSOL_MINT)) {
      return false;
    }
    if (ix.programId.equals(SYSTEM_PROGRAM_ID) && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2 && ix.keys[1]?.pubkey?.equals(wsolAta)) {
      return false;
    }
    if (ix.programId.equals(TOKEN_CLASSIC) && ix.data[0] === 17 && ix.keys[0]?.pubkey?.equals(wsolAta)) {
      return false;
    }
    return true;
  });
}

/** Unsigned wrap-SOL vtx for wallet path (server has no payer secret). */
async function buildWrapWsolTx(conn, payer, lamports) {
  if (lamports <= 0n) return null;
  const payerPk = payer instanceof PublicKey ? payer : new PublicKey(payer);
  const ata = payerWsolAta(payerPk);
  const priority = Number(process.env.PRIORITY_FEE || "500000");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payerPk,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
      createAssociatedTokenAccountIdempotentInstruction(payerPk, ata, payerPk, WSOL_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: ata, lamports: Number(lamports) }),
      createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
    ],
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  return { step: "wrap/sol", tx: Buffer.from(tx.serialize()).toString("base64"), bytes: tx.serialize().length };
}

async function sendWrapWsol(conn, payerKp, lamports, label) {
  if (lamports <= 0n) return null;
  const payer = payerKp.publicKey;
  const ata = payerWsolAta(payer);
  const priority = Number(process.env.PRIORITY_FEE || "500000");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
      createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, WSOL_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports: Number(lamports) }),
      createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
    ],
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  const sig = await sendRawAndConfirm(conn, tx, [payerKp], `${label} wrap SOL`);
  console.log(`    wrap SOL: ${sig} (${Number(lamports) / 1e9} wSOL)`);
  return sig;
}

async function prepareWsolQuote(conn, payerKp, patched, quoteMint, label) {
  if (quoteMint !== WSOL) return [];
  const lamports = wsolQuoteAmountLamports(patched.fundIxs);
  const sigs = [];
  if (lamports > 0n) sigs.push(await sendWrapWsol(conn, payerKp, lamports, label));
  patched.setupIxs = stripWsolWrapFromSetup(patched.setupIxs, payerKp.publicKey);
  return sigs.filter(Boolean);
}

function derivedAta(mint, owner, tokenProgram) {
  let allowOffCurve = false;
  try {
    getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  } catch {
    allowOffCurve = true;
  }
  return getAssociatedTokenAddressSync(mint, owner, allowOffCurve, tokenProgram);
}

/** Fix ATA addresses in create-ATA ixs only — do not blanket-remap Flux Init (breaks owner checks). */
function fixDerivedAtas(instructions) {
  let n = 0;
  for (const ix of instructions) {
    if (!ix.programId.equals(ATA_PROGRAM_ID) || ix.keys.length < 6) continue;
    const owner = ix.keys[2].pubkey;
    const mint = ix.keys[3].pubkey;
    const tokenProgram = ix.keys[5].pubkey;
    const ata = derivedAta(mint, owner, tokenProgram);
    if (!ix.keys[1].pubkey.equals(ata)) {
      ix.keys[1].pubkey = ata;
      n++;
    }
  }
  return n;
}

/** Point fund transfers at vault ATAs from rebuilt Flux Init. */
function syncFundTransfers(fundIxs, fluxInit, payerPub, receiptMint, quoteMint) {
  const receipt = new PublicKey(receiptMint);
  const quote = new PublicKey(quoteMint);
  const quoteProgram = quoteTokenProgram(quoteMint);
  const receiptVault = fluxInit.keys[2].pubkey;
  const quoteVault = fluxInit.keys[3].pubkey;
  const payerReceipt = derivedAta(receipt, payerPub, TOKEN_2022_PROGRAM_ID);
  const payerQuote = derivedAta(quote, payerPub, quoteProgram);

  for (const ix of fundIxs) {
    if (ix.programId.equals(TOKEN_2022_PROGRAM_ID) && ix.data[0] === 12) {
      ix.keys[0].pubkey = payerReceipt;
      ix.keys[2].pubkey = receiptVault;
    }
    if (ix.programId.equals(TOKEN_CLASSIC) && ix.data[0] === 12) {
      ix.keys[0].pubkey = payerQuote;
      ix.keys[2].pubkey = quoteVault;
    }
  }
}

/** Flux pool account alloc (324B, Flux owner) must run in same tx as Init — not in a prior direct setup. */
function findPoolCreateIx(instructions, poolPub) {
  return instructions.findIndex((ix) => {
    if (!ix.programId.equals(SYSTEM_PROGRAM_ID) || ix.data.length < 52) return false;
    if (Number(ix.data.readBigUInt64LE(12)) !== 324) return false;
    const owner = new PublicKey(ix.data.subarray(20, 52));
    if (!owner.equals(FLUX_PROGRAM_ID)) return false;
    return ix.keys.some((k) => k.isSigner && k.pubkey.equals(poolPub));
  });
}

function splitSetupFund(instructions, receiptIdx, poolPub) {
  let setupIxs = instructions.slice(0, receiptIdx);
  let fundIxs = instructions.slice(receiptIdx);
  const pci = findPoolCreateIx(setupIxs, poolPub);
  if (pci >= 0) {
    fundIxs = [setupIxs[pci], ...fundIxs];
    setupIxs = setupIxs.filter((_, i) => i !== pci);
  }
  return { setupIxs, fundIxs };
}

/** Remap pool/LP/state + derived vault ATAs — keeps API Init account flags intact. */
function buildPoolRemap(apiPool, poolPub, apiLp, lpPub, payerPub, receiptMint, quoteMint) {
  const remap = new Map();
  const oldState = fluxPoolStatePda(apiPool);
  const newState = fluxPoolStatePda(poolPub);
  const receipt = new PublicKey(receiptMint);
  const quote = new PublicKey(quoteMint);
  const quoteProgram = quoteTokenProgram(quoteMint);

  remap.set(apiPool.toBase58(), poolPub);
  remap.set(apiLp.toBase58(), lpPub);
  remap.set(oldState.toBase58(), newState);
  remap.set(
    derivedAta(receipt, oldState, TOKEN_2022_PROGRAM_ID).toBase58(),
    derivedAta(receipt, newState, TOKEN_2022_PROGRAM_ID),
  );
  remap.set(
    derivedAta(quote, oldState, quoteProgram).toBase58(),
    derivedAta(quote, newState, quoteProgram),
  );
  remap.set(
    derivedAta(apiLp, BEAM_AUTHORITY, TOKEN_2022_PROGRAM_ID).toBase58(),
    derivedAta(lpPub, BEAM_AUTHORITY, TOKEN_2022_PROGRAM_ID),
  );
  remap.set(
    derivedAta(apiLp, payerPub, TOKEN_2022_PROGRAM_ID).toBase58(),
    derivedAta(lpPub, payerPub, TOKEN_2022_PROGRAM_ID),
  );
  return remap;
}

async function patchReceiptXfer(conn, ix) {
  const amount = ix.data.readBigUInt64LE(1);
  const decimals = ix.data[9];
  const extraSigners = ix.keys.filter((k) => k.isSigner).slice(1);
  return createTransferCheckedWithTransferHookInstruction(
    conn,
    ix.keys[0].pubkey,
    ix.keys[1].pubkey,
    ix.keys[2].pubkey,
    ix.keys[3].pubkey,
    amount,
    decimals,
    extraSigners,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
}

function buildTx(payerKey, blockhash, instructions, altAccounts, maxBytes = 1232) {
  const msg = altAccounts?.length
    ? new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions }).compileToV0Message(altAccounts)
    : new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  const n = tx.serialize().length;
  if (maxBytes && n > maxBytes) throw new Error(`tx too large (${n} bytes)`);
  return tx;
}

async function loadFluxAlts(conn, b64) {
  const vtx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const lookups = vtx.message.addressTableLookups || [];
  return Promise.all(lookups.map(async (l) => {
    const ai = await conn.getAccountInfo(l.accountKey);
    if (!ai) throw new Error("missing ALT " + l.accountKey.toBase58());
    return new AddressLookupTableAccount({
      key: l.accountKey,
      state: AddressLookupTableAccount.deserialize(ai.data),
    });
  }));
}

/**
 * @param megatxn {{ creator: string, transactionIndex: number }} — use ephemeral signers for LP+pool
 */
async function buildPatchedPoolTxs(conn, b64, apiLpMint, apiPool, megatxn, tokenAMint, tokenBMint, opts = {}) {
  const useApiSigners = !!opts.useApiSigners;
  const altAccounts = await loadFluxAlts(conn, b64);
  const { payerKey, instructions: raw } = await decompileFluxTemplate(conn, b64);
  const instructions = raw.map(cloneIx);

  const apiLp = new PublicKey(apiLpMint);
  const apiPoolPk = new PublicKey(apiPool);

  let lpPub;
  let poolPub;
  let lpKp = null;
  let poolKp = null;
  let ephemeralCount = 0;

  if (useApiSigners) {
    lpPub = apiLp;
    poolPub = apiPoolPk;
  } else if (megatxn) {
    const creator = new PublicKey(megatxn.creator);
    const { pubkeys } = ephemeralSignersFor(creator, megatxn.transactionIndex, 2);
    lpPub = pubkeys[0];
    poolPub = pubkeys[1];
    ephemeralCount = 2;
  } else {
    lpKp = Keypair.generate();
    poolKp = Keypair.generate();
    lpPub = lpKp.publicKey;
    poolPub = poolKp.publicKey;
  }

  const payerPub = new PublicKey(payerKey);

  const receiptMint = tokenAMint || instructions.find(
    (ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID) && ix.data[0] === 12,
  )?.keys[1].pubkey?.toBase58();
  const quoteMint = tokenBMint || instructions.find(
    (ix) => ix.programId.equals(TOKEN_CLASSIC) && ix.data[0] === 12,
  )?.keys[1].pubkey?.toBase58();

  if (!useApiSigners && receiptMint && quoteMint) {
    const remap = buildPoolRemap(apiPoolPk, poolPub, apiLp, lpPub, payerPub, receiptMint, quoteMint);
    applyRemap(instructions, remap);
    patchInstructionDataPubkeys(instructions, remap);
    fixDerivedAtas(instructions);
  } else if (useApiSigners) {
    fixDerivedAtas(instructions);
  }

  const receiptIdx = instructions.findIndex(
    (ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID)
      && ix.data.length >= 9 && ix.data[0] === 12
      && RECEIPTS.has(ix.keys[1].pubkey.toBase58()),
  );
  if (receiptIdx < 0) throw new Error("receipt transferChecked not found in template");

  instructions[receiptIdx] = await patchReceiptXfer(conn, instructions[receiptIdx]);

  const fluxInit = instructions.find((ix) => ix.programId.equals(FLUX_PROGRAM_ID));

  // Megatxn legacy split — combined order matches API template (pool create before receipt xfer).
  let setupIxs = instructions.slice(0, receiptIdx);
  let fundIxs = instructions.slice(receiptIdx);
  const pci = findPoolCreateIx(setupIxs, poolPub);
  if (pci >= 0) {
    fundIxs = [setupIxs[pci], ...fundIxs];
    setupIxs = setupIxs.filter((_, i) => i !== pci);
  }
  const rebuiltInit = fundIxs.find((ix) => ix.programId.equals(FLUX_PROGRAM_ID)) || fluxInit;
  if (rebuiltInit && receiptMint && quoteMint) {
    syncFundTransfers(fundIxs, rebuiltInit, payerPub, receiptMint, quoteMint);
  }

  return {
    payerKey,
    setupIxs,
    fundIxs,
    lpKp,
    poolKp,
    altAccounts,
    ephemeralCount,
    pool: poolPub.toBase58(),
    lpMint: lpPub.toBase58(),
    transactionIndex: megatxn?.transactionIndex,
  };
}

function allPoolIxs(patched) {
  return [...patched.setupIxs, ...patched.fundIxs];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRIORITY_MICROLAMPORTS = Number(process.env.PRIORITY_FEE || "500000");
const SKIP_PREFLIGHT = process.env.SKIP_PREFLIGHT === "1";
const SKIP_SIM = process.env.SKIP_SIM === "1";

function withPriority(instructions, units = 1_400_000) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
    ...instructions,
  ];
}

async function buildPoolVtx(conn, patched, lutAccount, blockhash = null, opts = {}) {
  if (!blockhash) ({ blockhash } = await conn.getLatestBlockhash("confirmed"));
  const alts = [...patched.altAccounts, lutAccount];
  const ixs = opts.priority === false ? allPoolIxs(patched) : withPriority(allPoolIxs(patched));
  return buildTx(patched.payerKey, blockhash, ixs, alts);
}

function poolSigners(patched, payerKp) {
  const out = [payerKp];
  if (patched.poolKp) out.push(patched.poolKp);
  if (patched.lpKp) out.push(patched.lpKp);
  return out;
}

/**
 * Wallet: wrap (optional) + LUT create/extend (unsigned) + pool vtx (LP/pool signed server-side).
 * Wallet signs payer on every vtx; pool tx must land after LUT is active.
 */
async function buildWalletPoolTxs(conn, payer, receiptMint, quoteMint, receiptRaw, quoteRaw) {
  const j = await fluxCreatePool(payer, receiptMint, quoteMint, receiptRaw, quoteRaw);
  const patched = await buildPatchedPoolTxs(conn, j.transaction, j.lp_mint, j.pool, null, receiptMint, quoteMint);
  const payerPk = new PublicKey(payer);

  const txs = [];
  if (quoteMint === WSOL) {
    const lamports = wsolQuoteAmountLamports(patched.fundIxs);
    const wrap = await buildWrapWsolTx(conn, payerPk, lamports);
    if (wrap) txs.push(wrap);
    patched.setupIxs = stripWsolWrapFromSetup(patched.setupIxs, payerPk);
  }

  const inner = allPoolIxs(patched);
  const { lutAddress, addresses, txs: lutTxs } = await buildPoolLutTxs(conn, payerPk, inner);
  txs.push(...lutTxs);

  const lutAcct = localLutAccount(lutAddress, payerPk, collectLutAddresses(inner, payerPk));
  const poolTx = await buildPoolVtx(conn, patched, lutAcct);
  poolTx.sign([patched.lpKp, patched.poolKp]);

  txs.push({
    step: "pool",
    tx: Buffer.from(poolTx.serialize()).toString("base64"),
    bytes: poolTx.serialize().length,
    lut: lutAddress.toBase58(),
    lutAddresses: addresses,
  });

  return {
    txs,
    pool: patched.pool,
    lpMint: patched.lpMint,
    receiptMint,
    quoteMint,
    lut: lutAddress.toBase58(),
  };
}

async function sendRawAndConfirm(conn, tx, signers, label, opts = {}) {
  if (opts.refreshBlockhash !== false) {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = blockhash;
  }
  if (signers?.length) tx.sign(signers);

  if (!SKIP_SIM) {
    process.stdout.write(`    ${label}: simulating…\n`);
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: opts.sigVerify !== false,
      commitment: "processed",
    });
    if (sim.value.err) {
      const tail = sim.value.logs ? sim.value.logs.slice(-12).join("\n") : "";
      throw new Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}${tail ? "\n" + tail : ""}`);
    }
  }

  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: SKIP_PREFLIGHT,
      preflightCommitment: "processed",
      maxRetries: 5,
    });
  } catch (e) {
    const logs = e.logs ? "\n" + e.logs.join("\n") : "";
    throw new Error(`${label} send rejected: ${e.message}${logs}`);
  }
  process.stdout.write(`    ${label}: sent ${sig.slice(0, 16)}… confirming\n`);

  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(`${label} failed: ${JSON.stringify(v.err)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return sig;
    await sleep(2000);
  }
  throw new Error(`${label} not confirmed in 90s — ${sig}`);
}

function signersInMessage(msg, keypairs) {
  const n = msg.header.numRequiredSignatures;
  const required = new Set(msg.staticAccountKeys.slice(0, n).map((k) => k.toBase58()));
  return keypairs.filter((kp) => required.has(kp.publicKey.toBase58()));
}

/** Patch hook xfer · own LP/pool keypairs · LUT spawn · payer+pool+LP sign locally. */
async function sendPool(conn, payerKp, b64, apiLp, apiPool, label, dry, opts = {}) {
  const tokenA = opts.tokenA;
  const tokenB = opts.tokenB;
  const sigs = [];

  const patched = await buildPatchedPoolTxs(conn, b64, apiLp, apiPool, null, tokenA, tokenB, { useApiSigners: false });
  const inner = allPoolIxs(patched);

  if (dry) {
    const addrs = collectLutAddresses(inner, payerKp.publicKey);
    const lutAcct = localLutAccount(Keypair.generate().publicKey, payerKp.publicKey, addrs);
    const poolTx = await buildPoolVtx(conn, patched, lutAcct);
    poolTx.sign(poolSigners(patched, payerKp));
    console.log(`    pool ${patched.pool.slice(0, 8)}… · lp ${patched.lpMint.slice(0, 8)}… · ${inner.length} ixs · ~${poolTx.serialize().length}B`);
    return { pool: patched.pool, lpMint: patched.lpMint, sigs, dry: true, bytes: poolTx.serialize().length };
  }

  console.log(`    pool ${patched.pool.slice(0, 8)}… · lp ${patched.lpMint.slice(0, 8)}… · ${inner.length} ixs`);

  const wrapSigs = await prepareWsolQuote(conn, payerKp, patched, tokenB, label);
  sigs.push(...wrapSigs);

  const lut = await spawnPoolLut(conn, payerKp, allPoolIxs(patched), (tx, lbl) => sendRawAndConfirm(conn, tx, [payerKp], lbl), label);

  const poolTx = await buildPoolVtx(conn, patched, lut, null, { priority: false });
  const signers = signersInMessage(poolTx.message, poolSigners(patched, payerKp));
  const poolSig = await sendRawAndConfirm(conn, poolTx, signers, `${label} pool`, { sigVerify: true });
  console.log(`    pool: ${poolSig} (${poolTx.serialize().length}B)`);
  sigs.push(poolSig);

  return { pool: patched.pool, lpMint: patched.lpMint, sigs };
}

function receiptForQuoteUi(quoteUi, nav, dec = 6) {
  if (!nav || nav <= 0) throw new Error("invalid nav");
  return BigInt(Math.round((quoteUi / nav) * 10 ** dec));
}

function uiToRaw(ui, dec) {
  return BigInt(Math.round(ui * 10 ** dec));
}

function rawToUi(raw, dec) {
  return Number(raw) / 10 ** dec;
}

module.exports = {
  FLUX_API, WSOL, USDC, RECEIPTS,
  fluxCreatePool, buildPatchedPoolTxs, buildWalletPoolTxs, sendPool,
  receiptForQuoteUi, uiToRaw, rawToUi,
};