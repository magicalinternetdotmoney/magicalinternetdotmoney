// Postgres layer for the per-market long/short/lp leaderboards.
//
// One Neon database, four tables:
//   lev_markets          — cache of each on-chain Config (pair) + derived pools/LP mints
//   lev_position_events  — one row per (sig, ix, market, leg, wallet) balance change.
//     This is the immutable ledger the indexer appends to; the summary is a
//     pure fold over it, so a re-fold is always possible after a logic change.
//   lev_positions        — per (market, leg, wallet) rolled-up cost basis + balance.
//   lev_index_state      — per-source signature cursor for incremental + backfill.
//
// Cost-basis numeraire is the pair's QUOTE asset (USDC, 6dp). Long/short legs
// trade against USDC on the aq/bq CP-Swap pools, so each fill's executed price
// (quote_delta / token_delta) is recovered directly from that tx's balance
// deltas — more accurate than any oracle. LP positions are two-sided; their
// quote-equivalent cost is approximated (see indexer.js) and flagged.

const { Pool } = require('pg')

let pool = null
function getPool() {
  if (pool) return pool
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL
  if (!url) throw new Error('DATABASE_URL not set')
  // Neon pooled endpoint; keep the pool tiny — this process also runs the
  // site's RPC indexer, so we don't want to hog connections.
  pool = new Pool({ connectionString: url, max: 4 })
  return pool
}

async function query(text, params) {
  return getPool().query(text, params)
}

