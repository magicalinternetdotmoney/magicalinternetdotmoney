// Receipt-token metadata: create the receipt mint as Token-2022 with a
// MetadataPointer -> itself + initial TokenMetadata (update authority = protocol
// PDA), then call the program's update_metadata ix (the "2nd ix after init") to
// rename it. Verify the on-chain metadata changed.
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-metadata.ts
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  TYPE_SIZE,
  LENGTH_SIZE,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  getTokenMetadata,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import assert from "assert";
import * as fs from "fs";

const kp = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        `${process.cwd()}/target/deploy/leverage_engine_pinocchio-keypair.json`,
        "utf8",
      ),
    ),
  ),
);
const PROGRAM = kp.publicKey;
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u128 = (n: bigint) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & ((1n << 64n) - 1n));
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
};
const k = (pubkey: PublicKey, w: boolean, s = false) => ({
  pubkey,
  isSigner: s,
  isWritable: w,
});

describe("pinocchio receipt metadata (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const [config, cfgBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM,
  );
  const [authority, authBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    PROGRAM,
  );

  it("user metadata on the receipt; update_metadata renames it via CPI", async () => {
    // 1. receipt mint = Token-2022, MetadataPointer -> self, update authority = PDA
    const receipt = Keypair.generate();
    const meta = {
      mint: receipt.publicKey,
      name: "Initial",
      symbol: "RCPT",
      uri: "https://example.com/r.json",
      additionalMetadata: [],
      updateAuthority: authority, // counts toward the packed metadata size
    };
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(meta).length;
    // variable-length metadata → fund rent for the full final size + headroom
    const lamports =
      (await conn.getMinimumBalanceForRentExemption(mintLen + metaLen)) +
      10_000_000;
    console.log(
      `    >>> mintLen=${mintLen} metaLen=${metaLen} lamports=${lamports}`,
    );
    const send = async (tx: Transaction, signers: Keypair[] = []) => {
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(payer, ...signers);
      try {
        const sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
        });
        await conn.confirmTransaction(sig, "confirmed");
        return sig;
      } catch (e: any) {
        let logs = e?.logs;
        try {
          logs = logs ?? (await e?.getLogs?.(conn));
        } catch {}
        console.log("TX FAILED:", e?.message, "logs:", JSON.stringify(logs));
        throw e;
      }
    };
    await send(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: receipt.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMetadataPointerInstruction(
          receipt.publicKey,
          wallet.publicKey,
          receipt.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMintInstruction(
          receipt.publicKey,
          6,
          wallet.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: receipt.publicKey,
          updateAuthority: authority,
          mint: receipt.publicKey,
          mintAuthority: wallet.publicKey,
          name: meta.name,
          symbol: meta.symbol,
          uri: meta.uri,
        }),
      ),
      [receipt],
    );
    const m0 = await getTokenMetadata(
      conn,
      receipt.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    console.log(
      `    >>> initial metadata: name="${m0?.name}" symbol="${m0?.symbol}"`,
    );
    assert.equal(m0?.name, "Initial");

    // 2. init_config (records receipt mint; other keys are placeholders)
    const dummy = () => Keypair.generate().publicKey;
    const lam = BigInt(await conn.getMinimumBalanceForRentExemption(400));
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(dummy(), false),
            k(dummy(), false),
            k(dummy(), false),
            k(receipt.publicKey, false),
            k(dummy(), false),
            k(dummy(), false),
            k(dummy(), false),
            k(SystemProgram.programId, false),
          ],
          data: Buffer.concat([
            Buffer.from([1, authBump, cfgBump]),
            u64(20_000n),
            u64(50_000n),
            u64(2_000n),
            u64(5_000n),
            u128(1_000_000_000n),
            u64(lam),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    // 3. update_metadata: field 0 (name) -> the creating user's chosen name
    const newName = "MIM Test Receipt";
    const data = Buffer.concat([
      Buffer.from([5, 0]),
      Buffer.from(newName, "utf8"),
    ]); // tag=5, field=0(name)
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, false, true),
            k(config, false),
            k(authority, false),
            k(receipt.publicKey, true),
            k(TOKEN_2022_PROGRAM_ID, false),
          ],
          data,
        }),
      ),
      [],
      { skipPreflight: true },
    );

    const m1 = await getTokenMetadata(
      conn,
      receipt.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    console.log(`    >>> after update_metadata: name="${m1?.name}"`);
    assert.equal(m1?.name, newName, "update_metadata did not rename via CPI");
    assert.equal(m1?.symbol, "RCPT", "symbol should be unchanged");
  });
});
