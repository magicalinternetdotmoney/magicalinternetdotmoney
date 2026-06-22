#!/usr/bin/env node
/**
 * searchergap CLI — scan live markets for triangle gaps.
 *
 *   RPC_URL=https://... npx searchergap scan
 *   npx searchergap scan --rpc https://... --json
 */

import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { scanAll, runLoop, crankAll, runCrankLoop, previewCrankAll } from "../src/index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function expandTilde(p: string): string {
  return p.startsWith("~") ? (process.env.HOME || "") + p.slice(1) : p;
}

/** Read the Solana CLI config (~/.config/solana/cli/config.yml) for defaults. */
function solanaCliConfig(): { rpc?: string; keypair?: string } {
  try {
    const path = process.env.HOME ? `${process.env.HOME}/.config/solana/cli/config.yml` : "";
    const txt = readFileSync(path, "utf8");
    const rpc = txt.match(/^\s*json_rpc_url:\s*"?([^"\n]+?)"?\s*$/m)?.[1]?.trim();
    const keypair = txt.match(/^\s*keypair_path:\s*"?([^"\n]+?)"?\s*$/m)?.[1]?.trim();
    return { rpc, keypair };
  } catch {
    return {};
  }
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
  searchergap run   [--rpc <url>] [--keypair <path>] [--min-profit <usdc-atoms>] [--poll <ms>] [--tip <lamports>] [--jup-key <key>] [--jup-rate <req/s>] [--concurrency <n>] [--dry-run] [--no-jup] [--plain]
  searchergap crank [--rpc <url>] [--keypair <path>] [--poll <ms>] [--once] [--force] [--dry-run]

  run cycles ALL gaps (triangle + cross-venue vs Jupiter) and is LIVE by default
  — it signs with your keypair and sends. --dry-run simulates only. --no-jup
  drops the Jupiter feed. rpc + keypair fall back to your solana config
  (~/.config/solana/cli/config.yml). Jupiter Ultra key: --jup-key or $JUPITER_API_KEY
  (free at https://dev.jup.ag).

  crank fires the permissionless rebalance ix (tag 0) on every market. Default:
  sim-first (skip flat/breaker/paused). --once for cron; omit for loop. --force
  sends even when sim says no-op. --dry-run prints plan without sending.
  env: RPC_URL, KEYPAIR, CRANK_POLL_MS`);
}

function loadKeeper(cfgKeypair?: string): Keypair {
  const path = arg("keypair") || process.env.KEYPAIR || cfgKeypair;
  if (!path) throw new Error("--live needs --keypair <path>, $KEYPAIR, or a keypair_path in your solana config");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(expandTilde(path), "utf8"))));
}

async function main() {
  const cmd = process.argv[2];
  const cfg = solanaCliConfig();
  // rpc: --rpc → $RPC_URL → solana config → mainnet-beta
  const rpc = arg("rpc") || process.env.RPC_URL || cfg.rpc || "https://api.mainnet-beta.solana.com";

  if (cmd === "crank") {
    const connection = new Connection(rpc, "confirmed");
    const dryRun = process.argv.includes("--dry-run");
    const once = process.argv.includes("--once");
    const force = process.argv.includes("--force");
    const pollMs = Number(arg("poll") || process.env.CRANK_POLL_MS || 60_000);

    let keeper: Keypair;
    try { keeper = loadKeeper(cfg.keypair); }
    catch (e) {
      console.error(`crank needs --keypair, $KEYPAIR, or solana config keypair_path (${(e as Error).message})`);
      process.exit(1);
    }

    const opts = { force, onlyWhenNeeded: !force, log: console.log };

    if (dryRun) {
      const rs = await previewCrankAll(connection, opts);
      for (const r of rs) {
        console.log(JSON.stringify(r));
      }
      const wouldSend = rs.filter((r) => r.noop?.startsWith("would-fire:")).length;
      console.log(`dry-run: ${wouldSend}/${rs.length} would crank`);
      return;
    }

    console.log(`crank bot · ${keeper.publicKey.toBase58()} · ${rpc.replace(/\?.*/, "")}`);
    if (once) {
      const rs = await crankAll(connection, keeper, opts);
      const sent = rs.filter((r) => r.sent).length;
      console.log(`done: ${sent}/${rs.length} sent`);
      process.exit(sent > 0 ? 0 : 0);
      return;
    }

    console.log(`loop every ${pollMs}ms (CRANK_POLL_MS / --poll)`);
    runCrankLoop(connection, keeper, { ...opts, pollMs });
    return;
  }

  if (cmd === "run") {
    const connection = new Connection(rpc, "confirmed");
    const noJup = process.argv.includes("--no-jup");
    const jupKey = arg("jup-key") || process.env.JUPITER_API_KEY;

    // LIVE by default; fall back to dry-run if --dry-run or no keeper is available.
    let live = !process.argv.includes("--dry-run");
    let keeper: Keypair | null = null;
    if (live) {
      try { keeper = loadKeeper(cfg.keypair); }
      catch (e) { console.log(`no keypair (${(e as Error).message}) → DRY-RUN`); live = false; }
    }
    const plain = process.argv.includes("--plain");
    const useDash = !plain && process.stdout.isTTY;

    if (!useDash) {
      if (live) console.log(`⚠ LIVE — signing + sending as ${keeper!.publicKey.toBase58()}  (use --dry-run to simulate only)`);
      if (!noJup) {
        console.log(
          jupKey
            ? "cross-venue: Jupiter Ultra (keyed)"
            : "cross-venue: Jupiter Lite (free, rate-limited) — free key at https://dev.jup.ag → pass --jup-key or set $JUPITER_API_KEY (use --no-jup to disable)",
        );
      }
    }

    runLoop(connection, {
      live,
      keeper,
      dashboard: useDash,
      minProfitUsdcAtoms: BigInt(arg("min-profit") || process.env.MIN_PROFIT_USDC_ATOMS || "50000"),
      pollMs: Number(arg("poll") || process.env.POLL_MS || 4000),
      tipLamports: Number(arg("tip") || 10000),
      concurrency: Number(arg("concurrency") || process.env.SCAN_CONCURRENCY || 4),
      jupiter: noJup ? undefined : {
        enabled: true,
        apiKey: jupKey,
        ratePerSec: arg("jup-rate") ? Number(arg("jup-rate")) : undefined,
      },
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
