// On-chain reads for the leaderboard indexer. Mirrors the Config parsing in
// server.js (same field offsets) but standalone so the indexer can run as its
// own process / cron without booting the whole site.

const web3 = require('@solana/web3.js')
const { PublicKey, Connection } = web3

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || 'J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe',
)
const CP = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// pinocchio Config field offsets (must match server.js / config.rs).
const O_USDC = 36, O_MINT_A = 68, O_MINT_B = 100, O_RECEIPT = 132
const O_POOL_AB = 164, O_POOL_AQ = 196, O_POOL_BQ = 228
const CONFIG_MIN_SIZE = O_POOL_BQ + 32
const ZERO = '11111111111111111111111111111111'

function rdPk(buf, o) {
  return new PublicKey(buf.subarray(o, o + 32)).toBase58()
}

// Raydium CP-Swap PDAs.
function cpVault(pool, mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), new PublicKey(pool).toBuffer(), new PublicKey(mint).toBuffer()],
    CP,
  )[0].toBase58()
}
function cpLpMint(pool) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_lp_mint'), new PublicKey(pool).toBuffer()],
    CP,
  )[0].toBase58()
}
function cpObservation(pool) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), new PublicKey(pool).toBuffer()],
    CP,
  )[0].toBase58()
}

function conn() {
  const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
  return new Connection(rpc, 'confirmed')
}

// Discover every Config (market) the program owns. Returns the same shape the
// site uses, plus derived LP mints + observation accounts for each pool.
async function discoverMarkets(connection) {
  const c = connection || conn()
  const accts = await c.getProgramAccounts(PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: '2' } }], // discriminator byte 1 -> base58 '2'
  })
  const markets = []
  for (const { pubkey, account } of accts) {
    const buf = account.data
    if (!buf || buf.length < CONFIG_MIN_SIZE || buf[0] !== 1) continue
    const usdc = rdPk(buf, O_USDC)
    const mintA = rdPk(buf, O_MINT_A)
    const mintB = rdPk(buf, O_MINT_B)
    const receipt = rdPk(buf, O_RECEIPT)
    const poolAb = rdPk(buf, O_POOL_AB)
    const poolAq = rdPk(buf, O_POOL_AQ)
    const poolBq = rdPk(buf, O_POOL_BQ)
    if (poolAb === ZERO || poolAq === ZERO || poolBq === ZERO) continue
    markets.push({
      config: pubkey.toBase58(),
      receiptMint: receipt,
      mintA,
      mintB,
      quoteMint: usdc,
      pools: {
        ab: { pool: poolAb, vaultA: cpVault(poolAb, mintA), vaultB: cpVault(poolAb, mintB), lp: cpLpMint(poolAb), obs: cpObservation(poolAb) },
        aq: { pool: poolAq, vaultA: cpVault(poolAq, mintA), vaultQ: cpVault(poolAq, usdc), lp: cpLpMint(poolAq), obs: cpObservation(poolAq) },
        bq: { pool: poolBq, vaultB: cpVault(poolBq, mintB), vaultQ: cpVault(poolBq, usdc), lp: cpLpMint(poolBq), obs: cpObservation(poolBq) },
      },
    })
  }
  return markets
}

async function mintDecimals(connection, mint) {
  try {
    const r = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed')
    const info = r && r.value && r.value.data && r.value.data.parsed && r.value.data.parsed.info
    return info ? Number(info.decimals) : 6
  } catch {
    return 6
  }
}

// All token accounts for a mint, via getProgramAccounts on the token program
// with a mint memcmp. Returns [{ owner, tokenAccount }]. CP-Swap LP mints +
// the synth legs are SPL Token (legacy) — see the lib.rs comment. We probe
// both token programs to be safe.
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
async function holdersOf(connection, mint) {
  const out = new Map() // owner -> tokenAccount (first seen; owners normally have 1 ATA)
  for (const prog of [TOKEN, TOKEN_2022]) {
    let accts
    try {
      accts = await connection.getParsedProgramAccounts(prog, {
        commitment: 'confirmed',
        filters: [{ dataSize: prog.equals(TOKEN) ? 165 : undefined }, { memcmp: { offset: 0, bytes: mint } }].filter((f) => f.dataSize !== undefined || f.memcmp),
      })
    } catch {
      accts = []
    }
    for (const { pubkey, account } of accts) {
      const info = account.data && account.data.parsed && account.data.parsed.info
      if (!info || info.mint !== mint) continue
      const owner = info.owner
      if (!out.has(owner)) out.set(owner, pubkey.toBase58())
    }
  }
  return [...out.entries()].map(([owner, tokenAccount]) => ({ owner, tokenAccount }))
}

// Live quote-denominated prices for a market's legs + LP tokens. `m` is a
// lev_markets row (snake_case fields). Returns { priceA, priceB, lp: {poolId: price} }.
async function marketPrices(connection, m) {
  const vaults = [
    cpVault(m.pool_aq, m.mint_a), cpVault(m.pool_aq, m.quote_mint),
    cpVault(m.pool_bq, m.mint_b), cpVault(m.pool_bq, m.quote_mint),
    cpVault(m.pool_ab, m.mint_a), cpVault(m.pool_ab, m.mint_b),
  ].map((a) => new PublicKey(a))
  const res = await connection.getMultipleParsedAccounts(vaults, { commitment: 'confirmed' })
  const amt = (i) => {
    const info = res.value[i] && res.value[i].data && res.value[i].data.parsed && res.value[i].data.parsed.info
    return info ? Number(info.tokenAmount.uiAmount) || 0 : 0
  }
  const aqA = amt(0), aqQ = amt(1), bqB = amt(2), bqQ = amt(3), abA = amt(4), abB = amt(5)
  const priceA = aqA > 0 ? aqQ / aqA : 0
  const priceB = bqB > 0 ? bqQ / bqB : 0
  const supply = async (mint) => {
    try { const s = await connection.getTokenSupply(new PublicKey(mint), 'confirmed'); return Number(s.value.uiAmount) || 0 } catch { return 0 }
  }
  const [sAq, sBq, sAb] = await Promise.all([supply(m.lp_aq), supply(m.lp_bq), supply(m.lp_ab)])
  return {
    priceA, priceB,
    lp: {
      [m.pool_aq]: sAq > 0 ? (2 * aqQ) / sAq : 0,
      [m.pool_bq]: sBq > 0 ? (2 * bqQ) / sBq : 0,
      [m.pool_ab]: sAb > 0 ? (abA * priceA + abB * priceB) / sAb : 0,
    },
  }
}

module.exports = {
  PROGRAM_ID, CP, USDC,
  conn, discoverMarkets, mintDecimals, holdersOf, marketPrices,
  cpVault, cpLpMint, cpObservation,
}
