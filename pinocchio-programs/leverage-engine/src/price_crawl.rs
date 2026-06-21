//! Multivendor price index PDA — cursor rotation, per-venue samples, median aggregate.
//!
//! Root LUT (in Config) is the phone book: `lut[cursor]` is the pool (or child LUT)
//! for this slot. `advance_crawl` reads one venue, stores `samples[cursor]`, bumps
//! cursor, and recomputes `aggregate_wad` (median) when the pass wraps.

use pinocchio::{error::ProgramError, Address};

pub const PRICE_CRAWL_SEED: &[u8] = b"price_crawl";
pub const MAX_ENTRIES: usize = 12;
pub const TAG_INITIALIZED: u8 = 1;

/// Venue layout tags — match arm in `advance_crawl`.
pub const LAYOUT_NONE: u8 = 0;
pub const LAYOUT_CPSWAP: u8 = 1;
pub const LAYOUT_PUMPSWAP: u8 = 2;

/// Ignore empty/dead pools (synth anchor vaults can be very thin on mainnet).
pub const MIN_BASE_RESERVE: u64 = 100;

const O_TAG: usize = 0;
const O_CONFIG: usize = 1;
const O_CURSOR: usize = 33;
const O_PASS: usize = 34;
const O_NUM: usize = 42;
const O_AGG: usize = 43;
const O_BASE_MINT: usize = 59;
const O_QUOTE_MINT: usize = 91;
const O_LAYOUTS: usize = 123;
const O_SAMPLES: usize = 135; // 12 × (u128 + u64) = 288 → total 423

pub const PRICE_CRAWL_SIZE: usize = 423;

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

    pub fn config(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_CONFIG) }
    pub fn cursor(&self) -> u8 { self.0[O_CURSOR] }
    pub fn pass(&self) -> u64 { rd_u64(self.0, O_PASS).unwrap_or(0) }
    pub fn num_entries(&self) -> u8 { self.0[O_NUM] }
    pub fn aggregate_wad(&self) -> Result<u128, ProgramError> { rd_u128(self.0, O_AGG) }
    pub fn base_mint(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_BASE_MINT) }
    pub fn quote_mint(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_QUOTE_MINT) }

    pub fn entry_layout(&self, i: usize) -> u8 {
        if i >= MAX_ENTRIES {
            return LAYOUT_NONE;
        }
        self.0[O_LAYOUTS + i]
    }

    pub fn sample_price(&self, i: usize) -> Result<u128, ProgramError> {
        if i >= MAX_ENTRIES {
            return Ok(0);
        }
        rd_u128(self.0, O_SAMPLES + i * 24)
    }

    pub fn sample_slot(&self, i: usize) -> Result<u64, ProgramError> {
        if i >= MAX_ENTRIES {
            return Ok(0);
        }
        rd_u64(self.0, O_SAMPLES + i * 24 + 16)
    }
}

pub struct InitCrawlParams {
    pub config: Address,
    pub base_mint: Address,
    pub quote_mint: Address,
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
    wr(d, O_BASE_MINT, p.base_mint.as_array());
    wr(d, O_QUOTE_MINT, p.quote_mint.as_array());
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