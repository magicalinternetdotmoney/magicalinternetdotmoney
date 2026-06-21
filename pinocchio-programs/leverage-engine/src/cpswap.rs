//! Raydium CP-Swap pool reads — spot mid from vault reserves (and optional
//! observation account for future TWAP). Program id matches `cpswap_cpi.rs`.

use pinocchio::{error::ProgramError, AccountView, Address};
use leverage_math::WAD;

pub const CP_SWAP_ID: Address = Address::from_str_const("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

// Packed `PoolState` field offsets (8-byte disc + fields through token_1_mint).
const POOL_MIN_LEN: usize = 8 + 32 * 5;
const O_TOKEN0_VAULT: usize = 8 + 64;
const O_TOKEN1_VAULT: usize = 8 + 96;
const O_TOKEN0_MINT: usize = 8 + 160;
const O_TOKEN1_MINT: usize = 8 + 192;

#[inline(always)]
fn rd_pubkey(d: &[u8], o: usize) -> Result<Address, ProgramError> {
    let bytes: [u8; 32] = d
        .get(o..o + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok(Address::from(bytes))
}

/// Token-0 / token-1 vault ATAs from a CP-Swap `PoolState` account.
pub fn pool_vaults(data: &[u8]) -> Result<(Address, Address), ProgramError> {
    if data.len() < POOL_MIN_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok((rd_pubkey(data, O_TOKEN0_VAULT)?, rd_pubkey(data, O_TOKEN1_VAULT)?))
}

/// Canonical mint ordering in the pool (token_0 is byte-smaller).
pub fn pool_mints(data: &[u8]) -> Result<(Address, Address), ProgramError> {
    if data.len() < POOL_MIN_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok((rd_pubkey(data, O_TOKEN0_MINT)?, rd_pubkey(data, O_TOKEN1_MINT)?))
}

/// Quote per base, WAD-scaled. Caller picks which vault is base vs quote.
pub fn price_wad(base_reserve: u64, quote_reserve: u64) -> Option<u128> {
    if base_reserve == 0 {
        return None;
    }
    (quote_reserve as u128)
        .checked_mul(WAD)?
        .checked_div(base_reserve as u128)
}

/// Validate pool owner/id and return vault pubkeys.
pub fn validate_pool(pool: &AccountView, expected: &Address) -> Result<(Address, Address), ProgramError> {
    if pool.address() != expected || pool.owner() != &CP_SWAP_ID {
        return Err(ProgramError::InvalidAccountData);
    }
    pool_vaults(pool.try_borrow()?.as_ref())
}

/// Spot price with `base_mint` as the numerator token (quote per base, WAD).
pub fn spot_for_mints(
    pool_data: &[u8],
    base_mint: &Address,
    quote_mint: &Address,
    vault0_amt: u64,
    vault1_amt: u64,
) -> Result<u128, ProgramError> {
    let (t0, t1) = pool_mints(pool_data)?;
    let (base_res, quote_res) = if &t0 == base_mint && &t1 == quote_mint {
        (vault0_amt, vault1_amt)
    } else if &t1 == base_mint && &t0 == quote_mint {
        (vault1_amt, vault0_amt)
    } else {
        return Err(ProgramError::InvalidAccountData);
    };
    price_wad(base_res, quote_res).ok_or(ProgramError::InvalidAccountData)
}