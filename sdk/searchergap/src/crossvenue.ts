/**
 * Atomic cross-venue arb bundle: a Jupiter swap + a protocol CP-Swap in ONE
 * unsigned transaction, profit-guarded. Turns the `XVENUE … sell …bps vs
 * Jupiter` signal into a sendable bundle.
 *
 * SELL case (protocol leg is RICH vs Jupiter — what the scanner flags most):
 *   Jupiter buys USDC→leg, then the protocol SELLS leg→USDC with the protocol
 *   swap LAST and its `min_out = amountInUsdc + minProfit`. So the whole tx
 *   REVERTS unless it nets profit — no inventory, no bad fill. This is the
 *   clean, hard-guarded direction.
 *
 * The SDK builds + returns the unsigned VersionedTransaction. You sign + send
 * (ideally as a Jito bundle). The SDK never signs.
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { cpSwapBaseInputIx, jitoTipIx, loadAmmConfig, buildCrankIx, priceCrawlPda, type SwapLeg } from "./executor";
import { jupiterQuote, jupiterSwapInstructions, fetchAddressLookupTables, jupiterFairVsUsdc, type JupiterOpts } from "./jupiter";
import { readTriangle, readConfig, type Market } from "./markets";
import { simulateCrank, applyCrankToReserves, externalGap } from "./gap";
import { getAmountOut } from "./cpswap";
import { Side } from "./leverage-math";

export interface CrossVenueArb {
  /** unsigned, ALT-compressed. sign + send (Jito bundle recommended). */
  tx: VersionedTransaction;
  side: "sell";
  leg: "A" | "B";
  /** USDC spent on the Jupiter buy (atoms). */
  amountInUsdc: bigint;
  /** leg Jupiter guarantees to deliver (atoms) — the protocol sell's input. */
  jupiterMinLeg: bigint;
  /** protocol sell's min USDC out (atoms) = amountInUsdc + minProfit. The guard. */
  protocolMinOutUsdc: bigint;
}

/**
 * Build the SELL-side cross-venue bundle: Jupiter buys `amountInUsdc` of the leg,
 * the protocol sells the guaranteed leg amount back to USDC with a profit guard.
 */
export async function buildCrossVenueArb(args: {
  connection: Connection;
  owner: PublicKey;
  market: Market;
  leg: "A" | "B";
  /** USDC to route through Jupiter into the leg (atoms). */
  amountInUsdc: bigint;
  /** required net USDC profit or the tx reverts (atoms). */
  minProfitUsdc: bigint;
  jupiter?: JupiterOpts;
  tipLamports?: number;
}): Promise<CrossVenueArb> {
  const { connection, owner, market: m, leg, amountInUsdc, minProfitUsdc } = args;
  const legMint = leg === "A" ? m.mintA : m.mintB;
  const pool = leg === "A" ? m.pools.aq : m.pools.bq; // the leg/USDC pool
  const ammConfig = await loadAmmConfig(connection, pool.pool);

  // 1. Jupiter: USDC → leg, and its composable instructions.
  const quote = await jupiterQuote(m.quoteMint, legMint, amountInUsdc, args.jupiter);
  const jup = await jupiterSwapInstructions(quote.raw, owner, args.jupiter);

  // 2. Protocol: SELL the guaranteed leg amount → USDC, profit-guarded + LAST.
  const protocolMinOutUsdc = amountInUsdc + minProfitUsdc;
  const sellLeg: SwapLeg = {
    pool: pool.pool,
    ammConfig,
    inputMint: legMint,
    outputMint: m.quoteMint,
    inputVault: pool.vaultBase,
    outputVault: pool.vaultQuote,
    observation: pool.observation,
  };
  const protocolSell = cpSwapBaseInputIx({
    owner,
    amountIn: jup.minOut, // exactly what Jupiter guarantees to deliver
    minOut: protocolMinOutUsdc,
    leg: sellLeg,
  });

  // 3. Assemble: jup compute-budget + setup + swap → protocol sell → cleanup → tip.
  const ixs: TransactionInstruction[] = [
    ...jup.computeBudget,
    ...jup.setup,
    jup.swap,
    protocolSell,
    ...(jup.cleanup ? [jup.cleanup] : []),
    jitoTipIx(owner, args.tipLamports ?? 10_000),
  ];

  const lookupTables = await fetchAddressLookupTables(connection, jup.addressLookupTableAddresses);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(lookupTables);

  return {
    tx: new VersionedTransaction(msg),
    side: "sell",
    leg,
    amountInUsdc,
    jupiterMinLeg: jup.minOut,
    protocolMinOutUsdc,
  };
}

export interface CrankArbBundle {
  /** null = a bundle was built; otherwise why there's nothing to do. */
  noop: "flat" | "breaker" | "same-slot" | "no-market" | "paused" | "no-edge" | "jup-threshold" | null;
  tx?: VersionedTransaction;
  loser?: "A" | "B";
  /** USDC routed into the protocol buy (atoms). */
  amountInUsdc?: bigint;
  /** Jupiter's guaranteed USDC out on the sell — the profit guard (atoms). */
  jupiterMinOutUsdc?: bigint;
  estProfitUsdc?: bigint;
}

