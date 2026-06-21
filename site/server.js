// Magical Internet Money — REAL indexer + static host (zero deps, Node built-ins).
//
// NO MOCK DATA. Everything served here is read from chain (Solana JSON-RPC) for the
// pairs discovered on-chain via getProgramAccounts (Config accounts owned by the
// program). sym/name/logos come from on-chain Metaplex metadata (or T22 mint metadata).
// When no configs exist yet, /api/pairs is [] — that is the honest state. This indexer:
//   - reads the 6 vault token balances + 2 synth supplies + receipt supply (getMultipleAccounts)
//   - derives nav (redeemable quote per receipt), va/vb (per-constituent quote backing),
//     and tvl from those REAL reserves
//   - accumulates a time series by polling, so /api/charts fills in as it observes
//   - normalizes to USD via the USDC-quoted pool (quote==USDC ⇒ 1:1)
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const web3 = require("@solana/web3.js");
const { getTokenMetadata, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const txbuild = require("./txbuild.js");
const fluxbeam = require("./fluxbeam.js");

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, "public");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = process.env.PROGRAM_ID || "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME_MINT = "CNBuoZWcqAvVZJCrPFF1XQXeeXJsZKj7SUKZoE6Vpump";
const MEME_POOL_CACHE = new Map(); // legMint|MEME -> pool id|null
const DATA_DIR = process.env.DATA_DIR || "";           // set to a fly volume to persist series
const POLL_MS = +(process.env.POLL_MS || 30000);
const GPA_MS = +(process.env.GPA_MS || 45000);
const web3conn = new web3.Connection(RPC_URL, "confirmed"); // for the deposit/withdraw tx builder
const { PublicKey } = web3;
const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const ZERO = "11111111111111111111111111111111";
const CONFIG_SIZE = 400; // pinocchio Config account
// pinocchio Config field offsets (see pinocchio-programs/leverage-engine/src/config.rs)
const O_USDC = 36, O_MINT_A = 68, O_MINT_B = 100, O_RECEIPT = 132;
const O_POOL_AB = 164, O_POOL_AQ = 196, O_POOL_BQ = 228, O_FEE_BPS = 348;

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const META_CACHE = new Map(); // mint -> {name,symbol,uri}|null
function metaPda(mint) {
  const m = typeof mint === "string" ? new PublicKey(mint) : mint;
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), m.toBuffer()], METAPLEX)[0];
}
function readBorshStr(buf, off) {
  if (off + 4 > buf.length) return ["", off];
  const len = buf.readUInt32LE(off); off += 4;
  const end = Math.min(off + len, buf.length);
  return [buf.subarray(off, end).toString("utf8").replace(/\0/g, "").trim(), end];
}
function parseMetaplex(buf) {
  if (!buf || buf.length < 70 || buf[0] !== 4) return null;
  let off = 65; // key(1) + update_auth(32) + mint(32)
  const [name, o1] = readBorshStr(buf, off); off = o1;
  const [symbol, o2] = readBorshStr(buf, off); off = o2;
  const [uri, o3] = readBorshStr(buf, off);
  return name || symbol ? { name, symbol, uri } : null;
}
async function fetchMintMeta(mint) {
  if (META_CACHE.has(mint)) return META_CACHE.get(mint);
  let out = null;
  try {
    const r = await rpc("getAccountInfo", [metaPda(mint).toBase58(), { encoding: "base64" }]);
    if (r && r.value) out = parseMetaplex(Buffer.from(r.value.data[0], "base64"));
  } catch (e) {}
  if (!out) {
    try {
      const t = await getTokenMetadata(web3conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
      if (t && (t.name || t.symbol)) out = { name: t.name || "", symbol: t.symbol || "", uri: t.uri || "" };
    } catch (e) {}
  }
  if (out) META_CACHE.set(mint, out);
  return out;
}
function labelsFromLegs(rec, ma) {
  const underlyingSymbol = parseUnderlyingSymbol(ma && ma.name, ma && ma.symbol);
  const levM = (ma && ma.symbol || "").match(/^\+(\d+)x/i);
  const levMax = levM ? parseInt(levM[1], 10) : 5;
  const uSym = underlyingSymbol || "asset";
  const sym = (rec && rec.symbol) || (levMax + "x" + uSym).slice(0, 10);
  const name = (rec && rec.name) || (levMax + "x " + uSym + " LP").slice(0, 32);
  return { sym, name, underlyingSymbol: uSym, levMax };
}
async function enrichPair(chain) {
  const [rec, ma, mb] = await Promise.all([
    fetchMintMeta(chain.receiptMint), fetchMintMeta(chain.mintA), fetchMintMeta(chain.mintB),
  ]);
  const labels = labelsFromLegs(rec, ma);
  const underlyingMint = resolveUnderlyingMint({ name: labels.name, sym: labels.sym, underlyingSymbol: labels.underlyingSymbol });
  const onchain = { receipt: rec, mintA: ma, mintB: mb };
  const logo = await pairLogo({ name: labels.name, sym: labels.sym, underlyingSymbol: labels.underlyingSymbol, underlyingMint, onchain });
  return Object.assign({}, chain, {
    sym: labels.sym, name: labels.name, theme: { a: "#2fe6c0", b: "#a06bff" },
    underlyingMint, underlyingSymbol: labels.underlyingSymbol, levMax: labels.levMax,
    logo, onchain,
  });
}
function parseUnderlyingSymbol(mintAName, mintASymbol) {
  if (mintAName) {
    let m = mintAName.match(/MINTA\s*[·•]\s*(.+)/i);
    if (m) return m[1].trim().replace(/\s*\(.*\)$/, "");
    m = mintAName.match(/^\+\d+x\s+(.+)/i);
    if (m) return m[1].trim();
  }
  if (mintASymbol) {
    const s = mintASymbol.match(/^\+\d+x(.+)$/i);
    if (s) return s[1].trim();
  }
  return null;
}
function cpVault(poolB58, mintB58) {
  const pool = new PublicKey(poolB58), mint = new PublicKey(mintB58);
  return PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), pool.toBuffer(), mint.toBuffer()], CP)[0].toBase58();
}
function rdPk(buf, o) { return new PublicKey(buf.subarray(o, o + 32)).toBase58(); }
function parseConfigAccount(pubkey, dataB64) {
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length < CONFIG_SIZE || buf[0] !== 1) return null;
  const usdc = rdPk(buf, O_USDC), mintA = rdPk(buf, O_MINT_A), mintB = rdPk(buf, O_MINT_B), receipt = rdPk(buf, O_RECEIPT);
  const poolAb = rdPk(buf, O_POOL_AB), poolAq = rdPk(buf, O_POOL_AQ), poolBq = rdPk(buf, O_POOL_BQ);
  if (poolAb === ZERO || poolAq === ZERO || poolBq === ZERO) return null;
  const feeBps = buf.readUInt16LE(O_FEE_BPS) || 25;
  return {
    config: pubkey, receiptMint: receipt, quoteMint: usdc, mintA, mintB, quote: "USDC", tradeFeeBps: feeBps,
    pools: {
      ab: { pool: poolAb, vaultA: cpVault(poolAb, mintA), vaultB: cpVault(poolAb, mintB) },
      aq: { pool: poolAq, vaultA: cpVault(poolAq, mintA), vaultQ: cpVault(poolAq, usdc) },
      bq: { pool: poolBq, vaultB: cpVault(poolBq, mintB), vaultQ: cpVault(poolBq, usdc) },
    },
  };
}
// map underlying symbol from on-chain MINTA name → mint for logo lookup
const SYM_TO_MINT = {
  SOL: "So11111111111111111111111111111111111111112", WSOL: "So11111111111111111111111111111111111111112",
  BTC: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", cbBTC: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
};
function resolveUnderlyingMint(p) {
  if (p.underlyingMint) return p.underlyingMint;
  const us = p.underlyingSymbol;
  if (us && SYM_TO_MINT[us]) return SYM_TO_MINT[us];
  const hay = (p.name || "") + " " + (p.sym || "") + " " + (us || "");
  for (const [sym, mint] of Object.entries(SYM_TO_MINT)) if (new RegExp("\\b" + sym + "\\b", "i").test(hay)) return mint;
  return null;
}
const UNDERLYING_CACHE = new Map();
async function jupiterTokenByMint(mint) {
  try {
    const tok = await httpsGetJson("lite-api.jup.ag", "/tokens/v1/token/" + mint);
    if (tok && tok.logoURI) return { mint, symbol: tok.symbol || null, name: tok.name || null, logo: tok.logoURI };
  } catch (e) { /* fall through */ }
  return null;
}
async function jupiterSearchSymbol(sym) {
  if (!sym) return null;
  try {
    const hits = await httpsGetJson("lite-api.jup.ag", "/tokens/v1/search?query=" + encodeURIComponent(sym));
    const want = sym.toUpperCase();
    const tok = (Array.isArray(hits) ? hits : []).find((t) => t && t.symbol && t.symbol.toUpperCase() === want)
      || (Array.isArray(hits) ? hits[0] : null);
    if (tok && tok.logoURI) return { mint: tok.id || null, symbol: tok.symbol || null, name: tok.name || null, logo: tok.logoURI };
  } catch (e) { /* fall through */ }
  return null;
}
async function dexscreenerLogoBySymbol(sym) {
  if (!sym) return null;
  try {
    const data = await httpsGetJson("api.dexscreener.com", "/latest/dex/search?q=" + encodeURIComponent(sym));
    const want = sym.toUpperCase().replace(/X$/, ""); // SPCXx → SPCX
    const pairs = (data.pairs || []).filter((p) => p && p.chainId === "solana");
    for (const p of pairs) {
      for (const tok of [p.baseToken, p.quoteToken]) {
        if (!tok || !tok.address) continue;
        const ts = (tok.symbol || "").toUpperCase();
        if (ts === sym.toUpperCase() || ts === want || ts + "X" === sym.toUpperCase()) {
          return "https://cdn.dexscreener.com/tokens/solana/" + tok.address + ".png";
        }
      }
    }
  } catch (e) { /* no dexscreener hit */ }
  return null;
}
async function underlyingInfo(mint) {
  if (!mint) return null;
  if (mint === USDC_MINT) return { mint, symbol: "USDC", name: "USD Coin", logo: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png" };
  if (UNDERLYING_CACHE.has(mint)) return UNDERLYING_CACHE.get(mint);
  let out = null;
  try {
    const info = await httpsGetJson("api-v3.raydium.io", "/mint/ids?mints=" + mint);
    const tok = (info.data || [])[0];
    if (tok) out = { mint, symbol: tok.symbol, name: tok.name, logo: tok.logoURI || null };
  } catch (e) { /* try jupiter */ }
  if (!out || !out.logo) {
    const j = await jupiterTokenByMint(mint);
    if (j) out = Object.assign({ mint, symbol: null, name: null, logo: null }, out, j);
  }
  if (!out) out = { mint, symbol: null, name: null, logo: null };
  UNDERLYING_CACHE.set(mint, out);
  return out;
}
// Receipt / pair list icon — same source wallets see via /api/meta `image`.
async function pairLogo(p) {
  const um = resolveUnderlyingMint(p);
  if (um) {
    const ui = await underlyingInfo(um);
    if (ui && ui.logo) return ui.logo;
  }
  const us = p.underlyingSymbol
    || parseUnderlyingSymbol(p.onchain && p.onchain.mintA && p.onchain.mintA.name, p.onchain && p.onchain.mintA && p.onchain.mintA.symbol)
    || (p.sym || "").replace(/^\d+x/i, "");
  if (us) {
    const j = await jupiterSearchSymbol(us);
    if (j && j.logo) return j.logo;
    const dx = await dexscreenerLogoBySymbol(us);
    if (dx) return dx;
  }
  const rec = p.onchain && p.onchain.receipt;
  if (rec && rec.uri && rec.uri.startsWith("http") && !rec.uri.includes("/api/meta")) {
    try {
      const u = new URL(rec.uri);
      const meta = await httpsGetJson(u.hostname, u.pathname + u.search);
      if (meta && meta.image) return meta.image;
    } catch (e) { /* no off-chain image */ }
  }
  return null;
}
let REGISTRY = [];
let GPA_BUSY = false, GPA_AT = 0;
async function refreshRegistryFromGpa() {
  if (GPA_BUSY) return REGISTRY;
  GPA_BUSY = true;
  try {
    META_CACHE.clear();
    const rows = await rpc("getProgramAccounts", [PROGRAM_ID, {
      encoding: "base64",
      filters: [{ dataSize: CONFIG_SIZE }],
    }]);
    const seen = new Set(), raw = [];
    for (const row of rows || []) {
      const parsed = parseConfigAccount(row.pubkey, row.account.data[0]);
      if (!parsed || seen.has(parsed.receiptMint)) continue;
      seen.add(parsed.receiptMint);
      raw.push(parsed);
    }
    REGISTRY = await Promise.all(raw.map(enrichPair));
    migrateSeriesKeys();
    GPA_AT = Date.now();
    if (REGISTRY.length) { if (!POLLING) { POLLING = true; setInterval(poll, POLL_MS); } poll(); }
  } catch (e) { /* keep last good registry on rpc failure */ }
  finally { GPA_BUSY = false; }
  return REGISTRY;
}
async function ensureRegistry() {
  if (!REGISTRY.length || Date.now() - GPA_AT > GPA_MS) await refreshRegistryFromGpa();
  return REGISTRY;
}
let POLLING = false;

// ---- Solana JSON-RPC (raw https, zero deps) ----
let rpcId = 0;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
    const u = new URL(RPC_URL);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", port: u.port || 443, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            if (j.error) return reject(new Error(j.error.message || "rpc error"));
            resolve(j.result);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("rpc timeout")));
    req.write(body);
    req.end();
  });
}
// plain HTTPS GET → JSON (used for the Raydium public API; zero-dep)
function httpsGetJson(host, pathQ) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: pathQ, method: "GET", headers: { accept: "application/json" } },
      (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// jsonParsed token-account amount (UI float). Returns null if the account isn't a token account.
function tokAmount(accInfo) {
  try {
    const info = accInfo.data.parsed.info;
    return Number(info.tokenAmount.uiAmount);
  } catch (e) { return null; }
}
function mintSupply(accInfo) {
  try {
    const info = accInfo.data.parsed.info;
    return Number(info.supply) / Math.pow(10, info.decimals);
  } catch (e) { return null; }
}

// ---- per-pair on-chain read → economics ----
// reserves of the three pools; nav/va/vb expressed in the QUOTE asset (USD-equiv when quote==USDC).
async function readPair(p) {
  const accts = [
    p.receiptMint,                               // 0 receipt supply
    p.pools.aq.vaultA, p.pools.aq.vaultQ,        // 1,2 A/quote pool reserves
    p.pools.bq.vaultB, p.pools.bq.vaultQ,        // 3,4 B/quote pool reserves
    p.pools.ab.vaultA, p.pools.ab.vaultB,        // 5,6 A/B pool reserves
  ];
  const r = await rpc("getMultipleAccounts", [accts, { encoding: "jsonParsed" }]);
  const v = r.value;
  if (!v || v.some((x) => !x)) throw new Error("missing account(s) for " + p.sym);
  const supply = mintSupply(v[0]) || 0;
  const aqA = tokAmount(v[1]) || 0, aqQ = tokAmount(v[2]) || 0;
  const bqB = tokAmount(v[3]) || 0, bqQ = tokAmount(v[4]) || 0;
  const priceA = aqA > 0 ? aqQ / aqA : 0;
  const priceB = bqB > 0 ? bqQ / bqB : 0;
  const tvl = aqQ + bqQ; // quote locked in anchor pools (USD-equiv when quote==USDC)
  // No receipts minted yet (launch seed only) — still surface pool TVL; NAV needs supply > 0.
  if (supply <= 0) {
    return { nav: null, va: null, vb: null, mint: null, redeem: null, priceA, priceB, tvl, supply: 0 };
  }
  const va = aqQ / supply;
  const vb = bqQ / supply;
  const nav = va + vb;
  const fee = (p.tradeFeeBps || 0) / 10000;
  return {
    nav, va, vb,
    mint: nav * (1 + fee / 2),
    redeem: nav * (1 - fee / 2),
    priceA, priceB, tvl, supply,
  };
}

// ---- time series (accumulated by polling; persisted if DATA_DIR set) ----
const SERIES = {}; // receiptMint -> [{t,nav,mint,redeem,va,vb,tvl}]
const SERIES_CAP = 5000;
function seriesKey(p) { return (p && p.receiptMint) || p; }
function seriesPath() { return DATA_DIR ? path.join(DATA_DIR, "series.json") : ""; }
function loadSeries() {
  const f = seriesPath();
  if (!f) return;
  try { Object.assign(SERIES, JSON.parse(fs.readFileSync(f, "utf8"))); } catch (e) {}
}
function migrateSeriesKeys() {
  for (const p of REGISTRY) {
    const legacy = SERIES[p.sym];
    if (!legacy || !legacy.length || SERIES[p.receiptMint]) continue;
    const dupes = REGISTRY.filter((x) => x.sym === p.sym);
    if (dupes.length === 1) SERIES[p.receiptMint] = legacy;
  }
}
function saveSeries() {
  const f = seriesPath();
  if (!f) return;
  try { fs.writeFileSync(f, JSON.stringify(SERIES)); } catch (e) {}
}
async function poll() {
  for (const p of REGISTRY) {
    try {
      const e = await readPair(p);
      const k = seriesKey(p);
      const arr = (SERIES[k] = SERIES[k] || []);
      arr.push({
        t: Date.now(),
        nav: e.nav != null ? +e.nav.toFixed(6) : null,
        mint: e.mint != null ? +e.mint.toFixed(6) : null,
        redeem: e.redeem != null ? +e.redeem.toFixed(6) : null,
        va: e.va != null ? +e.va.toFixed(6) : null,
        vb: e.vb != null ? +e.vb.toFixed(6) : null,
        tvl: +e.tvl.toFixed(2),
      });
      if (arr.length > SERIES_CAP) arr.splice(0, arr.length - SERIES_CAP);
    } catch (e) { /* pair not readable yet — skip, do not fabricate */ }
  }
  saveSeries();
}
const TF_WIN = { "1H": 3600e3, "1D": 24 * 3600e3, "1W": 7 * 24 * 3600e3, "1M": 30 * 24 * 3600e3, ALL: Infinity };
function seriesFor(key, tf) {
  const all = SERIES[key] || [];
  if (!all.length) return [];
  const win = TF_WIN[tf] || TF_WIN["1D"];
  const cutoff = Date.now() - win;
  const pts = win === Infinity ? all : all.filter((x) => x.t >= cutoff);
  // downsample to ≤ 60 points so the chart stays light
  if (pts.length <= 60) return pts;
  const step = Math.ceil(pts.length / 60), out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}
// APY from observed nav growth (real, not assumed). Null until enough valid nav samples + time span.
const APY_WIN_MS = 7 * 24 * 3600e3;
const APY_MIN_SPAN_MS = 6 * 3600e3;
const APY_MAX_PCT = 5000;
const APY_MIN_PCT = 0.05;
function navSamples(key) {
  return (SERIES[key] || []).filter((x) => x.nav != null && x.nav > 0 && x.t > 0);
}
function apyFor(key, sym) {
  const all = navSamples(key);
  if (all.length < 2) return null;
  const cutoff = Date.now() - APY_WIN_MS;
  let pts = all.filter((x) => x.t >= cutoff);
  if (pts.length < 2) pts = all;
  const first = pts[0], last = pts[pts.length - 1];
  const dtMs = last.t - first.t;
  if (dtMs < APY_MIN_SPAN_MS) return null;
  const dtYears = dtMs / (365 * 24 * 3600e3);
  if (dtYears <= 0) return null;
  const growth = last.nav / first.nav;
  if (!isFinite(growth) || growth <= 0) return null;
  const apy = (Math.pow(growth, 1 / dtYears) - 1) * 100;
  if (!isFinite(apy) || Math.abs(apy) > APY_MAX_PCT || Math.abs(apy) < APY_MIN_PCT) return null;
  return { sym: sym || key, quoteEquiv: "USD", total: +apy.toFixed(2), observedFrom: first.t, points: pts.length };
}
function apyNote(key) {
  const all = navSamples(key);
  if (!all.length) return "no NAV yet — seed only until receipts are minted";
  if (all.length < 2) return "need ≥2 NAV samples";
  const first = all[0], last = all[all.length - 1];
  if (last.t - first.t < APY_MIN_SPAN_MS) return "APY unlocks after ~6h of indexer polls";
  if (!apyFor(key)) return "NAV flat over window — no meaningful APY yet";
  return null;
}
function pairScore(p) {
  const s = SERIES[seriesKey(p)];
  const last = s && s.length ? s[s.length - 1] : null;
  const tvl = last && last.tvl != null ? last.tvl : -1;
  const pts = s ? s.length : 0;
  return tvl * 1e6 + pts;
}
function dedupePairsList(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = (r.sym || r.receiptMint || "").toLowerCase();
    const prev = best.get(k);
    if (!prev) { best.set(k, r); continue; }
    const score = (r) => ((r.tvl != null ? r.tvl : -1) * 1e6) + (r.nav != null ? 1 : 0);
    if (score(r) > score(prev)) best.set(k, r);
  }
  return [...best.values()];
}

