"use strict";

const { PublicKey } = require("@solana/web3.js");
const {
  ACCOUNT_KEY_MEGA_TRANSACTION,
  ACCOUNT_KEY_TRANSACTION_BUFFER,
  MEGA_TRANSACTION_HEADER_LEN,
} = require("./constants.js");
const { deserializeMessage } = require("./serialization.js");

function decodeMegaTransaction(data) {
  if (data.length < MEGA_TRANSACTION_HEADER_LEN) {
    throw new Error("MegaTransaction data too short");
  }
  if (data[0] !== ACCOUNT_KEY_MEGA_TRANSACTION) {
    throw new Error(`Expected account key ${ACCOUNT_KEY_MEGA_TRANSACTION}, got ${data[0]}`);
  }

  const creator = new PublicKey(data.subarray(1, 33));
  const ephemeralSignerCount = data[33];
  const bumpsStart = MEGA_TRANSACTION_HEADER_LEN;
  const bumpsEnd = bumpsStart + ephemeralSignerCount;
  const ephemeralSignerBumps = Array.from(data.subarray(bumpsStart, bumpsEnd));
  const messageBytes = data.subarray(bumpsEnd);
  const message = deserializeMessage(messageBytes);

  return {
    accountKey: data[0],
    creator,
    ephemeralSignerCount,
    ephemeralSignerBumps,
    message,
  };
}

function decodeTransactionBuffer(data) {
  if (data[0] !== ACCOUNT_KEY_TRANSACTION_BUFFER) {
    throw new Error(`Expected account key ${ACCOUNT_KEY_TRANSACTION_BUFFER}, got ${data[0]}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const creator = new PublicKey(data.subarray(1, 33));
  const bufferIndex = data[33];
  const finalBufferHash = data.slice(34, 66);
  const finalBufferSize = view.getUint16(66, true);
  const currentSize = view.getUint16(68, true);
  return { creator, bufferIndex, finalBufferHash, finalBufferSize, currentSize };
}

module.exports = { decodeMegaTransaction, decodeTransactionBuffer };