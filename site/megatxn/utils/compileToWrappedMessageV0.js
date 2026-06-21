"use strict";

const {
  MessageAccountKeys,
  MessageV0,
} = require("@solana/web3.js");
const { CompiledKeys } = require("./compiled-keys.js");

function compileToWrappedMessageV0(args) {
  const compiledKeys = CompiledKeys.compile(args.instructions, args.payerKey);

  const addressTableLookups = [];
  const accountKeysFromLookups = { writable: [], readonly: [] };

  for (const lookupTable of args.addressLookupTableAccounts || []) {
    const extractResult = compiledKeys.extractTableLookup(lookupTable);
    if (extractResult !== undefined) {
      const [lookup, { writable, readonly }] = extractResult;
      addressTableLookups.push(lookup);
      accountKeysFromLookups.writable.push(...writable);
      accountKeysFromLookups.readonly.push(...readonly);
    }
  }

  const [header, staticAccountKeys] = compiledKeys.getMessageComponents();
  const accountKeys = new MessageAccountKeys(staticAccountKeys, accountKeysFromLookups);
  const compiledInstructions = accountKeys.compileInstructions(args.instructions);

  return new MessageV0({
    header,
    staticAccountKeys,
    recentBlockhash: args.recentBlockhash,
    compiledInstructions,
    addressTableLookups,
  });
}

module.exports = { compileToWrappedMessageV0 };