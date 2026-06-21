// "Unfuckedwith" validation: the program accepts pristine PDA-controlled LEGACY SPL
// Token synthetic mints (82-byte base, supply 0, no freeze) and REJECTS tampered ones
// (wrong mint authority, or a Token-2022 mint — synths must be legacy so the transfer
// hook can mint them without re-entering Token-2022).
// Run via: harness/run-pinocchio-config.sh harness/tests/pinocchio-validate.ts
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
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
const k = (pubkey: PublicKey, w: boolean, s = false) => ({
  pubkey,
  isSigner: s,
  isWritable: w,
});

describe("pinocchio pristine-mint validation (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    PROGRAM,
  );

  // pristine LEGACY SPL Token mint: 82-byte base, supply 0, no freeze, given authority.
  async function goodMint(mintAuth: PublicKey) {
    return createMint(conn, payer, mintAuth, null, 6);
  }
  // a Token-2022 mint (with a TransferFee extension) — must be REJECTED: the synths
  // have to be legacy, so any T22-owned mint fails the program-owner check.
  async function t22Mint() {
    const m = Keypair.generate();
    const len = getMintLen([ExtensionType.TransferFeeConfig]);
    const lamports = await conn.getMinimumBalanceForRentExemption(len);
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: m.publicKey,
          space: len,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferFeeConfigInstruction(
          m.publicKey,
          wallet.publicKey,
          wallet.publicKey,
          100,
          BigInt(1_000_000),
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMintInstruction(
          m.publicKey,
          6,
          authority,
          null,
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer, m],
      { skipPreflight: true },
    );
    return m.publicKey;
  }

  const validateIx = (a: PublicKey, b: PublicKey) =>
    new TransactionInstruction({
      programId: PROGRAM,
      keys: [k(authority, false), k(a, false), k(b, false)],
      data: Buffer.from([10, 6]), // tag, decimals
    });
  const expectFail = async (ix: TransactionInstruction, why: string) => {
    let threw = false;
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [], {
        skipPreflight: true,
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, `should have rejected: ${why}`);
  };

  it("accepts pristine PDA-controlled legacy mints", async () => {
    const a = await goodMint(authority),
      b = await goodMint(authority);
    await provider.sendAndConfirm(new Transaction().add(validateIx(a, b)), [], {
      skipPreflight: true,
    });
    console.log(`    >>> pristine legacy mintA/mintB accepted`);
  });

  it("rejects a mint whose authority is NOT the PDA", async () => {
    const good = await goodMint(authority),
      badAuth = await goodMint(wallet.publicKey);
    await expectFail(validateIx(good, badAuth), "mint authority != PDA");
    console.log(`    >>> rejected wrong-authority mint`);
  });

  it("rejects a Token-2022 mint (synths must be legacy)", async () => {
    const good = await goodMint(authority),
      t22 = await t22Mint();
    await expectFail(validateIx(good, t22), "synth mint is Token-2022, not legacy");
    console.log(`    >>> rejected Token-2022 synth mint`);
  });
});