/**
 * The deterministic manufacture-and-capture bundle:
 *   [crank]  → donates the loser, making it cheaper IN-PROTOCOL (a known amount)
 *   [protocol buy] → buy the now-cheap loser with USDC
 *   [jupiter sell] → sell it back to USDC at the market price (Jupiter's min_out
 *                    enforces ≥ amountIn + minProfit, so the whole tx reverts if
 *                    the math was wrong)
 *
 * Sized against the POST-crank reserves you compute (not a guess) using the REAL
 * on-chain `last_ratio`. One atomic, profit-guarded Jito-ready tx. Unsigned —
 * you sign + send.
 */
export async function buildCrankArbBundle(args: {
  connection: Connection;
  owner: PublicKey;
  market: Market;
  minProfitUsdc: bigint;
  /** crank leverage (0 ⇒ config l_max). */
  userLeverageBps?: bigint;
  jupiter?: JupiterOpts;
  tipLamports?: number;
}): Promise<CrankArbBundle> {
  const { connection, owner, market: m, minProfitUsdc } = args;
  const [reserves, cfg] = await Promise.all([readTriangle(connection, m), readConfig(connection, m)]);
  if (cfg.paused) return { noop: "paused" };

  // 1. deterministic crank plan from REAL on-chain state.
  const sim = simulateCrank({
    reserves,
    lastRatioWad: cfg.lastRatioWad,
    lMinBps: cfg.lMinBps, lMaxBps: cfg.lMaxBps, maxMintBps: cfg.maxMintBps, breakerBps: cfg.breakerBps,
    userLeverageBps: args.userLeverageBps ?? 0n,
  });
  if (sim.noop || !sim.plan) return { noop: (sim.noop as any) ?? "flat" };

  const loser: "A" | "B" = sim.plan.side === Side.A ? "A" : "B";
  const post = applyCrankToReserves(reserves, sim.plan);
  const legMint = loser === "A" ? m.mintA : m.mintB;
  const pool = loser === "A" ? m.pools.aq : m.pools.bq;
  const postTokenRes = loser === "A" ? post.aqA : post.bqB;
  const postUsdcRes = loser === "A" ? post.aqUsdc : post.bqUsdc;

  // 2. Jupiter price of the loser, and the post-crank buy-side gap.
  const probe = (postTokenRes > 100n ? postTokenRes / 100n : postTokenRes) || 1n;
  const fair = await jupiterFairVsUsdc(legMint, m.quoteMint, probe, args.jupiter);
  const ext = externalGap(post, loser === "A" ? { fairPriceA: fair } : { fairPriceB: fair }, m.tradeFeeBps);
  const arbLeg = loser === "A" ? ext.legA : ext.legB;
  if (!arbLeg || arbLeg.action !== "buy" || arbLeg.profitUsdc < minProfitUsdc) return { noop: "no-edge" };

  const amountInUsdc = arbLeg.optimalIn;

  // 3. protocol buy USDC→loser on the post-crank pool; min_out = expected − slip.
  const expLoser = getAmountOut(amountInUsdc, postUsdcRes, postTokenRes, m.tradeFeeBps);
  const minLoser = (expLoser * 995n) / 1000n;
  if (minLoser <= 0n) return { noop: "no-edge" };
  const ammConfig = await loadAmmConfig(connection, pool.pool);
  const buyLeg: SwapLeg = {
    pool: pool.pool, ammConfig, inputMint: m.quoteMint, outputMint: legMint,
    inputVault: pool.vaultQuote, outputVault: pool.vaultBase, observation: pool.observation,
  };
  const protocolBuy = cpSwapBaseInputIx({ owner, amountIn: amountInUsdc, minOut: minLoser, leg: buyLeg });

  // 4. Jupiter sells the guaranteed loser amount → USDC; its min_out is the guard.
  const quote = await jupiterQuote(legMint, m.quoteMint, minLoser, args.jupiter);
  const jup = await jupiterSwapInstructions(quote.raw, owner, args.jupiter);
  if (jup.minOut < amountInUsdc + minProfitUsdc) return { noop: "jup-threshold" };

  // 5. fuse: compute-budget, crank, jup setup, protocol buy, jup swap, cleanup, tip.
  const crank = buildCrankIx({ market: m, leverageBps: args.userLeverageBps ?? 0n, priceCrawl: priceCrawlPda(m.config) });
  const ixs: TransactionInstruction[] = [
    ...jup.computeBudget,
    crank,
    ...jup.setup,
    protocolBuy,
    jup.swap,
    ...(jup.cleanup ? [jup.cleanup] : []),
    jitoTipIx(owner, args.tipLamports ?? 10_000),
  ];
  const lookupTables = await fetchAddressLookupTables(connection, jup.addressLookupTableAddresses);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookupTables);

  return {
    noop: null,
    tx: new VersionedTransaction(msg),
    loser,
    amountInUsdc,
    jupiterMinOutUsdc: jup.minOut,
    estProfitUsdc: jup.minOut - amountInUsdc,
  };
}
