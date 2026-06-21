// FluxBeam pool indexer — background GPA (getProgramAccounts) + reserve enrichment.
"use strict";

const { Connection, PublicKey } = require("@solana/web3.js");
const { AccountLayout, getMint, getTransferHook, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");

const FLUX_PROGRAM_ID = new PublicKey("FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X");
const POOL_SIZE = 324;
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Receipt mints we prefer routing through (transfer-hook pools). */
const THOOK_MINTS = new Set([
  "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB",
  "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG",
]);

const O = {
  VERSION: 0,
  INIT: 1,
  BUMP: 2,
  POOL_TOKEN_PROG: 3,
  VAULT_A: 35,
  VAULT_B: 67,
  LP_MINT: 99,
  MINT_A: 131,
  MINT_B: 163,
  FEE: 195,
  TRADE_NUM: 227,
  TRADE_DEN: 235,
  OWNER_TRADE_NUM: 243,
  OWNER_TRADE_DEN: 251,
  OWNER_WD_NUM: 259,
  OWNER_WD_DEN: 267,
  HOST_NUM: 275,
  HOST_DEN: 283,
};

function rdPk(buf, off) {
  return new PublicKey(buf.subarray(off, off + 32));
}

function rdU64(buf, off) {
  return buf.readBigUInt64LE(off);
}

function parsePoolPubkey(pubkey, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length !== POOL_SIZE || buf[O.INIT] !== 1) return null;
  const mintA = rdPk(buf, O.MINT_A).toBase58();
  const mintB = rdPk(buf, O.MINT_B).toBase58();
  const hookA = THOOK_MINTS.has(mintA);
  const hookB = THOOK_MINTS.has(mintB);
  return {
    pool: pubkey,
    authority: PublicKey.findProgramAddressSync([new PublicKey(pubkey).toBuffer()], FLUX_PROGRAM_ID)[0].toBase58(),
    vaultA: rdPk(buf, O.VAULT_A).toBase58(),
    vaultB: rdPk(buf, O.VAULT_B).toBase58(),
    lpMint: rdPk(buf, O.LP_MINT).toBase58(),
    mintA,
    mintB,
    feeAccount: rdPk(buf, O.FEE).toBase58(),
    poolTokenProgram: rdPk(buf, O.POOL_TOKEN_PROG).toBase58(),
    tradeFeeNumerator: rdU64(buf, O.TRADE_NUM),
    tradeFeeDenominator: rdU64(buf, O.TRADE_DEN),
    ownerTradeFeeNumerator: rdU64(buf, O.OWNER_TRADE_NUM),
    ownerTradeFeeDenominator: rdU64(buf, O.OWNER_TRADE_DEN),
    hostFeeNumerator: rdU64(buf, O.HOST_NUM),
    hostFeeDenominator: rdU64(buf, O.HOST_DEN),
    thook: hookA || hookB,
    thookMint: hookA ? mintA : hookB ? mintB : null,
  };
}

function tokRaw(acc) {
  try {
    const t = acc.data.parsed.info.tokenAmount;
    return { raw: BigInt(t.amount), ui: Number(t.uiAmount), decimals: t.decimals };
  } catch {
    return null;
  }
}

class FluxIndexer {
  constructor(opts = {}) {
    this.rpcUrl = opts.rpcUrl || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    this.gpaMs = +(opts.gpaMs || process.env.FLUX_GPA_MS || 60000);
    this.reserveMs = +(opts.reserveMs || process.env.FLUX_RESERVE_MS || 30000);
    this.dataDir = opts.dataDir || process.env.DATA_DIR || "";
    this.conn = new Connection(this.rpcUrl, "confirmed");
    this.pools = [];
    this.byPair = new Map();
    this.hookMints = new Map();
    this.gpaBusy = false;
    this.gpaAt = 0;
    this.reserveAt = 0;
    this._hookScan = new Set();
  }

  poolKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  async _scanHookMint(mint) {
    if (this._hookScan.has(mint)) return;
    this._hookScan.add(mint);
    try {
      const pk = new PublicKey(mint);
      let info;
      try {
        info = await getMint(this.conn, pk, "confirmed", TOKEN_2022_PROGRAM_ID);
      } catch {
        return;
      }
      const hook = getTransferHook(info);
      if (hook && hook.programId) {
        this.hookMints.set(mint, { programId: hook.programId.toBase58(), authority: hook.authority?.toBase58?.() || null });
      }
    } catch { /* skip */ }
  }

