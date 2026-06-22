/**
 * On-chain discovery of leverage markets (Config accounts) and the reserves of
 * their CP-Swap triangle. Mirrors the field offsets + PDA derivations in
 * pinocchio-programs/leverage-engine (config.rs) and site/server.js.
 */

import { Connection, PublicKey } from "@solana/web3.js";

export const DEFAULT_PROGRAM_ID = new PublicKey("J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe");
export const CP_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// pinocchio Config field offsets (must match config.rs / server.js).
const O_USDC = 36, O_MINT_A = 68, O_MINT_B = 100, O_RECEIPT = 132;
const O_POOL_AB = 164, O_POOL_AQ = 196, O_POOL_BQ = 228;
const O_FEE_BPS = 348;
const CONFIG_MIN_SIZE = O_POOL_BQ + 32;
const ZERO = new PublicKey("11111111111111111111111111111111");

function rdPk(buf: Buffer, o: number): PublicKey {
  return new PublicKey(buf.subarray(o, o + 32));
}

/** Raydium CP-Swap pool vault PDA: ["pool_vault", pool, mint]. */
export function cpVault(pool: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), pool.toBuffer(), mint.toBuffer()],
    CP_PROGRAM_ID,
  )[0];
}
/** CP-Swap LP mint PDA: ["pool_lp_mint", pool]. */
export function cpLpMint(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), pool.toBuffer()], CP_PROGRAM_ID)[0];
}
/** CP-Swap observation (price oracle ring) PDA: ["observation", pool]. */
export function cpObservation(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("observation"), pool.toBuffer()], CP_PROGRAM_ID)[0];
}

export interface PoolLeg {
  pool: PublicKey;
  /** the synth-side vault (mintA for aq/ab, mintB for bq/ab). */
  vaultBase: PublicKey;
  /** the counter-side vault (USDC for aq/bq, the other synth for ab). */
  vaultQuote: PublicKey;
  lpMint: PublicKey;
  observation: PublicKey;
}

export interface Market {
  config: PublicKey;
  receiptMint: PublicKey;
  /** long leg (+). */
  mintA: PublicKey;
  /** short / inverse leg (−). */
  mintB: PublicKey;
  quoteMint: PublicKey;
  tradeFeeBps: bigint;
  pools: {
    /** A/B pair pool. vaultBase=A, vaultQuote=B. */
    ab: PoolLeg;
    /** A/USDC pool. vaultBase=A, vaultQuote=USDC. */
    aq: PoolLeg;
    /** B/USDC pool. vaultBase=B, vaultQuote=USDC. */
    bq: PoolLeg;
  };
}

function parseConfig(pubkey: PublicKey, data: Buffer): Market | null {
  if (data.length < CONFIG_MIN_SIZE || data[0] !== 1) return null;
  const usdc = rdPk(data, O_USDC);
  const mintA = rdPk(data, O_MINT_A);
  const mintB = rdPk(data, O_MINT_B);
  const receipt = rdPk(data, O_RECEIPT);
  const poolAb = rdPk(data, O_POOL_AB);
  const poolAq = rdPk(data, O_POOL_AQ);
  const poolBq = rdPk(data, O_POOL_BQ);
  if (poolAb.equals(ZERO) || poolAq.equals(ZERO) || poolBq.equals(ZERO)) return null;
  // NOTE: the CP-Swap *trade* fee is in Raydium's AmmConfig, not our Config —
  // Config offset 348 is the protocol *deposit* fee. Use the CP-Swap standard
  // 25 bps for arb sizing; override per-pool via readAmmConfig (TODO) if needed.
  const feeBps = 25n;
  void O_FEE_BPS;
  const leg = (pool: PublicKey, base: PublicKey, quote: PublicKey): PoolLeg => ({
    pool,
    vaultBase: cpVault(pool, base),
    vaultQuote: cpVault(pool, quote),
    lpMint: cpLpMint(pool),
    observation: cpObservation(pool),
  });
  return {
    config: pubkey,
    receiptMint: receipt,
    mintA,
    mintB,
    quoteMint: usdc,
    tradeFeeBps: feeBps,
    pools: {
      ab: leg(poolAb, mintA, mintB),
      aq: leg(poolAq, mintA, usdc),
      bq: leg(poolBq, mintB, usdc),
    },
  };
}

