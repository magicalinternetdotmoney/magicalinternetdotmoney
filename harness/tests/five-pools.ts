// Documents the atomic-pool-creation CEILING: 3 CP-Swap initializes fit one tx;
// a 4th blows Solana's 64-instruction trace cap (NOT CU, NOT size — Raydium
// creates ~6 accounts/pool internally, ~16 trace instructions each). So the
// triangle (3) is the Raydium-imposed max for a single introspected launch tx.
// Run via harness/run-five-pools.sh
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
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

const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const FEE = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const IX_INIT = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const sd = (s: string) => Buffer.from(s);
const pda = (s: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(s, CP)[0];
const ord = (x: PublicKey, y: PublicKey): [PublicKey, PublicKey] =>
  Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x];

function initIx(creator: PublicKey, x: PublicKey, y: PublicKey, amt: bigint) {
  const [t0, t1] = ord(x, y);
  const auth = pda([sd("vault_and_lp_mint_auth_seed")]);
  const pool = pda([sd("pool"), AMM0.toBuffer(), t0.toBuffer(), t1.toBuffer()]);
  const lp = pda([sd("pool_lp_mint"), pool.toBuffer()]);
  const data = Buffer.alloc(32);
  IX_INIT.copy(data, 0);
  data.writeBigUInt64LE(amt, 8);
  data.writeBigUInt64LE(amt, 16);
  data.writeBigUInt64LE(0n, 24);
  const k = (p: PublicKey, w: boolean, s = false) => ({
    pubkey: p,
    isSigner: s,
    isWritable: w,
  });
  return new TransactionInstruction({
    programId: CP,
    data,
    keys: [
      k(creator, true, true),
      k(AMM0, false),
      k(auth, false),
      k(pool, true),
      k(t0, false),
      k(t1, false),
      k(lp, true),
      k(getAssociatedTokenAddressSync(t0, creator), true),
      k(getAssociatedTokenAddressSync(t1, creator), true),
      k(getAssociatedTokenAddressSync(lp, creator), true),
      k(pda([sd("pool_vault"), pool.toBuffer(), t0.toBuffer()]), true),
      k(pda([sd("pool_vault"), pool.toBuffer(), t1.toBuffer()]), true),
      k(FEE, true),
      k(pda([sd("observation"), pool.toBuffer()]), true),
      k(TOKEN_PROGRAM_ID, false),
      k(TOKEN_PROGRAM_ID, false),
      k(TOKEN_PROGRAM_ID, false),
      k(ASSOCIATED_TOKEN_PROGRAM_ID, false),
      k(SystemProgram.programId, false),
      k(SYSVAR_RENT_PUBKEY, false),
    ],
  });
}

describe("CP-Swap atomic-creation ceiling (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const INIT = 1_000_000_000n;
  const mk = async () => {
    const m = await createMint(conn, payer, wallet.publicKey, null, 6);
    const a = await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      m,
      wallet.publicKey,
    );
    await mintTo(conn, payer, m, a.address, wallet.publicKey, INIT * 8n);
    return m;
  };

  async function createPools(pairs: [PublicKey, PublicKey][]) {
    const ixs = pairs.map(([x, y]) => initIx(wallet.publicKey, x, y, INIT));
    const slot = await conn.getSlot();
    const [createLutIx, lut] = AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      recentSlot: slot - 1,
    });
    const addrs = Array.from(
      new Set(ixs.flatMap((i) => i.keys.map((m) => m.pubkey.toBase58()))),
    )
      .map((s) => new PublicKey(s))
      .filter((p) => !p.equals(wallet.publicKey));
    await provider.sendAndConfirm(new Transaction().add(createLutIx), []);
    for (let i = 0; i < addrs.length; i += 20)
      await provider.sendAndConfirm(
        new Transaction().add(
          AddressLookupTableProgram.extendLookupTable({
            payer: wallet.publicKey,
            authority: wallet.publicKey,
            lookupTable: lut,
            addresses: addrs.slice(i, i + 20),
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
        ...ixs,
      ],
    }).compileToV0Message([lookup]);
    const size = msg.serialize().length;
    const vtx = new VersionedTransaction(msg);
    vtx.sign([payer]);
    const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return {
      size,
      cu: tx?.meta?.computeUnitsConsumed ?? -1,
      err: tx?.meta?.err ?? null,
    };
  }

  it("3 pools fit one tx", async () => {
    const [P0, P1, P2] = [await mk(), await mk(), await mk()];
    const r = await createPools([
      [P0, P1],
      [P0, P2],
      [P1, P2],
    ]);
    console.log(
      `    >>> 3 pools: ${r.cu} CU, ${r.size} B, err=${JSON.stringify(r.err)}`,
    );
    assert.equal(r.err, null, "3 pools should fit one tx");
  });

  it("4 pools exceed the 64-instruction trace cap", async () => {
    const [P0, P1, P2, P3] = [await mk(), await mk(), await mk(), await mk()];
    const r = await createPools([
      [P0, P1],
      [P0, P2],
      [P0, P3],
      [P1, P2],
    ]);
    console.log(
      `    >>> 4 pools: ${r.cu} CU, ${r.size} B, err=${JSON.stringify(r.err)}`,
    );
    assert.ok(
      r.err &&
        JSON.stringify(r.err).includes("MaxInstructionTraceLengthExceeded"),
      `expected trace-cap error, got ${JSON.stringify(r.err)}`,
    );
    console.log(
      `    >>> CEILING CONFIRMED: 3 pools = max atomic launch (CU/size had headroom; Raydium's internal account creation is the limit)`,
    );
  });
});