  async refreshGpa() {
    if (this.gpaBusy) return this.pools;
    this.gpaBusy = true;
    try {
      const rows = await this.conn.getProgramAccounts(FLUX_PROGRAM_ID, {
        commitment: "confirmed",
        filters: [{ dataSize: POOL_SIZE }],
      });
      const parsed = [];
      for (const row of rows) {
        const p = parsePoolPubkey(row.pubkey.toBase58(), row.account.data);
        if (!p) continue;
        p.reserveA = 0n;
        p.reserveB = 0n;
        p.decimalsA = 0;
        p.decimalsB = 0;
        parsed.push(p);
      }
      this.pools = parsed;
      this.byPair = new Map();
      for (const p of parsed) {
        const k = this.poolKey(p.mintA, p.mintB);
        const arr = this.byPair.get(k) || [];
        arr.push(p);
        this.byPair.set(k, arr);
        if (p.thook || THOOK_MINTS.has(p.mintA)) await this._scanHookMint(p.mintA);
        if (p.thook || THOOK_MINTS.has(p.mintB)) await this._scanHookMint(p.mintB);
      }
      for (const arr of this.byPair.values()) {
        arr.sort((a, b) => {
          if (a.thook !== b.thook) return a.thook ? -1 : 1;
          const la = a.reserveA + a.reserveB;
          const lb = b.reserveA + b.reserveB;
          return lb > la ? 1 : lb < la ? -1 : 0;
        });
      }
      this.gpaAt = Date.now();
      await this.refreshReserves();
    } catch (e) {
      console.error("[flux-indexer] gpa failed:", e.message || e);
    } finally {
      this.gpaBusy = false;
    }
    return this.pools;
  }

  async refreshReserves() {
    if (!this.pools.length) return;
    const vaults = [];
    for (const p of this.pools) vaults.push(p.vaultA, p.vaultB);
    const CHUNK = 90;
    const vaultMap = new Map();
    for (let i = 0; i < vaults.length; i += CHUNK) {
      const chunk = vaults.slice(i, i + CHUNK);
      const r = await this.conn.getMultipleAccountsInfo(chunk.map((v) => new PublicKey(v)), "confirmed");
      for (let j = 0; j < chunk.length; j++) {
        if (!r[j]) continue;
        try {
          vaultMap.set(chunk[j], AccountLayout.decode(r[j].data).amount);
        } catch { /* skip */ }
      }
    }
    const mints = [...new Set(this.pools.flatMap((p) => [p.mintA, p.mintB]))];
    const decMap = new Map();
    for (let i = 0; i < mints.length; i += CHUNK) {
      const chunk = mints.slice(i, i + CHUNK);
      const infos = await this.conn.getMultipleParsedAccounts(chunk.map((m) => new PublicKey(m)));
      for (let j = 0; j < chunk.length; j++) {
        const v = infos.value[j];
        if (!v) continue;
        try {
          decMap.set(chunk[j], v.data.parsed.info.decimals);
        } catch { /* skip */ }
      }
    }
    for (const p of this.pools) {
      p.reserveA = vaultMap.get(p.vaultA) || 0n;
      p.reserveB = vaultMap.get(p.vaultB) || 0n;
      p.decimalsA = decMap.get(p.mintA) ?? (p.mintA === WSOL ? 9 : 6);
      p.decimalsB = decMap.get(p.mintB) ?? (p.mintB === WSOL ? 9 : 6);
      p.tvlRaw = p.reserveA + p.reserveB;
    }
    this.reserveAt = Date.now();
  }

  async ensureFresh() {
    if (!this.pools.length || Date.now() - this.gpaAt > this.gpaMs) await this.refreshGpa();
    else if (Date.now() - this.reserveAt > this.reserveMs) await this.refreshReserves();
    return this.pools;
  }

  poolsForPair(mintA, mintB) {
    return this.byPair.get(this.poolKey(mintA, mintB)) || [];
  }

  hasHook(mint) {
    return THOOK_MINTS.has(mint) || this.hookMints.has(mint);
  }

  hookProgram(mint) {
    const h = this.hookMints.get(mint);
    return h ? h.programId : null;
  }

  start() {
    this.refreshGpa().catch(() => {});
    setInterval(() => this.refreshGpa().catch(() => {}), this.gpaMs);
    setInterval(() => this.refreshReserves().catch(() => {}), this.reserveMs);
  }

  snapshot() {
    return {
      updatedAt: this.gpaAt,
      reservesAt: this.reserveAt,
      count: this.pools.length,
      thookPools: this.pools.filter((p) => p.thook).length,
      pools: this.pools.map((p) => ({
        pool: p.pool,
        mintA: p.mintA,
        mintB: p.mintB,
        lpMint: p.lpMint,
        thook: p.thook,
        thookMint: p.thookMint,
        reserveA: p.reserveA.toString(),
        reserveB: p.reserveB.toString(),
        decimalsA: p.decimalsA,
        decimalsB: p.decimalsB,
      })),
      hookMints: Object.fromEntries(this.hookMints),
    };
  }
}

module.exports = {
  FluxIndexer,
  FLUX_PROGRAM_ID,
  POOL_SIZE,
  THOOK_MINTS,
  WSOL,
  USDC,
  parsePoolPubkey,
};