/** Discover every leverage market owned by the program via getProgramAccounts. */
export async function discoverMarkets(
  connection: Connection,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): Promise<Market[]> {
  const accts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: "2" } }], // discriminator byte 0x01 → base58 "2"
  });
  const out: Market[] = [];
  for (const { pubkey, account } of accts) {
    const m = parseConfig(pubkey, account.data as Buffer);
    if (m) out.push(m);
  }
  return out;
}

/** Raw u64 amount in an SPL token account (offset 64). */
function tokenAccountAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}
/** Raw u64 supply in an SPL mint (offset 36). */
function mintSupply(data: Buffer): bigint {
  return data.readBigUInt64LE(36);
}

export interface TriangleReserves {
  /** A reserve in the A/B pool. */
  abA: bigint;
  /** B reserve in the A/B pool. */
  abB: bigint;
  /** A reserve in the A/USDC pool. */
  aqA: bigint;
  /** USDC reserve in the A/USDC pool. */
  aqUsdc: bigint;
  /** B reserve in the B/USDC pool. */
  bqB: bigint;
  /** USDC reserve in the B/USDC pool. */
  bqUsdc: bigint;
  /** live mint supply of A. */
  supplyA: bigint;
  /** live mint supply of B. */
  supplyB: bigint;
}

// Config field offsets (config.rs).
const C_PAUSED = 35, C_L_MIN = 260, C_L_MAX = 268, C_MAX_MINT = 276, C_BREAKER = 284, C_LAST_RATIO = 292, C_ORACLE_KIND = 414, C_ORACLE_PRICE_LAST = 415;

function rdU128LE(d: Buffer, o: number): bigint {
  return d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);
}

export interface MarketConfig {
  paused: boolean;
  lMinBps: bigint;
  lMaxBps: bigint;
  maxMintBps: bigint;
  breakerBps: bigint;
  /** ratio recorded at the last rebalance — the real input to a crank sim. */
  lastRatioWad: bigint;
  oracleKind: number;
  oraclePriceLastWad: bigint;
}

/** Read the live Config (real last_ratio + leverage band) so a crank sim isn't fabricated. */
export async function readConfig(connection: Connection, m: Market): Promise<MarketConfig> {
  const info = await connection.getAccountInfo(m.config, "confirmed");
  if (!info) throw new Error(`config ${m.config.toBase58()} not found`);
  const d = info.data as Buffer;
  return {
    paused: d[C_PAUSED] !== 0,
    lMinBps: d.readBigUInt64LE(C_L_MIN),
    lMaxBps: d.readBigUInt64LE(C_L_MAX),
    maxMintBps: d.readBigUInt64LE(C_MAX_MINT),
    breakerBps: d.readBigUInt64LE(C_BREAKER),
    lastRatioWad: rdU128LE(d, C_LAST_RATIO),
    oracleKind: d.length > C_ORACLE_KIND ? d[C_ORACLE_KIND] : 0,
    oraclePriceLastWad: d.length >= C_ORACLE_PRICE_LAST + 16 ? rdU128LE(d, C_ORACLE_PRICE_LAST) : 0n,
  };
}

/** Read all six vault balances + the two synth supplies for a market. */
export async function readTriangle(connection: Connection, m: Market): Promise<TriangleReserves> {
  const keys = [
    m.pools.ab.vaultBase, m.pools.ab.vaultQuote,
    m.pools.aq.vaultBase, m.pools.aq.vaultQuote,
    m.pools.bq.vaultBase, m.pools.bq.vaultQuote,
    m.mintA, m.mintB,
  ];
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  for (let i = 0; i < 8; i++) {
    if (!infos[i]) throw new Error(`missing account ${keys[i].toBase58()} for market ${m.config.toBase58()}`);
  }
  const d = (i: number) => infos[i]!.data as Buffer;
  return {
    abA: tokenAccountAmount(d(0)),
    abB: tokenAccountAmount(d(1)),
    aqA: tokenAccountAmount(d(2)),
    aqUsdc: tokenAccountAmount(d(3)),
    bqB: tokenAccountAmount(d(4)),
    bqUsdc: tokenAccountAmount(d(5)),
    supplyA: mintSupply(d(6)),
    supplyB: mintSupply(d(7)),
  };
}
