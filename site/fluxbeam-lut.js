"use strict";

const {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const EXTEND_CHUNK = 20;
const LUT_READY_MS = Number(process.env.LUT_READY_MS || "5000");

/** Unique instruction pubkeys for a pool LUT (all signers stay static). */
function collectLutAddresses(instructions, payer) {
  const seen = new Set();
  const signers = new Set([payer.toBase58()]);
  for (const ix of instructions) {
    for (const k of ix.keys) if (k.isSigner) signers.add(k.pubkey.toBase58());
  }
  const out = [];
  const push = (pk) => {
    const b = pk.toBase58();
    if (signers.has(b) || seen.has(b)) return;
    seen.add(b);
    out.push(pk);
  };
  for (const ix of instructions) {
    push(ix.programId);
    for (const k of ix.keys) push(k.pubkey);
  }
  return out;
}

function buildLutTx(payer, blockhash, instructions) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToLegacyMessage();
  return new VersionedTransaction(msg);
}

/** Build create + extend txs for a fresh per-pool LUT (unsigned unless payerKp passed). */
async function buildPoolLutTxs(conn, payer, poolInstructions, payerKp = null) {
  if (!(payer instanceof PublicKey) && payer?.publicKey) {
    payerKp = payer;
    payer = payer.publicKey;
  } else if (!(payer instanceof PublicKey)) {
    payer = new PublicKey(payer);
  }
  const addresses = collectLutAddresses(poolInstructions, payer);
  const slot = await conn.getSlot("finalized");
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer,
    payer,
    recentSlot: Math.max(0, slot - 1),
  });

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const priority = Number(process.env.PRIORITY_FEE || "500000");
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
  ];

  const txs = [];
  const createTx = buildLutTx(payer, blockhash, [...budget, createIx]);
  if (payerKp) createTx.sign([payerKp]);
  txs.push({
    step: "lut/create",
    tx: Buffer.from(createTx.serialize()).toString("base64"),
    bytes: createTx.serialize().length,
    lut: lutAddress.toBase58(),
  });

  for (let i = 0; i < addresses.length; i += EXTEND_CHUNK) {
    const chunk = addresses.slice(i, i + EXTEND_CHUNK);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer,
      authority: payer,
      lookupTable: lutAddress,
      addresses: chunk,
    });
    const extendTx = buildLutTx(payer, blockhash, [...budget, extendIx]);
    if (payerKp) extendTx.sign([payerKp]);
    txs.push({
      step: `lut/extend/${Math.floor(i / EXTEND_CHUNK)}`,
      tx: Buffer.from(extendTx.serialize()).toString("base64"),
      bytes: extendTx.serialize().length,
      lut: lutAddress.toBase58(),
    });
  }

  return { lutAddress, addresses: addresses.length, txs };
}

/** Land LUT txs on-chain and return loaded AddressLookupTableAccount. */
async function spawnPoolLut(conn, payerKp, poolInstructions, sendTx, label) {
  const { lutAddress, addresses, txs } = await buildPoolLutTxs(conn, payerKp, poolInstructions);
  console.log(`    lut ${lutAddress.toBase58().slice(0, 8)}… · ${addresses} addrs · ${txs.length} txs`);
  for (const step of txs) {
    const vtx = VersionedTransaction.deserialize(Buffer.from(step.tx, "base64"));
    const sig = await sendTx(vtx, `${label} ${step.step}`);
    console.log(`    ${step.step}: ${sig} (${step.bytes}B)`);
  }
  await new Promise((r) => setTimeout(r, LUT_READY_MS));
  for (let i = 0; i < 30; i++) {
    const { value } = await conn.getAddressLookupTable(lutAddress);
    if (value && value.state.addresses.length > 0) return value;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`LUT not ready: ${lutAddress.toBase58()}`);
}

/** Compile against LUT before create txs have landed (wallet batching). */
function localLutAccount(lutAddress, authority, addresses) {
  return new AddressLookupTableAccount({
    key: lutAddress,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority,
      addresses,
    },
  });
}

module.exports = {
  collectLutAddresses,
  buildPoolLutTxs,
  spawnPoolLut,
  localLutAccount,
};