/**
 * Jupiter as the external price feed — the "fair" side of the cross-venue gap.
 *
 * Jupiter's best-route quote for `leg → USDC` is the leg's real market price
 * across every venue it can reach. Compared to a single protocol pool, the
 * difference IS the cross-venue arb (and after a crank dislocates the protocol
 * pool, the gap vs Jupiter is exactly what `externalGap` sizes).
 *
 * Lite (free, rate-limited) by default; pass an API key from https://dev.jup.ag
 * for Ultra (higher limits). Uses global fetch (Node 18+).
 */

import { PublicKey } from "@solana/web3.js";

export const JUP_LITE_BASE = "https://lite-api.jup.ag/swap/v1";
export const JUP_PRO_BASE = "https://api.jup.ag/swap/v1";

export interface JupiterOpts {
  /** dev.jup.ag key → uses the Ultra (keyed) host. omit for free Lite. */
  apiKey?: string;
  /** override the base url if Jupiter moves the path. */
  baseUrl?: string;
  slippageBps?: number;
}

export interface JupiterQuote {
  inAmount: bigint;
  outAmount: bigint;
  /** out/in (atoms per atom). */
  price: number;
  raw: unknown;
}

function asMint(m: string | PublicKey): string {
  return typeof m === "string" ? m : m.toBase58();
}

/** Raw Jupiter quote for `amount` atoms of inputMint → outputMint. */
export async function jupiterQuote(
  inputMint: string | PublicKey,
  outputMint: string | PublicKey,
  amount: bigint,
  opts: JupiterOpts = {},
): Promise<JupiterQuote> {
  const base = opts.baseUrl || (opts.apiKey ? JUP_PRO_BASE : JUP_LITE_BASE);
  const url =
    `${base}/quote?inputMint=${asMint(inputMint)}&outputMint=${asMint(outputMint)}` +
    `&amount=${amount.toString()}&slippageBps=${opts.slippageBps ?? 50}&restrictIntermediateTokens=true`;
  const headers: Record<string, string> = opts.apiKey ? { "x-api-key": opts.apiKey } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jupiter ${res.status} ${body}`.slice(0, 160));
  }
  const j: any = await res.json();
  if (!j || j.outAmount == null) throw new Error("jupiter: no route");
  const inAmount = BigInt(j.inAmount);
  const outAmount = BigInt(j.outAmount);
  return { inAmount, outAmount, price: inAmount === 0n ? 0 : Number(outAmount) / Number(inAmount), raw: j };
}

/**
 * Best-route price of `mint` in USDC: USDC-atoms per mint-atom — the same units
 * `externalGap` / `pegGap` expect as `fairPrice`. Probe with a realistic size
 * (a slice of the pool) so the quote reflects executable, not dust, pricing.
 */
export async function jupiterFairVsUsdc(
  mint: string | PublicKey,
  usdcMint: string | PublicKey,
  probeAtoms: bigint,
  opts: JupiterOpts = {},
): Promise<number> {
  if (probeAtoms <= 0n) return 0;
  const q = await jupiterQuote(mint, usdcMint, probeAtoms, opts);
  return q.price;
}
