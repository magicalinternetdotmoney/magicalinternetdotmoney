//! Multivendor price index PDA — cursor rotation, per-venue samples, median aggregate.
//!
//! Root LUT (in Config) is the phone book: `lut[cursor]` is the pool (or child LUT)
//! for this slot. `advance_crawl` / the transfer hook read one venue, store
//! `samples[cursor]`, bump cursor, and recompute `aggregate_wad` (median) on wrap.
//! Hook venue pubkeys (`O_HOOK_*`, offsets < 256) feed spl-token ExtraAccountMeta
//! discriminator-2 resolution on each receipt transfer.

use pinocchio::{error::ProgramError, Address};

pub const PRICE_CRAWL_SEED: &[u8] = b"price_crawl";
pub const MAX_ENTRIES: usize = 12;
pub const TAG_INITIALIZED: u8 = 1;

/// Venue layout tags — match arm in `advance_crawl` / hook price read.
pub const LAYOUT_NONE: u8 = 0;
/// Constant-product: pass two vault token accounts; price = quote/base reserves.
pub const LAYOUT_CPSWAP: u8 = 1;
pub const LAYOUT_PUMPSWAP: u8 = 2;
/// Concentrated / pool-state price (single pool account; hook_pool set, vaults zero).
pub const LAYOUT_AMM_POOL: u8 = 3;

/// Ignore empty/dead pools (synth anchor vaults can be very thin on mainnet).
pub const MIN_BASE_RESERVE: u64 = 100;

const O_TAG: usize = 0;
const O_CONFIG: usize = 1;
const O_CURSOR: usize = 33;
const O_PASS: usize = 34;
const O_NUM: usize = 42;
const O_AGG: usize = 43;
/// Active venue for transfer-hook account resolution (spl-token pubkeyData u8 offset).
const O_HOOK_POOL: usize = 59;
const O_HOOK_BASE_VAULT: usize = 91;
const O_HOOK_QUOTE_VAULT: usize = 123;
const O_LAYOUTS: usize = 155;
const O_SAMPLES: usize = 167; // 12 × (u128 + u64) = 288

pub const PRICE_CRAWL_SIZE: usize = 519;

#[inline(always)]
fn rd_pubkey(d: &[u8], o: usize) -> Result<Address, ProgramError> {
    let bytes: [u8; 32] = d
        .get(o..o + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::AccountDataTooSmall)?;
    Ok(Address::from(bytes))
}
#[inline(always)]
fn rd_u64(d: &[u8], o: usize) -> Result<u64, ProgramError> {
    d.get(o..o + 8)
        .and_then(|s| s.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or(ProgramError::AccountDataTooSmall)
}
#[inline(always)]
fn rd_u128(d: &[u8], o: usize) -> Result<u128, ProgramError> {
    d.get(o..o + 16)
        .and_then(|s| s.try_into().ok())
        .map(u128::from_le_bytes)
        .ok_or(ProgramError::AccountDataTooSmall)
}
#[inline(always)]
fn wr(d: &mut [u8], o: usize, bytes: &[u8]) {
    d[o..o + bytes.len()].copy_from_slice(bytes);
}

pub struct PriceCrawl<'a>(pub &'a [u8]);

impl<'a> PriceCrawl<'a> {
    pub fn load(d: &'a [u8]) -> Result<Self, ProgramError> {
        if d.len() < PRICE_CRAWL_SIZE || d[O_TAG] != TAG_INITIALIZED {
            return Err(ProgramError::UninitializedAccount);
        }
        Ok(PriceCrawl(d))
    }

    pub fn load_legacy(d: &'a [u8]) -> Result<Self, ProgramError> {
        if d.len() < 423 || d[O_TAG] != TAG_INITIALIZED {
            return Err(ProgramError::UninitializedAccount);
        }
        Ok(PriceCrawl(d))
    }

    pub fn config(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_CONFIG) }
    pub fn cursor(&self) -> u8 { self.0[O_CURSOR] }
    pub fn pass(&self) -> u64 { rd_u64(self.0, O_PASS).unwrap_or(0) }
    pub fn num_entries(&self) -> u8 { self.0[O_NUM] }
    pub fn aggregate_wad(&self) -> Result<u128, ProgramError> { rd_u128(self.0, O_AGG) }
    pub fn hook_pool(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_HOOK_POOL) }
    pub fn hook_base_vault(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_HOOK_BASE_VAULT) }
    pub fn hook_quote_vault(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_HOOK_QUOTE_VAULT) }

    pub fn entry_layout(&self, i: usize) -> u8 {
        if i >= MAX_ENTRIES {
            return LAYOUT_NONE;
        }
        if self.0.len() >= PRICE_CRAWL_SIZE {
            return self.0[O_LAYOUTS + i];
        }
        if self.0.len() >= 423 && i < MAX_ENTRIES {
            return self.0[123 + i];
        }
        LAYOUT_NONE
    }

    pub fn sample_price(&self, i: usize) -> Result<u128, ProgramError> {
        if i >= MAX_ENTRIES {
            return Ok(0);
        }
        let o = if self.0.len() >= PRICE_CRAWL_SIZE {
            O_SAMPLES + i * 24
        } else {
            135 + i * 24
        };
        rd_u128(self.0, o)
    }

    pub fn sample_slot(&self, i: usize) -> Result<u64, ProgramError> {
        if i >= MAX_ENTRIES {
            return Ok(0);
        }
        let o = if self.0.len() >= PRICE_CRAWL_SIZE {
            O_SAMPLES + i * 24 + 16
        } else {
            135 + i * 24 + 16
        };
        rd_u64(self.0, o)
    }
}