let schemaReady = null
async function ensureSchema() {
  if (schemaReady) return schemaReady
  schemaReady = (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS lev_markets (
        config           TEXT PRIMARY KEY,
        receipt_mint     TEXT NOT NULL,
        sym              TEXT,
        name             TEXT,
        mint_a           TEXT NOT NULL,
        mint_b           TEXT NOT NULL,
        quote_mint       TEXT NOT NULL,
        mint_a_decimals  INT  NOT NULL DEFAULT 6,
        mint_b_decimals  INT  NOT NULL DEFAULT 6,
        quote_decimals   INT  NOT NULL DEFAULT 6,
        pool_ab          TEXT,
        pool_aq          TEXT,
        pool_bq          TEXT,
        lp_ab            TEXT,
        lp_aq            TEXT,
        lp_bq            TEXT,
        underlying_mint  TEXT,
        underlying_symbol TEXT,
        sym              TEXT,
        name             TEXT,
        logo             TEXT,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- Display metadata, written by the site from its REGISTRY so the markets
      -- list can be searched / sorted in SQL (scales past a chip selector).
      ALTER TABLE lev_markets ADD COLUMN IF NOT EXISTS sym TEXT;
      ALTER TABLE lev_markets ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE lev_markets ADD COLUMN IF NOT EXISTS logo TEXT;
      CREATE INDEX IF NOT EXISTS lev_markets_sym_idx ON lev_markets(LOWER(sym));

      -- Immutable per-fill ledger. (sig, ix_index, market, leg, wallet) is the
      -- natural key: one tx can move a wallet's long AND short AND LP balances,
      -- and a router can swap the same leg twice in one tx (distinct ix_index).
      CREATE TABLE IF NOT EXISTS lev_position_events (
        sig          TEXT NOT NULL,
        ix_index     INT  NOT NULL DEFAULT 0,
        market       TEXT NOT NULL,
        leg          TEXT NOT NULL,         -- 'long' | 'short' | 'lp'
        pool         TEXT,                  -- for lp: which CP-Swap pool; else NULL
        wallet       TEXT NOT NULL,
        slot         BIGINT NOT NULL,
        block_time   TIMESTAMPTZ NOT NULL,
        token_delta  NUMERIC NOT NULL,      -- signed leg-token atoms (+ in / − out)
        quote_delta  NUMERIC NOT NULL DEFAULT 0,  -- signed quote (USDC) atoms
        sol_delta    NUMERIC NOT NULL DEFAULT 0,   -- signed native lamports
        kind         TEXT NOT NULL,         -- buy|sell|lp_add|lp_remove|transfer_in|transfer_out
        exec_price   DOUBLE PRECISION,      -- quote per token for this fill (abs ratio) or NULL
        PRIMARY KEY (sig, ix_index, market, leg, wallet)
      );
      CREATE INDEX IF NOT EXISTS lev_pe_market_leg_idx ON lev_position_events(market, leg);
      CREATE INDEX IF NOT EXISTS lev_pe_wallet_idx ON lev_position_events(wallet);
      CREATE INDEX IF NOT EXISTS lev_pe_time_idx ON lev_position_events(block_time DESC);

      -- Migration: lev_positions gained a pool column in its PK (LP tokens from the
      -- aq/bq/ab pools are NOT fungible, so they must be split per pool). The
      -- table is a pure fold of the immutable event ledger, so dropping +
      -- re-folding is lossless. Drop only the legacy (no-pool-column) shape.
      DO $lev_pos_pool_mig$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='lev_positions')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name='lev_positions' AND column_name='pool') THEN
          DROP TABLE lev_positions;
        END IF;
      END $lev_pos_pool_mig$;

      -- Per (market, leg, pool, wallet) rollup. Folded from lev_position_events.
      -- pool = '' for long/short; the CP-Swap pool id for each lp position.
      CREATE TABLE IF NOT EXISTS lev_positions (
        market           TEXT NOT NULL,
        leg              TEXT NOT NULL,
        pool             TEXT NOT NULL DEFAULT '',
        wallet           TEXT NOT NULL,
        balance          NUMERIC NOT NULL DEFAULT 0,   -- live leg-token atoms held
        token_decimals   INT NOT NULL DEFAULT 6,
        qty_in           NUMERIC NOT NULL DEFAULT 0,    -- token atoms ever acquired
        qty_out          NUMERIC NOT NULL DEFAULT 0,    -- token atoms ever disposed
        quote_in         NUMERIC NOT NULL DEFAULT 0,    -- quote atoms paid (buys/adds)
        quote_out        NUMERIC NOT NULL DEFAULT 0,    -- quote atoms received (sells/removes)
        sol_in           NUMERIC NOT NULL DEFAULT 0,
        sol_out          NUMERIC NOT NULL DEFAULT 0,
        avg_entry        DOUBLE PRECISION,              -- quote per token (cost basis of held)
        realized_pnl     DOUBLE PRECISION NOT NULL DEFAULT 0, -- quote, from disposals
        cost_basis_quote DOUBLE PRECISION NOT NULL DEFAULT 0, -- quote cost of CURRENT balance
        buy_count        INT NOT NULL DEFAULT 0,
        sell_count       INT NOT NULL DEFAULT 0,
        approx           BOOLEAN NOT NULL DEFAULT FALSE, -- true when LP / routed entries approximated
        -- Marked-to-market snapshot, written by the reprice tick so the API can
        -- ORDER BY / paginate entirely in SQL (the scale-critical bit).
        cur_price        DOUBLE PRECISION,
        cur_value        DOUBLE PRECISION NOT NULL DEFAULT 0,
        unrealized_pnl   DOUBLE PRECISION NOT NULL DEFAULT 0,
        pnl              DOUBLE PRECISION NOT NULL DEFAULT 0,
        roi              DOUBLE PRECISION,
        priced_at        TIMESTAMPTZ,
        first_at         TIMESTAMPTZ,
        last_at          TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (market, leg, pool, wallet)
      );
      CREATE INDEX IF NOT EXISTS lev_pos_market_leg_idx ON lev_positions(market, leg);
      CREATE INDEX IF NOT EXISTS lev_pos_balance_idx ON lev_positions(market, leg, balance DESC);
      -- Sort indexes for the SQL-paginated leaderboard (scales with holder count).
      CREATE INDEX IF NOT EXISTS lev_pos_pnl_idx ON lev_positions(market, leg, pnl DESC);
      CREATE INDEX IF NOT EXISTS lev_pos_value_idx ON lev_positions(market, leg, cur_value DESC);

      -- Per-source signature cursor. source = e.g. 'long:<mintA>' | 'short:<mintB>'
      -- | 'lp:<lpMint>'. newest_sig is the most recent sig we've ingested
      -- (incremental head); oldest_sig + backfill_done track the tail walk.
      CREATE TABLE IF NOT EXISTS lev_index_state (
        source        TEXT PRIMARY KEY,
        newest_sig    TEXT,
        oldest_sig    TEXT,
        backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Comments / trollbox: 0.1-SOL+memo (per-market, ca=leg mint) or
      -- 0.01-SOL+memo (ca='global'). Persisted so history never ages out.
      CREATE TABLE IF NOT EXISTS lev_comments (
        sig         TEXT PRIMARY KEY,
        wallet      TEXT NOT NULL,
        ca          TEXT NOT NULL,            -- leg mint, or 'global'
        side        TEXT,                     -- long|short|NULL(global)
        text        TEXT NOT NULL,
        parent_sig  TEXT,
        is_global   BOOLEAN NOT NULL DEFAULT FALSE,
        block_time  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lev_comments_ca_idx ON lev_comments(ca, block_time DESC);
      CREATE INDEX IF NOT EXISTS lev_comments_global_idx ON lev_comments(is_global, block_time DESC);
    `)
  })()
  return schemaReady
}

module.exports = { getPool, query, ensureSchema }
