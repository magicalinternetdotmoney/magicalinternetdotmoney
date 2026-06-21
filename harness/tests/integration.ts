// Integration test for leverage-engine against a surfpool MAINNET FORK.
//
// Proves on the fork: (1) the program deploys and `initialize_config` works with
// real USDC cloned from mainnet, and (2) the tx-introspection guard
// `register_triangle` correctly REJECTS a transaction that does not contain three
// CP-Swap `initialize` instructions (TriangleIncomplete). The positive path
// (three real pools in one tx) lands once `create_pool_fee` is wired.
//
// Run via harness/run-integration.sh (boots surfpool + deploys first).
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import assert from "assert";
import * as fs from "fs";

// Load the IDL at runtime (avoids ESM JSON import-attribute friction under ts-mocha).
const idl = JSON.parse(
  fs.readFileSync(`${process.cwd()}/target/idl/leverage_engine.json`, "utf8"),
);

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("leverage-engine (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as anchor.Idl, provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    program.programId,
  );

  let mintA: PublicKey;
  let mintB: PublicKey;
  let receiptMint: PublicKey;

  it("sets up mints + vaults (authority = PDA)", async () => {
    // synthetics + receipt minted by the authority PDA
    mintA = await createMint(conn, wallet.payer, authority, null, 6);
    mintB = await createMint(conn, wallet.payer, authority, null, 6);
    receiptMint = await createMint(conn, wallet.payer, authority, null, 6);

    // protocol-owned vaults (off-curve owner)
    await getOrCreateAssociatedTokenAccount(
      conn,
      wallet.payer,
      mintA,
      authority,
      true,
    );
    await getOrCreateAssociatedTokenAccount(
      conn,
      wallet.payer,
      mintB,
      authority,
      true,
    );
    await getOrCreateAssociatedTokenAccount(
      conn,
      wallet.payer,
      USDC,
      authority,
      true,
    ); // USDC cloned from mainnet
  });

  it("initialize_config", async () => {
    const reserveA = getAssociatedTokenAddressSync(mintA, authority, true);
    const reserveB = getAssociatedTokenAddressSync(mintB, authority, true);
    const usdcVault = getAssociatedTokenAddressSync(USDC, authority, true);

    await program.methods
      .initializeConfig({
        lMinBps: new anchor.BN(20_000), // 2x
        lMaxBps: new anchor.BN(50_000), // 5x
        maxMintBps: new anchor.BN(2_000), // 20%/rebalance
        breakerBps: new anchor.BN(5_000), // pause >= 50%
        minRebalanceInterval: new anchor.BN(0),
        priceInit: new anchor.BN(1_000_000_000),
      })
      .accounts({
        admin: wallet.publicKey,
        config,
        authority,
        usdcMint: USDC,
        mintA,
        mintB,
        receiptMint,
        usdcVault,
        reserveA,
        reserveB,
        oracle: Keypair.generate().publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await (program.account as any).config.fetch(config);
    assert.equal(cfg.mintA.toBase58(), mintA.toBase58());
    assert.equal(cfg.poolAb.toBase58(), PublicKey.default.toBase58()); // not yet registered
    assert.equal(cfg.lMaxBps.toNumber(), 50_000);
  });

  it("register_triangle REJECTS a tx without three CP-Swap initializes", async () => {
    const ix = await program.methods
      .registerTriangle()
      .accounts({
        admin: wallet.publicKey,
        config,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    let threw = false;
    try {
      // single-instruction tx: zero CP-Swap initializes present
      await provider.sendAndConfirm(new Transaction().add(ix), []);
    } catch (e: any) {
      threw = true;
      const msg = JSON.stringify(e.logs ?? e.message ?? e);
      assert.ok(
        /TriangleIncomplete|Expected exactly three/.test(msg),
        `expected TriangleIncomplete, got: ${msg}`,
      );
    }
    assert.ok(
      threw,
      "register_triangle should have rejected an incomplete triangle",
    );
  });
});
