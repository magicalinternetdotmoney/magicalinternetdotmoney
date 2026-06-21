// buy_burn flywheel: accrued fee (USDC stand-in) -> swap to MEME via the MEME/USDC
// CP-Swap pool -> burn the MEME. Verify the fee drains and MEME total supply drops.
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-buyburn.ts
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
const obsOf = (p: PublicKey) => cpp([sd("observation"), p.toBuffer()]);
// per-mint token program (MEME is Token-2022; USDC stand-in is legacy)
const PROG = new Map<string, PublicKey>();
const progOf = (m: PublicKey) => PROG.get(m.toBase58()) || TOKEN_PROGRAM_ID;
const ataOf = (m: PublicKey, owner: PublicKey, off = false) =>
  getAssociatedTokenAddressSync(m, owner, off, progOf(m));
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
      k(ataOf(t0, creator), true),
      k(ataOf(t1, creator), true),
      k(getAssociatedTokenAddressSync(lp, creator), true),
      k(vaultOf(pool, t0), true),
      k(vaultOf(pool, t1), true),
      k(FEE, true),
      k(obsOf(pool), true),
      k(TOKEN_PROGRAM_ID, false), // token_program (lp mint — always legacy)
      k(progOf(t0), false), // token_0_program
      k(progOf(t1), false), // token_1_program
      k(ASSOCIATED_TOKEN_PROGRAM_ID, false),
      k(SystemProgram.programId, false),
      k(SYSVAR_RENT_PUBKEY, false),
    ],
  });
}

describe("pinocchio buy_burn flywheel (surfpool fork)", () => {
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

  it("swaps fee USDC -> MEME and burns it (supply drops)", async () => {
    // mk(prog): create a mint under the given token program, fund the creator's ATA.
    const mk = async (prog: PublicKey) => {
      const m = await createMint(conn, payer, wallet.publicKey, null, 6, undefined, undefined, prog);
      PROG.set(m.toBase58(), prog);
      const a = await getOrCreateAssociatedTokenAccount(conn, payer, m, wallet.publicKey, false, undefined, undefined, prog);
      await mintTo(conn, payer, m, a.address, wallet.publicKey, INIT * 10n, [], undefined, prog);
      return m;
    };
    // MEME is Token-2022 (matches the real pump.fun mint); U (USDC stand-in) is legacy.
    const MEME = await mk(TOKEN_2022_PROGRAM_ID),
      U = await mk(TOKEN_PROGRAM_ID);
    const pool = poolOf(MEME, U);
    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        initIx(wallet.publicKey, MEME, U, INIT),
      ),
      [],
      { skipPreflight: true },
    );

    // protocol fee vault (USDC, legacy) + meme account (MEME, Token-2022), owned by the authority PDA
    const feeVault = (
      await getOrCreateAssociatedTokenAccount(conn, payer, U, authority, true, undefined, undefined, TOKEN_PROGRAM_ID)
    ).address;
    const memeAcct = (
      await getOrCreateAssociatedTokenAccount(conn, payer, MEME, authority, true, undefined, undefined, TOKEN_2022_PROGRAM_ID)
    ).address;
    await mintTo(conn, payer, U, feeVault, wallet.publicKey, 50_000_000n, [], undefined, TOKEN_PROGRAM_ID); // accrued fee

    // init_config (only auth_bump is read by buy_burn)
    const dummy = () => Keypair.generate().publicKey;
    const lam = BigInt(await conn.getMinimumBalanceForRentExemption(400));
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(U, false),
            k(dummy(), false),
            k(dummy(), false),
            k(dummy(), false),
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
            Buffer.from([0, 0]), // fee_bps = 0
            pool.toBuffer(), // buyburn_pool = the real MEME/USDC pool (hardening pin)
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    const memeSupply0 = (await getMint(conn, MEME, undefined, TOKEN_2022_PROGRAM_ID)).supply;
    const feeBefore = (await getAccount(conn, feeVault)).amount;

    // buy_burn
    const keys = [
      k(wallet.publicKey, false, true),
      k(config, false),
      k(authority, false),
      k(feeVault, true),
      k(memeAcct, true),
      k(MEME, true),
      k(AMM0, false),
      k(cpAuth(), false),
      k(pool, true),
      k(vaultOf(pool, U), true),
      k(vaultOf(pool, MEME), true),
      k(U, false),
      k(MEME, false),
      k(obsOf(pool), true),
      k(CP, false),
      k(TOKEN_PROGRAM_ID, false), // quote_token_program (USDC, legacy)
      k(TOKEN_2022_PROGRAM_ID, false), // meme_token_program (Token-2022)
    ];
    try {
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          new TransactionInstruction({
            programId: PROGRAM,
            keys,
            data: Buffer.concat([Buffer.from([11]), u64(50_000_000n), u64(0n)]),
          }),
        ),
        [],
        { skipPreflight: true },
      );
    } catch (e: any) {
      let logs = e?.logs;
      try {
        logs = logs ?? (await e?.getLogs?.(conn));
      } catch {}
      console.log(
        "BUYBURN FAILED:",
        e?.message,
        "\nLOGS:",
        (logs ?? []).join("\n"),
      );
      throw e;
    }

    const memeSupply1 = (await getMint(conn, MEME, undefined, TOKEN_2022_PROGRAM_ID)).supply;
    const feeAfter = (await getAccount(conn, feeVault)).amount;
    const memeLeft = (await getAccount(conn, memeAcct, undefined, TOKEN_2022_PROGRAM_ID)).amount;
    console.log(
      `    >>> fee USDC: ${feeBefore} -> ${feeAfter} (spent ${feeBefore - feeAfter})`,
    );
    console.log(
      `    >>> MEME supply: ${memeSupply0} -> ${memeSupply1} (burned ${memeSupply0 - memeSupply1})`,
    );
    assert.ok(feeAfter < feeBefore, "fee was not spent");
    assert.ok(memeSupply1 < memeSupply0, "MEME supply did not drop (no burn)");
    assert.equal(memeLeft, 0n, "bought MEME should be fully burned");

    // HARDENING red-team: a buy_burn routed through a FAKE pool must be rejected.
    const fakePool = Keypair.generate().publicKey;
    const badKeys = keys.slice();
    badKeys[8] = k(fakePool, true); // swap pool != config.buyburn_pool
    let rejected = false;
    try {
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          new TransactionInstruction({
            programId: PROGRAM,
            keys: badKeys,
            data: Buffer.concat([Buffer.from([11]), u64(1_000_000n), u64(0n)]),
          }),
        ),
        [],
        { skipPreflight: true },
      );
    } catch {
      rejected = true;
    }
    console.log(`    >>> fake-pool buy_burn rejected: ${rejected}`);
    assert.ok(
      rejected,
      "buy_burn accepted a fake pool (drain hole still open)",
    );
  });
});
