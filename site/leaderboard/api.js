// Leaderboard read API. Reads the marked-to-market lev_positions rows the
// indexer maintains and does ALL sorting / pagination / totals in SQL, so it
// scales with holder count (never loads the whole table into Node).
//
// Legs:
//   ls    = long + short combined per wallet (DEFAULT) — net directional P&L
//   long  = mintA holders
//   short = mintB holders
//   lp    = LP-mint holders, one row per CP-Swap pool (LP tokens aren't fungible
//           across pools, so they're kept separate — never summed)

const { query, ensureSchema } = require('./db')

const LEGS = ['ls', 'long', 'short', 'lp']
const SORT_COLS = {
  pnl: 'pnl', roi: 'roi', value: 'cur_value', realized: 'realized',
  balance: 'balance', avg_entry: 'avg_entry',
}

// Persist display metadata so the markets list is searchable/sortable in SQL.
// Called by the site whenever its on-chain REGISTRY refreshes.
async function syncMarketMeta(rows) {
  if (!rows || !rows.length) return
  await ensureSchema()
  for (const r of rows) {
    if (!r.config) continue
    await query(
      `UPDATE lev_markets SET sym=$2, name=$3, logo=$4, updated_at=NOW() WHERE config=$1`,
      [r.config, r.sym || null, r.name || null, r.logo || null],
    ).catch(() => {})
  }
}

const MARKET_SORT = {
  positions: 'positions', holders: 'holders', traders: 'traders',
  tvl: 'open_value', value: 'open_value', pnl: 'net_pnl',
  recent: 'last_at', sym: 'sym',
}

// Searchable / sortable / paginated market list with per-market aggregates.
// opts: { q, sort, order, limit, offset }
async function listMarkets(opts = {}) {
  await ensureSchema()
  const q = (opts.q || '').trim()
  const sortCol = MARKET_SORT[opts.sort] || 'positions'
  const order = String(opts.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 500)
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0)

  const params = []
  let where = ''
  if (q) {
    const i = params.push(`%${q}%`)
    where = `WHERE (m.sym ILIKE $${i} OR m.name ILIKE $${i} OR m.config ILIKE $${i}
              OR m.mint_a ILIKE $${i} OR m.mint_b ILIKE $${i} OR m.receipt_mint ILIKE $${i})`
  }
  const limIdx = params.push(limit)
  const offIdx = params.push(offset)

  const sql = `
    WITH agg AS (
      SELECT market,
             COUNT(*) FILTER (WHERE balance > 0 AND leg IN ('long','short'))                  AS holders,
             COUNT(DISTINCT wallet) FILTER (WHERE leg IN ('long','short'))                    AS traders,
             COUNT(*) FILTER (WHERE balance > 0)                                              AS positions,
             COALESCE(SUM(cur_value), 0)                                                      AS open_value,
             COALESCE(SUM(pnl), 0)                                                            AS net_pnl,
             MAX(last_at)                                                                     AS last_at
      FROM lev_positions GROUP BY market
    )
    SELECT m.config, m.receipt_mint, m.mint_a, m.mint_b, m.quote_mint,
           m.sym, m.name, m.logo,
           COALESCE(a.holders,0)    AS holders,
           COALESCE(a.traders,0)    AS traders,
           COALESCE(a.positions,0)  AS positions,
           COALESCE(a.open_value,0) AS open_value,
           COALESCE(a.net_pnl,0)    AS net_pnl,
           a.last_at,
           COUNT(*) OVER ()         AS total
    FROM lev_markets m
    LEFT JOIN agg a ON a.market = m.config
    ${where}
    ORDER BY ${sortCol} ${order} NULLS LAST, m.sym NULLS LAST, m.config
    LIMIT $${limIdx} OFFSET $${offIdx}`
  const r = await query(sql, params)
  const total = r.rows.length ? Number(r.rows[0].total) : 0
  return {
    total,
    nextOffset: offset + r.rows.length < total ? offset + limit : null,
    markets: r.rows.map((row) => ({
      config: row.config, receiptMint: row.receipt_mint,
      sym: row.sym || null, name: row.name || null, logo: row.logo || null,
      mintA: row.mint_a, mintB: row.mint_b, quoteMint: row.quote_mint,
      positions: Number(row.positions), holders: Number(row.holders), traders: Number(row.traders),
      openValue: Number(row.open_value), netPnl: Number(row.net_pnl),
      lastAt: row.last_at ? new Date(row.last_at).getTime() : null,
    })),
  }
}

