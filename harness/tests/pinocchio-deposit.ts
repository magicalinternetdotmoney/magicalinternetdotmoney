// Full protocol deposit -> withdraw round-trip through the Pinocchio program on
// the fork: init_config, deposit USDC (CP-Swap add-liquidity CPI + mint receipt),
// then withdraw (burn receipt + redeem Raydium LP + burn synth + return USDC).
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-deposit.ts
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
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
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

function initPoolIx(
  creator: PublicKey,
  x: PublicKey,
  y: PublicKey,
  amt: bigint,
) {
  const [t0, t1] = ord(x, y);
  const pool = poolOf(x, y);
  const lp = lpOf(pool);
  const data = Buffer.concat([D_INIT, u64(amt), u64(amt), u64(0n)]);
  return new TransactionInstruction({
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

describe("pinocchio deposit/withdraw round-trip (surfpool fork)", () => {
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

  it("deposit mints receipt + LP; withdraw burns receipt + returns USDC", async () => {
    // mints (wallet authority to seed pools, then hand A + receipt to the PDA)
    const A = await createMint(conn, payer, wallet.publicKey, null, 6);
    const B = await createMint(conn, payer, wallet.publicKey, null, 6);
    const U = await createMint(conn, payer, wallet.publicKey, null, 6); // USDC stand-in
    // receipt is Token-2022 (it carries the transfer hook in prod); A/B/U stay legacy.
    const receipt = await createMint(conn, payer, wallet.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    for (const m of [A, B, U]) {
      const ata = await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        m,
        wallet.publicKey,
      );
      await mintTo(conn, payer, m, ata.address, wallet.publicKey, INIT * 20n);
    }
    const poolAU = poolOf(A, U);
    const poolBU = poolOf(B, U);
    for (const ix of [
      initPoolIx(wallet.publicKey, A, U, INIT),
      initPoolIx(wallet.publicKey, B, U, INIT),
    ]) {
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ix,
        ),
        [],
        { skipPreflight: true },
      );
    }
    for (const m of [A, B]) {
      await setAuthority(
        conn,
        payer,
        m,
        wallet.publicKey,
        AuthorityType.MintTokens,
        authority,
      );
    }
    await setAuthority(
      conn,
      payer,
      receipt,
      wallet.publicKey,
      AuthorityType.MintTokens,
      authority,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    const lpMintAU = lpOf(poolAU);
    const lpMintBU = lpOf(poolBU);
    const vaultAuA = vaultOf(poolAU, A),
      vaultAuU = vaultOf(poolAU, U);
    const vaultBuB = vaultOf(poolBU, B),
      vaultBuU = vaultOf(poolBU, U);
    // protocol-owned accounts (authority PDA, off-curve)
    const protoUsdc = (
      await getOrCreateAssociatedTokenAccount(conn, payer, U, authority, true)
    ).address;
    const protoA = (
      await getOrCreateAssociatedTokenAccount(conn, payer, A, authority, true)
    ).address;
    const protoB = (
      await getOrCreateAssociatedTokenAccount(conn, payer, B, authority, true)
    ).address;
    const protoLpAU = (
      await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        lpMintAU,
        authority,
        true,
      )
    ).address;
    const protoLpBU = (
      await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        lpMintBU,
        authority,
        true,
      )
    ).address;
    // user accounts
    const userUsdc = getAssociatedTokenAddressSync(U, wallet.publicKey);
    const userReceipt = (
      await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        receipt,
        wallet.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      )
    ).address;

    // init_config
    const lamports = BigInt(await conn.getMinimumBalanceForRentExemption(400));
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
            k(poolOf(A, B), false),
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
            u64(lamports),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    // --- DEPOSIT (50/50 fan-out across A/Q + B/Q) ---
    const legDeposit = async (
      synth: PublicKey,
      pool: PublicKey,
      lpMint: PublicKey,
      vaultSynth: PublicKey,
      vaultU: PublicKey,
      protoSynth: PublicKey,
      protoLp: PublicKey,
      usdcAmount: bigint,
    ) => {
      const usdcReserve = (await getAccount(conn, vaultU)).amount;
      const synthReserve = (await getAccount(conn, vaultSynth)).amount;
      const lpSupply = (await getMint(conn, lpMint)).supply;
      const lpAmount = (usdcAmount * lpSupply) / usdcReserve;
      const maxSynth = (((synthReserve * lpAmount) / lpSupply) * 12n) / 10n;
      await provider.sendAndConfirm(
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          new TransactionInstruction({
            programId: PROGRAM,
            keys: [
              k(wallet.publicKey, true, true),
              k(config, true),
              k(authority, false),
              k(U, false),
              k(synth, true),
              k(receipt, true),
              k(userUsdc, true),
              k(protoUsdc, true),
              k(userReceipt, true),
              k(protoSynth, true),
              k(protoLp, true),
              k(pool, true),
              k(lpMint, true),
              k(vaultSynth, true),
              k(vaultU, true),
              k(cpAuth(), false),
              k(CP, false),
              k(TOKEN_PROGRAM_ID, false),
              k(TOKEN_2022_PROGRAM_ID, false),
            ],
            data: Buffer.concat([
              Buffer.from([2]),
              u64(lpAmount),
              u64(usdcAmount),
              u64(maxSynth),
            ]),
          }),
        ),
        [],
        { skipPreflight: true },
      );
      return lpAmount;
    };

    const usdcTotal = 100_000_000n;
    const usdcA = usdcTotal / 2n;
    const usdcB = usdcTotal - usdcA;
    const lpA = await legDeposit(
      A, poolAU, lpMintAU, vaultAuA, vaultAuU, protoA, protoLpAU, usdcA,
    );
    const lpB = await legDeposit(
      B, poolBU, lpMintBU, vaultBuB, vaultBuU, protoB, protoLpBU, usdcB,
    );

    const receiptBal = (await getAccount(conn, userReceipt, undefined, TOKEN_2022_PROGRAM_ID)).amount;
    const protoLpAuBal = (await getAccount(conn, protoLpAU)).amount;
    const protoLpBuBal = (await getAccount(conn, protoLpBU)).amount;
    console.log(
      `    >>> deposit fan-out: receipt=${receiptBal}, LP A/Q=${protoLpAuBal}, LP B/Q=${protoLpBuBal}`,
    );
    assert.equal(receiptBal, lpA + lpB, "receipt != sum of per-leg LP");
    assert.ok(protoLpAuBal >= lpA && protoLpBuBal >= lpB, "protocol missing LP");

    // --- WITHDRAW (proportional across both legs) ---
    const userUsdcBefore = (await getAccount(conn, userUsdc)).amount;
    const protoABefore = (await getAccount(conn, protoA)).amount;
    const protoBBefore = (await getAccount(conn, protoB)).amount;
    const protoUsdcBefore = (await getAccount(conn, protoUsdc)).amount;
    const totalLp = protoLpAuBal + protoLpBuBal;
    const burnA = (receiptBal * protoLpAuBal) / totalLp;
    const burnB = receiptBal - burnA;

    const wdLeg = (
      synth: PublicKey,
      pool: PublicKey,
      lpMint: PublicKey,
      vaultSynth: PublicKey,
      vaultU: PublicKey,
      protoSynth: PublicKey,
      protoLp: PublicKey,
      amount: bigint,
    ) =>
      new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          k(wallet.publicKey, true, true),
          k(config, true),
          k(authority, false),
          k(U, false),
          k(synth, true),
          k(receipt, true),
          k(userUsdc, true),
          k(protoUsdc, true),
          k(userReceipt, true),
          k(protoSynth, true),
          k(protoLp, true),
          k(pool, true),
          k(lpMint, true),
          k(vaultSynth, true),
          k(vaultU, true),
          k(cpAuth(), false),
          k(CP, false),
          k(TOKEN_PROGRAM_ID, false),
          k(TOKEN_2022_PROGRAM_ID, false),
          k(MEMO, false),
        ],
        data: Buffer.concat([Buffer.from([3]), u64(amount)]),
      });

    const wdTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }),
    );
    if (burnA > 0n) {
      wdTx.add(wdLeg(A, poolAU, lpMintAU, vaultAuA, vaultAuU, protoA, protoLpAU, burnA));
    }
    if (burnB > 0n) {
      wdTx.add(wdLeg(B, poolBU, lpMintBU, vaultBuB, vaultBuU, protoB, protoLpBU, burnB));
    }
    await provider.sendAndConfirm(wdTx, [], { skipPreflight: true });

    const receiptAfter = (await getAccount(conn, userReceipt, undefined, TOKEN_2022_PROGRAM_ID)).amount;
    const userUsdcAfter = (await getAccount(conn, userUsdc)).amount;
    const protoLpAuAfter = (await getAccount(conn, protoLpAU)).amount;
    const protoLpBuAfter = (await getAccount(conn, protoLpBU)).amount;
    const protoAAfter = (await getAccount(conn, protoA)).amount;
    const protoBAfter = (await getAccount(conn, protoB)).amount;
    const protoUsdcAfter = (await getAccount(conn, protoUsdc)).amount;
    console.log(
      `    >>> withdraw: receipt ${receiptBal}->${receiptAfter}, user USDC +${userUsdcAfter - userUsdcBefore}`,
    );
    assert.equal(receiptAfter, 0n, "receipt not fully burned");
    assert.ok(userUsdcAfter > userUsdcBefore, "user did not get USDC back");
    assert.equal(protoLpAuAfter, 0n, "A/Q Raydium LP not redeemed");
    assert.equal(protoLpBuAfter, 0n, "B/Q Raydium LP not redeemed");
    assert.equal(protoAAfter, protoABefore, "A synth should be burned, not accumulated");
    assert.equal(protoBAfter, protoBBefore, "B synth should be burned, not accumulated");
    assert.equal(protoUsdcAfter, 0n, "protocol should not custody quote after withdraw");
  });
});
