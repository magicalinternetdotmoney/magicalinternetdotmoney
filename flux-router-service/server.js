// FluxBeam GPA indexer + hook-aware swap router (standalone service).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Connection } = require("@solana/web3.js");
const { FluxIndexer, WSOL } = require("./flux-indexer.js");
const fluxRouter = require("./flux-router.js");
const { uiToRaw } = require("./amounts.js");

const PORT = +(process.env.PORT || 8080);
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PUBLIC = path.join(__dirname, "public");
const conn = new Connection(RPC_URL, "confirmed");
const indexer = new FluxIndexer({ rpcUrl: RPC_URL });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function json(res, body, status = 200) {
  const s = JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
}

function parseQuery(req) {
  const u = new URL(req.url, "http://localhost");
  const q = (k, d = "") => u.searchParams.get(k) || d;
  return { path: u.pathname, q };
}

function isPk(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function parseAmountUi(q, mint, indexer, fallback = "") {
  const ui = q("amountInUi", q("amountSol", q("amount", fallback)));
  if (!ui || !/^\d+(\.\d+)?$/.test(String(ui).trim())) return null;
  const dec = indexer.decimalsFor(mint);
  const raw = uiToRaw(ui, dec);
  if (raw <= 0n) return null;
  return raw;
}

async function handleApi(req, res, p, q) {
  if (p === "/healthz") {
    return json(res, {
      ok: true,
      pools: indexer.pools.length,
      indexing: indexer.gpaBusy,
      gpaFull: indexer.gpaFull,
    });
  }

  if (p === "/api/flux/pools") {
    await indexer.ensureFresh();
    return json(res, indexer.snapshot());
  }

  if (p === "/api/flux/quote") {
    const inputMint = q("inputMint", "");
    const outputMint = q("outputMint", "");
    if (!isPk(inputMint) || !isPk(outputMint)) return json(res, { error: "bad mints" }, 400);
    await indexer.ensureFresh();
    const amountIn = parseAmountUi(q, inputMint, indexer);
    if (!amountIn) return json(res, { error: "bad amountInUi" }, 400);
    try {
      const route = fluxRouter.quoteRoute(indexer, inputMint, outputMint, amountIn);
      return route ? json(res, { ok: true, ...route }) : json(res, { ok: false, error: "no route" });
    } catch (e) {
      return json(res, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === "/api/flux/arb") {
    await indexer.ensureFresh();
    const amountIn = parseAmountUi(q, WSOL, indexer, "0.1");
    if (!amountIn) return json(res, { error: "bad amountInUi" }, 400);
    try {
      const arb = await fluxRouter.quoteSolArb(indexer, amountIn);
      if (!arb) return json(res, { ok: false, error: "no arb route" });
      const { _raw, ...pub } = arb;
      return json(res, { ok: true, ...pub });
    } catch (e) {
      return json(res, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === "/api/tx/flux/swap") {
    const owner = q("owner", "");
    const inputMint = q("inputMint", "");
    const outputMint = q("outputMint", "");
    if (!isPk(owner)) return json(res, { error: "bad owner" }, 400);
    if (!isPk(inputMint) || !isPk(outputMint)) return json(res, { error: "bad mints" }, 400);
    const slippageBps = +(q("slippageBps", "100"));
    await indexer.ensureFresh();
    const amountIn = parseAmountUi(q, inputMint, indexer);
    if (!amountIn) return json(res, { error: "bad amountInUi" }, 400);
    try {
      const out = await fluxRouter.buildSwapTx(conn, indexer, owner, inputMint, outputMint, amountIn, slippageBps);
      return json(res, out);
    } catch (e) {
      return json(res, { ok: false, error: "build failed", message: String(e.message || e) });
    }
  }

  if (p === "/api/tx/flux/arb") {
    const owner = q("owner", "");
    if (!isPk(owner)) return json(res, { error: "bad owner" }, 400);
    const slippageBps = +(q("slippageBps", "300"));
    await indexer.ensureFresh();
    const amountIn = parseAmountUi(q, WSOL, indexer, "0.1");
    if (!amountIn) return json(res, { error: "bad amountInUi" }, 400);
    try {
      const out = await fluxRouter.buildSolArbTx(conn, indexer, owner, amountIn, slippageBps);
      return json(res, out);
    } catch (e) {
      return json(res, { ok: false, error: "build failed", message: String(e.message || e) });
    }
  }

  return false;
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, idx) => {
        if (e2) {
          res.writeHead(404);
          return res.end("not found");
        }
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }
  if (req.method !== "GET") {
    res.writeHead(405);
    return res.end("method not allowed");
  }

  const { path: p, q } = parseQuery(req);
  const api = await handleApi(req, res, p, q);
  if (api !== false) return;

  const file = p === "/" ? "/index.html" : p;
  const full = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  serveStatic(res, full);
});

indexer.start();
server.listen(PORT, () => {
  console.log(`mim-flux-router on :${PORT} rpc=${RPC_URL.replace(/\?.*/, "")}`);
});