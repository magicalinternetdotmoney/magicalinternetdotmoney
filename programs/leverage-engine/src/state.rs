use anchor_lang::prelude::*;

/// Global protocol configuration and cached market state.
///
/// One instance per deployment, at PDA `["config"]`. Holds the synthetic pair,
/// the Raydium CP-Swap pool ids that form the triangle (used by the milestone-2
/// CPI layer), the cached oracle prices the rebalance reads, and the elastic
/// leverage parameters.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin authority (params, pause, oracle push until the on-chain TWAP read
    /// lands in milestone 2).
    pub admin: Pubkey,

    /// PDA (`["authority"]`) that is the mint authority of the synthetics +
    /// receipt and the owner of every protocol-held token account.
    pub authority: Pubkey,
    pub authority_bump: u8,
    pub config_bump: u8,

    // --- mints ---
    /// Base quote asset (USDC).
    pub usdc_mint: Pubkey,
    /// Leveraged-long synthetic.
    pub mint_a: Pubkey,
    /// Inverse synthetic.
    pub mint_b: Pubkey,
    /// Token-2022 receipt mint (carries the rebalancing transfer hook).
    pub receipt_mint: Pubkey,

    // --- protocol-held reserves (milestone 2: Raydium pool vaults) ---
    pub usdc_vault: Pubkey,
    pub reserve_a: Pubkey,
    pub reserve_b: Pubkey,

    // --- Raydium CP-Swap triangle (registered via introspection) ---
    pub pool_ab: Pubkey,
    pub pool_a_usdc: Pubkey,
    pub pool_b_usdc: Pubkey,

    /// Persistent Address Lookup Table (authority = `authority` PDA) holding the
    /// triangle + reserve + config accounts, so deposit/rebalance/hook v0 txs fit
    /// the 1232-byte size limit. `default()` until `init_lookup_table`.
    pub lookup_table: Pubkey,

    // --- oracle (cached) ---
    /// External oracle / TWAP source account.
    pub oracle: Pubkey,
    /// Reference price of the underlying at the *previous* rebalance (WAD, 1e9).
    pub price_last: u64,
    /// Most recent reference price pushed by the oracle crank (WAD, 1e9).
    pub price_now: u64,
    /// Unix ts of the last applied rebalance.
    pub last_rebalance_ts: i64,

    // --- elastic leverage parameters (bps; 10_000 == 1.0x) ---
    pub l_min_bps: u64,
    pub l_max_bps: u64,
    /// Max fraction of the loser reserve mintable in a single rebalance (bps).
    pub max_mint_bps: u64,
    /// Underlying move (bps) at/above which minting pauses (circuit breaker).
    pub breaker_bps: u64,
    /// Minimum seconds between applied rebalances.
    pub min_rebalance_interval: i64,

    // --- accounting / safety ---
    pub total_usdc_deposited: u64,
    pub total_minted_a: u64,
    pub total_minted_b: u64,
    pub paused: bool,

    /// Forward-compat padding.
    pub _reserved: [u8; 64],
}

/// Parameters accepted by `initialize_config`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitConfigParams {
    pub l_min_bps: u64,
    pub l_max_bps: u64,
    pub max_mint_bps: u64,
    pub breaker_bps: u64,
    pub min_rebalance_interval: i64,
    pub price_init: u64,
}