// Build the base row-set SQL + params. For 'ls' it aggregates long+short per
// wallet; otherwise it's the raw per-(pool,)wallet rows for the leg.
function baseQuery(market, leg, exclude, hideEmpty) {
  const params = [market]
  const exclIdx = params.push(exclude && exclude.length ? exclude : ['']) // $2
  const live = `(balance > 0 OR qty_in > 0 OR qty_out > 0 OR realized_pnl <> 0)`
  // "rated" = actually holds, or has a non-dust realized result. Hides the
  // tail of wallets that touched a leg once and ended flat at ~$0.
  const RATED_DIRECT = `(balance > 0 OR ABS(realized_pnl) >= 0.005)`
  const RATED_LS_HAVING = `HAVING (bool_or(balance > 0) OR ABS(SUM(pnl)) >= 0.005)`
  if (leg === 'ls') {
    return {
      sql: `
        SELECT wallet,
               NULL::double precision AS balance,
               NULL::double precision AS avg_entry,
               NULL::double precision AS cur_price,
               SUM(cur_value)        AS cur_value,
               SUM(cost_basis_quote) AS cost_basis,
               SUM(realized_pnl)     AS realized,
               SUM(unrealized_pnl)   AS unrealized,
               SUM(pnl)              AS pnl,
               CASE WHEN SUM(cost_basis_quote) >= 0.005 THEN SUM(pnl)/SUM(cost_basis_quote) ELSE NULL END AS roi,
               SUM(buy_count)::int   AS buys,
               SUM(sell_count)::int  AS sells,
               bool_or(approx)       AS approx,
               MAX((balance>0)::int) AS holding,
               array_to_string(array_agg(DISTINCT CASE leg WHEN 'long' THEN 'L' WHEN 'short' THEN 'S' END), '+') AS legs,
               ''::text              AS pool,
               MIN(first_at)         AS first_at,
               MAX(last_at)          AS last_at
        FROM lev_positions
        WHERE market = $1 AND leg IN ('long','short') AND wallet <> ALL($${exclIdx}::text[]) AND ${live}
        GROUP BY wallet
        ${hideEmpty ? RATED_LS_HAVING : ''}`,
      params,
    }
  }
  const legIdx = params.push(leg) // $3
  return {
    sql: `
      SELECT wallet, balance, avg_entry, cur_price,
             cur_value,
             cost_basis_quote AS cost_basis,
             realized_pnl     AS realized,
             unrealized_pnl   AS unrealized,
             pnl, roi,
             buy_count  AS buys,
             sell_count AS sells,
             approx,
             (balance > 0)::int AS holding,
             $${legIdx}::text   AS legs,
             COALESCE(pool,'')  AS pool,
             first_at, last_at
      FROM lev_positions
      WHERE market = $1 AND leg = $${legIdx} AND wallet <> ALL($${exclIdx}::text[])
        AND ${hideEmpty ? RATED_DIRECT : live}`,
    params,
  }
}

