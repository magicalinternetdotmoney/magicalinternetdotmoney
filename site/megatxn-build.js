"use strict";

const crypto = require("crypto");
const {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js"); // ComputeBudget used in withPriority
const {
  PROGRAM_ID,
  BUFFER_CHUNK_SIZE,
  getTransactionPda,
  getTransactionBufferPda,
  getEphemeralSignerPda,
  serializeTransactionMessage,
  txnBufferCreate,
  txnBufferExtend,
  txnCreate,
  txnCreateFromBuffer,
  buildExecuteInstruction,
} = require("./megatxn/index.js");

const INLINE_CREATE_LIMIT = 900;

async function findFreeMegatxnIndex(conn, creator) {
  const creatorPk = typeof creator === "string" ? new PublicKey(creator) : creator;
  const CHUNK = 32;
  for (let start = 0; start < 256; start += CHUNK) {
    const txnPdas = [];
    const bufPdas = [];
    for (let i = start; i < Math.min(start + CHUNK, 256); i++) {
      txnPdas.push(getTransactionPda(creatorPk, i)[0]);
      bufPdas.push(getTransactionBufferPda(creatorPk, i)[0]);
    }
    const [txnInfos, bufInfos] = await Promise.all([
      conn.getMultipleAccountsInfo(txnPdas),
      conn.getMultipleAccountsInfo(bufPdas),
    ]);
    for (let j = 0; j < txnInfos.length; j++) {
      if (!txnInfos[j] && !bufInfos[j]) return start + j;
    }
  }
  throw new Error("no free megatxn index (0-255)");
}

const { serializeMessage } = require("./megatxn/serialization.js");

/** Serialize using web3 v0 compilation — matches standard account indexes (wrapped compiler diverges). */
function serializeInnerMessage(payerKey, blockhash, instructions, altAccounts) {
  const tm = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions });
  if (!altAccounts?.length) {
    return serializeTransactionMessage(tm, undefined);
  }
  const v0 = tm.compileToV0Message(altAccounts);
  const h = v0.header;
  const numSigners = h.numRequiredSignatures;
  return serializeMessage({
    numSigners,
    numWritableSigners: numSigners - h.numReadonlySignedAccounts,
    numWritableNonSigners: v0.staticAccountKeys.length - numSigners - h.numReadonlyUnsignedAccounts,
    accountKeys: v0.staticAccountKeys,
    instructions: v0.compiledInstructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accountIndexes: Array.from(ix.accountKeyIndexes),
      data: Array.from(ix.data),
    })),
    addressTableLookups: v0.addressTableLookups.map((l) => ({
      accountKey: l.accountKey,
      writableIndexes: Array.from(l.writableIndexes),
      readonlyIndexes: Array.from(l.readonlyIndexes),
    })),
  });
}

function withPriority(instructions, units = 1_400_000) {
  const PRIORITY = Number(process.env.PRIORITY_FEE || "50000");
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY }),
    ...instructions,
  ];
}

function buildVersionedTx(payerKey, blockhash, instructions, altAccounts, maxBytes) {
  const ixs = withPriority(instructions);
  const msg = altAccounts?.length
    ? new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(altAccounts)
    : new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  const bytes = tx.serialize().length;
  if (maxBytes && bytes > maxBytes) throw new Error(`tx too large (${bytes} bytes)`);
  return { tx, bytes };
}

function txB64(tx, signers) {
  if (signers?.length) tx.sign(signers);
  return { tx: Buffer.from(tx.serialize()).toString("base64"), bytes: tx.serialize().length };
}

function ephemeralSignersFor(creator, transactionIndex, count) {
  const [transactionPda] = getTransactionPda(creator, transactionIndex);
  const pubkeys = [];
  for (let i = 0; i < count; i++) pubkeys.push(getEphemeralSignerPda(transactionPda, i)[0]);
  return { transactionPda, pubkeys };
}

