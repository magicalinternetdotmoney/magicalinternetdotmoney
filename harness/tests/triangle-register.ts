// Positive-path integration: build the protocol's persistent PDA-authority LUT,
// then create all THREE real Raydium CP-Swap pools + call `register_triangle` in
// ONE v0 transaction on a surfpool fork. Proves the introspection guard ACCEPTS a
// correctly-formed atomic triangle and records the pools in Config.
//
// `config.usdc_mint` is a controlled stand-in mint here (the introspection path is
// identical to real USDC; only deposit funding differs). Run via
// harness/run-triangle-register.sh.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
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

const idl = JSON.parse(
  fs.readFileSync(`${process.cwd()}/target/idl/leverage_engine.json`, "utf8"),
);

const CP_SWAP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM_CONFIG0 = new PublicKey(
  "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
);
const CREATE_POOL_FEE = new PublicKey(
  "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8",
);
const ALT_PROGRAM = new PublicKey(
  "AddressLookupTab1e1111111111111111111111111",
);
const IX_INITIALIZE = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

const seed = (s: string) => Buffer.from(s);
const cpPda = (s: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(s, CP_SWAP)[0];
const order = (x: PublicKey, y: PublicKey): [PublicKey, PublicKey] =>
  Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x];

function buildInitialize(
  creator: PublicKey,
  mintX: PublicKey,
  mintY: PublicKey,
  amt: bigint,
) {
  const [t0, t1] = order(mintX, mintY);
  const authority = cpPda([seed("vault_and_lp_mint_auth_seed")]);
  const poolState = cpPda([
    seed("pool"),
    AMM_CONFIG0.toBuffer(),
    t0.toBuffer(),
    t1.toBuffer(),
  ]);
  const lpMint = cpPda([seed("pool_lp_mint"), poolState.toBuffer()]);
  const vault0 = cpPda([
    seed("pool_vault"),
    poolState.toBuffer(),
    t0.toBuffer(),
  ]);
  const vault1 = cpPda([
    seed("pool_vault"),
    poolState.toBuffer(),
    t1.toBuffer(),
  ]);
  const observation = cpPda([seed("observation"), poolState.toBuffer()]);
  const data = Buffer.alloc(32);
  IX_INITIALIZE.copy(data, 0);
  data.writeBigUInt64LE(amt, 8);
  data.writeBigUInt64LE(amt, 16);
  data.writeBigUInt64LE(0n, 24);
  const k = (pubkey: PublicKey, w: boolean, s = false) => ({
    pubkey,
    isSigner: s,
    isWritable: w,
  });
  const keys = [
    k(creator, true, true),
    k(AMM_CONFIG0, false),
    k(authority, false),
    k(poolState, true),
    k(t0, false),
    k(t1, false),
    k(lpMint, true),
    k(getAssociatedTokenAddressSync(t0, creator), true),
    k(getAssociatedTokenAddressSync(t1, creator), true),
    k(getAssociatedTokenAddressSync(lpMint, creator), true),
    k(vault0, true),
    k(vault1, true),
    k(CREATE_POOL_FEE, true),
    k(observation, true),
    k(TOKEN_PROGRAM_ID, false),
    k(TOKEN_PROGRAM_ID, false),
    k(TOKEN_PROGRAM_ID, false),
    k(ASSOCIATED_TOKEN_PROGRAM_ID, false),
    k(SystemProgram.programId, false),
    k(SYSVAR_RENT_PUBKEY, false),
  ];
  return {
    ix: new TransactionInstruction({ programId: CP_SWAP, keys, data }),
    poolState,
  };
}