// ---- payloads (GPA + on-chain metadata; never invented) ----
function regPair(key) {
  if (!key) return null;
  const byMint = REGISTRY.find((p) => p.receiptMint === key);
  if (byMint) return byMint;
  const bySym = REGISTRY.filter((p) => p.sym === key);
  if (!bySym.length) return null;
  if (bySym.length === 1) return bySym[0];
  return bySym.slice().sort((a, b) => pairScore(b) - pairScore(a))[0];
}
function regPairLookup(sym, mint) {
  if (mint) { const p = regPair(mint); if (p) return p; }
  if (sym) return regPair(sym);
  return null;
}
// Resolve which config leg a synth mint is (mint_a = long/+, mint_b = inverse/−).
function regPairBySynthMint(mint) {
  if (!mint) return null;
  return REGISTRY.find((p) => p.mintA === mint || p.mintB === mint) || null;
}
function synthLegRole(pair, mint) {
  if (!pair || !mint) return null;
  if (pair.mintA === mint) return { side: "A", leg: "long", configRole: "mint_a", sign: "+" };
  if (pair.mintB === mint) return { side: "B", leg: "inverse", configRole: "mint_b", sign: "-" };
  return null;
}
function filterPairs(rows, q) {
  if (!q) return rows;
  const s = q.toLowerCase();
  return rows.filter((p) =>
    (p.sym && p.sym.toLowerCase().includes(s)) ||
    (p.name && p.name.toLowerCase().includes(s)) ||
    (p.receiptMint && p.receiptMint.toLowerCase().includes(s))
  );
}
function sortPairs(rows, sort, order) {
  const dir = order === "asc" ? 1 : -1;
  const key = sort || "tvl";
  return rows.slice().sort((a, b) => {
    if (key === "name" || key === "sym") return dir * String(a[key] || "").localeCompare(String(b[key] || ""));
    const av = a[key] == null ? -1 : a[key], bv = b[key] == null ? -1 : b[key];
    return dir * (av - bv);
  });
}
async function pairsPayload(opts) {
  await ensureRegistry();
  const umints = [...new Set(REGISTRY.map(resolveUnderlyingMint).filter(Boolean))];
  await Promise.all(umints.map((m) => underlyingInfo(m)));
  const out = [];
  for (const p of REGISTRY) {
    let tvl = null, last = null;
    const sk = seriesKey(p);
    const s = SERIES[sk];
    if (s && s.length) { last = s[s.length - 1]; tvl = last.tvl; }
    const ap = apyFor(sk, p.sym);
    const um = resolveUnderlyingMint(p);
    const ui = um ? UNDERLYING_CACHE.get(um) : null;
    out.push({
      name: p.name, sym: p.sym, theme: p.theme, quote: p.quote, tvl,
      apr: ap ? ap.total : null, nav: last ? last.nav : null,
      receiptMint: p.receiptMint, mintA: p.mintA, mintB: p.mintB,
      underlyingMint: um, underlyingSymbol: (ui && ui.symbol) || p.underlyingSymbol || null,
      logo: p.logo || (ui && ui.logo) || null,
      underlyingLogo: p.logo || (ui && ui.logo) || null,
    });
  }
  const q = (opts && opts.q) || "", sort = (opts && opts.sort) || "tvl", order = (opts && opts.order) || "desc";
  return sortPairs(filterPairs(dedupePairsList(out), q), sort, order);
}
async function findMemePool(legMint) {
  const key = legMint + "|" + MEME_MINT;
  if (MEME_POOL_CACHE.has(key)) return MEME_POOL_CACHE.get(key);
  let out = null;
  try {
    const pools = await httpsGetJson("api-v3.raydium.io",
      "/pools/info/mint?mint1=" + legMint + "&mint2=" + MEME_MINT + "&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1");
    const ps = ((pools.data || {}).data) || [];
    const cp = ps.find((x) => x && x.programId === CP.toBase58());
    out = cp ? cp.id : null;
  } catch (e) { /* no meme pool for this leg */ }
  MEME_POOL_CACHE.set(key, out);
  return out;
}
async function memePoolsFor(p) {
  const [am, bm] = await Promise.all([findMemePool(p.mintA), findMemePool(p.mintB)]);
  let memeSym = "MEME";
  if (UNDERLYING_CACHE.has(MEME_MINT)) memeSym = UNDERLYING_CACHE.get(MEME_MINT).symbol || memeSym;
  else {
    try {
      const info = await httpsGetJson("api-v3.raydium.io", "/mint/ids?mints=" + MEME_MINT);
      const tok = (info.data || [])[0];
      if (tok) {
        UNDERLYING_CACHE.set(MEME_MINT, { mint: MEME_MINT, symbol: tok.symbol, name: tok.name, logo: tok.logoURI || null });
        memeSym = tok.symbol || memeSym;
      }
    } catch (e) {}
  }
  return { am, bm, memeSym };
}
async function contractsPayload(p) {
  if (!p) return null;
  const q = p.quote || "USDC";
  const canon = txbuild.canonicalPairMeta(p, process.env.SITE_ORIGIN || "https://magicalinternet.money");
  const [rec, ma, mb, meme] = await Promise.all([
    fetchMintMeta(p.receiptMint), fetchMintMeta(p.mintA), fetchMintMeta(p.mintB), memePoolsFor(p),
  ]);
  const recSym = (rec && rec.symbol) || p.sym || "receipt";
  const plusSym = (ma && ma.symbol) || canon.mintA.symbol;
  const minusSym = (mb && mb.symbol) || canon.mintB.symbol;
  const rows = [
    { label: "Receipt · " + recSym, tag: "Token-2022 · hook", addr: p.receiptMint, leg: "receipt", symbol: recSym, name: (rec && rec.name) || p.name },
    { label: plusSym + " · long", tag: "SPL · mint_a", addr: p.mintA, leg: "long", side: "A", configRole: "mint_a", symbol: plusSym, name: (ma && ma.name) || canon.mintA.name },
    { label: minusSym + " · inverse", tag: "SPL · mint_b", addr: p.mintB, leg: "inverse", side: "B", configRole: "mint_b", symbol: minusSym, name: (mb && mb.name) || canon.mintB.name },
    { label: "Pool · " + plusSym + " / " + minusSym, tag: "CPMM", addr: p.pools.ab.pool },
    { label: "Pool · " + plusSym + " / " + q, tag: "CPMM", addr: p.pools.aq.pool },
    { label: "Pool · " + minusSym + " / " + q, tag: "CPMM", addr: p.pools.bq.pool },
  ];
  if (meme.am) rows.push({ label: "Pool · " + plusSym + " / " + meme.memeSym, tag: "CPMM · MEME", addr: meme.am });
  if (meme.bm) rows.push({ label: "Pool · " + minusSym + " / " + meme.memeSym, tag: "CPMM · MEME", addr: meme.bm });
  return rows.filter((r) => r.addr);
}
async function metaPayload(p, side, mintOnly) {
  if (mintOnly) {
    await ensureRegistry();
    const m = await fetchMintMeta(mintOnly);
    if (!m) return null;
    const pair = regPairBySynthMint(mintOnly) || regPair(mintOnly);
    const role = pair ? synthLegRole(pair, mintOnly) : null;
    const us = parseUnderlyingSymbol(m.name, m.symbol);
    const um = resolveUnderlyingMint({ sym: m.symbol, name: m.name, underlyingSymbol: us });
    const symLeg = m.symbol && (m.symbol.startsWith("-") || m.symbol.startsWith("−")) ? "inverse" : "long";
    const leg = role ? role.leg : symLeg;
    const image = (await pairLogo({
      sym: m.symbol, name: m.name, underlyingSymbol: us, underlyingMint: um,
      onchain: pair ? pair.onchain : { mintA: m },
    })) || undefined;
    const out = {
      name: m.name, symbol: m.symbol,
      description: (m.symbol && /^[+-−]\d+x/i.test(m.symbol) ? m.symbol + " synthetic · " + leg + " leg" : m.uri) || "",
      image, mint: mintOnly, leg,
    };
    if (role) Object.assign(out, { side: role.side, configRole: role.configRole, pair: pair.sym, receiptMint: pair.receiptMint });
    else if (pair && pair.receiptMint === mintOnly) out.leg = "receipt";
    return out;
  }
  if (!p) return null;
  const image = (await pairLogo(p)) || undefined;
  const oc = p.onchain || {};
  const canon = txbuild.canonicalPairMeta(p, process.env.SITE_ORIGIN || "https://magicalinternet.money");
  if (side === "A" || side === "B") {
    const om = side === "A" ? oc.mintA : oc.mintB;
    const fb = side === "A" ? canon.mintA : canon.mintB;
    const leg = side === "A" ? "long" : "inverse";
    return {
      name: (om && om.name) || fb.name,
      symbol: (om && om.symbol) || fb.symbol,
      description: (fb.symbol || "") + " synthetic · " + leg + " leg of " + p.name,
      image, mint: side === "A" ? p.mintA : p.mintB,
      side, leg, configRole: side === "A" ? "mint_a" : "mint_b", pair: p.sym, receiptMint: p.receiptMint,
    };
  }
  const rec = oc.receipt;
  return {
    name: (rec && rec.name) || (p.name + " receipt"), symbol: (rec && rec.symbol) || p.sym,
    description: "Leveraged pair receipt for " + p.name, image, mint: p.receiptMint,
    leg: "receipt", pair: p.sym, receiptMint: p.receiptMint,
  };
}

