"use strict";

const { PROGRAM_ID } = require("./constants.js");
const { getEphemeralSignerPda } = require("./pdas.js");
const { decodeMegaTransaction } = require("./accounts.js");
const { txnExecute } = require("./instructions.js");

function isStaticWritableIndex(msg, index) {
  if (index >= msg.accountKeys.length) return false;
  if (index < msg.numWritableSigners) return true;
  if (index >= msg.numSigners) {
    return index - msg.numSigners < msg.numWritableNonSigners;
  }
  return false;
}

async function buildRemainingAccounts(args) {
  const { message, creator, transactionPda, ephemeralSignerBumps } = args;
  const programId = args.programId || PROGRAM_ID;

  const ephemeralSignerPdas = ephemeralSignerBumps.map((_, i) =>
    getEphemeralSignerPda(transactionPda, i, programId)[0],
  );

  const altKeys = message.addressTableLookups.map((l) => l.accountKey);
  const altAccounts = new Map();
  await Promise.all(
    altKeys.map(async (key) => {
      const { value } = await args.connection.getAddressLookupTable(key);
      if (!value) throw new Error(`Address lookup table ${key.toBase58()} not found`);
      altAccounts.set(key.toBase58(), value);
    }),
  );

  const accountMetas = [];

  for (const key of altKeys) {
    accountMetas.push({ pubkey: key, isSigner: false, isWritable: false });
  }

  for (let i = 0; i < message.accountKeys.length; i++) {
    const key = message.accountKeys[i];
    const isSigner = i < message.numSigners
      && !key.equals(creator)
      && !ephemeralSignerPdas.some((p) => key.equals(p));
    const isWritable = isStaticWritableIndex(message, i);
    accountMetas.push({ pubkey: key, isSigner, isWritable });
  }

  for (const lookup of message.addressTableLookups) {
    const alt = altAccounts.get(lookup.accountKey.toBase58());
    for (const idx of lookup.writableIndexes) {
      accountMetas.push({ pubkey: alt.state.addresses[idx], isSigner: false, isWritable: true });
    }
  }

  for (const lookup of message.addressTableLookups) {
    const alt = altAccounts.get(lookup.accountKey.toBase58());
    for (const idx of lookup.readonlyIndexes) {
      accountMetas.push({ pubkey: alt.state.addresses[idx], isSigner: false, isWritable: false });
    }
  }

  return { accountMetas, lookupTableAccounts: [...altAccounts.values()] };
}

async function buildExecuteInstruction(args) {
  const programId = args.programId || PROGRAM_ID;
  const { getTransactionPda } = require("./pdas.js");
  const [transactionPda] = getTransactionPda(args.creator, args.transactionIndex, programId);

  const accountInfo = await args.connection.getAccountInfo(transactionPda);
  if (!accountInfo) throw new Error(`MegaTransaction account not found: ${transactionPda.toBase58()}`);

  const txnAccount = decodeMegaTransaction(accountInfo.data);
  const { accountMetas, lookupTableAccounts } = await buildRemainingAccounts({
    connection: args.connection,
    message: txnAccount.message,
    ephemeralSignerBumps: txnAccount.ephemeralSignerBumps,
    creator: args.creator,
    transactionPda,
    programId,
  });

  return {
    instruction: txnExecute({
      transaction: transactionPda,
      creator: args.creator,
      remainingAccounts: accountMetas,
      programId,
    }),
    lookupTableAccounts,
    transactionPda,
  };
}

module.exports = { buildRemainingAccounts, buildExecuteInstruction };