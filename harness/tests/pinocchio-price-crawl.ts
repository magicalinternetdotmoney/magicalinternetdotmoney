// Price crawl: init PDA, extend root LUT with pool, advance_crawl stores sample + median.
// Run via: harness/run-pinocchio-price-crawl.sh
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
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
const ALT = new PublicKey("AddressLookupTab1e1111111111111111111111111");
const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const PRICE_CRAWL_SIZE = 423;
const LAYOUT_CPSWAP = 1;

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
const k = (pubkey: PublicKey, w: boolean, s = false) => ({
  pubkey,
  isSigner: s,
  isWritable: w,
});
const sd = (s: string) => Buffer.from(s);
const cpp = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CP)[0];

describe("pinocchio price crawl (surfpool fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const [config, cfgBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM,
  );
  const [authority, authBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    PROGRAM,
  );
  const [priceCrawl, crawlBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("price_crawl"), config.toBuffer()],
    PROGRAM,
  );

  it("advance_crawl writes sample and aggregate", async () => {
    const d = () => Keypair.generate().publicKey;
    const usdc = await createMint(conn, payer, wallet.publicKey, null, 6);
    const mintA = await createMint(conn, payer, authority, null, 6);
    const mintB = await createMint(conn, payer, authority, null, 6);
    const receipt = Keypair.generate().publicKey;
    const lam = BigInt(await conn.getMinimumBalanceForRentExemption(432));
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(usdc, false),
            k(mintA, false),
            k(mintB, false),
            k(receipt, false),
            k(d(), false),
            k(d(), false),
            k(d(), false),
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

    const recentSlot = BigInt((await conn.getSlot()) - 1);
    const [lut, lutBump] = PublicKey.findProgramAddressSync(
      [authority.toBuffer(), u64(recentSlot)],
      ALT,
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, true),
            k(authority, false),
            k(lut, true),
            k(ALT, false),
            k(SystemProgram.programId, false),
          ],
          data: Buffer.concat([Buffer.from([8]), u64(recentSlot), Buffer.from([lutBump])]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    // Use pool_a_usdc from config as crawl venue (must exist on fork from triangle tests)
    const cfgAi = await conn.getAccountInfo(config);
    assert.ok(cfgAi);
    const poolAq = new PublicKey(cfgAi!.data.subarray(196, 228));
    const extendPool = poolAq.toBuffer();
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, false),
            k(authority, false),
            k(lut, true),
            k(ALT, false),
            k(SystemProgram.programId, false),
          ],
          data: Buffer.concat([Buffer.from([9]), extendPool]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    const crawlRent = BigInt(await conn.getMinimumBalanceForRentExemption(PRICE_CRAWL_SIZE));
    const layouts = Buffer.alloc(12);
    layouts[0] = LAYOUT_CPSWAP;
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(wallet.publicKey, true, true),
            k(config, false),
            k(priceCrawl, true),
            k(SystemProgram.programId, false),
          ],
          data: Buffer.concat([
            Buffer.from([15, crawlBump, 1]),
            layouts,
            u128(50_000_000_000n),
            u64(crawlRent),
          ]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    const poolAi = await conn.getAccountInfo(poolAq);
    assert.ok(poolAi);
    const v0 = new PublicKey(poolAi!.data.subarray(8 + 64, 8 + 96));
    const v1 = new PublicKey(poolAi!.data.subarray(8 + 96, 8 + 128));
    const t0 = new PublicKey(poolAi!.data.subarray(8 + 160, 8 + 192));
    const baseVault = t0.equals(mintA) ? v0 : v1;
    const quoteVault = t0.equals(mintA) ? v1 : v0;

    const slot = BigInt(await conn.getSlot());
    await provider.sendAndConfirm(
      new Transaction().add(
        new TransactionInstruction({
          programId: PROGRAM,
          keys: [
            k(priceCrawl, true),
            k(config, false),
            k(lut, false),
            k(poolAq, false),
            k(baseVault, false),
            k(quoteVault, false),
          ],
          data: Buffer.concat([Buffer.from([16]), u64(slot)]),
        }),
      ),
      [],
      { skipPreflight: true },
    );

    const crawlAi = await conn.getAccountInfo(priceCrawl);
    assert.ok(crawlAi);
    const cdata = crawlAi!.data;
    assert.strictEqual(cdata[33], 0); // cursor wrapped to 0 after 1 entry
    const agg = cdata.readBigUInt64LE(43) + (cdata.readBigUInt64LE(51) << 64n);
    assert.ok(agg > 0n, "aggregate should be set");
  });
});