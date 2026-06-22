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

import { PublicKey, TransactionInstruction, AddressLookupTableAccount, type Connection } from "@solana/web3.js";
import { rateGate } from "./limit";

export const JUP_LITE_BASE = "https://lite-api.jup.ag/swap/v1";
export const JUP_PRO_BASE = "https://api.jup.ag/swap/v1";

// Global QPS gate for ALL Jupiter calls (quote + swap-instructions). Parallel
// market scans funnel through this single lane so we never exceed the plan's
// rate limit. Default ≈ 1 req/s (Lite-safe); `setJupiterRatePerSec` widens it
// for a keyed Ultra plan.
let jupiterGate = rateGate(1100);
export function setJupiterRatePerSec(perSec: number): void {
  jupiterGate = rateGate(perSec > 0 ? Math.ceil(1000 / perSec) : 0);
}
/** await the shared Jupiter rate lane before issuing a request. */
export function jupiterThrottle(): Promise<void> {
  return jupiterGate();
}

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
  await jupiterThrottle();
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

function deserializeIx(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

export interface JupiterSwapIxs {
  computeBudget: TransactionInstruction[];
  setup: TransactionInstruction[];
  swap: TransactionInstruction;
  cleanup?: TransactionInstruction;
  /** min output the Jupiter swap guarantees (atoms) — quote.otherAmountThreshold. */
  minOut: bigint;
  /** expected output (atoms) — quote.outAmount. */
  expectedOut: bigint;
  addressLookupTableAddresses: string[];
}

/**
 * Fetch Jupiter swap instructions for a quote (from `jupiterQuote(...).raw`) so
 * the swap can be composed INTO your own atomic tx alongside a protocol swap.
 */
export async function jupiterSwapInstructions(
  quoteRaw: any,
  userPublicKey: string | PublicKey,
  opts: JupiterOpts = {},
): Promise<JupiterSwapIxs> {
  const base = opts.baseUrl || (opts.apiKey ? JUP_PRO_BASE : JUP_LITE_BASE);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  await jupiterThrottle();
  const res = await fetch(`${base}/swap-instructions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      quoteResponse: quoteRaw,
      userPublicKey: asMint(userPublicKey),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!res.ok) throw new Error(`jupiter swap-ix ${res.status} ${await res.text().catch(() => "")}`.slice(0, 180));
  const j: any = await res.json();
  if (j.error) throw new Error("jupiter swap-ix: " + j.error);
  return {
    computeBudget: (j.computeBudgetInstructions || []).map(deserializeIx),
    setup: (j.setupInstructions || []).map(deserializeIx),
    swap: deserializeIx(j.swapInstruction),
    cleanup: j.cleanupInstruction ? deserializeIx(j.cleanupInstruction) : undefined,
    minOut: BigInt(quoteRaw.otherAmountThreshold ?? quoteRaw.outAmount),
    expectedOut: BigInt(quoteRaw.outAmount),
    addressLookupTableAddresses: j.addressLookupTableAddresses || [],
  };
}

/** Load the Address Lookup Table accounts Jupiter references. */
export async function fetchAddressLookupTables(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const a of addresses) {
    const r = await connection.getAddressLookupTable(new PublicKey(a));
    if (r.value) out.push(r.value);
  }
  return out;
}
