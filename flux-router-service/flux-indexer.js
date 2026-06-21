// FluxBeam indexer — fast bootstrap, background paginated GPA, chunked reserve refresh.
"use strict";

const fs = require("fs");
const path = require("path");
const { Connection, PublicKey } = require("@solana/web3.js");
const { AccountLayout, getMint, getTransferHook, TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");

const FLUX_PROGRAM_ID = new PublicKey("FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X");
const POOL_SIZE = 324;
const POOL_SLICE = { offset: 1, length: 290 };
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RESERVE_CHUNK = +(process.env.RESERVE_CHUNK || 100);

const THOOK_MINTS = new Set([
  "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB",
  "EJf2gAc6QtNLd5nhq97GxMDxFXTULEPbWHKTaUzr8KVG",
]);

const SEED_POOLS = [
  "8G9fDqV6e5eMWYnnFaNN5YhuuNUZU9xkkAvrQym6RUC1",
  "Hb1JtjwHHmvvN9tau7YU8gX55UQqezbNgNvei27rFr56",
  "CLsj54K1ku4UGt5M5fSmynZ9XCZE5rgqnCB6cuuvvT8b",
  "C9MH8gTPhYTbsJrcQM6LMu1XaceuVvn3Y83KU7ZKPqx4",
];

const O = {
  INIT: 1,
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
  HOST_NUM: 275,
  HOST_DEN: 283,
};

function rdPk(buf, absOff, sliceStart) {
  const i = absOff - sliceStart;
  return new PublicKey(buf.subarray(i, i + 32));
}

function rdU64(buf, absOff, sliceStart) {
  return buf.readBigUInt64LE(absOff - sliceStart);
}

function parsePoolPubkey(pubkey, data, sliceStart = 0) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "base64");
  if (buf.length < O.HOST_DEN - sliceStart + 8) return null;
  if (buf[O.INIT - sliceStart] !== 1) return null;
  const mintA = rdPk(buf, O.MINT_A, sliceStart).toBase58();
  const mintB = rdPk(buf, O.MINT_B, sliceStart).toBase58();
  const hookA = THOOK_MINTS.has(mintA);
  const hookB = THOOK_MINTS.has(mintB);
  return {
    pool: pubkey,
    authority: PublicKey.findProgramAddressSync([new PublicKey(pubkey).toBuffer()], FLUX_PROGRAM_ID)[0].toBase58(),
    vaultA: rdPk(buf, O.VAULT_A, sliceStart).toBase58(),
    vaultB: rdPk(buf, O.VAULT_B, sliceStart).toBase58(),
    lpMint: rdPk(buf, O.LP_MINT, sliceStart).toBase58(),
    mintA,
    mintB,
    feeAccount: rdPk(buf, O.FEE, sliceStart).toBase58(),
    poolTokenProgram: rdPk(buf, O.POOL_TOKEN_PROG, sliceStart).toBase58(),
    tradeFeeNumerator: rdU64(buf, O.TRADE_NUM, sliceStart),
    tradeFeeDenominator: rdU64(buf, O.TRADE_DEN, sliceStart),
    ownerTradeFeeNumerator: rdU64(buf, O.OWNER_TRADE_NUM, sliceStart),
    ownerTradeFeeDenominator: rdU64(buf, O.OWNER_TRADE_DEN, sliceStart),
    hostFeeNumerator: rdU64(buf, O.HOST_NUM, sliceStart),
    hostFeeDenominator: rdU64(buf, O.HOST_DEN, sliceStart),
    thook: hookA || hookB,
    thookMint: hookA ? mintA : hookB ? mintB : null,
  };
}

const FEE_U64 = [
  "tradeFeeNumerator",
  "tradeFeeDenominator",
  "ownerTradeFeeNumerator",
  "ownerTradeFeeDenominator",
  "hostFeeNumerator",
  "hostFeeDenominator",
];

function toBigInt(v) {
  if (typeof v === "bigint") return v;
  if (v == null || v === "") return 0n;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(v);
}

function normalizeReserves(p) {
  p.reserveA = toBigInt(p.reserveA);
  p.reserveB = toBigInt(p.reserveB);
  for (const k of FEE_U64) p[k] = toBigInt(p[k]);
  return p;
}

