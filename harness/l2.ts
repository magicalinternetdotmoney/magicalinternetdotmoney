// End-to-end LAUNCH: create the synthetic pair + fire the triangle on-chain.
//
// Sequence (all pieces individually fork-verified in pinocchio-*.ts):
//   1. create MINTA / MINTB  (legacy SPL, 6dp, wallet=temp mint auth, no freeze)
//   2. create receipt        (Token-2022 + TransferHook→program + MetadataPointer→self)
//   3. mint seed amounts of A/B to the creator (so the pools can be seeded)
//   4. init_config           (usdc, mints, receipt, dummy pools, leverage band, fee)
//   5. ATOMIC triangle       (3 CP-Swap initializes + register_triangle in ONE v0 tx + LUT)
//   6. setAuthority A,B → PDA (hand minting to the program; rebalance/deposit can now mint)
//
// Receipt metadata can be backfilled later; ExtraAccountMetaList is initialized
// at launch so wallet transfers resolve hook accounts.
//
// Params via env:
//   ANCHOR_PROVIDER_URL, ANCHOR_WALLET  (wallet = creator + fee payer + upgrade auth)
//   L_USDC_MINT   real USDC on mainnet, or a stand-in on the fork
//   L_MINT_USDC   "1" → create+mint the USDC stand-in to the wallet (fork only)
//   L_ASSET_USD   side-A underlying USD price (e.g. SOL=72.0) — sets the seed ratio
//   L_SEED_USDC   total USDC to seed (default 10)
//   L_LEV         max leverage band (default 5)
//   L_SYM, L_NAME receipt symbol / name
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey, Keypair, Transaction, TransactionInstruction, TransactionMessage,
  VersionedTransaction, AddressLookupTableProgram, ComputeBudgetProgram,
  SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority, AuthorityType,
  getAssociatedTokenAddressSync, getMintLen, ExtensionType,
  createInitializeTransferHookInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";

