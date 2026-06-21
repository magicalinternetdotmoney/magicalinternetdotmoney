// Multi-pool deposit fan-out + fee faucet: seed_pair seeds the A/B pool (minted
// A+B house liquidity); deposit fans the user's quote across A/Q and B/Q, minting
// receipt and skimming a 1% fee into the fee_vault (the buy_burn faucet).
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-fanout.ts
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  setAuthority,
  AuthorityType,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
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
const lpOf = (p: PublicKey) => cpp([sd("pool_lp_mint"), p.toBuffer()]);
const obsOf = (p: PublicKey) => cpp([sd("observation"), p.toBuffer()]);
const k = (pubkey: PublicKey, w: boolean, s = false) => ({
  pubkey,
  isSigner: s,
  isWritable: w,
});
const u16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
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
  const lp = lpOf(pool);
  return new TransactionInstruction({
    programId: CP,
    data: Buffer.concat([D_INIT, u64(amt), u64(amt), u64(0n)]),
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
      k(obsOf(pool), true),
      k(TOKEN_PROGRAM_ID, false),
      k(TOKEN_PROGRAM_ID, false),
      k(TOKEN_PROGRAM_ID, false),
      k(ASSOCIATED_TOKEN_PROGRAM_ID, false),
      k(SystemProgram.programId, false),
      k(SYSVAR_RENT_PUBKEY, false),
    ],
  });
}

describe("pinocchio deposit fan-out + fee skim (surfpool fork)", () => {
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
  const ata = (m: PublicKey, o: PublicKey, prog?: PublicKey) =>
    getAssociatedTokenAddressSync(m, o, true, prog);
  const bal = async (a: PublicKey, prog?: PublicKey) =>
    (await getAccount(conn, a, undefined, prog)).amount;

  it("seeds A/B, fans deposits across A/Q + B/Q, skims a 1% fee", async () => {
    const mk = async () => {
      const m = await createMint(conn, payer, wallet.publicKey, null, 6);
      const a = await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        m,
        wallet.publicKey,
      );
      await mintTo(conn, payer, m, a.address, wallet.publicKey, INIT * 30n);
      return m;
    };
    const A = await mk(),
      B = await mk(),
      Q = await mk(); // Q = quote (USDC/MEME stand-in)
    // receipt is Token-2022 (hook in prod), authority = PDA; synths A/B/Q stay legacy.
    const receipt = await createMint(conn, payer, authority, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    for (const [x, y] of [
      [A, B],
      [A, Q],
      [B, Q],
    ] as [PublicKey, PublicKey][])
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          initIx(wallet.publicKey, x, y, INIT),
        ),
        [],
        { skipPreflight: true },
      );
    await setAuthority(
      conn,
      payer,
      A,
      wallet.publicKey,
      AuthorityType.MintTokens,
      authority,
    );
    await setAuthority(
      conn,
      payer,
      B,
      wallet.publicKey,
      AuthorityType.MintTokens,
      authority,
    );

    const poolAB = poolOf(A, B),
      poolAQ = poolOf(A, Q),
      poolBQ = poolOf(B, Q);
    // protocol accounts
    for (const [m, owner, prog] of [
      [A, authority, undefined],
      [B, authority, undefined],
      [Q, authority, undefined],
      [lpOf(poolAB), authority, undefined],
      [lpOf(poolAQ), authority, undefined],
      [lpOf(poolBQ), authority, undefined],
      [receipt, wallet.publicKey, TOKEN_2022_PROGRAM_ID],
    ] as [PublicKey, PublicKey, PublicKey | undefined][])
      await getOrCreateAssociatedTokenAccount(conn, payer, m, owner, true, undefined, undefined, prog);
    const feeVault = ata(Q, authority);
    const userQ = ata(Q, wallet.publicKey),
      userReceipt = ata(receipt, wallet.publicKey, TOKEN_2022_PROGRAM_ID);

    // init_config with fee_bps = 100 (1%)
    const lam = BigInt(await conn.getMinimumBalanceForRentExemption(400));
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(Q, false),
            k(A, false),
            k(B, false),
            k(receipt, false),
            k(poolAB, false),
            k(poolAQ, false),
            k(poolBQ, false),
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
            u16(100),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    // seed_pair(A/B): house liquidity
    const lpAbBefore = await bal(ata(lpOf(poolAB), authority));
    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, false, true),
            k(config, false),
            k(authority, false),
            k(A, true),
            k(B, true),
            k(ata(A, authority), true),
            k(ata(B, authority), true),
            k(ata(lpOf(poolAB), authority), true),
            k(poolAB, true),
            k(lpOf(poolAB), true),
            k(vaultOf(poolAB, A), true),
            k(vaultOf(poolAB, B), true),
            k(cpAuth(), false),
            k(CP, false),
            k(TOKEN_PROGRAM_ID, false),
            k(TOKEN_2022_PROGRAM_ID, false),
          ],
          data: Buffer.concat([
            Buffer.from([12]),
            u64(100_000_000n),
            u64(120_000_000n),
            u64(120_000_000n),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );
    const lpAbAfter = await bal(ata(lpOf(poolAB), authority));
    console.log(`    >>> seed_pair A/B LP: +${lpAbAfter - lpAbBefore}`);

    // deposit fan-out: A/Q then B/Q (each: user Q + minted synthetic, 1% fee skim)
    const depositIx = (synth: PublicKey, pool: PublicKey) =>
      new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          k(wallet.publicKey, false, true),
          k(config, true),
          k(authority, false),
          k(Q, false),
          k(synth, true),
          k(receipt, true),
          k(userQ, true),
          k(ata(Q, authority), true),
          k(userReceipt, true),
          k(ata(synth, authority), true),
          k(ata(lpOf(pool), authority), true),
          k(pool, true),
          k(lpOf(pool), true),
          k(vaultOf(pool, synth), true),
          k(vaultOf(pool, Q), true),
          k(cpAuth(), false),
          k(CP, false),
          k(TOKEN_PROGRAM_ID, false),
          k(TOKEN_2022_PROGRAM_ID, false),
          k(feeVault, true), // [19] fee_vault → skim
        ],
        data: Buffer.concat([
          Buffer.from([2]),
          u64(99_000_000n),
          u64(100_000_000n),
          u64(120_000_000n),
        ]), // lp, usdc_amount, max_synth
      });
    const feeBefore = await bal(feeVault),
      recBefore = await bal(userReceipt, TOKEN_2022_PROGRAM_ID);
    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        depositIx(A, poolAQ),
      ),
      [],
      { skipPreflight: true },
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        depositIx(B, poolBQ),
      ),
      [],
      { skipPreflight: true },
    );
    const feeAfter = await bal(feeVault),
      recAfter = await bal(userReceipt, TOKEN_2022_PROGRAM_ID);

    console.log(
      `    >>> fan-out: receipt +${recAfter - recBefore}, fee_vault +${feeAfter - feeBefore} (1% of 2×100M = ~2M)`,
    );
    assert.ok(lpAbAfter > lpAbBefore, "seed_pair did not add A/B liquidity");
    assert.ok(recAfter > recBefore, "deposits did not mint receipt");
    assert.equal(feeAfter - feeBefore, 2_000_000n, "fee skim != 1% of 2×100M");
    assert.ok((await bal(ata(lpOf(poolAQ), authority))) > 0n, "no A/Q LP");
    assert.ok((await bal(ata(lpOf(poolBQ), authority))) > 0n, "no B/Q LP");
  });
});
