"use strict";

const {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} = require("@solana/web3.js");
const { PROGRAM_ID } = require("./constants.js");

const DISC_BUFFER_CREATE = 0;
const DISC_BUFFER_EXTEND = 1;
const DISC_BUFFER_CLOSE = 2;
const DISC_TXN_CREATE = 3;
const DISC_TXN_CREATE_FROM_BUFFER = 4;
const DISC_TXN_EXECUTE = 5;
const DISC_TXN_CLOSE = 6;

function txnBufferCreate(args) {
  const data = Buffer.alloc(1 + 1 + 32 + 2 + args.buffer.length);
  let offset = 0;
  data.writeUInt8(DISC_BUFFER_CREATE, offset++);
  data.writeUInt8(args.bufferIndex, offset++);
  Buffer.from(args.finalBufferHash).copy(data, offset);
  offset += 32;
  data.writeUInt16LE(args.finalBufferSize, offset);
  offset += 2;
  Buffer.from(args.buffer).copy(data, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: args.transactionBuffer, isSigner: false, isWritable: true },
      { pubkey: args.creator, isSigner: true, isWritable: false },
      { pubkey: args.rentPayer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: args.programId || PROGRAM_ID,
    data,
  });
}

function txnBufferExtend(args) {
  const data = Buffer.alloc(1 + args.buffer.length);
  data.writeUInt8(DISC_BUFFER_EXTEND, 0);
  Buffer.from(args.buffer).copy(data, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: args.transactionBuffer, isSigner: false, isWritable: true },
      { pubkey: args.creator, isSigner: true, isWritable: false },
    ],
    programId: args.programId || PROGRAM_ID,
    data,
  });
}

function txnCreate(args) {
  const data = Buffer.alloc(1 + 1 + 1 + args.transactionMessage.length);
  let offset = 0;
  data.writeUInt8(DISC_TXN_CREATE, offset++);
  data.writeUInt8(args.transactionIndex, offset++);
  data.writeUInt8(args.ephemeralSigners, offset++);
  Buffer.from(args.transactionMessage).copy(data, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: args.transaction, isSigner: false, isWritable: true },
      { pubkey: args.creator, isSigner: true, isWritable: false },
      { pubkey: args.rentPayer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: args.programId || PROGRAM_ID,
    data,
  });
}

function txnCreateFromBuffer(args) {
  return new TransactionInstruction({
    keys: [
      { pubkey: args.transaction, isSigner: false, isWritable: true },
      { pubkey: args.creator, isSigner: true, isWritable: false },
      { pubkey: args.rentPayer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: args.transactionBuffer, isSigner: false, isWritable: true },
    ],
    programId: args.programId || PROGRAM_ID,
    data: Buffer.from([DISC_TXN_CREATE_FROM_BUFFER, args.transactionIndex, args.ephemeralSigners]),
  });
}

function txnExecute(args) {
  return new TransactionInstruction({
    keys: [
      { pubkey: args.transaction, isSigner: false, isWritable: true },
      { pubkey: args.creator, isSigner: true, isWritable: true },
      ...args.remainingAccounts,
    ],
    programId: args.programId || PROGRAM_ID,
    data: Buffer.from([DISC_TXN_EXECUTE]),
  });
}

module.exports = {
  txnBufferCreate,
  txnBufferExtend,
  txnCreate,
  txnCreateFromBuffer,
  txnExecute,
};