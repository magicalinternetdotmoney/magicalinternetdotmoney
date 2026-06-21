"use strict";

function uiToRaw(ui, decimals) {
  const s = String(ui).trim();
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return 0n;
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return raw;
}

function rawToUi(raw, decimals) {
  let n = typeof raw === "bigint" ? raw : BigInt(raw);
  const neg = n < 0n;
  if (neg) n = -n;
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = n % base;
  if (frac === 0n) return (neg ? "-" : "") + whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
}

function formatUi(raw, decimals, maxFrac = 6) {
  const ui = rawToUi(raw, decimals);
  const [w, f = ""] = ui.split(".");
  if (!f) return w;
  return `${w}.${f.slice(0, maxFrac).replace(/0+$/, "") || "0"}`;
}

module.exports = { uiToRaw, rawToUi, formatUi };