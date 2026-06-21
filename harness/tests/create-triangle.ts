// Empirical CU/size test: create real Raydium CP-Swap pools on a surfpool fork.
//
// Answers two hard constraints that can only be measured, not reasoned about:
//   1. SIZE  — do 3 `initialize` instructions fit one tx? (1232-byte legacy limit
//              → we use a v0 tx + Address Lookup Table to compress account keys.)
//   2. CU    — do 3 pool creates fit under the 1.4M compute-unit cap?
//
// Base asset is irrelevant to CU, so we use three mints we control (A, B, U) to
// sidestep funding real USDC. Run via harness/run-triangle.sh.
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
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

const CP_SWAP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM_CONFIG0 = new PublicKey(
  "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
);
const CREATE_POOL_FEE = new PublicKey(
  "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8",
);
const IX_INITIALIZE = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

const seed = (s: string) => Buffer.from(s);
const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, CP_SWAP)[0];

function orderMints(x: PublicKey, y: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x];
}

// Build a CP-Swap `initialize` instruction for the (mintX, mintY) pair.
function buildInitialize(
  creator: PublicKey,
  mintX: PublicKey,
  mintY: PublicKey,
  initAmount: bigint,
): { ix: TransactionInstruction; poolState: PublicKey } {
  const [t0, t1] = orderMints(mintX, mintY);
  const authority = pda([seed("vault_and_lp_mint_auth_seed")]);
  const poolState = pda([
    seed("pool"),
    AMM_CONFIG0.toBuffer(),
    t0.toBuffer(),
    t1.toBuffer(),
  ]);
  const lpMint = pda([seed("pool_lp_mint"), poolState.toBuffer()]);
  const vault0 = pda([seed("pool_vault"), poolState.toBuffer(), t0.toBuffer()]);
  const vault1 = pda([seed("pool_vault"), poolState.toBuffer(), t1.toBuffer()]);
  const observation = pda([seed("observation"), poolState.toBuffer()]);
  const creator0 = getAssociatedTokenAddressSync(t0, creator);
  const creator1 = getAssociatedTokenAddressSync(t1, creator);
  const creatorLp = getAssociatedTokenAddressSync(lpMint, creator);

  const data = Buffer.alloc(8 + 8 + 8 + 8);
  IX_INITIALIZE.copy(data, 0);
  data.writeBigUInt64LE(initAmount, 8); // init_amount_0
  data.writeBigUInt64LE(initAmount, 16); // init_amount_1
  data.writeBigUInt64LE(0n, 24); // open_time = 0 (immediate)

  const k = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  const keys = [
    k(creator, true, true), // 0 creator
    k(AMM_CONFIG0, false), // 1 amm_config
    k(authority, false), // 2 authority
    k(poolState, true), // 3 pool_state
    k(t0, false), // 4 token_0_mint
    k(t1, false), // 5 token_1_mint
    k(lpMint, true), // 6 lp_mint
    k(creator0, true), // 7 creator_token_0
    k(creator1, true), // 8 creator_token_1
    k(creatorLp, true), // 9 creator_lp_token
    k(vault0, true), // 10 token_0_vault
    k(vault1, true), // 11 token_1_vault
    k(CREATE_POOL_FEE, true), // 12 create_pool_fee
    k(observation, true), // 13 observation_state
    k(TOKEN_PROGRAM_ID, false), // 14 token_program
    k(TOKEN_PROGRAM_ID, false), // 15 token_0_program
    k(TOKEN_PROGRAM_ID, false), // 16 token_1_program
    k(ASSOCIATED_TOKEN_PROGRAM_ID, false), // 17 associated_token_program
    k(SystemProgram.programId, false), // 18 system_program
    k(SYSVAR_RENT_PUBKEY, false), // 19 rent
  ];
  return {
    ix: new TransactionInstruction({ programId: CP_SWAP, keys, data }),
    poolState,
  };
}