async function table({ market, leg, limit, offset, sort, excludeWallets, hideEmpty }) {
  await ensureSchema()
  if (!LEGS.includes(leg)) leg = 'ls'
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  offset = Math.max(parseInt(offset, 10) || 0, 0)
  let sortCol = SORT_COLS[sort] || 'pnl'
  if (leg === 'ls' && (sortCol === 'balance' || sortCol === 'avg_entry')) sortCol = 'pnl'

  const mres = await query('SELECT config, mint_a_decimals, mint_b_decimals FROM lev_markets WHERE config=$1', [market])
  if (!mres.rows.length) return { error: 'unknown market' }

  const { sql: base, params } = baseQuery(market, leg, excludeWallets, hideEmpty !== false)

  // Page of rows — ordered + limited in SQL.
  const pageParams = params.slice()
  const limIdx = pageParams.push(limit)
  const offIdx = pageParams.push(offset)
  const pageSql = `
    WITH pos AS (${base})
    SELECT *, ROW_NUMBER() OVER (ORDER BY ${sortCol} DESC NULLS LAST, wallet) AS rank
    FROM pos ORDER BY ${sortCol} DESC NULLS LAST, wallet
    LIMIT $${limIdx} OFFSET $${offIdx}`
  const pageRes = await query(pageSql, pageParams)

  // Totals over the whole filtered set (not just the page).
  const totSql = `
    WITH pos AS (${base})
    SELECT COUNT(*)::int AS traders,
           COALESCE(SUM(holding),0)::int AS holders,
           COALESCE(SUM(cur_value),0)  AS open_value,
           COALESCE(SUM(cost_basis),0) AS cost_basis,
           COALESCE(SUM(realized),0)   AS realized,
           COALESCE(SUM(unrealized),0) AS unrealized,
           COALESCE(SUM(pnl),0)        AS pnl,
           COALESCE(SUM((pnl>0)::int),0)::int AS winners,
           COALESCE(SUM((pnl<0)::int),0)::int AS losers
    FROM pos`
  const totRes = await query(totSql, params)
  const t = totRes.rows[0] || {}

  // Header current price for single-token legs.
  let currentPrice = null
  if (leg === 'long' || leg === 'short') {
    const pr = await query(
      `SELECT MAX(cur_price) AS p FROM lev_positions WHERE market=$1 AND leg=$2 AND cur_price IS NOT NULL`,
      [market, leg],
    )
    currentPrice = pr.rows[0] && pr.rows[0].p != null ? Number(pr.rows[0].p) : null
  }

  const rows = pageRes.rows.map((r) => {
    const costBasis = Number(r.cost_basis) || 0
    const curValue = Number(r.cur_value) || 0
    return {
      rank: Number(r.rank) + offset,
      wallet: r.wallet,
      legs: r.legs,
      pool: r.pool || null,
      balance: r.balance == null ? null : Number(r.balance) / Math.pow(10, leg === 'short' ? mres.rows[0].mint_b_decimals : leg === 'long' ? mres.rows[0].mint_a_decimals : 9),
      avgEntry: r.avg_entry == null ? null : Number(r.avg_entry),
      currentPrice: r.cur_price == null ? null : Number(r.cur_price),
      costBasis,
      curValue,
      realizedPnl: Number(r.realized) || 0,
      unrealizedPnl: Number(r.unrealized) || 0,
      pnl: Number(r.pnl) || 0,
      roi: r.roi == null ? null : Number(r.roi),
      buys: r.buys, sells: r.sells,
      approx: r.approx === true,
      noBasis: costBasis <= 0 && curValue > 0,
      holding: r.holding === 1,
      firstAt: r.first_at ? new Date(r.first_at).getTime() : null,
      lastAt: r.last_at ? new Date(r.last_at).getTime() : null,
    }
  })

  return {
    market, leg, currentPrice, quote: 'USDC',
    totals: {
      traders: t.traders || 0, holders: t.holders || 0,
      openValue: Number(t.open_value) || 0, costBasis: Number(t.cost_basis) || 0,
      realized: Number(t.realized) || 0, unrealized: Number(t.unrealized) || 0,
      pnl: Number(t.pnl) || 0, winners: t.winners || 0, losers: t.losers || 0,
    },
    rows,
    nextOffset: rows.length === limit ? offset + limit : null,
    asOf: Date.now(),
  }
}

// Leg-token price history from executed fills (real prices over time), plus the
// connected wallet's own fills as entry markers. Powers the /trade chart so a
// trader sees the instrument they hold + where they entered.
const TF_INTERVAL = { '1m': '1 minute', '5m': '5 minutes', '30m': '30 minutes', '1h': '1 hour', '4h': '4 hours', '1d': '1 day', '1w': '7 days', '1mo': '30 days', all: null }
async function legPrice({ market, leg, wallet, limit, tf }) {
  await ensureSchema()
  if (leg !== 'long' && leg !== 'short') leg = 'long'
  limit = Math.min(Math.max(parseInt(limit, 10) || 500, 10), 2000)
  // timeframe filter from a whitelist (safe to inline — not raw user input)
  const iv = Object.prototype.hasOwnProperty.call(TF_INTERVAL, tf) ? TF_INTERVAL[tf] : '1 day'
  const sinceClause = iv ? `AND block_time >= NOW() - INTERVAL '${iv}'` : ''
  // latest `limit` fills (newest first), then flip to chronological for the chart
  const sr = await query(
    `SELECT EXTRACT(EPOCH FROM block_time) * 1000 AS t, exec_price AS price
       FROM lev_position_events
      WHERE market = $1 AND leg = $2 AND exec_price IS NOT NULL AND exec_price > 0 ${sinceClause}
      ORDER BY block_time DESC LIMIT $3`,
    [market, leg, limit],
  )
  const points = sr.rows.map((r) => ({ t: Math.round(Number(r.t)), price: Number(r.price) })).reverse()
  let trades = []
  if (wallet) {
    const tr = await query(
      `SELECT EXTRACT(EPOCH FROM block_time) * 1000 AS t, exec_price AS price, kind, token_delta
         FROM lev_position_events
        WHERE market = $1 AND leg = $2 AND wallet = $3 AND exec_price IS NOT NULL AND exec_price > 0 ${sinceClause}
        ORDER BY block_time ASC LIMIT 200`,
      [market, leg, wallet],
    )
    trades = tr.rows.map((r) => ({
      t: Math.round(Number(r.t)), price: Number(r.price),
      side: Number(r.token_delta) >= 0 ? 'buy' : 'sell', kind: r.kind,
    }))
  }
  return { market, leg, points, trades, asOf: Date.now() }
}