// ---- http ----
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(body);
}

let programDeployed = false;
async function refreshStatus() {
  try { const r = await rpc("getAccountInfo", [PROGRAM_ID, { encoding: "base64" }]); programDeployed = !!(r && r.value); }
  catch (e) { /* leave as-is on transient rpc error */ }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const q = (k, d) => u.searchParams.get(k) || d;

  if (p === "/healthz") return json(res, { ok: true });

  // POST /api/rpc — same-origin JSON-RPC proxy to RPC_URL (keeps the key off the client,
  // lets the browser's web3.js Connection send the launch txs).
  if (p === "/api/rpc" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ru = new URL(RPC_URL);
      const pr = https.request({ hostname: ru.hostname, path: ru.pathname + ru.search, method: "POST", port: ru.port || 443, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (pres) => {
        let b = ""; pres.on("data", (d) => (b += d)); pres.on("end", () => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(b); });
      });
      pr.on("error", () => { res.writeHead(502); res.end('{"jsonrpc":"2.0","error":{"message":"rpc proxy error"}}'); });
      pr.setTimeout(20000, () => pr.destroy());
      pr.write(body); pr.end();
    });
    return;
  }

  // honest chain status — the frontend gates real actions on this
  if (p === "/api/status")
    return json(res, { programId: PROGRAM_ID, deployed: programDeployed, rpc: RPC_URL.replace(/\?.*/, ""), usdcMint: USDC_MINT, pairs: REGISTRY.length });
  // real wallet balances (SOL + USDC) via server-side RPC — keeps any RPC key off the client
  if (p === "/api/balance") {
    const owner = q("owner", "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) return json(res, { error: "bad owner" }, 400);
    try {
      const [sol, tok] = await Promise.all([
        rpc("getBalance", [owner]),
        rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }]),
      ]);
      let usdc = 0;
      for (const a of tok.value || []) usdc += Number(a.account.data.parsed.info.tokenAmount.uiAmount) || 0;
      return json(res, { owner, sol: (sol.value || 0) / 1e9, usdc });
    } catch (e) { return json(res, { error: "rpc", message: String(e.message || e) }, 502); }
  }
  // /api/underlying?ca=<mint> — resolve a pasted token + its Raydium pool vs USDC.
  // This is the TWAP anchor for a leg: the leg tracks this token's USDC price.
  if (p === "/api/underlying") {
    const ca = q("ca", "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return json(res, { error: "bad mint" }, 400);
    // USDC itself is the quote — a constant $1 anchor (no pool lookup; USDC/USDC has none).
    if (ca === USDC_MINT)
      return json(res, { mint: ca, symbol: "USDC", name: "USD Coin", decimals: 6, priceUsd: 1, pool: null, hasUsdcPool: true, isQuote: true });
    try {
      const [info, pools] = await Promise.all([
        httpsGetJson("api-v3.raydium.io", "/mint/ids?mints=" + ca),
        httpsGetJson("api-v3.raydium.io", "/pools/info/mint?mint1=" + ca + "&mint2=" + USDC_MINT + "&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1"),
      ]);
      const tok = (info.data || [])[0];
      if (!tok) return json(res, { error: "unknown token", ca }, 404);
      const ps = ((pools.data || {}).data) || [];
      const best = ps.find((x) => x && x.price) || null;
      let priceUsd = null, pool = null;
      if (best) {
        const usdcIsB = best.mintB && best.mintB.address === USDC_MINT;
        priceUsd = usdcIsB ? best.price : best.price ? 1 / best.price : null;
        pool = { id: best.id, type: best.type, tvl: best.tvl };
      }
      return json(res, { mint: ca, symbol: tok.symbol, name: tok.name, decimals: tok.decimals, logo: tok.logoURI, program: tok.programId, priceUsd, pool, hasUsdcPool: !!best });
    } catch (e) { return json(res, { error: "lookup failed", message: String(e.message || e) }, 502); }
  }
  // build an UNSIGNED deposit/withdraw tx for the connected wallet to sign+send.
  if (p === "/api/tx/deposit" || p === "/api/tx/withdraw") {
    await ensureRegistry();
    const sym = q("sym", ""), owner = q("owner", ""), pair = regPair(sym);
    if (!pair) return json(res, { error: "unknown pair" }, 404);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) return json(res, { error: "bad owner" }, 400);
    try {
      if (p.endsWith("deposit")) {
        const usdc = BigInt(q("usdc", "0"));
        if (usdc <= 0n) return json(res, { error: "amount required" }, 400);
        return json(res, await txbuild.buildDeposit(web3conn, { programId: PROGRAM_ID, user: owner, pair, usdcAmount: usdc }));
      } else {
        const receipt = BigInt(q("receipt", "0"));
        if (receipt <= 0n) return json(res, { error: "amount required" }, 400);
        return json(res, await txbuild.buildWithdraw(web3conn, { programId: PROGRAM_ID, user: owner, pair, receiptAmount: receipt }));
      }
    } catch (e) { return json(res, { error: "build failed", message: String(e.message || e) }, 502); }
  }
  // FluxBeam pool: LUT txs + LP/pool pre-signed pool vtx; wallet signs as payer.
  if (p === "/api/tx/fluxbeam-pool") {
    await ensureRegistry();
    const sym = q("sym", ""), owner = q("owner", ""), pair = regPair(sym);
    if (!pair) return json(res, { error: "unknown pair" }, 404);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) return json(res, { error: "bad owner" }, 400);
    const quoteMint = q("quoteMint", "");
    if (quoteMint !== fluxbeam.WSOL && quoteMint !== fluxbeam.USDC) {
      return json(res, { error: "quoteMint must be WSOL or USDC" }, 400);
    }
    const quoteUi = parseFloat(q("quoteUi", "0"));
    if (!(quoteUi > 0)) return json(res, { error: "quoteUi required" }, 400);
    try {
      let nav = null;
      const s = SERIES[seriesKey(pair)];
      if (s && s.length) nav = s[s.length - 1].nav;
      if (!nav) {
        const econ = await readPair(pair);
        nav = econ.nav;
      }
      if (!nav || nav <= 0) return json(res, { error: "nav unavailable" }, 502);
      const qDec = quoteMint === fluxbeam.WSOL ? 9 : 6;
      const quoteRaw = fluxbeam.uiToRaw(quoteUi, qDec);
      let quoteUsd = quoteUi;
      if (quoteMint === fluxbeam.WSOL) {
        const ui = await underlyingInfo(fluxbeam.WSOL);
        const px = ui && ui.priceUsd;
        if (!px) return json(res, { error: "SOL price unavailable" }, 502);
        quoteUsd = quoteUi * px;
      }
      let receiptRaw = q("receiptRaw", "") ? BigInt(q("receiptRaw", "0")) : fluxbeam.receiptForQuoteUi(quoteUsd, nav, 6);
      if (receiptRaw <= 0n) return json(res, { error: "receipt amount zero" }, 400);
      const out = await fluxbeam.buildWalletPoolTxs(
        web3conn, owner, pair.receiptMint, quoteMint, receiptRaw, quoteRaw,
      );
      return json(res, {
        sym, quoteMint, quoteUi, quoteRaw: quoteRaw.toString(), receiptRaw: receiptRaw.toString(),
        receiptUi: fluxbeam.rawToUi(receiptRaw, 6), nav, pool: out.pool, lpMint: out.lpMint,
        txs: out.txs, lut: out.lut,
      });
    } catch (e) { return json(res, { error: "build failed", message: String(e.message || e) }, 502); }
  }
  // a single token balance for an owner (used for the receipt balance in withdraw sizing)
  if (p === "/api/tokenbalance") {
    const owner = q("owner", ""), mint = q("mint", "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json(res, { error: "bad args" }, 400);
    try {
      const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
      let ui = 0, raw = "0", decimals = 0;
      for (const a of r.value || []) { const t = a.account.data.parsed.info.tokenAmount; ui += Number(t.uiAmount) || 0; raw = t.amount; decimals = t.decimals; }
      return json(res, { owner, mint, uiAmount: ui, amount: raw, decimals });
    } catch (e) { return json(res, { error: "rpc", message: String(e.message || e) }, 502); }
  }
  if (p === "/api/pairs") return json(res, { pairs: await pairsPayload({ q: q("q", ""), sort: q("sort", "tvl"), order: q("order", "desc") }) });
  if (p === "/api/charts") {
    await ensureRegistry();
    const key = q("receipt", "") || q("sym", "");
    const pair = regPair(key);
    if (!pair) return json(res, { error: "unknown pair", points: [] }, 404);
    return json(res, { sym: pair.sym, receiptMint: pair.receiptMint, tf: q("tf", "1D"), points: seriesFor(seriesKey(pair), q("tf", "1D")) });
  }
  if (p === "/api/apy") {
    await ensureRegistry();
    const key = q("receipt", "") || q("sym", "");
    const pair = regPair(key);
    if (!pair) return json(res, { error: "unknown pair" }, 404);
    const sk = seriesKey(pair);
    const a = apyFor(sk, pair.sym);
    return a ? json(res, a) : json(res, { sym: pair.sym, receiptMint: pair.receiptMint, quoteEquiv: "USD", total: null, note: apyNote(sk), navSamples: navSamples(sk).length });
  }
  if (p === "/api/contracts") {
    await ensureRegistry();
    const c = await contractsPayload(regPair(q("sym", ""))); return c ? json(res, { contracts: c }) : json(res, { error: "unknown pair" }, 404);
  }
  if (p === "/api/meta") {
    const mintOnly = q("mint", "");
    if (mintOnly && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintOnly)) {
      const sideQ = q("side", "");
      if (sideQ === "A" || sideQ === "B") {
        await ensureRegistry();
        const pair = regPairBySynthMint(mintOnly);
        const role = pair ? synthLegRole(pair, mintOnly) : null;
        if (role && role.side !== sideQ) {
          return json(res, {
            error: "side mismatch",
            hint: "mint " + mintOnly.slice(0, 8) + "… is config " + role.configRole + " (" + role.leg + "); use side=" + role.side,
            expectedSide: role.side, leg: role.leg, configRole: role.configRole,
          }, 409);
        }
      }
      const pair = regPair(mintOnly) || regPairBySynthMint(mintOnly);
      if (pair) {
        const role = synthLegRole(pair, mintOnly);
        const sideUse = (sideQ === "A" || sideQ === "B") ? sideQ : (role ? role.side : (pair.receiptMint === mintOnly ? "" : ""));
        const fromReg = await metaPayload(pair, sideUse, null);
        if (fromReg) return json(res, fromReg);
      }
      const m = await metaPayload(null, sideQ, mintOnly);
      return m ? json(res, m) : json(res, { error: "no on-chain metadata" }, 404);
    }
    await ensureRegistry();
    const m = await metaPayload(regPairLookup(q("sym", ""), q("receipt", "")), q("side", "")); return m ? json(res, m) : json(res, { error: "unknown pair" }, 404);
  }
  // build unsigned backfill txs for on-chain Metaplex metadata (pair admin signs; TAG 13).
  if (p === "/api/tx/backfill-metadata") {
    await ensureRegistry();
    const owner = q("owner", ""), receipt = q("receipt", ""), sym = q("sym", "");
    const pair = regPair(receipt || sym);
    if (!pair) return json(res, { error: "unknown pair" }, 404);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) return json(res, { error: "bad owner" }, 400);
    // allow override labels when on-chain metadata not set yet (pre-backfill)
    if (q("name", "")) pair.name = q("name", "");
    if (sym) pair.sym = sym;
    if (q("underlying", "")) pair.underlyingSymbol = q("underlying", "");
    const um = resolveUnderlyingMint(pair);
    if (um) { const ui = await underlyingInfo(um); if (ui && !pair.underlyingSymbol) pair.underlyingSymbol = ui.symbol; }
    const origin = process.env.SITE_ORIGIN || ("https://" + (req.headers.host || "localhost"));
    try {
      return json(res, await txbuild.buildBackfillMetadata(web3conn, { programId: PROGRAM_ID, user: owner, pair, siteOrigin: origin }));
    } catch (e) { return json(res, { error: "build failed", message: String(e.message || e) }, 502); }
  }

  // static (SPA fallback to index.html)
  let file = p === "/" ? "/index.html" : p;
  let full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(full, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

loadSeries();
refreshStatus();
setInterval(refreshStatus, 60000);
refreshRegistryFromGpa().then(() => {
  if (REGISTRY.length) { POLLING = true; poll(); setInterval(poll, POLL_MS); }
});
setInterval(refreshRegistryFromGpa, GPA_MS);
server.listen(PORT, () => console.log("magic internet money indexer on :" + PORT + " — rpc=" + RPC_URL.replace(/\?.*/, "") + " program=" + PROGRAM_ID + " deployed=? pairs=gpa"));