/// Offsets for spl-token `ExtraAccountMeta` discriminator-2 (pubkey from account data).
pub const HOOK_POOL_DATA_OFF: u8 = O_HOOK_POOL as u8;
pub const HOOK_BASE_VAULT_DATA_OFF: u8 = O_HOOK_BASE_VAULT as u8;
pub const HOOK_QUOTE_VAULT_DATA_OFF: u8 = O_HOOK_QUOTE_VAULT as u8;

pub struct InitCrawlParams {
    pub config: Address,
    pub num_entries: u8,
    pub layouts: [u8; MAX_ENTRIES],
    pub init_aggregate_wad: u128,
}

pub fn write_init(d: &mut [u8], p: &InitCrawlParams) -> Result<(), ProgramError> {
    if d.len() < PRICE_CRAWL_SIZE {
        return Err(ProgramError::AccountDataTooSmall);
    }
    let n = p.num_entries.min(MAX_ENTRIES as u8);
    d[O_TAG] = TAG_INITIALIZED;
    wr(d, O_CONFIG, p.config.as_array());
    d[O_CURSOR] = 0;
    wr(d, O_PASS, &0u64.to_le_bytes());
    d[O_NUM] = n;
    wr(d, O_AGG, &p.init_aggregate_wad.to_le_bytes());
    wr(d, O_HOOK_POOL, &[0u8; 32]);
    wr(d, O_HOOK_BASE_VAULT, &[0u8; 32]);
    wr(d, O_HOOK_QUOTE_VAULT, &[0u8; 32]);
    for i in 0..MAX_ENTRIES {
        d[O_LAYOUTS + i] = if (i as u8) < n { p.layouts[i] } else { LAYOUT_NONE };
    }
    for i in 0..MAX_ENTRIES {
        let o = O_SAMPLES + i * 24;
        wr(d, o, &0u128.to_le_bytes());
        wr(d, o + 16, &0u64.to_le_bytes());
    }
    Ok(())
}

pub fn set_entry_layout(d: &mut [u8], index: u8, layout: u8) -> Result<(), ProgramError> {
    if d.len() < PRICE_CRAWL_SIZE || d[O_TAG] != TAG_INITIALIZED {
        return Err(ProgramError::UninitializedAccount);
    }
    let n = d[O_NUM];
    if index >= n {
        return Err(ProgramError::InvalidInstructionData);
    }
    d[O_LAYOUTS + index as usize] = layout;
    Ok(())
}

pub fn store_sample_and_advance(
    d: &mut [u8],
    price_wad: u128,
    slot: u64,
    new_aggregate: u128,
) -> Result<(), ProgramError> {
    if d.len() < PRICE_CRAWL_SIZE || d[O_TAG] != TAG_INITIALIZED {
        return Err(ProgramError::UninitializedAccount);
    }
    let n = d[O_NUM] as usize;
    if n == 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    let cur = d[O_CURSOR] as usize;
    if cur >= n {
        return Err(ProgramError::InvalidAccountData);
    }
    let o = O_SAMPLES + cur * 24;
    wr(d, o, &price_wad.to_le_bytes());
    wr(d, o + 16, &slot.to_le_bytes());

    let next = ((cur + 1) % n) as u8;
    d[O_CURSOR] = next;
    if next == 0 {
        let pass = rd_u64(d, O_PASS)?.saturating_add(1);
        wr(d, O_PASS, &pass.to_le_bytes());
    }
    wr(d, O_AGG, &new_aggregate.to_le_bytes());
    Ok(())
}

pub fn set_hook_venue(
    d: &mut [u8],
    pool: &Address,
    base_vault: &Address,
    quote_vault: &Address,
) -> Result<(), ProgramError> {
    if d.len() < PRICE_CRAWL_SIZE {
        return Err(ProgramError::AccountDataTooSmall);
    }
    wr(d, O_HOOK_POOL, pool.as_array());
    wr(d, O_HOOK_BASE_VAULT, base_vault.as_array());
    wr(d, O_HOOK_QUOTE_VAULT, quote_vault.as_array());
    Ok(())
}

/// Hook path: two reserve token accounts only (`hook_pool` zeroed).
pub fn set_hook_reserves(d: &mut [u8], base_vault: &Address, quote_vault: &Address) -> Result<(), ProgramError> {
    set_hook_venue(d, &Address::from([0u8; 32]), base_vault, quote_vault)
}