// Live global tape — most-recent buy/sell fills across ALL markets + wallets.
async function recentTrades({ limit, market }) {
  await ensureSchema()
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const params = [limit]
  let where = ''
  if (market) { params.push(market); where = `AND e.market = $${params.length}` }
  const r = await query(
    `SELECT e.block_time, e.market, m.sym, e.leg, e.kind, e.wallet, e.exec_price,
            e.token_delta, e.quote_delta, m.mint_a_decimals, m.mint_b_decimals
       FROM lev_position_events e
       LEFT JOIN lev_markets m ON m.config = e.market
      WHERE e.kind IN ('buy', 'sell') AND e.exec_price IS NOT NULL AND e.exec_price > 0 ${where}
      ORDER BY e.block_time DESC LIMIT $1`,
    params,
  )
  return {
    trades: r.rows.map((x) => {
      const dec = (x.leg === 'short' ? x.mint_b_decimals : x.mint_a_decimals) || 6
      return {
        t: new Date(x.block_time).getTime(),
        market: x.sym || String(x.market).slice(0, 6),
        config: x.market,
        leg: x.leg,
        side: Number(x.token_delta) >= 0 ? 'buy' : 'sell',
        wallet: x.wallet,
        price: Number(x.exec_price),
        size: x.token_delta == null ? null : Math.abs(Number(x.token_delta)) / Math.pow(10, dec),
        usd: x.quote_delta == null ? null : Math.abs(Number(x.quote_delta)) / 1e6,
      }
    }),
    asOf: Date.now(),
  }
}

// Comments / trollbox — persisted in lev_comments (durable, full history).
async function insertComment(c) {
  await ensureSchema()
  await query(
    `INSERT INTO lev_comments (sig, wallet, ca, side, text, parent_sig, is_global, block_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8 / 1000.0))
     ON CONFLICT (sig) DO NOTHING`,
    [c.sig, c.wallet, c.ca, c.side || null, c.text, c.parent || null, !!c.global, c.t || Date.now()],
  )
}
async function commentsForMarket({ mints, roles, limit }) {
  await ensureSchema()
  limit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500)
  if (!mints || !mints.length) return { comments: [] }
  // expand mints into $2,$3,… placeholders (robust — no array-param quirks)
  const params = [limit]
  const ph = mints.map((m) => { params.push(m); return '$' + params.length }).join(',')
  const r = await query(
    `SELECT sig, wallet, ca, side, text, parent_sig, EXTRACT(EPOCH FROM block_time) * 1000 AS t
       FROM lev_comments WHERE is_global = FALSE AND ca IN (${ph})
      ORDER BY block_time DESC LIMIT $1`,
    params,
  )
  return {
    comments: r.rows.map((x) => ({
      sig: x.sig, wallet: x.wallet, ca: x.ca,
      side: (roles && roles[x.ca]) || x.side || 'long',
      text: x.text, parent: x.parent_sig, t: Math.round(Number(x.t)),
    })),
  }
}
async function trollbox({ limit }) {
  await ensureSchema()
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300)
  const r = await query(
    `SELECT sig, wallet, text, parent_sig, EXTRACT(EPOCH FROM block_time) * 1000 AS t
       FROM lev_comments WHERE is_global = TRUE ORDER BY block_time DESC LIMIT $1`,
    [limit],
  )
  return { messages: r.rows.map((x) => ({ sig: x.sig, wallet: x.wallet, text: x.text, parent: x.parent_sig, t: Math.round(Number(x.t)) })) }
}

module.exports = { listMarkets, syncMarketMeta, table, legPrice, recentTrades, insertComment, commentsForMarket, trollbox, LEGS }
