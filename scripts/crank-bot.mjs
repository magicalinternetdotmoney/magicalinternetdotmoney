#!/usr/bin/env node
/**
 * Cron-friendly rebalance crank bot.
 *
 *   KEYPAIR=~/levered.json RPC_URL=https://... node scripts/crank-bot.mjs
 *   node scripts/crank-bot.mjs --once          # cron: */5 * * * *
 *   node scripts/crank-bot.mjs --poll 30000    # loop every 30s
 *   node scripts/crank-bot.mjs --dry-run
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "sdk/searchergap/dist/bin/searchergap.js");
const args = ["crank", ...process.argv.slice(2)];
if (!args.includes("--once") && !args.some((a, i) => args[i - 1] === "--poll")) {
  if (!process.env.CRANK_POLL_MS) args.push("--poll", "60000");
}

const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));