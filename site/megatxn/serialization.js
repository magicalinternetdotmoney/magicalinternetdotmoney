"use strict";

const { PublicKey } = require("@solana/web3.js");
const { compileToWrappedMessageV0 } = require("./utils/compileToWrappedMessageV0.js");

function serializeTransactionMessage(message, addressLookupTableAccounts) {
  const compiled = compileToWrappedMessageV0({
    payerKey: message.payerKey,
    recentBlockhash: message.recentBlockhash,
    instructions: message.instructions,
    addressLookupTableAccounts,
  });

  const numSigners = compiled.header.numRequiredSignatures;
  const numWritableSigners = numSigners - compiled.header.numReadonlySignedAccounts;
  const numWritableNonSigners = compiled.staticAccountKeys.length
    - numSigners
    - compiled.header.numReadonlyUnsignedAccounts;

  const msg = {
    numSigners,
    numWritableSigners,
    numWritableNonSigners,
    accountKeys: compiled.staticAccountKeys,
    instructions: compiled.compiledInstructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accountIndexes: Array.from(ix.accountKeyIndexes),
      data: Array.from(ix.data),
    })),
    addressTableLookups: compiled.addressTableLookups,
  };

  return serializeMessage(msg);
}

function serializeMessage(msg) {
  let size = 3;
  size += 1 + msg.accountKeys.length * 32;
  size += 1;
  for (const ix of msg.instructions) {
    size += 1 + 1 + ix.accountIndexes.length + 2 + ix.data.length;
  }
  size += 1;
  for (const lookup of msg.addressTableLookups) {
    size += 32 + 1 + lookup.writableIndexes.length + 1 + lookup.readonlyIndexes.length;
  }

  const buf = Buffer.alloc(size);
  let offset = 0;

  buf.writeUInt8(msg.numSigners, offset++);
  buf.writeUInt8(msg.numWritableSigners, offset++);
  buf.writeUInt8(msg.numWritableNonSigners, offset++);

  buf.writeUInt8(msg.accountKeys.length, offset++);
  for (const key of msg.accountKeys) {
    key.toBuffer().copy(buf, offset);
    offset += 32;
  }

  buf.writeUInt8(msg.instructions.length, offset++);
  for (const ix of msg.instructions) {
    buf.writeUInt8(ix.programIdIndex, offset++);
    buf.writeUInt8(ix.accountIndexes.length, offset++);
    for (const idx of ix.accountIndexes) buf.writeUInt8(idx, offset++);
    buf.writeUInt16LE(ix.data.length, offset);
    offset += 2;
    for (const byte of ix.data) buf.writeUInt8(byte, offset++);
  }

  buf.writeUInt8(msg.addressTableLookups.length, offset++);
  for (const lookup of msg.addressTableLookups) {
    lookup.accountKey.toBuffer().copy(buf, offset);
    offset += 32;
    buf.writeUInt8(lookup.writableIndexes.length, offset++);
    for (const idx of lookup.writableIndexes) buf.writeUInt8(idx, offset++);
    buf.writeUInt8(lookup.readonlyIndexes.length, offset++);
    for (const idx of lookup.readonlyIndexes) buf.writeUInt8(idx, offset++);
  }

  return buf;
}

function deserializeMessage(data) {
  const buf = Buffer.from(data);
  let offset = 0;

  const numSigners = buf.readUInt8(offset++);
  const numWritableSigners = buf.readUInt8(offset++);
  const numWritableNonSigners = buf.readUInt8(offset++);

  const accountKeysCount = buf.readUInt8(offset++);
  const accountKeys = [];
  for (let i = 0; i < accountKeysCount; i++) {
    accountKeys.push(new PublicKey(buf.subarray(offset, offset + 32)));
    offset += 32;
  }

  const instructionsCount = buf.readUInt8(offset++);
  const instructions = [];
  for (let i = 0; i < instructionsCount; i++) {
    const programIdIndex = buf.readUInt8(offset++);
    const accountIndexesCount = buf.readUInt8(offset++);
    const accountIndexes = [];
    for (let j = 0; j < accountIndexesCount; j++) accountIndexes.push(buf.readUInt8(offset++));
    const dataLen = buf.readUInt16LE(offset);
    offset += 2;
    const ixData = [];
    for (let j = 0; j < dataLen; j++) ixData.push(buf.readUInt8(offset++));
    instructions.push({ programIdIndex, accountIndexes, data: ixData });
  }

  const lookupsCount = buf.readUInt8(offset++);
  const addressTableLookups = [];
  for (let i = 0; i < lookupsCount; i++) {
    const accountKey = new PublicKey(buf.subarray(offset, offset + 32));
    offset += 32;
    const writableCount = buf.readUInt8(offset++);
    const writableIndexes = [];
    for (let j = 0; j < writableCount; j++) writableIndexes.push(buf.readUInt8(offset++));
    const readonlyCount = buf.readUInt8(offset++);
    const readonlyIndexes = [];
    for (let j = 0; j < readonlyCount; j++) readonlyIndexes.push(buf.readUInt8(offset++));
    addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
  }

  return {
    numSigners,
    numWritableSigners,
    numWritableNonSigners,
    accountKeys,
    instructions,
    addressTableLookups,
  };
}

module.exports = { serializeTransactionMessage, serializeMessage, deserializeMessage };