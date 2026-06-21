"use strict";

const { PublicKey } = require("@solana/web3.js");

class CompiledKeys {
  constructor(payer, keyMetaMap) {
    this.payer = payer;
    this.keyMetaMap = keyMetaMap;
  }

  static compile(instructions, payer) {
    const keyMetaMap = new Map();

    const getOrInsertDefault = (pubkey) => {
      const address = pubkey.toBase58();
      let keyMeta = keyMetaMap.get(address);
      if (keyMeta === undefined) {
        keyMeta = { isSigner: false, isWritable: false, isInvoked: false };
        keyMetaMap.set(address, keyMeta);
      }
      return keyMeta;
    };

    const payerKeyMeta = getOrInsertDefault(payer);
    payerKeyMeta.isSigner = true;
    payerKeyMeta.isWritable = true;

    for (const ix of instructions) {
      getOrInsertDefault(ix.programId).isInvoked = false;
      for (const accountMeta of ix.keys) {
        const keyMeta = getOrInsertDefault(accountMeta.pubkey);
        keyMeta.isSigner ||= accountMeta.isSigner;
        keyMeta.isWritable ||= accountMeta.isWritable;
      }
    }

    return new CompiledKeys(payer, keyMetaMap);
  }

  getMessageComponents() {
    const mapEntries = [...this.keyMetaMap.entries()];
    if (mapEntries.length > 256) throw new Error("Max static account keys length exceeded");

    const writableSigners = mapEntries.filter(([, m]) => m.isSigner && m.isWritable);
    const readonlySigners = mapEntries.filter(([, m]) => m.isSigner && !m.isWritable);
    const writableNonSigners = mapEntries.filter(([, m]) => !m.isSigner && m.isWritable);
    const readonlyNonSigners = mapEntries.filter(([, m]) => !m.isSigner && !m.isWritable);

    if (writableSigners.length === 0) throw new Error("Expected at least one writable signer key");
    if (writableSigners[0][0] !== this.payer.toBase58()) {
      throw new Error("Expected first writable signer key to be the fee payer");
    }

    const header = {
      numRequiredSignatures: writableSigners.length + readonlySigners.length,
      numReadonlySignedAccounts: readonlySigners.length,
      numReadonlyUnsignedAccounts: readonlyNonSigners.length,
    };

    const staticAccountKeys = [
      ...writableSigners.map(([a]) => new PublicKey(a)),
      ...readonlySigners.map(([a]) => new PublicKey(a)),
      ...writableNonSigners.map(([a]) => new PublicKey(a)),
      ...readonlyNonSigners.map(([a]) => new PublicKey(a)),
    ];

    return [header, staticAccountKeys];
  }

  extractTableLookup(lookupTable) {
    const [writableIndexes, drainedWritableKeys] = this.drainKeysFoundInLookupTable(
      lookupTable.state.addresses,
      (m) => !m.isSigner && !m.isInvoked && m.isWritable,
    );
    const [readonlyIndexes, drainedReadonlyKeys] = this.drainKeysFoundInLookupTable(
      lookupTable.state.addresses,
      (m) => !m.isSigner && !m.isInvoked && !m.isWritable,
    );

    if (writableIndexes.length === 0 && readonlyIndexes.length === 0) return undefined;

    return [
      { accountKey: lookupTable.key, writableIndexes, readonlyIndexes },
      { writable: drainedWritableKeys, readonly: drainedReadonlyKeys },
    ];
  }

  drainKeysFoundInLookupTable(lookupTableEntries, keyMetaFilter) {
    const indexes = [];
    const drainedKeys = [];

    for (const [address, keyMeta] of this.keyMetaMap.entries()) {
      if (keyMetaFilter(keyMeta)) {
        const key = new PublicKey(address);
        const idx = lookupTableEntries.findIndex((e) => e.equals(key));
        if (idx >= 0) {
          if (idx >= 256) throw new Error("Max lookup table index exceeded");
          indexes.push(idx);
          drainedKeys.push(key);
          this.keyMetaMap.delete(address);
        }
      }
    }

    return [indexes, drainedKeys];
  }
}

module.exports = { CompiledKeys };