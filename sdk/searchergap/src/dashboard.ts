/**
 * In-place terminal dashboard for the searcher loop.
 * Uses ANSI escapes only — no extra deps. Falls back to plain logs when not a TTY.
 */

import type { Connection } from "@solana/web3.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface WinRecord {
  at: Date;
  market: string;
  direction: string;
  txid?: string;
  /** realized USDC delta (atoms); null until confirmed on-chain */
  usdcAtoms: bigint | null;
  feeLamports: number;
}

export interface DashboardMeta {
  live: boolean;
  keeper?: string;
  minProfitUsdc: number;
  pollMs: number;
  jupiter?: string;
  markets?: number;
}

export interface DashboardSink {
  plain(msg: string): void;
  setMeta(meta: DashboardMeta): void;
  scanStart(markets: number, tick: number): void;
  setMarket(id: string, tvlUsd: number, triangle: string): void;
  setProbe(label: string, detail: string): void;
  clearProbe(): void;
  noteSkip(label: string, reason: string): void;
  recordSend(market: string, direction: string, txid?: string): void;
  setError(msg: string): void;
  flush(): void;
  stop(): void;
}

function fmtUsdc(atoms: bigint): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").slice(0, 4);
  return `${neg ? "-" : "+"}$${whole.toLocaleString()}.${frac}`;
}

function fmtSol(lamports: number): string {
  const neg = lamports < 0;
  const a = Math.abs(lamports);
  return `${neg ? "-" : "+"}${(a / 1e9).toFixed(6)} SOL`;
}

function shortPk(pk?: string): string {
  if (!pk) return "—";
  return pk.slice(0, 4) + "…" + pk.slice(-4);
}

function shortSig(sig?: string): string {
  if (!sig) return "—";
  return sig.slice(0, 8) + "…" + sig.slice(-6);
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ── color (256-color ANSI; honor NO_COLOR) ──────────────────────────────────
const NO_COLOR = !!process.env.NO_COLOR;
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m",
  green: "\x1b[38;5;42m", red: "\x1b[38;5;203m", cyan: "\x1b[38;5;44m",
  yellow: "\x1b[38;5;221m", gray: "\x1b[38;5;245m", mag: "\x1b[38;5;177m",
  blue: "\x1b[38;5;75m", border: "\x1b[38;5;239m",
};
function paint(s: string, ...codes: string[]): string {
  return NO_COLOR ? s : codes.join("") + s + C.reset;
}
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number { return s.replace(ANSI_RE, "").length; }
/** pad to visible width n, ignoring ANSI escapes. */
function padV(s: string, n: number): string {
  const len = visLen(s);
  return len >= n ? s : s + " ".repeat(n - len);
}
/** unicode sparkline of recent magnitudes. */
function sparkline(vals: number[]): string {
  if (!vals.length) return "";
  const ticks = "▁▂▃▄▅▆▇█";
  const max = Math.max(...vals.map((v) => Math.abs(v)), 1e-9);
  return vals.map((v) => ticks[Math.min(7, Math.floor((Math.abs(v) / max) * 7.999))]).join("");
}

