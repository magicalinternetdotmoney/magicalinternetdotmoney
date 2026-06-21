#!/usr/bin/env node
// FluxBeam liquidity pools for 3xSOL + 5xBTC receipt tokens.
// Pool API: https://docs.fluxbeam.xyz/developers/pool-api.md
"use strict";

const fs = require("fs");
const { Connection, Keypair } = require("@solana/web3.js");
const {
  fluxCreatePool, sendPool, WSOL, USDC,
  receiptForQuoteUi, uiToRaw, rawToUi,
} = require("./fluxbeam.js");

const SITE_API = process.env.SITE_API || "https://magicalinternet.money/api";
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes("--" + name); }

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function tokenBalance(owner, mint) {
  const d = await fetchJson(`${SITE_API}/tokenbalance?owner=${owner}&mint=${mint}`);
  if (d.error) throw new Error(d.error);
  return { raw: BigInt(d.amount), ui: d.uiAmount, dec: d.decimals };
}

async function buildPlan(payer, onlyLabel) {
  const solUi = Number(arg("sol-each", "1.5"));
  const pairs = await fetchJson(`${SITE_API}/pairs`);
  const nav = Object.fromEntries(pairs.pairs.map((p) => [p.sym, p.nav]));

  const usdc = await tokenBalance(payer, USDC);
  const r3b = await tokenBalance(payer, "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB");
  const r5 = await tokenBalance(payer, "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG");

  const usdcHalf = usdc.raw / 2n;
  const solEach = uiToRaw(solUi, 9);
  const solUsd = solUi * Number(arg("sol-usd", "71.63"));

  const specs = [
    { label: "3xSOL / SOL", sym: "3xSOL", receiptMint: "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB", quoteMint: WSOL, quoteRaw: solEach, quoteUi: solUi, receiptNeed: receiptForQuoteUi(solUsd, nav["3xSOL"], r3b.dec) },
    { label: "3xSOL / USDC", sym: "3xSOL", receiptMint: "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB", quoteMint: USDC, quoteRaw: usdcHalf, quoteUi: rawToUi(usdcHalf, usdc.dec), receiptNeed: receiptForQuoteUi(rawToUi(usdcHalf, usdc.dec), nav["3xSOL"], r3b.dec) },
    { label: "5xBTC / SOL", sym: "5xBTC", receiptMint: "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG", quoteMint: WSOL, quoteRaw: solEach, quoteUi: solUi, receiptNeed: receiptForQuoteUi(solUsd, nav["5xBTC"], r5.dec) },
    { label: "5xBTC / USDC", sym: "5xBTC", receiptMint: "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG", quoteMint: USDC, quoteRaw: usdcHalf, quoteUi: rawToUi(usdcHalf, usdc.dec), receiptNeed: receiptForQuoteUi(rawToUi(usdcHalf, usdc.dec), nav["5xBTC"], r5.dec) },
  ];

  let left3 = r3b.raw;
  let left5 = r5.raw;
  const plan = [];
  const todo = onlyLabel ? specs.filter((s) => s.label.toLowerCase().includes(onlyLabel.toLowerCase())) : specs;
  for (const s of todo) {
    const left = s.sym === "3xSOL" ? left3 : left5;
    const use = s.receiptNeed > left ? left : s.receiptNeed;
    if (use <= 0n) continue;
    if (s.sym === "3xSOL") left3 -= use; else left5 -= use;
    plan.push({ ...s, receiptRaw: use, receiptUi: rawToUi(use, 6), capped: use < s.receiptNeed });
  }
  if (!plan.length) throw new Error("insufficient receipt balances for any pool");
  return { plan, nav, balances: { usdc: usdc.ui, r3: r3b.ui, r5: r5.ui, solUi } };
}

async function main() {
  const keyPath = arg("key", process.env.ADMIN_KEY || process.argv.find((a) => a.endsWith(".json")) || "");
  if (!keyPath) {
    console.error("usage: node fluxbeam-pools.js [--dry-run] [--sol-each 1.5] <admin-key.json>");
    process.exit(1);
  }
  const payerKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))));
  const payer = payerKp.publicKey.toBase58();
  const dry = hasFlag("dry-run");

  const only = arg("only", "");
  const { plan, nav, balances } = await buildPlan(payer, only);
  console.log("payer", payer);
  console.log("nav", nav);
  console.log("balances", balances);
  console.log("plan:");
  for (const p of plan) {
    const cap = p.capped ? " (receipt capped)" : "";
    const q = p.quoteMint === WSOL ? "SOL" : "USDC";
    console.log(`  ${p.label}${cap}: ${p.receiptUi.toFixed(6)} receipt + ${p.quoteUi.toFixed(6)} ${q}`);
  }

  const conn = new Connection(RPC, "confirmed");
  const results = [];

  const filtered = plan;
  if (!filtered.length) throw new Error(`no plan entries match --only ${only}`);

  for (const p of filtered) {
    console.log(`\n==> ${p.label}`);
    const j = await fluxCreatePool(payer, p.receiptMint, p.quoteMint, p.receiptRaw, p.quoteRaw);
    const out = await sendPool(conn, payerKp, j.transaction, j.lp_mint, j.pool, p.label, dry, {
      tokenA: j.token_a || p.receiptMint,
      tokenB: j.token_b || p.quoteMint,
    });
    console.log(`  pool ${out.pool}`);
    console.log(`  lp   ${out.lpMint}`);
    results.push({ ...p, pool: out.pool, lpMint: out.lpMint, sigs: out.sigs });
    if (!dry) await new Promise((r) => setTimeout(r, 5000));
  }

  if (results.length) {
    console.log("\n", JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});