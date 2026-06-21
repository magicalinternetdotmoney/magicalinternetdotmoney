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
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
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

// CP-Swap initialize for a MIXED pool: a legacy `synth` + a Token-2022 `meme`.
// Sets each side's token program correctly (synth=legacy, meme=T22).
function memePoolIx(creator: PublicKey, synth: PublicKey, meme: PublicKey, synthAmt: bigint, memeAmt: bigint) {
  const [t0, t1] = ord(synth, meme);
  const isSynth0 = t0.equals(synth);
  const [a0, a1] = isSynth0 ? [synthAmt, memeAmt] : [memeAmt, synthAmt];
  const prog0 = isSynth0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const prog1 = isSynth0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const pool = poolOf(synth, meme);
  const lp = cpp([sd("pool_lp_mint"), pool.toBuffer()]);
  return {
    pool,
    ix: new TransactionInstruction({
      programId: CP,
      data: Buffer.concat([D_INIT, u64(a0), u64(a1), u64(0n)]),
      keys: [
        k(creator, true, true), k(AMM0, false), k(cpAuth(), false), k(pool, true),
        k(t0, false), k(t1, false), k(lp, true),
        k(getAssociatedTokenAddressSync(t0, creator, false, prog0), true),
        k(getAssociatedTokenAddressSync(t1, creator, false, prog1), true),
        k(getAssociatedTokenAddressSync(lp, creator), true),
        k(vaultOf(pool, t0), true), k(vaultOf(pool, t1), true), k(FEE, true),
        k(cpp([sd("observation"), pool.toBuffer()]), true),
        k(TOKEN_PROGRAM_ID, false), k(prog0, false), k(prog1, false),
        k(ASSOCIATED_TOKEN_PROGRAM_ID, false), k(SystemProgram.programId, false), k(SYSVAR_RENT_PUBKEY, false),
      ],
    }),
  };
}

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
  // optional 2 MEME-quote pools (→ 5 AMMs). MEME is Token-2022; creator must hold it.
  let MEME_MINT = env("L_MEME_MINT") ? new PublicKey(env("L_MEME_MINT")) : null;
  const MEME_PER = BigInt(env("L_MEME_PER_POOL", "0")); // MEME base units seeded into EACH meme pool

  const [authority, authBump] = PublicKey.findProgramAddressSync([Buffer.from("authority")], PROGRAM);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Each launch is FRESH (config is now per-pair, keyed by the receipt — no singleton
  // to resume from; a failed attempt just leaks a little rent, re-run starts clean).
  // USDC: real (mainnet) or a created stand-in (fork)
  let U: PublicKey;
  if (env("L_MINT_USDC") === "1") {
    U = await createMint(conn, payer, me, null, DEC);
    const ua = await getOrCreateAssociatedTokenAccount(conn, payer, U, me);
    await mintTo(conn, payer, U, ua.address, me, BigInt(Math.round(SEED_USDC * 4)) * ONE);
    console.log("  USDC stand-in:", U.toBase58());
  } else {
    U = new PublicKey(env("L_USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
  }
  // fork only: create a Token-2022 MEME stand-in + fund the creator
  if (env("L_MINT_MEME") === "1") {
    MEME_MINT = await createMint(conn, payer, me, null, DEC, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    const ma = await getOrCreateAssociatedTokenAccount(conn, payer, MEME_MINT, me, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
    await mintTo(conn, payer, MEME_MINT, ma.address, me, MEME_PER * 8n, [], undefined, TOKEN_2022_PROGRAM_ID);
    console.log("  MEME stand-in (T22):", MEME_MINT.toBase58());
  }
  // 1. synth mints (legacy), creator is temp mint authority
  const A = await createMint(conn, payer, me, null, DEC);
  const B = await createMint(conn, payer, me, null, DEC);
  console.log("  MINTA:", A.toBase58(), "\n  MINTB:", B.toBase58());
  // 2. receipt: Token-2022 + TransferHook→program + MetadataPointer→self
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

  // per-pair config PDA = ["config", receipt]
  const [config, cfgBump] = PublicKey.findProgramAddressSync([Buffer.from("config"), receipt.toBuffer()], PROGRAM);

  // ---- 3. seed amounts (USDC pools split 50/50; A/B balanced by value) ----
  const halfUsd = SEED_USDC / 2;
  const usdcPer = BigInt(Math.round(halfUsd * 1e6));        // USDC into each USDC pool
  const aSeed = BigInt(Math.round((halfUsd / ASSET_USD) * 1e6)); // MINTA @ asset price → ~ASSET_USD
  const bSeed = BigInt(Math.round(halfUsd * 1e6));          // MINTB @ ~$1
  // mint enough A/B to the creator: A used in A/USDC + A/B ; B used in B/USDC + A/B
  // triangle uses A in {A/B, A/USDC} and B in {B/USDC, A/B}; each MEME pool needs one more aSeed/bSeed.
  const memeOn = !!(MEME_MINT && MEME_PER > 0n);
  const aMintTotal = aSeed * (memeOn ? 3n : 2n), bMintTotal = bSeed * (memeOn ? 3n : 2n);
  // create ATA + mint in ONE atomic tx (no read-after-create race against lagging RPC).
  for (const [m, amt, lbl] of [[A, aMintTotal, "A"], [B, bMintTotal, "B"]] as [PublicKey, bigint, string][]) {
    const ata = getAssociatedTokenAddressSync(m, me, false, TOKEN_PROGRAM_ID);
    await provider.sendAndConfirm(new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(me, ata, me, m, TOKEN_PROGRAM_ID),
      createMintToInstruction(m, ata, me, amt, [], TOKEN_PROGRAM_ID),
    ), [], { skipPreflight: true });
    console.log(`  [seed] ${lbl}: minted ${amt} → ${ata.toBase58().slice(0, 6)}… ✓`);
  }
  // make sure the LP ATAs exist (CP-Swap mints LP to the creator)
  console.log(`  seed: A/USDC=${usdcPer} USDC + ${aSeed} A · B/USDC=${usdcPer} USDC + ${bSeed} B · A/B=${aSeed} A + ${bSeed} B`);

  // ---- 4. init_config (per-pair PDA; dummy pools overwritten by register_triangle) ----
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
  console.log("  init_config ✓ (per-pair config", config.toBase58().slice(0, 8) + "…, leverage band", LEV + "x)");

  // ---- 5. ATOMIC triangle: 3 inits + register in one v0 tx (LUT for size) ----
  const inits = [initIx(me, A, B, aSeed, bSeed), initIx(me, A, U, aSeed, usdcPer), initIx(me, B, U, bSeed, usdcPer)];
  const registerIx = new TransactionInstruction({ programId: PROGRAM, keys: [k(me, false, true), k(config, true), k(SYSVAR_INSTRUCTIONS_PUBKEY, false)], data: Buffer.from([6]) });
  const slot = await conn.getSlot();
  const [createLutIx, lut] = AddressLookupTableProgram.createLookupTable({ authority: me, payer: me, recentSlot: slot - 1 });
  const addrs = Array.from(new Set([...inits.flatMap((i) => i.ix.keys.map((m) => m.pubkey.toBase58())), ...registerIx.keys.map((m) => m.pubkey.toBase58()), PROGRAM.toBase58()])).map((s) => new PublicKey(s)).filter((p) => !p.equals(me));
  await provider.sendAndConfirm(new Transaction().add(createLutIx), [], { skipPreflight: true });
  await sleep(1800); // let the new LUT account propagate before extending (else "Invalid account owner")
  for (let i = 0; i < addrs.length; i += 18) {
    await provider.sendAndConfirm(new Transaction().add(AddressLookupTableProgram.extendLookupTable({ payer: me, authority: me, lookupTable: lut, addresses: addrs.slice(i, i + 18) })), [], { skipPreflight: true });
    await sleep(400);
  }
  // wait until the LUT is visible AND holds every address the v0 tx will reference.
  let lookup: any = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const got = (await conn.getAddressLookupTable(lut)).value;
    if (got && got.state.addresses.length >= addrs.length) { lookup = got; break; }
  }
  if (!lookup) throw new Error("LUT did not populate in time");
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

  // ---- 5b. (optional) 2 MEME-quote pools → 5 AMMs (mixed legacy-synth / T22-MEME) ----
  let memePools: { am?: string; bm?: string } = {};
  if (memeOn) {
    const am = memePoolIx(me, A, MEME_MINT!, aSeed, MEME_PER);
    const bm = memePoolIx(me, B, MEME_MINT!, bSeed, MEME_PER);
    for (const [lbl, p] of [["A/MEME", am], ["B/MEME", bm]] as [string, typeof am][]) {
      await provider.sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 }), p.ix), [], { skipPreflight: true });
      await sleep(500);
      console.log(`    pool ${lbl} :`, p.pool.toBase58());
    }
    memePools = { am: am.pool.toBase58(), bm: bm.pool.toBase58() };
    console.log("  2 MEME pools created ✓ (5 AMMs)");
  }

  // ---- 6. hand minting to the program ----
  await setAuthority(conn, payer, A, me, AuthorityType.MintTokens, authority, [], { skipPreflight: true, commitment: "confirmed" });
  await setAuthority(conn, payer, B, me, AuthorityType.MintTokens, authority, [], { skipPreflight: true, commitment: "confirmed" });
  // the receipt (Token-2022) must ALSO hand minting to the PDA, else deposit can't mint it.
  await setAuthority(conn, payer, receipt, me, AuthorityType.MintTokens, authority, [], { skipPreflight: true, commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
  console.log("  synth + receipt mint authority → PDA ✓");

  // ---- 7. init transfer-hook ExtraAccountMetaList (wallet transfers need this) ----
  const [metaList, metaBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), receipt.toBuffer()],
    PROGRAM,
  );
  const hookMask = 0b00101111101;
  const hookEmbeds = [
    config, authority, A, B,
    vaultOf(inits[0].pool, A), vaultOf(inits[0].pool, B),
    vaultOf(inits[1].pool, A), vaultOf(inits[1].pool, U),
    vaultOf(inits[2].pool, B), vaultOf(inits[2].pool, U),
    TOKEN_PROGRAM_ID,
  ];
  const metaRent = BigInt(await conn.getMinimumBalanceForRentExemption(16 + hookEmbeds.length * 35));
  await provider.sendAndConfirm(new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        k(me, true, true), k(metaList, true), k(receipt, false), k(SystemProgram.programId, false),
        ...hookEmbeds.map((pk) => k(pk, false)),
      ],
      data: Buffer.concat([
        Buffer.from([7]),
        u64(metaRent),
        Buffer.from([hookEmbeds.length]),
        Buffer.from([hookMask & 0xff, (hookMask >> 8) & 0xff]),
        Buffer.from([metaBump]),
      ]),
    }),
  ), [], { skipPreflight: true });
  console.log("  transfer-hook extras ✓", metaList.toBase58());

  // verify config picked up the real pools (best-effort; launch already landed on-chain)
  let got = "";
  for (let i = 0; i < 10; i++) {
    const ai = await conn.getAccountInfo(config);
    if (ai) { got = new PublicKey(ai.data.subarray(164, 196)).toBase58(); break; }
    await sleep(600);
  }
  if (got && got !== inits[0].pool.toBase58()) console.warn("  ⚠ config pool_ab mismatch (verify only):", got);
  else if (got) console.log("  config.pool_ab verified ✓");
  console.log("\n=== LAUNCH COMPLETE ===");
  console.log(JSON.stringify({ sym: SYM, name: NAME, receiptMint: receipt.toBase58(), config: config.toBase58(), mintA: A.toBase58(), mintB: B.toBase58(), quoteMint: U.toBase58(), memeMint: MEME_MINT ? MEME_MINT.toBase58() : null, lut: lut.toBase58(), pools: { ab: inits[0].pool.toBase58(), aq: inits[1].pool.toBase58(), bq: inits[2].pool.toBase58(), am: memePools.am || null, bm: memePools.bm || null } }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error("LAUNCH FAILED:", e?.message || e); if (e?.logs) console.error(e.logs.join("\n")); process.exit(1); });