const env = (k: string, d?: string) => process.env[k] ?? d ?? "";
const PROGRAM = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/target/deploy/leverage_engine_pinocchio-keypair.json`, "utf8")))).publicKey;
const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const AMM0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const FEE = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
const D_INIT = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const sd = (s: string) => Buffer.from(s);
const cpp = (s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, CP)[0];
const ord = (x: PublicKey, y: PublicKey): [PublicKey, PublicKey] => Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x];
const cpAuth = () => cpp([sd("vault_and_lp_mint_auth_seed")]);
const poolOf = (x: PublicKey, y: PublicKey) => { const [t0, t1] = ord(x, y); return cpp([sd("pool"), AMM0.toBuffer(), t0.toBuffer(), t1.toBuffer()]); };
const vaultOf = (p: PublicKey, m: PublicKey) => cpp([sd("pool_vault"), p.toBuffer(), m.toBuffer()]);
const k = (pubkey: PublicKey, w: boolean, s = false) => ({ pubkey, isSigner: s, isWritable: w });
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & ((1n << 64n) - 1n)); b.writeBigUInt64LE(n >> 64n, 8); return b; };

// CP-Swap initialize, seeding `a0`/`a1` of the (sorted) token0/token1.
function initIx(creator: PublicKey, x: PublicKey, y: PublicKey, ax: bigint, ay: bigint) {
  const [t0, t1] = ord(x, y);
  const [a0, a1] = t0.equals(x) ? [ax, ay] : [ay, ax];
  const pool = poolOf(x, y);
  const lp = cpp([sd("pool_lp_mint"), pool.toBuffer()]);
  return {
    pool,
    ix: new TransactionInstruction({
      programId: CP,
      data: Buffer.concat([D_INIT, u64(a0), u64(a1), u64(0n)]),
      keys: [
        k(creator, true, true), k(AMM0, false), k(cpAuth(), false), k(pool, true),
        k(t0, false), k(t1, false), k(lp, true),
        k(getAssociatedTokenAddressSync(t0, creator), true), k(getAssociatedTokenAddressSync(t1, creator), true),
        k(getAssociatedTokenAddressSync(lp, creator), true),
        k(vaultOf(pool, t0), true), k(vaultOf(pool, t1), true), k(FEE, true),
        k(cpp([sd("observation"), pool.toBuffer()]), true),
        k(TOKEN_PROGRAM_ID, false), k(TOKEN_PROGRAM_ID, false), k(TOKEN_PROGRAM_ID, false),
        k(ASSOCIATED_TOKEN_PROGRAM_ID, false), k(SystemProgram.programId, false), k(SYSVAR_RENT_PUBKEY, false),
      ],
    }),
  };
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const payer = wallet.payer;
  const me = wallet.publicKey;

  const ASSET_USD = parseFloat(env("L_ASSET_USD", "72"));
  const SEED_USDC = parseFloat(env("L_SEED_USDC", "10"));
  const LEV = parseInt(env("L_LEV", "5"), 10);
  const SYM = env("L_SYM", "3xSOL");
  const NAME = env("L_NAME", "3x SOL LP");
  const DEC = 6, ONE = 1_000_000n;

  const [config, cfgBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);
  const [authority, authBump] = PublicKey.findProgramAddressSync([Buffer.from("authority")], PROGRAM);

  // ---- USDC: real (mainnet) or a created stand-in (fork) ----
  let U: PublicKey;
  if (env("L_MINT_USDC") === "1") {
    U = await createMint(conn, payer, me, null, DEC);
    const ua = await getOrCreateAssociatedTokenAccount(conn, payer, U, me);
    await mintTo(conn, payer, U, ua.address, me, BigInt(Math.round(SEED_USDC * 4)) * ONE);
    console.log("  USDC stand-in:", U.toBase58());
  } else {
    U = new PublicKey(env("L_USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
  }

  // ---- 1. synth mints (legacy), creator is temp mint authority ----
  const A = await createMint(conn, payer, me, null, DEC);
  const B = await createMint(conn, payer, me, null, DEC);
  console.log("  MINTA:", A.toBase58(), "\n  MINTB:", B.toBase58());

  // ---- 2. receipt: Token-2022 + TransferHook→program + MetadataPointer→self ----
  const receiptKp = Keypair.generate();
  const receipt = receiptKp.publicKey;
  const mintLen = getMintLen([ExtensionType.TransferHook, ExtensionType.MetadataPointer]);
  const rLam = await conn.getMinimumBalanceForRentExemption(mintLen);
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: me, newAccountPubkey: receipt, space: mintLen, lamports: rLam, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(receipt, me, PROGRAM, TOKEN_2022_PROGRAM_ID),
    createInitializeMetadataPointerInstruction(receipt, me, receipt, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(receipt, DEC, me, null, TOKEN_2022_PROGRAM_ID),
  ), [receiptKp], { skipPreflight: true });
  console.log("  receipt (T22+hook):", receipt.toBase58());

  // ---- 3. seed amounts (USDC pools split 50/50; A/B balanced by value) ----
  const halfUsd = SEED_USDC / 2;
  const usdcPer = BigInt(Math.round(halfUsd * 1e6));        // USDC into each USDC pool
  const aSeed = BigInt(Math.round((halfUsd / ASSET_USD) * 1e6)); // MINTA @ asset price → ~ASSET_USD
  const bSeed = BigInt(Math.round(halfUsd * 1e6));          // MINTB @ ~$1
  // mint enough A/B to the creator: A used in A/USDC + A/B ; B used in B/USDC + A/B
  const aMintTotal = aSeed * 2n, bMintTotal = bSeed * 2n;
  for (const [m, amt] of [[A, aMintTotal], [B, bMintTotal]] as [PublicKey, bigint][]) {
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, m, me);
    await mintTo(conn, payer, m, ata.address, me, amt);
  }
  // make sure the LP ATAs exist (CP-Swap mints LP to the creator)
  console.log(`  seed: A/USDC=${usdcPer} USDC + ${aSeed} A · B/USDC=${usdcPer} USDC + ${bSeed} B · A/B=${aSeed} A + ${bSeed} B`);

  // ---- 4. init_config (dummy pools, overwritten by register_triangle) ----
  const dummy = () => Keypair.generate().publicKey;
  const cLam = BigInt(await conn.getMinimumBalanceForRentExemption(400));
  await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [k(me, true, true), k(config, true), k(U, false), k(A, false), k(B, false), k(receipt, false), k(dummy(), false), k(dummy(), false), k(dummy(), false), k(SystemProgram.programId, false)],
    data: Buffer.concat([
      Buffer.from([1, authBump, cfgBump]),
      u64(20_000n), u64(BigInt(LEV) * 10_000n), u64(2_000n), u64(5_000n), u128(ONE), u64(cLam),
    ]),
  })), [], { skipPreflight: true });
  console.log("  init_config ✓ (leverage band", LEV + "x)");

  // ---- 5. ATOMIC triangle: 3 inits + register in one v0 tx (LUT for size) ----
  const inits = [initIx(me, A, B, aSeed, bSeed), initIx(me, A, U, aSeed, usdcPer), initIx(me, B, U, bSeed, usdcPer)];
  const registerIx = new TransactionInstruction({ programId: PROGRAM, keys: [k(me, false, true), k(config, true), k(SYSVAR_INSTRUCTIONS_PUBKEY, false)], data: Buffer.from([6]) });
  const slot = await conn.getSlot();
  const [createLutIx, lut] = AddressLookupTableProgram.createLookupTable({ authority: me, payer: me, recentSlot: slot - 1 });
  const addrs = Array.from(new Set([...inits.flatMap((i) => i.ix.keys.map((m) => m.pubkey.toBase58())), ...registerIx.keys.map((m) => m.pubkey.toBase58()), PROGRAM.toBase58()])).map((s) => new PublicKey(s)).filter((p) => !p.equals(me));
  await provider.sendAndConfirm(new Transaction().add(createLutIx), []);
  for (let i = 0; i < addrs.length; i += 18)
    await provider.sendAndConfirm(new Transaction().add(AddressLookupTableProgram.extendLookupTable({ payer: me, authority: me, lookupTable: lut, addresses: addrs.slice(i, i + 18) })), []);
  await new Promise((r) => setTimeout(r, 1200));
  const lookup = (await conn.getAddressLookupTable(lut)).value!;
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: me, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...inits.map((i) => i.ix), registerIx],
  }).compileToV0Message([lookup]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  console.log("  TRIANGLE FIRED ✓ tx:", sig);
  console.log("    pool A/B :", inits[0].pool.toBase58());
  console.log("    pool A/U :", inits[1].pool.toBase58());
  console.log("    pool B/U :", inits[2].pool.toBase58());

  // ---- 6. hand minting to the program ----
  await setAuthority(conn, payer, A, me, AuthorityType.MintTokens, authority);
  await setAuthority(conn, payer, B, me, AuthorityType.MintTokens, authority);
  console.log("  synth mint authority → PDA ✓");

  // verify config picked up the real pools
  const cd = (await conn.getAccountInfo(config))!.data;
  const got = new PublicKey(cd.subarray(164, 196)).toBase58();
  if (got !== inits[0].pool.toBase58()) throw new Error("register_triangle did not write pool_ab");
  console.log("\n=== LAUNCH COMPLETE ===");
  console.log(JSON.stringify({ sym: SYM, name: NAME, receiptMint: receipt.toBase58(), mintA: A.toBase58(), mintB: B.toBase58(), quoteMint: U.toBase58(), lut: lut.toBase58(), pools: { ab: inits[0].pool.toBase58(), aq: inits[1].pool.toBase58(), bq: inits[2].pool.toBase58() } }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error("LAUNCH FAILED:", e?.message || e); if (e?.logs) console.error(e.logs.join("\n")); process.exit(1); });
