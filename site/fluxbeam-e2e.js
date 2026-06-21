#!/usr/bin/env node
// E2E: deposit USDC → mint receipts → create 4 FluxBeam pools (LUT + direct 3-signer).
// Target sizing (defaults): ~$175 receipt/pool ($350/pair), $100 USDC/pool, ~$100 SOL/pool.
"use strict";

const fs = require("fs");
const {
  Connection, Keypair, PublicKey, VersionedTransaction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  fluxCreatePool, sendPool, WSOL, USDC,
  receiptForQuoteUi, uiToRaw, rawToUi,
} = require("./fluxbeam.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const SITE_API = process.env.SITE_API || "https://magicalinternet.money/api";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function fetchJson(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.message || j.error || `${url} → ${r.status}`);
  return j;
}

async function tokenBalance(owner, mint) {
  const d = await fetchJson(`${SITE_API}/tokenbalance?owner=${owner}&mint=${mint}`);
  return { raw: BigInt(d.amount), ui: d.uiAmount, dec: d.decimals };
}

async function sendTx(conn, payerKp, b64, label) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  tx.sign([payerKp]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "processed" });
  if (sim.value.err) {
    const tail = sim.value.logs ? sim.value.logs.slice(-10).join("\n") : "";
    throw new Error(`${label} sim: ${JSON.stringify(sim.value.err)}${tail ? "\n" + tail : ""}`);
  }
  const skip = process.env.SKIP_PREFLIGHT !== "0";
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: skip, preflightCommitment: "processed" });
  } catch (e) {
    throw new Error(`${label} send: ${e.message}${e.logs ? "\n" + e.logs.join("\n") : ""}`);
  }
  for (let i = 0; i < 45; i++) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(`${label}: ${JSON.stringify(v.err)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") {
      console.log(`  ✓ ${label}: ${sig}`);
      return sig;
    }
    await sleep(2000);
  }
  throw new Error(`${label} not confirmed: ${sig}`);
}

async function deposit(conn, payerKp, sym, usdcRaw) {
  const owner = payerKp.publicKey.toBase58();
  const d = await fetchJson(`${SITE_API}/tx/deposit?sym=${encodeURIComponent(sym)}&owner=${owner}&usdc=${usdcRaw.toString()}`);
  if (!d.tx) throw new Error(`deposit build failed for ${sym}`);
  return sendTx(conn, payerKp, d.tx, `deposit ${sym} (${rawToUi(usdcRaw, 6)} USDC)`);
}

function allocateReceipts(specs, balances) {
  let left3 = balances.r3.raw;
  let left5 = balances.r5.raw;
  const plan = [];
  for (const s of specs) {
    const left = s.sym === "3xSOL" ? left3 : left5;
    const use = s.receiptNeed > left ? left : s.receiptNeed;
    if (use <= 0n) {
      console.warn(`  skip ${s.label}: need ${s.receiptNeed} raw, have ${left}`);
      continue;
    }
    if (s.sym === "3xSOL") left3 -= use;
    else left5 -= use;
    plan.push({ ...s, receiptRaw: use, receiptUi: rawToUi(use, 6), capped: use < s.receiptNeed });
  }
  return plan;
}

function buildSpecs(nav, balances, solEach, usdcEachRaw) {
  const solRaw = uiToRaw(solEach, 9);
  const solUsd = solEach * Number(arg("sol-usd", "72"));
  const usdcEachUi = rawToUi(usdcEachRaw, 6);
  return [
    { label: "3xSOL / SOL", sym: "3xSOL", receiptMint: "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB", quoteMint: WSOL, quoteRaw: solRaw, quoteUi: solEach, receiptNeed: receiptForQuoteUi(solUsd, nav["3xSOL"], balances.r3.dec) },
    { label: "3xSOL / USDC", sym: "3xSOL", receiptMint: "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB", quoteMint: USDC, quoteRaw: usdcEachRaw, quoteUi: usdcEachUi, receiptNeed: receiptForQuoteUi(usdcEachUi, nav["3xSOL"], balances.r3.dec) },
    { label: "5xBTC / SOL", sym: "5xBTC", receiptMint: "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG", quoteMint: WSOL, quoteRaw: solRaw, quoteUi: solEach, receiptNeed: receiptForQuoteUi(solUsd, nav["5xBTC"], balances.r5.dec) },
    { label: "5xBTC / USDC", sym: "5xBTC", receiptMint: "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG", quoteMint: USDC, quoteRaw: usdcEachRaw, quoteUi: usdcEachUi, receiptNeed: receiptForQuoteUi(usdcEachUi, nav["5xBTC"], balances.r5.dec) },
  ];
}

async function loadBalances(payer) {
  const r3 = await tokenBalance(payer, "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB");
  const r5 = await tokenBalance(payer, "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG");
  const usdc = await tokenBalance(payer, USDC);
  return { r3, r5, usdc };
}

async function buildPlan(payer, nav, receiptUsdPerPool, solEach, usdcEach) {
  const balances = await loadBalances(payer);
  const specs = buildSpecs(nav, balances, solEach, uiToRaw(usdcEach, 6));
  const plan = allocateReceipts(specs, balances);
  return { plan, balances: { r3: balances.r3.ui, r5: balances.r5.ui, usdc: balances.usdc.ui } };
}

/** Split available SOL (2 pools) + USDC (2 pools); receipts capped to wallet balance. */
async function buildMaxPlan(conn, payer, nav) {
  const solReserve = Number(arg("sol-reserve", "0.4"));
  const lamports = await conn.getBalance(new PublicKey(payer));
  const solUi = lamports / 1e9;
  const solEach = Math.floor(((Math.max(0, solUi - solReserve) / 2) * 1e9)) / 1e9;
  if (solEach <= 0) throw new Error(`insufficient SOL (${solUi} − ${solReserve} reserve)`);

  const balances = await loadBalances(payer);
  const usdcEachRaw = balances.usdc.raw / 2n;
  if (usdcEachRaw <= 0n) throw new Error("insufficient USDC");

  const specs = buildSpecs(nav, balances, solEach, usdcEachRaw);
  const plan = allocateReceipts(specs, balances);
  return {
    plan,
    balances: { sol: solUi, usdc: balances.usdc.ui, r3: balances.r3.ui, r5: balances.r5.ui },
    sizing: { solEach, usdcEach: rawToUi(usdcEachRaw, 6), solReserve },
  };
}

async function main() {
  const keyPath = arg("key", process.env.ADMIN_KEY || process.argv.find((a) => a.endsWith(".json")) || "");
  if (!keyPath) {
    console.error("usage: node fluxbeam-e2e.js [--receipt-usd 175] [--sol-each 1.39] [--usdc-each 100] [--deposit-3x 300] [--deposit-5x 200] <key.json>");
    process.exit(1);
  }

  const useMax = process.argv.includes("--max");
  const receiptUsdPerPool = Number(arg("receipt-usd", "200"));
  const solEach = Number(arg("sol-each", String(200 / Number(arg("sol-usd", "72")))));
  const usdcEach = Number(arg("usdc-each", "200"));
  const deposit3x = Number(arg("deposit-3x", "300"));
  const deposit5x = Number(arg("deposit-5x", "200"));
  const skipDeposit = process.argv.includes("--skip-deposit") || useMax;

  const payerKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))));
  const payer = payerKp.publicKey.toBase58();
  const conn = new Connection(RPC, "confirmed");

  const pairs = await fetchJson(`${SITE_API}/pairs`);
  const nav = Object.fromEntries(pairs.pairs.map((p) => [p.sym, p.nav]));

  console.log("=== FluxBeam E2E ===");
  console.log("payer", payer);
  console.log("nav", nav);
  if (useMax) console.log("mode: MAX — split SOL/USDC across 4 pools");
  else console.log("target per pool:", receiptUsdPerPool, "USD receipt ·", solEach, "SOL ·", usdcEach, "USDC");
  console.log("preflight", process.env.SKIP_PREFLIGHT === "1" ? "OFF" : "ON");

  if (!skipDeposit) {
    console.log("\n--- deposits ---");
    await deposit(conn, payerKp, "3xSOL", uiToRaw(deposit3x, 6));
    await sleep(3000);
    await deposit(conn, payerKp, "5xBTC", uiToRaw(deposit5x, 6));
    await sleep(3000);
  }

  const built = useMax
    ? await buildMaxPlan(conn, payer, nav)
    : { ...(await buildPlan(payer, nav, receiptUsdPerPool, solEach, usdcEach)), sizing: { solEach, usdcEach } };
  const { plan, balances, sizing } = built;
  console.log("\n--- balances ---", balances);
  if (useMax) console.log("sizing:", sizing);
  for (const p of plan) {
    const q = p.quoteMint === WSOL ? "SOL" : "USDC";
    console.log(`  ${p.label}${p.capped ? " (CAPPED)" : ""}: ${p.receiptUi.toFixed(4)} receipt + ${p.quoteUi} ${q}`);
  }
  if (!plan.length) throw new Error("no pools — deposit more receipt tokens");

  const results = [];
  console.log("\n--- pools ---");
  for (const p of plan) {
    console.log(`\n==> ${p.label}`);
    const j = await fluxCreatePool(payer, p.receiptMint, p.quoteMint, p.receiptRaw, p.quoteRaw);
    const out = await sendPool(conn, payerKp, j.transaction, j.lp_mint, j.pool, p.label, false, {
      tokenA: j.token_a || p.receiptMint,
      tokenB: j.token_b || p.quoteMint,
    });
    console.log(`  pool ${out.pool}`);
    console.log(`  lp   ${out.lpMint}`);
    results.push({ ...p, pool: out.pool, lpMint: out.lpMint, sigs: out.sigs });
    await sleep(4000);
  }

  console.log("\n=== DONE ===");
  console.log(JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});