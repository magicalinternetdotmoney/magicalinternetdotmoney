#!/usr/bin/env node
/**
 * searchergap CLI — scan live markets for triangle gaps.
 *
 *   RPC_URL=https://... npx searchergap scan
 *   npx searchergap scan --rpc https://... --json
 */

import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { scanAll, runLoop } from "../src/index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmtUsdc(atoms: bigint): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").slice(0, 4);
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${frac}`;
}

function usage() {
  console.log(`usage:
  searchergap scan  [--rpc <url>] [--json]
  searchergap run   [--rpc <url>] [--live] [--keypair <path>] [--min-profit <usdc-atoms>] [--poll <ms>] [--tip <lamports>]

  run is DRY-RUN by default (scan + build + simulate, never sends).
  --live signs with --keypair (or $KEYPAIR) and sends. You run that; the SDK only signs when you ask.
  env: RPC_URL, KEYPAIR, MIN_PROFIT_USDC_ATOMS, POLL_MS`);
}

function loadKeeper(): Keypair {
  const path = arg("keypair") || process.env.KEYPAIR;
  if (!path) throw new Error("--live needs --keypair <path> or $KEYPAIR");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path.replace(/^~/, process.env.HOME || "~"), "utf8"))));
}

async function main() {
  const cmd = process.argv[2];
  const rpc = arg("rpc") || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

  if (cmd === "run") {
    const live = process.argv.includes("--live");
    const connection = new Connection(rpc, "confirmed");
    runLoop(connection, {
      live,
      keeper: live ? loadKeeper() : null,
      minProfitUsdcAtoms: BigInt(arg("min-profit") || process.env.MIN_PROFIT_USDC_ATOMS || "50000"),
      pollMs: Number(arg("poll") || process.env.POLL_MS || 4000),
      tipLamports: Number(arg("tip") || 10000),
    });
    return; // runLoop keeps the process alive via setInterval
  }

  if (cmd !== "scan") {
    usage();
    process.exit(cmd ? 1 : 0);
  }
  const json = process.argv.includes("--json");
  const connection = new Connection(rpc, "confirmed");

  const scans = await scanAll(connection);
  if (json) {
    const safe = scans.map((s) => ({
      config: s.market.config.toBase58(),
      receiptMint: s.market.receiptMint.toBase58(),
      priceA: s.implied ? Number(s.implied.priceAWad) / 1e9 : null,
      priceB: s.implied ? Number(s.implied.priceBWad) / 1e9 : null,
      triangle: {
        direction: s.triangle.direction,
        inputUsdc: s.triangle.inputUsdc.toString(),
        profitUsdc: s.triangle.profitUsdc.toString(),
        profitBps: s.triangle.profitBps,
        deviationBps: s.triangle.deviationBps,
      },
    }));
    console.log(JSON.stringify(safe, null, 2));
    return;
  }

  console.log(`searchergap · ${scans.length} markets · ${rpc.replace(/\?.*/, "")}\n`);
  for (const s of scans) {
    const t = s.triangle;
    const pa = s.implied ? (Number(s.implied.priceAWad) / 1e9).toFixed(6) : "—";
    const pb = s.implied ? (Number(s.implied.priceBWad) / 1e9).toFixed(6) : "—";
    console.log(`■ ${s.market.config.toBase58()}`);
    console.log(`  priceA=${pa}  priceB=${pb}  fee=${s.market.tradeFeeBps}bps`);
    if (t.direction) {
      console.log(
        `  TRIANGLE GAP  ${t.direction}  in=${fmtUsdc(t.inputUsdc)} → profit=${fmtUsdc(t.profitUsdc)} (${t.profitBps}bps)  dev=${t.deviationBps.toFixed(1)}bps`,
      );
    } else {
      console.log(`  triangle coherent (no profitable cycle)  dev=${t.deviationBps.toFixed(1)}bps`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("searchergap error:", e.message || e);
  process.exit(1);
});
