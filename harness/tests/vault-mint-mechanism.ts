// Load-bearing mechanism check: does minting a synthetic DIRECTLY INTO a CP-Swap
// pool vault move the price? (i.e. does CP-Swap's x*y=k read live vault balances?)
// If yes, the rebalance is just `mint_to` into the loser vaults — no swap needed.
//
// Method: create a pool, swap B->A (baseline out), then mint a large chunk of A
// straight into A's vault, swap the SAME B->A again. If the 2nd swap returns more
// A (despite the 1st swap having made A scarcer), minting-into-vault moved price.
// Run via harness/run-vault-mechanism.sh.
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import assert from "assert";

const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const FEE = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const D_INIT = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const D_SWAP = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

const sd = (s: string) => Buffer.from(s);
const pda = (s: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(s, CP)[0];
const ord = (x: PublicKey, y: PublicKey): [PublicKey, PublicKey] =>
  Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x];
const auth = () => pda([sd("vault_and_lp_mint_auth_seed")]);
const poolOf = (t0: PublicKey, t1: PublicKey) =>
  pda([sd("pool"), AMM0.toBuffer(), t0.toBuffer(), t1.toBuffer()]);
const vaultOf = (pool: PublicKey, m: PublicKey) =>
  pda([sd("pool_vault"), pool.toBuffer(), m.toBuffer()]);
const obsOf = (pool: PublicKey) => pda([sd("observation"), pool.toBuffer()]);

const k = (pubkey: PublicKey, w: boolean, s = false) => ({
  pubkey,
  isSigner: s,
  isWritable: w,
});

function initIx(creator: PublicKey, x: PublicKey, y: PublicKey, amt: bigint) {
  const [t0, t1] = ord(x, y);
  const pool = poolOf(t0, t1);
  const lp = pda([sd("pool_lp_mint"), pool.toBuffer()]);
  const data = Buffer.alloc(32);
  D_INIT.copy(data, 0);
  data.writeBigUInt64LE(amt, 8);
  data.writeBigUInt64LE(amt, 16);
  data.writeBigUInt64LE(0n, 24);
  const keys = [
    k(creator, true, true),
    k(AMM0, false),
    k(auth(), false),
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
  return {
    ix: new TransactionInstruction({ programId: CP, keys, data }),
    pool,
  };
}

function swapIx(
  payer: PublicKey,
  pool: PublicKey,
  inM: PublicKey,
  outM: PublicKey,
  amtIn: bigint,
) {
  const data = Buffer.alloc(24);
  D_SWAP.copy(data, 0);
  data.writeBigUInt64LE(amtIn, 8);
  data.writeBigUInt64LE(0n, 16); // min out
  const keys = [
    k(payer, false, true),
    k(auth(), false),
    k(AMM0, false),
    k(pool, true),
    k(getAssociatedTokenAddressSync(inM, payer), true),
    k(getAssociatedTokenAddressSync(outM, payer), true),
    k(vaultOf(pool, inM), true),
    k(vaultOf(pool, outM), true),
    k(TOKEN_PROGRAM_ID, false),
    k(TOKEN_PROGRAM_ID, false),
    k(inM, false),
    k(outM, false),
    k(obsOf(pool), true),
  ];
  return new TransactionInstruction({ programId: CP, keys, data });
}

describe("mint-into-vault moves CP-Swap price (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const INIT = 1_000_000_000n;

  it("a direct mint into A's vault gives more A out on an identical B->A swap", async () => {
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
    const { pool } = initIx(wallet.publicKey, A, B, INIT);
    await provider.sendAndConfirm(
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        initIx(wallet.publicKey, A, B, INIT).ix,
      ),
      [],
      { skipPreflight: true },
    );

    const aAta = getAssociatedTokenAddressSync(A, wallet.publicKey);
    const swapAmt = 50_000_000n;

    // swap #1: B -> A (baseline)
    const a0 = (await getAccount(conn, aAta)).amount;
    await provider.sendAndConfirm(
      new Transaction().add(swapIx(wallet.publicKey, pool, B, A, swapAmt)),
      [],
      {
        skipPreflight: true,
      },
    );
    const a1 = (await getAccount(conn, aAta)).amount;
    const out1 = a1 - a0;

    // mint a LARGE chunk of A straight into A's pool vault (we are mint authority)
    const vaultA = vaultOf(pool, A);
    const vBefore = (await getAccount(conn, vaultA)).amount;
    await mintTo(conn, payer, A, vaultA, wallet.publicKey, INIT * 5n); // 5x the reserve
    const vAfter = (await getAccount(conn, vaultA)).amount;

    // swap #2: identical B -> A
    const a2pre = (await getAccount(conn, aAta)).amount;
    await provider.sendAndConfirm(
      new Transaction().add(swapIx(wallet.publicKey, pool, B, A, swapAmt)),
      [],
      {
        skipPreflight: true,
      },
    );
    const a2 = (await getAccount(conn, aAta)).amount;
    const out2 = a2 - a2pre;

    console.log(`    >>> A vault: ${vBefore} -> ${vAfter} (minted in)`);
    console.log(
      `    >>> B->A out #1 = ${out1}   #2 (after vault mint) = ${out2}`,
    );
    assert.ok(vAfter > vBefore, "vault balance did not increase");
    assert.ok(
      out2 > out1 * 2n,
      `expected far more A out after inflating its vault; got ${out1} -> ${out2}`,
    );
  });
});
