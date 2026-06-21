// Pinocchio persistent PDA-authority LUT: init_config, then init_lookup_table
// (program creates an ALT owned by the authority PDA, stores it in Config), then
// extend_lookup_table (PDA-signed). Verify the LUT exists + holds the addresses.
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-lut.ts
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
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
const ALT = new PublicKey("AddressLookupTab1e1111111111111111111111111");
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

describe("pinocchio persistent LUT (surfpool fork)", () => {
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

  it("program creates + extends a PDA-authority LUT", async () => {
    const d = () => Keypair.generate().publicKey;
    const A = await createMint(conn, payer, wallet.publicKey, null, 6);
    const lam = BigInt(await conn.getMinimumBalanceForRentExemption(400));
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(d(), false),
            k(A, false),
            k(d(), false),
            k(d(), false),
            k(d(), false),
            k(d(), false),
            k(d(), false),
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

    // init_lookup_table
    const recentSlot = BigInt((await conn.getSlot()) - 1);
    const [lut, lutBump] = PublicKey.findProgramAddressSync(
      [authority.toBuffer(), u64(recentSlot)],
      ALT,
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(authority, false),
            k(lut, true),
            k(ALT, false),
            k(SystemProgram.programId, false),
          ],
          data: Buffer.concat([
            Buffer.from([8]),
            u64(recentSlot),
            Buffer.from([lutBump]),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    const cfg = await conn.getAccountInfo(config);
    const storedLut = new PublicKey(cfg!.data.subarray(316, 348)).toBase58();
    const lutAcct = await conn.getAccountInfo(lut);
    console.log(
      `    >>> LUT created: ${lut.toBase58().slice(0, 8)}, stored in config=${storedLut.slice(0, 8)}, owner=${lutAcct?.owner.toBase58().slice(0, 8)}`,
    );
    assert.equal(storedLut, lut.toBase58(), "LUT not stored in config");
    assert.ok(lutAcct, "LUT account not created");
    assert.equal(
      lutAcct!.owner.toBase58(),
      ALT.toBase58(),
      "LUT not owned by ALT program",
    );

    // extend_lookup_table with 3 addresses
    const addrs = [d(), d(), d()];
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, false),
            k(authority, false),
            k(lut, true),
            k(ALT, false),
            k(SystemProgram.programId, false),
          ],
          data: Buffer.concat([
            Buffer.from([9]),
            ...addrs.map((a) => a.toBuffer()),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    await new Promise((r) => setTimeout(r, 600));
    const table = (await conn.getAddressLookupTable(lut)).value!;
    console.log(
      `    >>> LUT now holds ${table.state.addresses.length} addresses`,
    );
    assert.equal(
      table.state.addresses.length,
      3,
      "extend did not add addresses",
    );
    assert.equal(
      table.state.addresses[0].toBase58(),
      addrs[0].toBase58(),
      "address mismatch",
    );
    assert.equal(
      table.state.authority?.toBase58(),
      authority.toBase58(),
      "LUT authority should be the PDA",
    );
  });
});
