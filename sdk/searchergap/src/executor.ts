/**
 * Executor — builds the UNSIGNED instructions / transaction a searcher's keeper
 * signs and sends. This module never signs and never sends; it turns a gap into
 * a bundle-ready tx.
 *
 *  - cpSwapBaseInputIx   — one Raydium CP-Swap swap_base_input instruction
 *  - buildTriangleArbIxs — the 3-hop atomic cycle (last hop guards profit)
 *  - buildCrankIx        — the permissionless rebalance crank (tag 0)
 *  - jitoTipIx           — a SystemProgram tip to a Jito tip account
 *  - buildArbBundleTx    — assemble an unsigned VersionedTransaction
 *
 * The synth legs + USDC are all legacy SPL Token, so every swap mint uses
 * TOKEN_PROGRAM_ID (the receipt is Token-2022 but is never swapped here).
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { CP_PROGRAM_ID, DEFAULT_PROGRAM_ID, type Market } from "./markets";
import { getAmountOut } from "./cpswap";
import type { TriangleReserves } from "./markets";
import type { TriangleDirection } from "./gap";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Raydium CP-Swap global authority PDA (constant). */
export const CP_AUTHORITY = new PublicKey("GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL");
const SWAP_BASE_INPUT_DISC = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

/** Mainnet Jito tip accounts (any one is fine; rotate to spread load). */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((s) => new PublicKey(s));

export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  )[0];
}

/** Read a CP-Swap pool's amm_config (PoolState field at offset 8, after the disc). */
export async function loadAmmConfig(connection: Connection, pool: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(pool, "confirmed");
  if (!info) throw new Error(`pool ${pool.toBase58()} not found`);
  return new PublicKey(info.data.subarray(8, 40));
}

export interface SwapLeg {
  pool: PublicKey;
  ammConfig: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  observation: PublicKey;
}

/** Build one CP-Swap swap_base_input instruction (owner signs directly). */
export function cpSwapBaseInputIx(args: {
  owner: PublicKey;
  amountIn: bigint;
  minOut: bigint;
  leg: SwapLeg;
}): TransactionInstruction {
  const { owner, amountIn, minOut, leg } = args;
  const data = Buffer.alloc(24);
  SWAP_BASE_INPUT_DISC.copy(data, 0);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(minOut, 16);
  const inputAta = associatedTokenAddress(leg.inputMint, owner);
  const outputAta = associatedTokenAddress(leg.outputMint, owner);
  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: CP_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: leg.ammConfig, isSigner: false, isWritable: false },
    { pubkey: leg.pool, isSigner: false, isWritable: true },
    { pubkey: inputAta, isSigner: false, isWritable: true },
    { pubkey: outputAta, isSigner: false, isWritable: true },
    { pubkey: leg.inputVault, isSigner: false, isWritable: true },
    { pubkey: leg.outputVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: leg.inputMint, isSigner: false, isWritable: false },
    { pubkey: leg.outputMint, isSigner: false, isWritable: false },
    { pubkey: leg.observation, isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId: CP_PROGRAM_ID, keys, data });
}

export interface AmmConfigs {
  aq: PublicKey;
  ab: PublicKey;
  bq: PublicKey;
}

/** Read all three pools' amm_config accounts for a market. */
export async function loadAmmConfigs(connection: Connection, m: Market): Promise<AmmConfigs> {
  const [aq, ab, bq] = await Promise.all([
    loadAmmConfig(connection, m.pools.aq.pool),
    loadAmmConfig(connection, m.pools.ab.pool),
    loadAmmConfig(connection, m.pools.bq.pool),
  ]);
  return { aq, ab, bq };
}

/**
 * The three hops of a triangle cycle as SwapLeg specs (no amounts yet).
 *  AQ→AB→BQ: USDC→A (aq) → A→B (ab) → B→USDC (bq)
 *  BQ→AB→AQ: USDC→B (bq) → B→A (ab) → A→USDC (aq)
 */
