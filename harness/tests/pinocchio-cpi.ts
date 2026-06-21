// On-chain proof that the Pinocchio program's PDA-signed mint_to CPI works.
// Deploys leverage_engine_pinocchio to the surfpool fork, points a mint's
// authority at the program's ["authority"] PDA, and calls TAG_REBALANCE with a
// 1% down move @ 3x → expects the program to mint exactly 3% of the pair reserve
// into reserve_a via CPI. Run via harness/run-pinocchio-cpi.sh.
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import assert from "assert";
import * as fs from "fs";

describe("pinocchio mint_to CPI (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;

  // real program id from the deploy keypair
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

  it("mints exactly 3% of the pair reserve into reserve_a via CPI", async () => {
    // mints with authority = program PDA
    const mintA = await createMint(conn, payer, authority, null, 6);
    const mintB = await createMint(conn, payer, authority, null, 6);
    const reserveA = (
      await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        mintA,
        wallet.publicKey,
      )
    ).address;
    const reserveB = (
      await getOrCreateAssociatedTokenAccount(
        conn,
        payer,
        mintB,
        wallet.publicKey,
      )
    ).address;

    // data: tag(1) + 7×u64 LE + bump(1)
    const data = Buffer.alloc(1 + 7 * 8 + 1);
    data.writeUInt8(0, 0); // TAG_REBALANCE
    data.writeBigUInt64LE(100n, 1); // price_last
    data.writeBigUInt64LE(99n, 9); // price_now  (−1% → loser = A)
    data.writeBigUInt64LE(1_000_000n, 17); // reserve_a_pair
    data.writeBigUInt64LE(1_000_000n, 25); // reserve_b_pair
    data.writeBigUInt64LE(500_000n, 33); // reserve_a_usdc
    data.writeBigUInt64LE(500_000n, 41); // reserve_b_usdc
    data.writeBigUInt64LE(30_000n, 49); // user_leverage_bps (3x)
    data.writeUInt8(authBump, 57); // authority bump

    const keys = [
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: mintA, isSigner: false, isWritable: true },
      { pubkey: mintB, isSigner: false, isWritable: true },
      { pubkey: reserveA, isSigner: false, isWritable: true },
      { pubkey: reserveB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const ix = new TransactionInstruction({ programId, keys, data });

    const sig = await provider.sendAndConfirm(new Transaction().add(ix), [], {
      skipPreflight: true,
    });
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log(
      `    >>> pinocchio rebalance CU = ${tx?.meta?.computeUnitsConsumed}`,
    );

    const acct = await getAccount(conn, reserveA);
    // 1% move * 3x = 3% of 1_000_000 = 30_000
    assert.equal(Number(acct.amount), 30_000, "loser was not minted by CPI");
  });
});
