// Token-2022 transfer hook end-to-end on the fork: receipt mint with a
// TransferHook -> our Pinocchio program; init the ExtraAccountMetaList with the
// rebalance accounts; then a RECEIPT TRANSFER fires the hook, which reads the
// vaults and mints the loser (A) into its pools. ("transferrer pays" rebalancing.)
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-hook.ts
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  setAuthority,
  AuthorityType,
  getAssociatedTokenAddressSync,
  getMintLen,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
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
      k(cpp([sd("observation"), pool.toBuffer()]), true),
      k(TOKEN_PROGRAM_ID, false),
      k(TOKEN_PROGRAM_ID, false),
      k(TOKEN_PROGRAM_ID, false),
      k(ASSOCIATED_TOKEN_PROGRAM_ID, false),
      k(SystemProgram.programId, false),
      k(SYSVAR_RENT_PUBKEY, false),
    ],
  });
}

describe("pinocchio Token-2022 transfer hook (surfpool fork)", () => {
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

  it("a receipt transfer fires the hook → mints the loser into its pools", async () => {
    const mk = async () => {
      const m = await createMint(conn, payer, wallet.publicKey, null, 6);
      const a = await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        m,
        wallet.publicKey,
      );
      await mintTo(conn, payer, m, a.address, wallet.publicKey, INIT * 20n);
      return m;
    };
    const A = await mk(),
      B = await mk(),
      U = await mk();
    for (const [x, y] of [
      [A, B],
      [A, U],
      [B, U],
    ] as [PublicKey, PublicKey][])
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          initIx(wallet.publicKey, x, y, INIT),
        ),
        [],
        { skipPreflight: true },
      );

    const poolAB = poolOf(A, B),
      poolAU = poolOf(A, U),
      poolBU = poolOf(B, U);
    const vAbA = vaultOf(poolAB, A),
      vAbB = vaultOf(poolAB, B),
      vAuA = vaultOf(poolAU, A),
      vAuU = vaultOf(poolAU, U),
      vBuB = vaultOf(poolBU, B),
      vBuU = vaultOf(poolBU, U);

    // move market so A underperforms, then hand A,B to the PDA
    await mintTo(conn, payer, A, vAuA, wallet.publicKey, 500_000_000n);
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

    // receipt mint = Token-2022 + TransferHook -> our program
    const receipt = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await conn.getMinimumBalanceForRentExemption(mintLen);
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: receipt.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(
          receipt.publicKey,
          wallet.publicKey,
          PROGRAM,
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMintInstruction(
          receipt.publicKey,
          9,
          wallet.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer, receipt],
      { skipPreflight: true },
    );

    // init_config
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
            k(receipt.publicKey, false),
            k(poolAB, false),
            k(poolAU, false),
            k(poolBU, false),
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

    // init_extra_account_metas: embed the 11 rebalance accounts (hook order)
    const [metaList, metaBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), receipt.publicKey.toBuffer()],
      PROGRAM,
    );
    const embeds = [
      config,
      authority,
      A,
      B,
      vAbA,
      vAbB,
      vAuA,
      vAuU,
      vBuB,
      vBuU,
      TOKEN_PROGRAM_ID,
    ];
    const mask = 0b00101111101; // writable: config,mint_a,mint_b,vAbA,vAbB,vAuA,vBuB (bits 0,2,3,4,5,6,8) = 381
    const metaRent = BigInt(
      await conn.getMinimumBalanceForRentExemption(16 + embeds.length * 35),
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(metaList, true),
            k(receipt.publicKey, false),
            k(SystemProgram.programId, false),
            ...embeds.map((e) => k(e, false)),
          ],
          data: Buffer.concat([
            Buffer.from([7]),
            u64(metaRent),
            Buffer.from([embeds.length]),
            Buffer.from([mask & 0xff, (mask >> 8) & 0xff]),
            Buffer.from([metaBump]),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    // mint receipt to wallet + recipient ATA
    const src = getAssociatedTokenAddressSync(
      receipt.publicKey,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const recipient = Keypair.generate();
    const dst = getAssociatedTokenAddressSync(
      receipt.publicKey,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          src,
          wallet.publicKey,
          receipt.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          dst,
          recipient.publicKey,
          receipt.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        createMintToInstruction(
          receipt.publicKey,
          src,
          wallet.publicKey,
          100 * 10 ** 9,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer],
      { skipPreflight: true },
    );

    const before = {
      abA: (await getAccount(conn, vAbA)).amount,
      auA: (await getAccount(conn, vAuA)).amount,
      abB: (await getAccount(conn, vAbB)).amount,
    };

    // TRANSFER receipt → fires the hook → rebalance
    const transferIx = await createTransferCheckedWithTransferHookInstruction(
      conn,
      src,
      receipt.publicKey,
      dst,
      wallet.publicKey,
      BigInt(1 * 10 ** 9),
      9,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        transferIx,
      ),
      [payer],
      { skipPreflight: true },
    );

    const after = {
      abA: (await getAccount(conn, vAbA)).amount,
      auA: (await getAccount(conn, vAuA)).amount,
      abB: (await getAccount(conn, vAbB)).amount,
    };
    console.log(
      `    >>> hook fired: pair A vault +${after.abA - before.abA}, A/USDC A vault +${after.auA - before.auA}`,
    );
    assert.ok(after.abA > before.abA, "hook did not mint A into the pair pool");
    assert.ok(
      after.auA > before.auA,
      "hook did not mint A into the A/USDC pool",
    );
    assert.equal(after.abB, before.abB, "winner B should be untouched");
  });
});
