#!/usr/bin/env node
/**
 * Verify README + /api/status claims against mainnet (Helius RPC).
 * Usage: RPC_URL='https://mainnet.helius-rpc.com/?api-key=...' node scripts/verify-mainnet-claims.mjs
 */
import https from "https";

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";
const EXPECT_PD = "F1QCWDHFBMr1BsL7CTdetpxTbQXkzwDkQVUmy3EvknE5";
const EXPECT_UA = "CnkHq3wRSsegjpJJvvRWb1uiCJvPMAYW6b7P1Yq8FpCT";
const CP_SWAP = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const SITE = process.env.SITE_ORIGIN || "https://magicalinternet.money";

const SAMPLE_TXS = {
  deposit3xSOL: "3j1nCrnG15M9ZvnDWaVQMLRtnyhqhizSG1xkLnW4ShkqhqZQebLUttwEsgDhR3rUC4fmb7iJPa4jpBYWCiQQCq5X",
  deposit5xBTC: "4df5jUNBeEoBU4fMHcJktjWx4BE7LF1qnMXsQC8MoLRhKj6SGxQUVMVc1GX38NiLQuJLMJWJbJTREjeZpebGwUSs",
  depositLEV: "3mDnbYNMhVko2evpnfm2Cu8SvcqfGEGKtUeZcQ3R1Zod5jE9DGCyeWMT1xm1RGGmWd9jgAPth9C8ZeA5yL4ZNUiG",
  withdraw: "jXfNVqUNBSY9e5XZ6v3PKDr7qujGcfsFmU7Xd2kjPXCVmRXtamLtYa6adPccrKYT41LwBEwqRLUj8KtCkciK6kM",
  initConfig: "N5RhLJYiZKHew3GRc3SgzgTQXsSer1BacEX7Tz68iMGEVMbzMJ9o4G7Wiegx8JLoFM7zVHhUmScGsrV885pAFm6",
  registerTriangle: "4VR9HkYA73Y7hckoriVYkpffrCagAe92s2qBSRKayrJAiMt5BBvUAxTExRjzWaSyuoNXEVBav2JH4CTBJHLquXZF",
  initHook: "5J8kViDMZKJkJ79Y4uwnj2tMiih5WbiTy3r6AmV59Lqx3t5Q63q85H24tzk7ZfDR7F1Lv2gKhyUUAynAnKKDmUnr",
  transferHookExecute: "48Vj2Afb9rgRP941smC5QMjeMKk7KwMjLcVDQefYpaYiDZKE87m5m8g597zQxF4MHwCvvwVebg9y8NbHEbJGRt3Y",
  transferHookRebalance3xSOL: "Ggs5oQaXJLxy41F9z3asMtEvfrwzCyDBv1TizGxUfUgbXXLr2gNn7BkxYqHPiKDqtrmA655gWESh6g2458CMe5w",
  raydiumLpMintActivity: "3Lb58HxGBkwE8QwxZkkw1GsKs6CLBBHbXqH34VhEShz3CLKY2nVdJ4t3gBRhMTUAX2z8yrkGh8BxBG9hgwNNupJ4",
};

let rpcId = 0;
function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  const u = new URL(RPC);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            if (j.error) reject(new Error(j.error.message));
            else resolve(j.result);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

function b58(buf) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    out = alphabet[r] + out;
  }
  for (const b of buf) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