export function triangleLegs(m: Market, cfg: AmmConfigs, direction: TriangleDirection): SwapLeg[] {
  const usdc = m.quoteMint, A = m.mintA, B = m.mintB;
  if (direction === "AQ→AB→BQ") {
    return [
      { pool: m.pools.aq.pool, ammConfig: cfg.aq, inputMint: usdc, outputMint: A, inputVault: m.pools.aq.vaultQuote, outputVault: m.pools.aq.vaultBase, observation: m.pools.aq.observation },
      { pool: m.pools.ab.pool, ammConfig: cfg.ab, inputMint: A, outputMint: B, inputVault: m.pools.ab.vaultBase, outputVault: m.pools.ab.vaultQuote, observation: m.pools.ab.observation },
      { pool: m.pools.bq.pool, ammConfig: cfg.bq, inputMint: B, outputMint: usdc, inputVault: m.pools.bq.vaultBase, outputVault: m.pools.bq.vaultQuote, observation: m.pools.bq.observation },
    ];
  }
  return [
    { pool: m.pools.bq.pool, ammConfig: cfg.bq, inputMint: usdc, outputMint: B, inputVault: m.pools.bq.vaultQuote, outputVault: m.pools.bq.vaultBase, observation: m.pools.bq.observation },
    { pool: m.pools.ab.pool, ammConfig: cfg.ab, inputMint: B, outputMint: A, inputVault: m.pools.ab.vaultQuote, outputVault: m.pools.ab.vaultBase, observation: m.pools.ab.observation },
    { pool: m.pools.aq.pool, ammConfig: cfg.aq, inputMint: A, outputMint: usdc, inputVault: m.pools.aq.vaultBase, outputVault: m.pools.aq.vaultQuote, observation: m.pools.aq.observation },
  ];
}

/**
 * Build the 3 swap ixs for a triangle cycle. Intermediate hops use min_out=0
 * (atomic — only the net matters); the FINAL hop's min_out is set to
 * `amountIn + minProfit` so the whole bundle reverts unless it clears profit.
 */
export function buildTriangleArbIxs(args: {
  owner: PublicKey;
  market: Market;
  ammConfigs: AmmConfigs;
  reserves: TriangleReserves;
  direction: TriangleDirection;
  amountIn: bigint;
  /** minimum USDC profit (atoms) required or the bundle reverts. */
  minProfit?: bigint;
}): TransactionInstruction[] {
  const { owner, market, ammConfigs, reserves, direction, amountIn } = args;
  const legs = triangleLegs(market, ammConfigs, direction);
  const fee = market.tradeFeeBps;

  // forward-simulate to set intermediate amountIns (the on-chain amounts will
  // match because the bundle is atomic at this slot's reserves).
  const r = reserves;
  const rIn: [bigint, bigint][] =
    direction === "AQ→AB→BQ"
      ? [
          [r.aqUsdc, r.aqA],
          [r.abA, r.abB],
          [r.bqB, r.bqUsdc],
        ]
      : [
          [r.bqUsdc, r.bqB],
          [r.abB, r.abA],
          [r.aqA, r.aqUsdc],
        ];
  const a1 = amountIn;
  const o1 = getAmountOut(a1, rIn[0][0], rIn[0][1], fee);
  const o2 = getAmountOut(o1, rIn[1][0], rIn[1][1], fee);
  const finalMin = amountIn + (args.minProfit ?? 1n);

  return [
    cpSwapBaseInputIx({ owner, amountIn: a1, minOut: 0n, leg: legs[0] }),
    cpSwapBaseInputIx({ owner, amountIn: o1, minOut: 0n, leg: legs[1] }),
    cpSwapBaseInputIx({ owner, amountIn: o2, minOut: finalMin, leg: legs[2] }),
  ];
}

export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const WITHDRAW_DISC = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** CP-Swap orders accounts token_0 < token_1 (byte-smaller mint first). */
function order2(mintA: PublicKey, mintB: PublicKey): boolean {
  return Buffer.compare(mintA.toBuffer(), mintB.toBuffer()) <= 0;
}

/**
 * Direct-to-Raydium add liquidity (CP-Swap `deposit`). `lpAmount` LP to mint;
 * `maxBase`/`maxQuote` are slippage caps. The pool pulls the amounts needed at
 * the current ratio (CP-Swap deposits are balanced — a "one leg" add is a swap
 * then a balanced add). owner signs directly. Use for JIT liquidity around a
 * predictable fat swap.
 */
export function cpAddLiquidityIx(args: {
  owner: PublicKey;
  pool: PublicKey;
  lpMint: PublicKey;
  mintBase: PublicKey;
  mintQuote: PublicKey;
  lpAmount: bigint;
  maxBase: bigint;
  maxQuote: bigint;
}): TransactionInstruction {
  return lpIx(DEPOSIT_DISC, args, false);
}

/** Direct-to-Raydium remove liquidity (CP-Swap `withdraw`). `minBase`/`minQuote`
 *  are slippage floors. */
export function cpRemoveLiquidityIx(args: {
  owner: PublicKey;
  pool: PublicKey;
  lpMint: PublicKey;
  mintBase: PublicKey;
  mintQuote: PublicKey;
  lpAmount: bigint;
  minBase: bigint;
  minQuote: bigint;
}): TransactionInstruction {
  return lpIx(WITHDRAW_DISC, { ...args, maxBase: args.minBase, maxQuote: args.minQuote }, true);
}