/** Poll getTransaction until indexed or retries exhausted. */
export async function fetchTxUsdcDelta(
  connection: Connection,
  sig: string,
  owner: string,
  retries = 8,
  delayMs = 400,
): Promise<{ usdcAtoms: bigint; feeLamports: number } | null> {
  for (let i = 0; i < retries; i++) {
    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx?.meta) {
      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      const idx = (arr: typeof pre) => {
        const row = arr.find((b) => b.owner === owner && b.mint === USDC_MINT);
        return row ? BigInt(row.uiTokenAmount.amount) : 0n;
      };
      return { usdcAtoms: idx(post) - idx(pre), feeLamports: tx.meta.fee ?? 0 };
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

class PlainSink implements DashboardSink {
  private sessionUsdc = 0n;
  private sessionFees = 0;
  private sent = 0;
  private confirmed = 0;
  constructor(private connection: Connection | null = null, private owner: string | null = null) {}
  plain(msg: string): void { console.log(msg); }
  setMeta(_: DashboardMeta): void {}
  scanStart(n: number, tick: number): void { this.plain(`— scan tick ${tick} · ${n} markets —`); }
  setMarket(id: string, tvl: number, tri: string): void { this.plain(`· ${id}  tvl≈$${tvl.toFixed(0)}  triangle:${tri}`); }
  setProbe(label: string, detail: string): void { this.plain(`  ${label}: ${detail}`); }
  clearProbe(): void {}
  noteSkip(label: string, reason: string): void { this.plain(`  ${label}: ${reason}`); }
  recordSend(market: string, dir: string, txid?: string): void {
    this.sent++;
    this.plain(`  ✓ ${dir} · ${market.slice(0, 8)} → ${txid ?? "dry-run"}`);
    // realized net-PnL: read the actual on-chain USDC delta from the confirmed tx.
    if (txid && this.connection && this.owner) {
      fetchTxUsdcDelta(this.connection, txid, this.owner).then((d) => {
        if (!d) { this.plain(`    net PnL: (tx ${txid.slice(0, 8)}… not yet indexed)`); return; }
        this.sessionUsdc += d.usdcAtoms;
        this.sessionFees += d.feeLamports;
        this.confirmed++;
        this.plain(
          `    net PnL: ${fmtUsdc(d.usdcAtoms)} USDC  fee ${fmtSol(-d.feeLamports)}` +
          `  ·  session ${fmtUsdc(this.sessionUsdc)} USDC over ${this.confirmed} fills (fees ${fmtSol(-this.sessionFees)})`,
        );
      }).catch(() => {});
    }
  }
  setError(msg: string): void { console.error(msg); }
  flush(): void {}
  stop(): void {
    if (this.sent > 0) {
      this.plain(
        `searchergap session · realized ${fmtUsdc(this.sessionUsdc)} USDC · ${this.confirmed}/${this.sent} fills · fees ${fmtSol(-this.sessionFees)}`,
      );
    }
  }
}

class TtyDashboard implements DashboardSink {
  private meta: DashboardMeta = { live: false, minProfitUsdc: 0.05, pollMs: 4000 };
  private tick = 0;
  private markets = 0;
  private marketLine = "";
  private probe = "";
  private probeDetail = "";
  private lastErr = "";
  private wins: WinRecord[] = [];
  private pnlHistory: number[] = [];
  private sessionUsdc = 0n;
  private sessionFees = 0;
  private sent = 0;
  private confirmed = 0;
  private skipped = 0;
  private started = Date.now();
  private altOn = false;
  private width = 72;

  constructor(private connection: Connection | null, private owner: string | null) {
    if (process.stdout.isTTY) {
      this.width = Math.min(88, Math.max(60, process.stdout.columns || 72));
      process.stdout.write("\x1b[?25l"); // hide cursor
      this.altOn = true;
      process.stdout.write("\x1b[?1049h"); // alt screen
    }
    const restore = () => this.stop();
    process.once("SIGINT", restore);
    process.once("SIGTERM", restore);
    process.once("exit", () => { if (this.altOn) process.stdout.write("\x1b[?1049l\x1b[?25h"); });
  }

  plain(msg: string): void {
    // don't scroll in TTY mode — fold into error line briefly
    this.lastErr = clip(msg, this.width - 4);
    this.flush();
  }

  setMeta(meta: DashboardMeta): void {
    this.meta = meta;
    this.flush();
  }

  scanStart(markets: number, tick: number): void {
    this.tick = tick;
    this.markets = markets;
    this.marketLine = "";
    this.probe = "";
    this.probeDetail = "";
    this.flush();
  }

  setMarket(id: string, tvl: number, tri: string): void {
    this.marketLine = `${id}  tvl $${tvl.toFixed(0)}  ·  ${tri}`;
    this.flush();
  }

  setProbe(label: string, detail: string): void {
    this.probe = label;
    this.probeDetail = detail;
    this.flush();
  }

  clearProbe(): void {
    this.probe = "";
    this.probeDetail = "";
    this.flush();
  }

  noteSkip(_label: string, _reason: string): void {
    this.skipped++;
    this.probe = "";
    this.probeDetail = "";
    this.flush();
  }

  recordSend(market: string, direction: string, txid?: string): void {
    const rec: WinRecord = { at: new Date(), market, direction, txid, usdcAtoms: null, feeLamports: 0 };
    this.wins.unshift(rec);
    if (this.wins.length > 12) this.wins.length = 12;
    this.sent++;
    this.probe = "";
    this.probeDetail = "";
    this.flush();

    if (txid && this.connection && this.owner) {
      fetchTxUsdcDelta(this.connection, txid, this.owner).then((d) => {
        if (!d) return;
        rec.usdcAtoms = d.usdcAtoms;
        rec.feeLamports = d.feeLamports;
        this.sessionUsdc += d.usdcAtoms;
        this.sessionFees += d.feeLamports;
        this.pnlHistory.push(Number(d.usdcAtoms) / 1e6);
        if (this.pnlHistory.length > 32) this.pnlHistory.shift();
        this.confirmed++;
        this.flush();
      }).catch(() => {});
    }
  }

  setError(msg: string): void {
    this.lastErr = clip(msg, this.width - 4);
    this.flush();
  }

  private uptime(): string {
    const s = Math.floor((Date.now() - this.started) / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h${m % 60}m`;
    if (m > 0) return `${m}m${s % 60}s`;
    return `${s}s`;
  }

  flush(): void {
    if (!process.stdout.isTTY) return;
    const w = this.width;
    const inner = w - 2; // visible cells between the two border glyphs
    const bar = (l: string, r: string, fill = "─") => paint(l + fill.repeat(inner) + r, C.border);
    const side = paint("│", C.border);
    const lines: string[] = [];
    const row = (content: string) => lines.push(`${side}${padV(content, inner)}${side}`);
    const blank = () => row("");
    const heading = (t: string) => row(" " + paint(t, C.dim, C.bold));

    // ── header ────────────────────────────────────────────────────────────
    const dot = this.meta.live ? paint("●", C.green) : paint("○", C.yellow);
    const modeTxt = paint(this.meta.live ? "LIVE" : "DRY-RUN", this.meta.live ? C.green : C.yellow, C.bold);
    const brand = paint("searchergap", C.bold, C.mag);
    const right = paint(`${this.meta.jupiter ?? "off"}  ${shortPk(this.meta.keeper)}`, C.gray);
    const headLeft = ` ${brand}   ${dot} ${modeTxt}`;
    row(padV(headLeft, inner - visLen(right) - 1) + right + " ");
    row(" " + paint(`up ${this.uptime()} · tick ${this.tick} · poll ${this.meta.pollMs}ms · min $${this.meta.minProfitUsdc} · ${this.markets} mkts`, C.dim));

    // ── hero: realized PnL ────────────────────────────────────────────────
    lines.push(bar("├", "┤"));
    const pos = this.sessionUsdc >= 0n;
    const accent = pos ? C.green : C.red;
    const arrow = paint(pos ? "▲" : "▼", accent);
    const big = paint(`${fmtUsdc(this.sessionUsdc)}`, accent, C.bold);
    const spark = paint(sparkline(this.pnlHistory), accent);
    blank();
    heading("REALIZED PnL");
    row(`   ${big} ${paint("USDC", C.gray)} ${arrow}    ${spark}`);
    row("   " + paint(`${this.confirmed}/${this.sent} confirmed  ·  fees ${fmtSol(-this.sessionFees)}`, C.gray));
    blank();

    // ── last fill ─────────────────────────────────────────────────────────
    const last = this.wins[0];
    lines.push(bar("├", "┤"));
    heading("LAST FILL");
    if (last) {
      const lp = last.usdcAtoms != null
        ? paint(fmtUsdc(last.usdcAtoms), last.usdcAtoms >= 0n ? C.green : C.red, C.bold)
        : paint("confirming…", C.yellow, C.italic);
      row(`   ${paint(clip(last.direction, 18), C.cyan)}  ${paint(last.market.slice(0, 8), C.gray)}  ${lp}`);
      if (last.txid) row("   " + paint(shortSig(last.txid), C.dim));
    } else {
      row("   " + paint("(waiting for first fill)", C.dim, C.italic));
    }

    // ── scan ──────────────────────────────────────────────────────────────
    lines.push(bar("├", "┤"));
    heading("SCAN");
    row("   " + paint(`${this.markets} markets · ${this.skipped} skips`, C.gray) + "  " + paint(clip(this.marketLine || "…", w - 24), C.blue));
    if (this.probe) row("   " + paint("◆ ", C.yellow) + paint(this.probe, C.yellow) + "  " + paint(clip(this.probeDetail, w - 22), C.dim));
    if (this.lastErr) row("   " + paint(`⚠ ${this.lastErr}`, C.red));

    // ── recent fills ──────────────────────────────────────────────────────
    lines.push(bar("├", "┤"));
    heading("RECENT FILLS");
    const tail = this.wins.slice(0, 6);
    if (!tail.length) {
      row("   " + paint("(none yet)", C.dim, C.italic));
    } else {
      for (const win of tail) {
        const t = win.at.toISOString().slice(11, 19);
        const known = win.usdcAtoms != null;
        const sign = known ? (win.usdcAtoms! >= 0n ? C.green : C.red) : C.dim;
        const mark = paint(known ? "●" : "○", sign);
        const p = padV(known ? paint(fmtUsdc(win.usdcAtoms!), sign) : paint("…", C.dim), 11);
        row(`   ${mark} ${p}  ${paint(clip(win.direction, 14), C.cyan)}  ${paint(win.market.slice(0, 8), C.gray)}  ${paint(t, C.dim)}`);
      }
    }

    // ── frame ─────────────────────────────────────────────────────────────
    lines.unshift(bar("╭", "╮"));
    lines.push(bar("╰", "╯"));
    lines.push("");
    lines.push(" " + paint("ctrl+c", C.bold) + paint(" to quit", C.dim));

    process.stdout.write("\x1b[H\x1b[2J");
    process.stdout.write(lines.join("\n"));
  }

  stop(): void {
    if (!this.altOn) return;
    this.altOn = false;
    process.stdout.write("\x1b[?1049l\x1b[?25h");
    // summary on exit to main screen
    const pos = this.sessionUsdc >= 0n;
    console.log(
      `${paint("searchergap", C.bold, C.mag)} session  ·  ` +
      `${paint(fmtUsdc(this.sessionUsdc) + " USDC", pos ? C.green : C.red, C.bold)}  ·  ` +
      `${this.confirmed} fills  ·  ${paint(`fees ${fmtSol(-this.sessionFees)}`, C.gray)}`,
    );
  }
}

/** Create the right sink: TTY dashboard unless plain mode or non-TTY. */
export function createDashboard(args: {
  plain?: boolean;
  connection?: Connection | null;
  owner?: string | null;
}): DashboardSink {
  if (args.plain || !process.stdout.isTTY) return new PlainSink(args.connection ?? null, args.owner ?? null);
  return new TtyDashboard(args.connection ?? null, args.owner ?? null);
}