function normalizePoolRow(p) {
  const row = { ...p };
  for (const k of FEE_U64) row[k] = toBigInt(row[k]);
  row.reserveA = toBigInt(row.reserveA);
  row.reserveB = toBigInt(row.reserveB);
  return row;
}

function emptyPool(p) {
  const row = normalizePoolRow(p);
  return {
    ...row,
    reserveA: row.reserveA || 0n,
    reserveB: row.reserveB || 0n,
    decimalsA: row.mintA === WSOL ? 9 : row.mintA === USDC ? 6 : 0,
    decimalsB: row.mintB === WSOL ? 9 : row.mintB === USDC ? 6 : 0,
  };
}

async function rpcV2(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

class FluxIndexer {
  constructor(opts = {}) {
    this.rpcUrl = opts.rpcUrl || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    this.gpaMs = +(opts.gpaMs || process.env.FLUX_GPA_MS || 300000);
    this.reserveMs = +(opts.reserveMs || process.env.FLUX_RESERVE_MS || 30000);
    this.gpaPage = +(opts.gpaPage || process.env.FLUX_GPA_PAGE || 1000);
    this.dataDir = opts.dataDir || process.env.DATA_DIR || "";
    this.cacheFile = this.dataDir ? path.join(this.dataDir, "flux-pools.json") : "";
    this.conn = new Connection(this.rpcUrl, "confirmed");
    this.pools = [];
    this.poolMap = new Map();
    this.byPair = new Map();
    this.hookMints = new Map();
    this.gpaBusy = false;
    this.gpaFull = false;
    this.gpaAt = 0;
    this.reserveAt = 0;
    this.reserveBusy = false;
    this._hookScan = new Set();
    this._mintDecimals = new Map();
    this._transferFeeBps = new Map();
    this._bootstrapped = false;
  }

  poolKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  decimalsFor(mint) {
    if (mint === WSOL) return 9;
    if (mint === USDC) return 6;
    return this._mintDecimals.get(mint) ?? 6;
  }

  transferFeeBps(mint) {
    if (mint === WSOL || mint === USDC) return 0;
    return this._transferFeeBps.get(mint) || 0;
  }

  hasTransferFee(mint) {
    return this.transferFeeBps(mint) > 0;
  }

  /** Fetch decimals + transfer-fee bps for mints (required before arb filtering). */
  async ensureMintMeta(mints) {
    const need = [...new Set(mints)].filter(
      (m) => m && m !== WSOL && m !== USDC && !this._transferFeeBps.has(m),
    );
    if (!need.length) return;
    for (let i = 0; i < need.length; i += RESERVE_CHUNK) {
      const chunk = need.slice(i, i + RESERVE_CHUNK);
      const infos = await this.conn.getMultipleParsedAccounts(chunk.map((m) => new PublicKey(m)));
      for (let j = 0; j < chunk.length; j++) {
        const v = infos.value[j];
        if (!v) {
          this._transferFeeBps.set(chunk[j], 0);
          continue;
        }
        try {
          const info = v.data.parsed.info;
          this._mintDecimals.set(chunk[j], info.decimals);
          this._transferFeeBps.set(chunk[j], FluxIndexer._parseTransferFeeBps(info));
        } catch {
          this._transferFeeBps.set(chunk[j], 0);
        }
      }
    }
  }

  static _parseTransferFeeBps(mintInfo) {
    try {
      const exts = mintInfo?.extensions;
      if (!Array.isArray(exts)) return 0;
      const cfg = exts.find((e) => e.extension === "transferFeeConfig");
      const fee = cfg?.state?.newerTransferFee?.transferFeeBasisPoints;
      return typeof fee === "number" && fee > 0 ? fee : 0;
    } catch {
      return 0;
    }
  }

  _rebuildByPair() {
    this.byPair = new Map();
    for (const p of this.pools) {
      const k = this.poolKey(p.mintA, p.mintB);
      const arr = this.byPair.get(k) || [];
      arr.push(p);
      this.byPair.set(k, arr);
    }
    for (const arr of this.byPair.values()) {
      arr.sort((a, b) => {
        if (a.thook !== b.thook) return a.thook ? -1 : 1;
        const la = toBigInt(a.reserveA) + toBigInt(a.reserveB);
        const lb = toBigInt(b.reserveA) + toBigInt(b.reserveB);
        return lb > la ? 1 : lb < la ? -1 : 0;
      });
    }
  }

  _mergePools(incoming) {
    let added = 0;
    for (const raw of incoming) {
      if (this.poolMap.has(raw.pool)) continue;
      const p = emptyPool(raw);
      this.poolMap.set(p.pool, p);
      this.pools.push(p);
      added++;
    }
    if (added) this._rebuildByPair();
    return added;
  }

  _loadCache() {
    if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return false;
    try {
      const rows = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      if (!Array.isArray(rows) || !rows.length) return false;
      this.pools = rows.map((r) => normalizeReserves(emptyPool(r)));
      this.poolMap = new Map(this.pools.map((p) => [p.pool, p]));
      this._rebuildByPair();
      this.gpaAt = fs.statSync(this.cacheFile).mtimeMs;
      console.log(`[flux-indexer] cache loaded ${this.pools.length} pools`);
      return true;
    } catch (e) {
      console.error("[flux-indexer] cache read failed:", e.message || e);
      return false;
    }
  }

  _saveCache() {
    if (!this.cacheFile || !this.pools.length) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const slim = this.pools.map((p) => ({
        pool: p.pool, authority: p.authority, vaultA: p.vaultA, vaultB: p.vaultB,
        lpMint: p.lpMint, mintA: p.mintA, mintB: p.mintB, feeAccount: p.feeAccount,
        poolTokenProgram: p.poolTokenProgram,
        tradeFeeNumerator: p.tradeFeeNumerator.toString(),
        tradeFeeDenominator: p.tradeFeeDenominator.toString(),
        ownerTradeFeeNumerator: p.ownerTradeFeeNumerator.toString(),
        ownerTradeFeeDenominator: p.ownerTradeFeeDenominator.toString(),
        hostFeeNumerator: p.hostFeeNumerator.toString(),
        hostFeeDenominator: p.hostFeeDenominator.toString(),
        thook: p.thook, thookMint: p.thookMint,
      }));
      fs.writeFileSync(this.cacheFile, JSON.stringify(slim));
    } catch (e) {
      console.error("[flux-indexer] cache write failed:", e.message || e);
    }
  }

  async _scanHookMint(mint) {
    if (this._hookScan.has(mint)) return;
    this._hookScan.add(mint);
    try {
      const info = await getMint(this.conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
      this._mintDecimals.set(mint, info.decimals);
      const hook = getTransferHook(info);
      if (hook?.programId) {
        this.hookMints.set(mint, { programId: hook.programId.toBase58(), authority: hook.authority?.toBase58?.() || null });
      }
    } catch { /* skip */ }
  }

  async _fetchByPubkeys(pubkeys) {
    if (!pubkeys.length) return [];
    const infos = await this.conn.getMultipleAccountsInfo(pubkeys.map((p) => new PublicKey(p)), "confirmed");
    const out = [];
    const sliceStart = POOL_SLICE.offset;
    for (let i = 0; i < pubkeys.length; i++) {
      if (!infos[i]) continue;
      const p = parsePoolPubkey(pubkeys[i], infos[i].data, 0);
      if (p) out.push(p);
    }
    return out;
  }

  async _fetchByMintOffset(mint, offset) {
    const rows = await this.conn.getProgramAccounts(FLUX_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { dataSize: POOL_SIZE },
        { memcmp: { offset, bytes: new PublicKey(mint).toBase58() } },
      ],
      dataSlice: POOL_SLICE,
    });
    const sliceStart = POOL_SLICE.offset;
    const out = [];
    for (const row of rows) {
      const p = parsePoolPubkey(row.pubkey.toBase58(), row.account.data, sliceStart);
      if (p) out.push(p);
    }
    return out;
  }

  async bootstrapFast() {
    if (this._bootstrapped) return this.pools;
    const t0 = Date.now();
    const tasks = [this._fetchByPubkeys(SEED_POOLS)];
    for (const mint of THOOK_MINTS) {
      tasks.push(this._fetchByMintOffset(mint, O.MINT_A));
      tasks.push(this._fetchByMintOffset(mint, O.MINT_B));
    }
    const batches = await Promise.all(tasks);
    const boot = batches.flat();
    const added = this._mergePools(boot);
    const bootPools = boot.map((b) => this.poolMap.get(b.pool)).filter(Boolean);
    for (const mint of THOOK_MINTS) {
      await this._scanHookMint(mint);
      for (const p of bootPools) {
        if (p.mintA === mint || p.mintB === mint) p.thook = true;
      }
    }
    this._bootstrapped = true;
    if (!this.gpaAt) this.gpaAt = Date.now();
    console.log(`[flux-indexer] bootstrap ${bootPools.length} hot pools (+${added}) in ${Date.now() - t0}ms`);
    await this.refreshReserves(bootPools);
    return this.pools;
  }

  async _fetchGpaPage(paginationKey) {
    const opts = {
      encoding: "base64",
      filters: [{ dataSize: POOL_SIZE }],
      dataSlice: POOL_SLICE,
      limit: this.gpaPage,
    };
    if (paginationKey) opts.paginationKey = paginationKey;
    return rpcV2(this.rpcUrl, "getProgramAccountsV2", [FLUX_PROGRAM_ID.toBase58(), opts]);
  }

  async _refreshGpaBackground() {
    if (this.gpaBusy) return;
    this.gpaBusy = true;
    this.gpaFull = false;
    const sliceStart = POOL_SLICE.offset;
    const t0 = Date.now();
    let paginationKey = null;
    let pages = 0;
    let totalAdded = 0;

    try {
      while (true) {
        let result;
        try {
          result = await this._fetchGpaPage(paginationKey);
        } catch (e) {
          console.error("[flux-indexer] getProgramAccountsV2 unavailable:", e.message || e);
          break;
        }

        const accounts = result.accounts || [];
        const parsed = [];
        for (const row of accounts) {
          const data = row.account?.data?.[0] || row.account?.data;
          const p = parsePoolPubkey(row.pubkey, data, sliceStart);
          if (p) parsed.push(p);
        }
        const added = this._mergePools(parsed);
        totalAdded += added;
        pages++;

        if (added) {
          const fresh = this.pools.slice(-added);
          this.refreshReserves(fresh).catch(() => {});
          if (pages % 5 === 0) this._saveCache();
        }

        paginationKey = result.paginationKey;
        if (!paginationKey || !accounts.length) break;
      }

      for (const mint of THOOK_MINTS) await this._scanHookMint(mint);
      this.gpaAt = Date.now();
      this.gpaFull = true;
      this._saveCache();
      console.log(`[flux-indexer] full scan ${this.pools.length} pools (+${totalAdded} new, ${pages} pages) in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error("[flux-indexer] background gpa failed:", e.message || e);
    } finally {
      this.gpaBusy = false;
    }
  }

  async refreshReserves(targetPools = null) {
    const list = targetPools || this.pools;
    if (!list.length) return;
    if (this.reserveBusy && !targetPools) return;
    if (!targetPools) this.reserveBusy = true;

    try {
      const vaults = [];
      for (const p of list) vaults.push(p.vaultA, p.vaultB);
      const vaultMap = new Map();
      for (let i = 0; i < vaults.length; i += RESERVE_CHUNK) {
        const chunk = vaults.slice(i, i + RESERVE_CHUNK);
        const r = await this.conn.getMultipleAccountsInfo(chunk.map((v) => new PublicKey(v)), "confirmed");
        for (let j = 0; j < chunk.length; j++) {
          if (!r[j]) continue;
          try {
            vaultMap.set(chunk[j], AccountLayout.decode(r[j].data).amount);
          } catch { /* skip */ }
        }
      }

      const mints = [...new Set(list.flatMap((p) => [p.mintA, p.mintB]))];
      const decMap = new Map();
      for (let i = 0; i < mints.length; i += RESERVE_CHUNK) {
        const chunk = mints.slice(i, i + RESERVE_CHUNK);
        const infos = await this.conn.getMultipleParsedAccounts(chunk.map((m) => new PublicKey(m)));
        for (let j = 0; j < chunk.length; j++) {
          const v = infos.value[j];
          if (!v) continue;
          try {
            const info = v.data.parsed.info;
            decMap.set(chunk[j], info.decimals);
            const feeBps = FluxIndexer._parseTransferFeeBps(info);
            if (feeBps) this._transferFeeBps.set(chunk[j], feeBps);
          } catch { /* skip */ }
        }
      }

      for (const p of list) {
        p.reserveA = toBigInt(vaultMap.get(p.vaultA) || 0);
        p.reserveB = toBigInt(vaultMap.get(p.vaultB) || 0);
        p.decimalsA = decMap.get(p.mintA) ?? (p.mintA === WSOL ? 9 : 6);
        p.decimalsB = decMap.get(p.mintB) ?? (p.mintB === WSOL ? 9 : 6);
        this._mintDecimals.set(p.mintA, p.decimalsA);
        this._mintDecimals.set(p.mintB, p.decimalsB);
        normalizeReserves(p);
      }
      if (!targetPools) this.reserveAt = Date.now();
    } finally {
      if (!targetPools) this.reserveBusy = false;
    }
  }

  async _refreshPriorityPools() {
    const priority = this.pools.filter((p) => p.thook || SEED_POOLS.includes(p.pool));
    if (!priority.length) return;
    await this.refreshReserves(priority);
    console.log(`[flux-indexer] priority reserves ${priority.length} pools`);
  }

  _thookReservesStale() {
    return this.pools.some((p) => p.thook && p.reserveA === 0n && p.reserveB === 0n);
  }

  async ensureFresh() {
    if (!this._bootstrapped && !this.pools.length) await this.bootstrapFast();
    if (this._thookReservesStale()) await this._refreshPriorityPools();
    else if (Date.now() - this.reserveAt > this.reserveMs) this.refreshReserves().catch(() => {});
    return this.pools;
  }

  poolsForPair(mintA, mintB) {
    return this.byPair.get(this.poolKey(mintA, mintB)) || [];
  }

  hasHook(mint) {
    return THOOK_MINTS.has(mint) || this.hookMints.has(mint);
  }

  hookProgram(mint) {
    return this.hookMints.get(mint)?.programId || null;
  }

  async _runStartup() {
    if (this._loadCache()) {
      this._bootstrapped = true;
      await this._refreshPriorityPools();
      const warm = this.pools
        .filter((p) => p.mintA === WSOL || p.mintB === WSOL || p.mintA === USDC || p.mintB === USDC)
        .slice(0, 2000);
      this.refreshReserves(warm).catch(() => {});
    } else {
      await this.bootstrapFast();
    }
    this._refreshGpaBackground().catch(() => {});
  }

  start() {
    this._runStartup().catch((e) => console.error("[flux-indexer] startup failed:", e.message || e));
    setInterval(() => {
      if (!this.gpaBusy) this._refreshGpaBackground().catch(() => {});
    }, this.gpaMs);
    setInterval(() => this.refreshReserves().catch(() => {}), this.reserveMs);
  }

  snapshot() {
    const { formatUi } = require("./amounts.js");
    return {
      indexing: this.gpaBusy,
      gpaFull: this.gpaFull,
      updatedAt: this.gpaAt,
      reservesAt: this.reserveAt,
      count: this.pools.length,
      thookPools: this.pools.filter((p) => p.thook).length,
      pools: [...this.pools].sort((a, b) => (b.thook - a.thook)).slice(0, 200).map((p) => ({
        pool: p.pool,
        mintA: p.mintA,
        mintB: p.mintB,
        thook: p.thook,
        reserveA: formatUi(p.reserveA, p.decimalsA),
        reserveB: formatUi(p.reserveB, p.decimalsB),
      })),
      hookMints: Object.fromEntries(this.hookMints),
    };
  }
}

module.exports = {
  FluxIndexer,
  FLUX_PROGRAM_ID,
  POOL_SIZE,
  POOL_SLICE,
  THOOK_MINTS,
  WSOL,
  USDC,
  parsePoolPubkey,
  RESERVE_CHUNK,
  toBigInt,
};