describe("register_triangle positive path (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as anchor.Idl, provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const INIT = 1_000_000_000n;

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    program.programId,
  );

  let A: PublicKey, B: PublicKey, U: PublicKey, receipt: PublicKey;
  let pools: { ix: TransactionInstruction; poolState: PublicKey }[];

  it("setup mints + funded creator ATAs + protocol vaults", async () => {
    const mk = async () => {
      const m = await createMint(conn, payer, wallet.publicKey, null, 6);
      const ata = await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        m,
        wallet.publicKey,
      );
      await mintTo(conn, payer, m, ata.address, wallet.publicKey, INIT * 4n);
      return m;
    };
    A = await mk();
    B = await mk();
    U = await mk(); // stand-in "USDC"
    receipt = await createMint(conn, payer, authority, null, 6);
    // protocol-owned vaults (authority PDA, off-curve)
    await getOrCreateAssociatedTokenAccount(conn, payer, A, authority, true);
    await getOrCreateAssociatedTokenAccount(conn, payer, B, authority, true);
    await getOrCreateAssociatedTokenAccount(conn, payer, U, authority, true);
  });

  it("initialize_config", async () => {
    await program.methods
      .initializeConfig({
        lMinBps: new anchor.BN(20_000),
        lMaxBps: new anchor.BN(50_000),
        maxMintBps: new anchor.BN(2_000),
        breakerBps: new anchor.BN(5_000),
        minRebalanceInterval: new anchor.BN(0),
        priceInit: new anchor.BN(1_000_000_000),
      })
      .accounts({
        admin: wallet.publicKey,
        config,
        authority,
        usdcMint: U,
        mintA: A,
        mintB: B,
        receiptMint: receipt,
        usdcVault: getAssociatedTokenAddressSync(U, authority, true),
        reserveA: getAssociatedTokenAddressSync(A, authority, true),
        reserveB: getAssociatedTokenAddressSync(B, authority, true),
        oracle: Keypair.generate().publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("init + extend the persistent PDA-authority LUT", async () => {
    pools = [
      buildInitialize(wallet.publicKey, A, B, INIT),
      buildInitialize(wallet.publicKey, A, U, INIT),
      buildInitialize(wallet.publicKey, B, U, INIT),
    ];
    const registerIx = await program.methods
      .registerTriangle()
      .accounts({
        admin: wallet.publicKey,
        config,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const recentSlot = (await conn.getSlot()) - 1;
    const [lut] = PublicKey.findProgramAddressSync(
      [
        authority.toBuffer(),
        new anchor.BN(recentSlot).toArrayLike(Buffer, "le", 8),
      ],
      ALT_PROGRAM,
    );

    await program.methods
      .initLookupTable(new anchor.BN(recentSlot))
      .accounts({
        admin: wallet.publicKey,
        config,
        authority,
        lookupTable: lut,
        lutProgram: ALT_PROGRAM,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await (program.account as any).config.fetch(config);
    assert.equal(
      cfg.lookupTable.toBase58(),
      lut.toBase58(),
      "LUT not stored in config",
    );

    // every non-signer account the v0 tx will touch
    const all = [
      ...pools.flatMap((p) => p.ix.keys.map((m) => m.pubkey)),
      ...registerIx.keys.map((m) => m.pubkey),
      CP_SWAP,
      program.programId,
    ];
    const addrs = Array.from(new Set(all.map((p) => p.toBase58())))
      .map((s) => new PublicKey(s))
      .filter((p) => !p.equals(wallet.publicKey)); // signer stays static

    for (let i = 0; i < addrs.length; i += 18) {
      await program.methods
        .extendLookupTable(addrs.slice(i, i + 18))
        .accounts({
          admin: wallet.publicKey,
          config,
          authority,
          lookupTable: lut,
          lutProgram: ALT_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    await new Promise((r) => setTimeout(r, 900)); // LUT warmup
    (globalThis as any).__lut = lut;
  });

  it("ONE v0 tx: 3 real pools + register_triangle, against the protocol LUT", async () => {
    const lut: PublicKey = (globalThis as any).__lut;
    const registerIx = await program.methods
      .registerTriangle()
      .accounts({
        admin: wallet.publicKey,
        config,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const lookup = (await conn.getAddressLookupTable(lut)).value!;
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...pools.map((p) => p.ix),
        registerIx, // introspection runs LAST, sees the 3 initializes
      ],
    }).compileToV0Message([lookup]);
    console.log(`    >>> v0 message size = ${msg.serialize().length} bytes`);

    const vtx = new VersionedTransaction(msg);
    vtx.sign([payer]);
    const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
    await conn.confirmTransaction(sig, "confirmed");
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log(
      `    >>> full triangle+register CU = ${tx?.meta?.computeUnitsConsumed}`,
    );

    const cfg = await (program.account as any).config.fetch(config);
    const [ab] = order(A, B);
    const pool = (x: PublicKey, y: PublicKey) => {
      const [t0, t1] = order(x, y);
      return cpPda([
        seed("pool"),
        AMM_CONFIG0.toBuffer(),
        t0.toBuffer(),
        t1.toBuffer(),
      ]).toBase58();
    };
    assert.equal(cfg.poolAb.toBase58(), pool(A, B), "pool_ab not registered");
    assert.equal(
      cfg.poolAUsdc.toBase58(),
      pool(A, U),
      "pool_a_usdc not registered",
    );
    assert.equal(
      cfg.poolBUsdc.toBase58(),
      pool(B, U),
      "pool_b_usdc not registered",
    );
    void ab;
  });
});
