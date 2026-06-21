// Validate the CP-Swap deposit (add-liquidity) + withdraw (redeem) CPIs on the
// fork: seed a pool, deposit liquidity for LP, then withdraw the LP back to the
// underlying. This is the building block for the protocol deposit/withdraw (the
// receipt token will represent the protocol's LP claim). Run via
// harness/run-cpswap-lp.sh.
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
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
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import assert from "assert";

const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const FEE = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const D_INIT = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const D_DEP = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const D_WD = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);

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

function initIx(creator: PublicKey, x: PublicKey, y: PublicKey, amt: bigint) {
  const [t0, t1] = ord(x, y);
  const pool = poolOf(x, y);
  const lp = lpOf(pool);
  const data = Buffer.concat([D_INIT, u64(amt), u64(amt), u64(0n)]);
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

// shared account list for deposit/withdraw (owner = signer)
function lpAccounts(
  owner: PublicKey,
  pool: PublicKey,
  x: PublicKey,
  y: PublicKey,
) {
  const [t0, t1] = ord(x, y);
  const lp = lpOf(pool);
  return [
    k(owner, false, true),
    k(cpAuth(), false),
    k(pool, true),
    k(getAssociatedTokenAddressSync(lp, owner), true),
    k(getAssociatedTokenAddressSync(t0, owner), true),
    k(getAssociatedTokenAddressSync(t1, owner), true),
    k(vaultOf(pool, t0), true),
    k(vaultOf(pool, t1), true),
    k(TOKEN_PROGRAM_ID, false),
    k(TOKEN_2022_PROGRAM_ID, false),
    k(t0, false),
    k(t1, false),
    k(lp, true),
  ];
}

function depositIx(
  owner: PublicKey,
  pool: PublicKey,
  x: PublicKey,
  y: PublicKey,
  lpAmt: bigint,
  maxA: bigint,
) {
  return new TransactionInstruction({
    programId: CP,
    keys: lpAccounts(owner, pool, x, y),
    data: Buffer.concat([D_DEP, u64(lpAmt), u64(maxA), u64(maxA)]),
  });
}
function withdrawIx(
  owner: PublicKey,
  pool: PublicKey,
  x: PublicKey,
  y: PublicKey,
  lpAmt: bigint,
) {
  return new TransactionInstruction({
    programId: CP,
    keys: [...lpAccounts(owner, pool, x, y), k(MEMO, false)],
    data: Buffer.concat([D_WD, u64(lpAmt), u64(0n), u64(0n)]),
  });
}

describe("CP-Swap deposit/withdraw LP round-trip (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const INIT = 1_000_000_000n;

  it("deposit mints LP + pulls tokens; withdraw burns LP + returns tokens", async () => {
    const mk = async () => {
      const m = await createMint(conn, payer, wallet.publicKey, null, 6);
      const ata = await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        m,
        wallet.publicKey,
      );
      await mintTo(conn, payer, m, ata.address, wallet.publicKey, INIT * 10n);
      return m;
    };
    const A = await mk();
    const B = await mk();
    const pool = poolOf(A, B);
    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        initIx(wallet.publicKey, A, B, INIT),
      ),
      [],
      { skipPreflight: true },
    );

    const lpAta = getAssociatedTokenAddressSync(lpOf(pool), wallet.publicKey);
    const aAta = getAssociatedTokenAddressSync(A, wallet.publicKey);
    const bal = async (a: PublicKey) => (await getAccount(conn, a)).amount;

    const lp0 = await bal(lpAta);
    const a0 = await bal(aAta);

    // DEPOSIT: ask for 100M LP, allow up to 300M of each token
    await provider.sendAndConfirm(
      new Transaction().add(
        depositIx(wallet.publicKey, pool, A, B, 100_000_000n, 300_000_000n),
      ),
      [],
      { skipPreflight: true },
    );
    const lp1 = await bal(lpAta);
    const a1 = await bal(aAta);
    console.log(
      `    >>> deposit: LP ${lp0}->${lp1} (+${lp1 - lp0}), A ${a0}->${a1} (${a1 - a0})`,
    );
    assert.ok(lp1 > lp0, "deposit did not mint LP");
    assert.ok(a1 < a0, "deposit did not pull token A");

    // WITHDRAW: burn all the LP we just got
    await provider.sendAndConfirm(
      new Transaction().add(
        withdrawIx(wallet.publicKey, pool, A, B, lp1 - lp0),
      ),
      [],
      { skipPreflight: true },
    );
    const lp2 = await bal(lpAta);
    const a2 = await bal(aAta);
    console.log(
      `    >>> withdraw: LP ${lp1}->${lp2} (${lp2 - lp1}), A ${a1}->${a2} (+${a2 - a1})`,
    );
    assert.equal(lp2, lp0, "withdraw did not burn the deposited LP");
    assert.ok(a2 > a1, "withdraw did not return token A");
  });
});