function lpIx(
  disc: Buffer,
  a: { owner: PublicKey; pool: PublicKey; lpMint: PublicKey; mintBase: PublicKey; mintQuote: PublicKey; lpAmount: bigint; maxBase: bigint; maxQuote: bigint },
  isWithdraw: boolean,
): TransactionInstruction {
  const baseFirst = order2(a.mintBase, a.mintQuote);
  const m0 = baseFirst ? a.mintBase : a.mintQuote;
  const m1 = baseFirst ? a.mintQuote : a.mintBase;
  const lim0 = baseFirst ? a.maxBase : a.maxQuote;
  const lim1 = baseFirst ? a.maxQuote : a.maxBase;
  const ownerLp = associatedTokenAddress(a.lpMint, a.owner);
  const o0 = associatedTokenAddress(m0, a.owner);
  const o1 = associatedTokenAddress(m1, a.owner);
  const vault = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), a.pool.toBuffer(), mint.toBuffer()], CP_PROGRAM_ID)[0];
  const v0 = vault(m0), v1 = vault(m1);

  const data = Buffer.alloc(32);
  disc.copy(data, 0);
  data.writeBigUInt64LE(a.lpAmount, 8);
  data.writeBigUInt64LE(lim0, 16);
  data.writeBigUInt64LE(lim1, 24);

  const keys = [
    { pubkey: a.owner, isSigner: true, isWritable: true },
    { pubkey: CP_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: ownerLp, isSigner: false, isWritable: true },
    { pubkey: o0, isSigner: false, isWritable: true },
    { pubkey: o1, isSigner: false, isWritable: true },
    { pubkey: v0, isSigner: false, isWritable: true },
    { pubkey: v1, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: m0, isSigner: false, isWritable: false },
    { pubkey: m1, isSigner: false, isWritable: false },
    { pubkey: a.lpMint, isSigner: false, isWritable: true },
  ];
  if (isWithdraw) keys.push({ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false });
  return new TransactionInstruction({ programId: CP_PROGRAM_ID, keys, data });
}

/**
 * Build the permissionless rebalance crank (instruction tag 0). For crawl-oracle
 * markets, pass `priceCrawl` (PDA ["price_crawl", config]); standalone crawl
 * cranks read the stored aggregate. leverageBps=0 ⇒ config l_max.
 */
export function buildCrankIx(args: {
  market: Market;
  programId?: PublicKey;
  leverageBps?: bigint;
  priceCrawl?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? DEFAULT_PROGRAM_ID;
  const m = args.market;
  const authority = PublicKey.findProgramAddressSync([Buffer.from("authority")], programId)[0];
  const data = Buffer.alloc(9);
  data.writeUInt8(0, 0); // tag 0 = rebalance
  data.writeBigUInt64LE(args.leverageBps ?? 0n, 1);
  const keys = [
    { pubkey: m.config, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: m.mintA, isSigner: false, isWritable: true },
    { pubkey: m.mintB, isSigner: false, isWritable: true },
    { pubkey: m.pools.ab.vaultBase, isSigner: false, isWritable: true },
    { pubkey: m.pools.ab.vaultQuote, isSigner: false, isWritable: true },
    { pubkey: m.pools.aq.vaultBase, isSigner: false, isWritable: true },
    { pubkey: m.pools.aq.vaultQuote, isSigner: false, isWritable: false },
    { pubkey: m.pools.bq.vaultBase, isSigner: false, isWritable: true },
    { pubkey: m.pools.bq.vaultQuote, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  if (args.priceCrawl) keys.push({ pubkey: args.priceCrawl, isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId, keys, data });
}

/** PDA ["price_crawl", config] under the leverage program. */
export function priceCrawlPda(config: PublicKey, programId: PublicKey = DEFAULT_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("price_crawl"), config.toBuffer()], programId)[0];
}

/** A Jito tip: SystemProgram.transfer of `lamports` to a tip account. */
export function jitoTipIx(from: PublicKey, lamports: number | bigint, tipIndex = 0): TransactionInstruction {
  const tip = JITO_TIP_ACCOUNTS[tipIndex % JITO_TIP_ACCOUNTS.length];
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: tip, lamports });
}

/**
 * Assemble an UNSIGNED VersionedTransaction from instructions, with a fresh
 * blockhash and `payer` as fee payer. The caller signs + sends (or wraps it in a
 * Jito bundle). This SDK never signs.
 */
export async function buildUnsignedTx(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}