function txHasProgram(tx, prog) {
  const msg = tx?.transaction?.message;
  if (!msg) return false;
  const keys = (msg.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const idx = keys.indexOf(prog);
  if (idx < 0) return false;
  const top = msg.instructions || [];
  if (top.some((ix) => ix.programIdIndex === idx || keys[ix.programIdIndex] === prog)) return true;
  const meta = tx.meta;
  const inner = meta?.innerInstructions || [];
  for (const grp of inner) {
    for (const ix of grp.instructions || []) {
      if (keys[ix.programIdIndex] === prog) return true;
    }
  }
  return false;
}

function txLogHits(tx, needles) {
  const logs = tx?.meta?.logMessages || [];
  const hay = logs.join("\n");
  return needles.map((n) => ({ needle: n, hit: hay.includes(n) }));
}

async function getTx(sig) {
  return rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

const results = [];
function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log((pass ? "✅" : "❌") + " " + name + (detail ? " — " + detail : ""));
}

async function main() {
  console.log("RPC:", RPC.replace(/\?.*$/, ""));
  console.log("Site:", SITE);
  console.log("");

  // Program + upgrade authority
  const progAi = await rpc("getAccountInfo", [PROGRAM, { encoding: "base64" }]);
  ok("program deployed", !!progAi?.value);
  ok("program executable", !!progAi?.value?.executable, progAi?.value?.owner);
  const buf = Buffer.from(progAi.value.data[0], "base64");
  const pd = b58(buf.subarray(4, 36));
  ok("programData matches", pd === EXPECT_PD, pd);
  const pdAi = await rpc("getAccountInfo", [pd, { encoding: "base64" }]);
  const pdb = Buffer.from(pdAi.value.data[0], "base64");
  const ua = b58(pdb.subarray(13, 45));
  ok("upgradeAuthority matches", ua === EXPECT_UA, ua);

  // Config count
  const [r400, r432] = await Promise.all([
    rpc("getProgramAccounts", [PROGRAM, { encoding: "base64", filters: [{ dataSize: 400 }] }]),
    rpc("getProgramAccounts", [PROGRAM, { encoding: "base64", filters: [{ dataSize: 432 }] }]),
  ]);
  const totalConfigs = (r400?.length || 0) + (r432?.length || 0);
  ok("5 config accounts on-chain", totalConfigs === 5, `400:${r400?.length} 432:${r432?.length}`);

  // Site APIs
  let status, pairs;
  try {
    status = await fetchJson(SITE + "/api/status");
    pairs = await fetchJson(SITE + "/api/pairs");
    const pairList = pairs.pairs || pairs;
    ok("site /api/status deployed", status.deployed === true);
    ok("site pairs count", status.pairs === 5, `pairs=${status.pairs}`);
    ok("site /api/pairs returns all configs", Array.isArray(pairList) && pairList.length === 5, `len=${pairList?.length}`);
    const spcxx = (pairList || []).filter((p) => (p.sym || "").toLowerCase() === "10xspcxx");
    ok("both 10xSPCXx pairs listed", spcxx.length === 2, spcxx.map((p) => p.symDisplay || p.receiptMint?.slice(0, 8)).join(", "));
    const withNav = (pairList || []).filter((p) => p.nav != null);
    ok("pairs with receipt supply (nav)", withNav.length >= 2, `nav pairs: ${withNav.map((p) => p.sym).join(", ")}`);
    ok("site has sampleTransactions", !!status.sampleTransactions?.deposit3xSOL, status.sampleTransactions ? "present" : "MISSING — deploy pending");
    ok("transferHookObservedOnMainnet true", status.transferHookObservedOnMainnet === true);
    ok("rebalanceObservedOnMainnet false (tag 0 only)", status.rebalanceObservedOnMainnet === false);
  } catch (e) {
    ok("site APIs reachable", false, String(e.message));
  }

  // Sample txs
  for (const [kind, sig] of Object.entries(SAMPLE_TXS)) {
    try {
      const tx = await getTx(sig);
      ok(`tx exists: ${kind}`, !!tx, sig.slice(0, 12) + "…");
      if (!tx) continue;
      const err = tx.meta?.err;
      ok(`tx succeeded: ${kind}`, !err, err ? JSON.stringify(err) : "ok");
      if (kind.startsWith("deposit") || kind === "withdraw") {
        const hasProg = txHasProgram(tx, PROGRAM);
        const hasCp = txHasProgram(tx, CP_SWAP);
        ok(`${kind} invokes program`, hasProg);
        ok(`${kind} CP-Swap CPI`, hasCp, hasCp ? "Raydium vault CPI" : "check logs");
        const logHits = txLogHits(tx, ["Deposit", "Withdraw", "Instruction: Deposit", "Instruction: Withdraw"]);
        if (!hasCp) ok(`${kind} deposit/withdraw in logs`, logHits.some((h) => h.hit), logHits.filter((h) => h.hit).map((h) => h.needle).join(", "));
      }
      if (kind === "initHook") {
        ok("initHook invokes program", txHasProgram(tx, PROGRAM));
      }
      if (kind === "transferHookExecute" || kind === "transferHookRebalance3xSOL") {
        const logs = (tx.meta?.logMessages || []).join("\n");
        ok(`transfer hook: ${kind}`, /TransferChecked/.test(logs) && logs.includes(PROGRAM));
      }
    } catch (e) {
      ok(`tx fetch: ${kind}`, false, e.message);
    }
  }

  // Scan program txs for rebalance tag 0 (first 300 signatures)
  const sigs = await rpc("getSignaturesForAddress", [PROGRAM, { limit: 300 }]);
  let rebalanceHits = 0;
  for (const s of sigs.slice(0, 50)) {
    try {
      const tx = await getTx(s.signature);
      const dataIx = tx?.transaction?.message?.instructions?.find((ix) => {
        const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
        return keys[ix.programIdIndex] === PROGRAM;
      });
      if (dataIx?.data) {
        const tag = Buffer.from(dataIx.data, "base64")[0];
        if (tag === 0) rebalanceHits++;
      }
    } catch (_) {}
  }
  ok("rebalance tag 0 not in recent 50 prog txs", rebalanceHits === 0, `hits=${rebalanceHits} (sampled 50/${sigs.length})`);

  console.log("\n--- summary ---");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`${passed}/${results.length} passed`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log("  -", f.name, f.detail);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});