describe("CP-Swap triangle creation (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const INIT = 1_000_000_000n; // 1000 tokens @ 6dp seed liquidity per side

  // Create a funded source mint owned by the payer (free minting for the test).
  async function fundedMint(): Promise<PublicKey> {
    const m = await createMint(conn, payer, wallet.publicKey, null, 6);
    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      m,
      wallet.publicKey,
    );
    await mintTo(conn, payer, m, ata.address, wallet.publicKey, INIT * 4n);
    return m;
  }

  async function cuOf(sig: string): Promise<number> {
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.computeUnitsConsumed ?? -1;
  }

  it("baseline: ONE pool create — measure CU", async () => {
    const [p, q] = [await fundedMint(), await fundedMint()];
    const { ix, poolState } = buildInitialize(wallet.publicKey, p, q, INIT);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ix,
    );
    const sig = await provider.sendAndConfirm(tx, [], { skipPreflight: true });
    const cu = await cuOf(sig);
    console.log(`    >>> single pool CU = ${cu}`);
    const acct = await conn.getAccountInfo(poolState);
    assert.ok(acct, "pool_state not created");
    assert.ok(cu > 0 && cu < 1_400_000, `single pool CU out of range: ${cu}`);
  });

  it("TRIANGLE: 3 pool creates in ONE v0 tx (LUT) — measure CU/size feasibility", async () => {
    const [A, B, U] = [
      await fundedMint(),
      await fundedMint(),
      await fundedMint(),
    ];
    const inits = [
      buildInitialize(wallet.publicKey, A, B, INIT),
      buildInitialize(wallet.publicKey, A, U, INIT),
      buildInitialize(wallet.publicKey, B, U, INIT),
    ];

    // Address Lookup Table to beat the 1232-byte legacy tx size limit.
    const slot = await conn.getSlot();
    const [createLutIx, lut] = AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      recentSlot: slot - 1,
    });
    const addrs = Array.from(
      new Set(inits.flatMap((i) => i.ix.keys.map((m) => m.pubkey.toBase58()))),
    ).map((s) => new PublicKey(s));
    console.log(`    >>> LUT addresses = ${addrs.length}`);

    // create alone, then extend in <=20-address chunks (each extend must itself
    // fit 1232 bytes — ~30 addrs max; 20 is safe).
    await provider.sendAndConfirm(new Transaction().add(createLutIx), []);
    for (let i = 0; i < addrs.length; i += 20) {
      const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: wallet.publicKey,
        authority: wallet.publicKey,
        lookupTable: lut,
        addresses: addrs.slice(i, i + 20),
      });
      await provider.sendAndConfirm(new Transaction().add(extendIx), []);
    }
    // LUTs need one slot to warm up before use.
    await new Promise((r) => setTimeout(r, 800));

    const lookup = (await conn.getAddressLookupTable(lut)).value!;
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...inits.map((i) => i.ix),
      ],
    }).compileToV0Message([lookup]);

    const serialized = msg.serialize().length;
    console.log(
      `    >>> v0 message size = ${serialized} bytes (LUT-compressed)`,
    );

    const vtx = new VersionedTransaction(msg);
    vtx.sign([payer]);

    let sig: string;
    let fit = true;
    try {
      sig = await conn.sendTransaction(vtx, { skipPreflight: true });
      await conn.confirmTransaction(sig, "confirmed");
    } catch (e: any) {
      fit = false;
      console.log(`    >>> 3-in-1 tx FAILED: ${e.message ?? e}`);
      throw e;
    }
    const cu = await cuOf(sig);
    console.log(`    >>> THREE pools in one tx CU = ${cu} (cap 1,400,000)`);
    for (const { poolState } of inits) {
      assert.ok(
        await conn.getAccountInfo(poolState),
        "a pool_state was not created",
      );
    }
    assert.ok(
      fit && cu > 0 && cu <= 1_400_000,
      `triangle CU exceeded cap: ${cu}`,
    );
  });
});