/** Build megatxn create txs (inline or buffered). Execute is separate — needs on-chain create first. */
async function buildMegatxnCreateTxs(conn, creatorPk, payerKey, instructions, altAccounts, ephemeralCount, transactionIndexIn) {
  const creator = typeof creatorPk === "string" ? new PublicKey(creatorPk) : creatorPk;
  const transactionIndex = transactionIndexIn ?? await findFreeMegatxnIndex(conn, creator);
  const [transactionPda] = getTransactionPda(creator, transactionIndex);
  const [bufferPda] = getTransactionBufferPda(creator, transactionIndex);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  const messageBytes = serializeInnerMessage(payerKey, blockhash, instructions, altAccounts);
  const txs = [];

  if (messageBytes.length <= INLINE_CREATE_LIMIT) {
    const createIx = txnCreate({
      transactionIndex,
      ephemeralSigners: ephemeralCount,
      transactionMessage: messageBytes,
      transaction: transactionPda,
      creator,
      rentPayer: creator,
    });
    const { tx, bytes } = buildVersionedTx(creator, blockhash, [createIx], null, 1232);
    txs.push({ step: "megatxn/create", tx: Buffer.from(tx.serialize()).toString("base64"), bytes });
  } else {
    const hash = crypto.createHash("sha256").update(messageBytes).digest();
    const first = messageBytes.subarray(0, BUFFER_CHUNK_SIZE);
    const createBufIx = txnBufferCreate({
      bufferIndex: transactionIndex,
      finalBufferHash: hash,
      finalBufferSize: messageBytes.length,
      buffer: first,
      transactionBuffer: bufferPda,
      creator,
      rentPayer: creator,
    });
    let { tx, bytes } = buildVersionedTx(creator, blockhash, [createBufIx], null, 1232);
    txs.push({ step: "megatxn/buffer-create", tx: Buffer.from(tx.serialize()).toString("base64"), bytes });

    for (let i = BUFFER_CHUNK_SIZE; i < messageBytes.length; i += BUFFER_CHUNK_SIZE) {
      const chunk = messageBytes.subarray(i, i + BUFFER_CHUNK_SIZE);
      const extendIx = txnBufferExtend({ buffer: chunk, transactionBuffer: bufferPda, creator });
      ({ tx, bytes } = buildVersionedTx(creator, blockhash, [extendIx], null, 1232));
      txs.push({ step: `megatxn/buffer-extend/${Math.floor(i / BUFFER_CHUNK_SIZE)}`, tx: Buffer.from(tx.serialize()).toString("base64"), bytes });
    }

    const finalizeIx = txnCreateFromBuffer({
      transactionIndex,
      ephemeralSigners: ephemeralCount,
      transaction: transactionPda,
      creator,
      rentPayer: creator,
      transactionBuffer: bufferPda,
    });
    ({ tx, bytes } = buildVersionedTx(creator, blockhash, [finalizeIx], null, 1232));
    txs.push({ step: "megatxn/create-from-buffer", tx: Buffer.from(tx.serialize()).toString("base64"), bytes });
  }

  return {
    txs,
    transactionIndex,
    transactionPda: transactionPda.toBase58(),
    messageBytes: messageBytes.length,
    ephemeralCount,
  };
}

/** Build megatxn execute tx — call after create txs have confirmed on-chain. */
async function buildMegatxnExecuteTx(conn, creatorPk, transactionIndex, computeUnits = 1_400_000) {
  const creator = typeof creatorPk === "string" ? new PublicKey(creatorPk) : creatorPk;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const { instruction, lookupTableAccounts } = await buildExecuteInstruction({
    connection: conn,
    creator,
    transactionIndex,
    programId: PROGRAM_ID,
  });

  const ixs = withPriority([instruction], computeUnits);

  const msg = lookupTableAccounts.length
    ? new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookupTableAccounts)
    : new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();

  const tx = new VersionedTransaction(msg);
  return {
    step: "megatxn/execute",
    tx: Buffer.from(tx.serialize()).toString("base64"),
    bytes: tx.serialize().length,
    transactionIndex,
  };
}

module.exports = {
  findFreeMegatxnIndex,
  ephemeralSignersFor,
  buildMegatxnCreateTxs,
  buildMegatxnExecuteTx,
};