// Validate Pinocchio init_config: create the ["config"] PDA via CreateAccount CPI
// and write the manually-serialized Config; read it back and decode the fields.
// Run via harness/run-pinocchio-config.sh.
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

describe("pinocchio init_config (surfpool fork)", () => {
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

  it("creates + initializes the config account", async () => {
    const A = await createMint(conn, payer, wallet.publicKey, null, 6);
    const B = await createMint(conn, payer, wallet.publicKey, null, 6);
    const U = await createMint(conn, payer, wallet.publicKey, null, 6);
    const receipt = await createMint(conn, payer, wallet.publicKey, null, 6);
    // pool ids are just keys here (init_config records them, doesn't deref)
    const poolAB = Keypair.generate().publicKey;
    const poolAU = Keypair.generate().publicKey;
    const poolBU = Keypair.generate().publicKey;

    const lamports = BigInt(await conn.getMinimumBalanceForRentExemption(400));
    const data = Buffer.concat([
      Buffer.from([1]), // TAG_INIT_CONFIG
      Buffer.from([authBump, cfgBump]),
      u64(20_000n),
      u64(50_000n),
      u64(2_000n),
      u64(5_000n), // l_min,l_max,max_mint,breaker
      u128(1_000_000_000n), // init_ratio
      u64(lamports),
    ]);
    const k = (pubkey: PublicKey, w: boolean, s = false) => ({
      pubkey,
      isSigner: s,
      isWritable: w,
    });
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        k(wallet.publicKey, true, true),
        k(config, true),
        k(U, false),
        k(A, false),
        k(B, false),
        k(receipt, false),
        k(poolAB, false),
        k(poolAU, false),
        k(poolBU, false),
        k(SystemProgram.programId, false),
      ],
      data,
    });
    await provider.sendAndConfirm(new Transaction().add(ix), [], {
      skipPreflight: true,
    });

    const acct = await conn.getAccountInfo(config);
    assert.ok(acct, "config account not created");
    const d = acct!.data;
    console.log(
      `    >>> config size=${d.length} owner=${acct!.owner.toBase58().slice(0, 8)}`,
    );
    assert.equal(d.length, 400, "config size mismatch");
    assert.equal(d[0], 1, "tag not initialized");
    assert.equal(
      new PublicKey(d.subarray(1, 33)).toBase58(),
      wallet.publicKey.toBase58(),
      "admin",
    );
    assert.equal(d[33], authBump, "auth_bump");
    assert.equal(
      new PublicKey(d.subarray(68, 100)).toBase58(),
      A.toBase58(),
      "mint_a @68",
    );
    assert.equal(d.readBigUInt64LE(268), 50_000n, "l_max @268");
    assert.equal(d.readBigUInt64LE(292), 1_000_000_000n, "last_ratio low @292");
    console.log(
      `    >>> config decoded OK: admin/mint_a/l_max/last_ratio all match`,
    );
  });
});
