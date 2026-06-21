//! PumpSwap AMM pool layout — read on-chain reserves for the external price oracle.
//!
//! Program: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (mainnet + devnet).

use pinocchio::{error::ProgramError, AccountView, Address};
use leverage_math::WAD;

/// PumpSwap program id (constant-product AMM).
pub const PUMP_SWAP_ID: Address = Address::from_str_const("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

const POOL_MIN_LEN: usize = 211; // 8-byte disc + pool fields through lp_supply
const O_BASE_VAULT: usize = 139;
const O_QUOTE_VAULT: usize = 171;

#[inline(always)]
fn rd_pubkey(d: &[u8], o: usize) -> Result<Address, ProgramError> {
    let bytes: [u8; 32] = d
        .get(o..o + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok(Address::from(bytes))
}

/// Parse the base/quote vault ATAs stored in a PumpSwap `Pool` account.
pub fn pool_vaults(data: &[u8]) -> Result<(Address, Address), ProgramError> {
    if data.len() < POOL_MIN_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok((rd_pubkey(data, O_BASE_VAULT)?, rd_pubkey(data, O_QUOTE_VAULT)?))
}

/// Quote per base, WAD-scaled (`quote_reserve * WAD / base_reserve`).
pub fn price_wad(base_reserve: u64, quote_reserve: u64) -> Option<u128> {
    if base_reserve == 0 {
        return None;
    }
    (quote_reserve as u128)
        .checked_mul(WAD)?
        .checked_div(base_reserve as u128)
}

/// Validate a PumpSwap pool account and return its vault addresses.
pub fn validate_pool(pool: &AccountView, expected: &Address) -> Result<(Address, Address), ProgramError> {
    if pool.address() != expected || pool.owner() != &PUMP_SWAP_ID {
        return Err(ProgramError::InvalidAccountData);
    }
    pool_vaults(pool.try_borrow()?.as_ref())
}