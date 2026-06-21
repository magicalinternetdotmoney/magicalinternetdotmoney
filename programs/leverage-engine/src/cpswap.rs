//! Raydium CP-Swap (CPMM) interop constants + PDA derivation.
//!
//! We don't depend on the `raydium-cp-swap` crate (heavy, version-fragile);
//! instead we CPI / introspect by raw discriminator + account order taken from
//! the live on-chain IDL (`harness/artifacts/raydium_cp_swap.json`).

use anchor_lang::prelude::*;

/// Raydium CP-Swap program id (mainnet).
pub const CP_SWAP_ID: Pubkey = anchor_lang::solana_program::pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

/// Pool-creation fee receiver (a global program constant; an SPL token account).
/// Verified identical across sampled mainnet pools via gPA + creation-tx trace.
pub const CREATE_POOL_FEE: Pubkey = anchor_lang::solana_program::pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");

// --- anchor instruction discriminators = sha256("global:<name>")[..8] ---
pub const IX_INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
pub const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
pub const IX_SWAP_BASE_INPUT: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];

// --- account indices within the `initialize` instruction (see IDL order) ---
// creator(0), amm_config(1), authority(2), pool_state(3),
// token_0_mint(4), token_1_mint(5), lp_mint(6), ...
pub const INIT_POOL_STATE: usize = 3;
pub const INIT_TOKEN0_MINT: usize = 4;
pub const INIT_TOKEN1_MINT: usize = 5;
/// Minimum account count we expect on a real `initialize` (full set is 20).
pub const INIT_MIN_ACCOUNTS: usize = 6;

// --- PDA seeds (must match the program) ---
pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const POOL_SEED: &[u8] = b"pool";
pub const LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const VAULT_SEED: &[u8] = b"pool_vault";
pub const OBSERVATION_SEED: &[u8] = b"observation";
pub const AMM_CONFIG_SEED: &[u8] = b"amm_config";

/// CP-Swap pool authority PDA (single, program-wide).
pub fn authority() -> Pubkey {
    Pubkey::find_program_address(&[AUTH_SEED], &CP_SWAP_ID).0
}

/// `amm_config` PDA for a config index.
pub fn amm_config(index: u16) -> Pubkey {
    Pubkey::find_program_address(&[AMM_CONFIG_SEED, &index.to_be_bytes()], &CP_SWAP_ID).0
}

/// `pool_state` PDA. Note: token_0 must be the byte-smaller mint.
pub fn pool_state(amm_config: &Pubkey, token_0: &Pubkey, token_1: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[POOL_SEED, amm_config.as_ref(), token_0.as_ref(), token_1.as_ref()],
        &CP_SWAP_ID,
    )
    .0
}

pub fn lp_mint(pool_state: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[LP_MINT_SEED, pool_state.as_ref()], &CP_SWAP_ID).0
}

pub fn pool_vault(pool_state: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, pool_state.as_ref(), mint.as_ref()], &CP_SWAP_ID).0
}

/// `observation_state` PDA — CP-Swap's on-chain TWAP oracle for the pool.
pub fn observation_state(pool_state: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[OBSERVATION_SEED, pool_state.as_ref()], &CP_SWAP_ID).0
}

/// Canonical CP-Swap token ordering: token_0 is the byte-smaller pubkey.
pub fn order_mints(x: Pubkey, y: Pubkey) -> (Pubkey, Pubkey) {
    if x.to_bytes() <= y.to_bytes() {
        (x, y)
    } else {
        (y, x)
    }
}

/// True if `{t0, t1}` is the unordered pair `{a, b}`.
pub fn is_pair(t0: &Pubkey, t1: &Pubkey, a: &Pubkey, b: &Pubkey) -> bool {
    (t0 == a && t1 == b) || (t0 == b && t1 == a)
}
