"use strict";

const { PublicKey } = require("@solana/web3.js");
const {
  PROGRAM_ID,
  SEED_PREFIX,
  SEED_TRANSACTION,
  SEED_EPHEMERAL_SIGNER,
  SEED_TRANSACTION_BUFFER,
} = require("./constants.js");

function getTransactionBufferPda(creator, bufferIndex, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, SEED_TRANSACTION_BUFFER, creator.toBuffer(), Buffer.from([bufferIndex])],
    programId,
  );
}

function getTransactionPda(creator, transactionIndex, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, SEED_TRANSACTION, creator.toBuffer(), Buffer.from([transactionIndex])],
    programId,
  );
}

function getEphemeralSignerPda(transactionPda, ephemeralSignerIndex, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, transactionPda.toBuffer(), SEED_EPHEMERAL_SIGNER, Buffer.from([ephemeralSignerIndex])],
    programId,
  );
}

module.exports = { getTransactionBufferPda, getTransactionPda, getEphemeralSignerPda };