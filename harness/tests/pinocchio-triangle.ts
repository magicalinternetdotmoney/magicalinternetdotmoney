// Pinocchio register_triangle: prove via instructions-sysvar introspection that
// 3 real CP-Swap initializes are in ONE v0 tx, and that the program writes the
// pool ids into Config. init_config is seeded with DUMMY pool ids first, so a
// passing test means register_triangle actually overwrote them via introspection.
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-triangle.ts
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
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
const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const FEE = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const D_INIT = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const sd = (s: string) => Buffer.from(s);
const cpp = (s: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(s, CP)[0];
const ord = (x: PublicKey, y: PublicKey): [PublicKey, PublicKey] =>
  Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x];
const cpAuth = () => cpp([sd("vault_and_lp_mint_auth_seed")]);
const poolOf = (x: PublicKey, y: PublicKey) => {
  const [t0, t1] = ord(x, y);
  return cpp([sd("pool"), AMM0.toBuffer(), t0.toBuffer(), t1.toBuffer()]);
};
const vaultOf = (p: PublicKey, m: PublicKey) =>
  cpp([sd("pool_vault"), p.toBuffer(), m.toBuffer()]);
const k = (pubkey: PublicKey, w: boolean, s = false) => ({
  pubkey,
  isSigner: s,
  isWritable: w,
});
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

function initIx(creator: PublicKey, x: PublicKey, y: PublicKey, amt: bigint) {
  const [t0, t1] = ord(x, y);
  const pool = poolOf(x, y);
  const lp = cpp([sd("pool_lp_mint"), pool.toBuffer()]);
  const data = Buffer.concat([D_INIT, u64(amt), u64(amt), u64(0n)]);
  return {
    pool,
    ix: new TransactionInstruction({
      programId: CP,
      data,
      keys: [
        k(creator, true, true),
        k(AMM0, false),
        k(cpAuth(), false),
        k(pool, true),
        k(t0, false),
        k(t1, false),
        k(lp, true),
        k(getAssociatedTokenAddressSync(t0, creator), true),
        k(getAssociatedTokenAddressSync(t1, creator), true),
        k(getAssociatedTokenAddressSync(lp, creator), true),
        k(vaultOf(pool, t0), true),
        k(vaultOf(pool, t1), true),
        k(FEE, true),
        k(cpp([sd("observation"), pool.toBuffer()]), true),
        k(TOKEN_PROGRAM_ID, false),
        k(TOKEN_PROGRAM_ID, false),
        k(TOKEN_PROGRAM_ID, false),
        k(ASSOCIATED_TOKEN_PROGRAM_ID, false),
        k(SystemProgram.programId, false),
        k(SYSVAR_RENT_PUBKEY, false),
      ],
    }),
  };
}

describe("pinocchio register_triangle introspection (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const INIT = 1_000_000_000n;
  const [config, cfgBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM,
  );
  const [authority, authBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    PROGRAM,
  );

  it("writes the 3 pool ids via introspection of one v0 tx", async () => {
    const mk = async () => {
      const m = await createMint(conn, payer, wallet.publicKey, null, 6);
      const a = await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        m,
        wallet.publicKey,
      );
      await mintTo(conn, payer, m, a.address, wallet.publicKey, INIT * 4n);
      return m;
    };
    const A = await mk(),
      B = await mk(),
      U = await mk();

    // init_config with DUMMY pool ids
    const dummyAB = Keypair.generate().publicKey,
      dummyAU = Keypair.generate().publicKey,
      dummyBU = Keypair.generate().publicKey;
    const receipt = await createMint(conn, payer, wallet.publicKey, null, 6);
    const lam = BigInt(await conn.getMinimumBalanceForRentExemption(400));
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(U, false),
            k(A, false),
            k(B, false),
            k(receipt, false),
            k(dummyAB, false),
            k(dummyAU, false),
            k(dummyBU, false),
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

    const inits = [
      initIx(wallet.publicKey, A, B, INIT),
      initIx(wallet.publicKey, A, U, INIT),
      initIx(wallet.publicKey, B, U, INIT),
    ];
    const registerIx = new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        k(wallet.publicKey, false, true),
        k(config, true),
        k(SYSVAR_INSTRUCTIONS_PUBKEY, false),
      ],
      data: Buffer.from([6]),
    });

    // LUT
    const slot = await conn.getSlot();
    const [createLutIx, lut] = AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      recentSlot: slot - 1,
    });
    const addrs = Array.from(
      new Set([
        ...inits.flatMap((i) => i.ix.keys.map((m) => m.pubkey.toBase58())),
        ...registerIx.keys.map((m) => m.pubkey.toBase58()),
        PROGRAM.toBase58(),
      ]),
    )
      .map((s) => new PublicKey(s))
      .filter((p) => !p.equals(wallet.publicKey));
    await provider.sendAndConfirm(new Transaction().add(createLutIx), []);
    for (let i = 0; i < addrs.length; i += 18)
      await provider.sendAndConfirm(
        new Transaction().add(
          AddressLookupTableProgram.extendLookupTable({
            payer: wallet.publicKey,
            authority: wallet.publicKey,
            lookupTable: lut,
            addresses: addrs.slice(i, i + 18),
          }),
        ),
        [],
      );
    await new Promise((r) => setTimeout(r, 900));

    const lookup = (await conn.getAddressLookupTable(lut)).value!;
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...inits.map((i) => i.ix),
        registerIx,
      ],
    }).compileToV0Message([lookup]);
    const vtx = new VersionedTransaction(msg);
    vtx.sign([payer]);
    const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");

    const acct = await conn.getAccountInfo(config);
    const d = acct!.data;
    const poolAB = new PublicKey(d.subarray(164, 196)).toBase58();
    const poolAU = new PublicKey(d.subarray(196, 228)).toBase58();
    const poolBU = new PublicKey(d.subarray(228, 260)).toBase58();
    console.log(
      `    >>> config pool_ab=${poolAB.slice(0, 8)} (real=${inits[0].pool.toBase58().slice(0, 8)}, dummy was ${dummyAB.toBase58().slice(0, 8)})`,
    );
    assert.equal(
      poolAB,
      inits[0].pool.toBase58(),
      "pool_ab not set by introspection",
    );
    assert.equal(poolAU, inits[1].pool.toBase58(), "pool_a_usdc not set");
    assert.equal(poolBU, inits[2].pool.toBase58(), "pool_b_usdc not set");
    assert.notEqual(poolAB, dummyAB.toBase58(), "dummy was not overwritten");
  });
});
