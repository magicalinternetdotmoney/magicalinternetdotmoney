// End-to-end oracle-free rebalance on the fork: 3 real CP-Swap pools, move A's
// price by trading, then call the Pinocchio program which READS all 6 vault
// balances + both mint supplies on-chain, derives the implied A/B ratio, sees A
// underperformed, and mints A into BOTH its pool vaults (pair + A/USDC). No oracle.
// Run via harness/run-pinocchio-rebalance.sh.
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
  setAuthority,
  AuthorityType,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import assert from "assert";
import * as fs from "fs";

const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const FEE = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const D_INIT = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const WAD = 1_000_000_000n;

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
const vaultOf = (pool: PublicKey, m: PublicKey) =>
  cpp([sd("pool_vault"), pool.toBuffer(), m.toBuffer()]);
const obsOf = (pool: PublicKey) => cpp([sd("observation"), pool.toBuffer()]);
const k = (pubkey: PublicKey, w: boolean, s = false) => ({
  pubkey,
  isSigner: s,
  isWritable: w,
});

function initIx(creator: PublicKey, x: PublicKey, y: PublicKey, amt: bigint) {
  const [t0, t1] = ord(x, y);
  const pool = poolOf(x, y);
  const lp = cpp([sd("pool_lp_mint"), pool.toBuffer()]);
  const data = Buffer.alloc(32);
  D_INIT.copy(data, 0);
  data.writeBigUInt64LE(amt, 8);
  data.writeBigUInt64LE(amt, 16);
  data.writeBigUInt64LE(0n, 24);
  const keys = [
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
  ];
  return new TransactionInstruction({ programId: CP, keys, data });
}

describe("oracle-free pinocchio rebalance (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const INIT = 1_000_000_000n;

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
  const programId = kp.publicKey;
  const [authority, authBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    programId,
  );

  it("reads 6 vaults + 2 mints on-chain, mints the loser (A) into both its pools", async () => {
    // mints — start with wallet as authority so we can seed pools, then hand A,B to the PDA.
    const mk = async () => {
      const m = await createMint(conn, payer, wallet.publicKey, null, 6);
      const ata = await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        m,
        wallet.publicKey,
      );
      await mintTo(conn, payer, m, ata.address, wallet.publicKey, INIT * 20n);
      return m;
    };
    const A = await mk(),
      B = await mk(),
      U = await mk();

    // 3 pools, all seeded 1:1 → price_a = price_b = 1 → ratio = 1.0
    for (const [x, y] of [
      [A, B],
      [A, U],
      [B, U],
    ] as [PublicKey, PublicKey][]) {
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          initIx(wallet.publicKey, x, y, INIT),
        ),
        [],
        { skipPreflight: true },
      );
    }

    const poolAB = poolOf(A, B),
      poolAU = poolOf(A, U),
      poolBU = poolOf(B, U);
    const vAbA = vaultOf(poolAB, A),
      vAbB = vaultOf(poolAB, B);
    const vAuA = vaultOf(poolAU, A),
      vAuU = vaultOf(poolAU, U);
    const vBuB = vaultOf(poolBU, B),
      vBuU = vaultOf(poolBU, U);

    // MOVE THE MARKET (while we still hold A's mint authority): inflate A's vault in
    // the A/USDC pool → price_a = usdc/a falls → A underperforms B → A is the loser.
    await mintTo(conn, payer, A, vAuA, wallet.publicKey, 500_000_000n);

    // now hand A & B mint authority to the program PDA (it mints the loser)
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

    // init_config: stores params + last_ratio = 1.0 (the pre-move basis)
    const [config, cfgBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId,
    );
    const receipt = await createMint(conn, payer, authority, null, 6);
    const u128 = (n: bigint) => {
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(n & ((1n << 64n) - 1n));
      b.writeBigUInt64LE(n >> 64n, 8);
      return b;
    };
    const u64b = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(n);
      return b;
    };
    const lamports = BigInt(await conn.getMinimumBalanceForRentExemption(400));
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId,
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
          data: Buffer.concat([
            Buffer.from([1, authBump, cfgBump]),
            u64b(20_000n),
            u64b(50_000n),
            u64b(2_000n),
            u64b(5_000n),
            u128(WAD),
            u64b(lamports),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    const before = {
      abA: (await getAccount(conn, vAbA)).amount,
      abB: (await getAccount(conn, vAbB)).amount,
      auA: (await getAccount(conn, vAuA)).amount,
    };

    // rebalance: last_ratio + params + bump now come from Config; data = tag + user_leverage
    const data = Buffer.concat([Buffer.from([0]), u64b(30_000n)]); // 3x

    const keys = [
      k(config, true),
      k(authority, false),
      k(A, true),
      k(B, true),
      k(vAbA, true),
      k(vAbB, true),
      k(vAuA, true),
      k(vAuU, false),
      k(vBuB, true),
      k(vBuU, false),
      k(TOKEN_PROGRAM_ID, false),
    ];
    const sig = await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({ programId, keys, data }),
      ),
      [],
      { skipPreflight: true },
    );
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log(
      `    >>> oracle-free rebalance CU = ${tx?.meta?.computeUnitsConsumed}`,
    );

    const after = {
      abA: (await getAccount(conn, vAbA)).amount,
      abB: (await getAccount(conn, vAbB)).amount,
      auA: (await getAccount(conn, vAuA)).amount,
    };
    console.log(
      `    >>> pair A vault:  ${before.abA} -> ${after.abA}  (+${after.abA - before.abA})`,
    );
    console.log(
      `    >>> A/USDC A vault: ${before.auA} -> ${after.auA}  (+${after.auA - before.auA})`,
    );

    assert.ok(
      after.abA > before.abA,
      "loser A was NOT minted into the pair pool",
    );
    assert.ok(
      after.auA > before.auA,
      "loser A was NOT minted into the A/USDC pool",
    );
    assert.equal(after.abB, before.abB, "winner B should not have been minted");
  });
});
