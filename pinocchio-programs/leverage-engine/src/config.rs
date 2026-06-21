//! Protocol Config account — manual fixed-offset (de)serialization (no_std, zero
//! deps). One instance at PDA `["config"]`, owned by this program.

use pinocchio::{error::ProgramError, Address};

/// Legacy config size (all mainnet configs deployed before the PumpSwap oracle).
pub const CONFIG_MIN_SIZE: usize = 400;
/// Current config size — new inits allocate this; oracle fields live past byte 400.
pub const CONFIG_SIZE: usize = 432;
/// Marks an initialized config (byte 0).
pub const TAG_INITIALIZED: u8 = 1;

// Field byte offsets.
const O_TAG: usize = 0; // u8
const O_ADMIN: usize = 1; // [u8;32]
const O_AUTH_BUMP: usize = 33; // u8
const O_CFG_BUMP: usize = 34; // u8
const O_PAUSED: usize = 35; // u8
const O_USDC_MINT: usize = 36; // [u8;32]
const O_MINT_A: usize = 68;
const O_MINT_B: usize = 100;
const O_RECEIPT_MINT: usize = 132;
const O_POOL_AB: usize = 164;
const O_POOL_A_USDC: usize = 196;
const O_POOL_B_USDC: usize = 228;
const O_L_MIN: usize = 260; // u64
const O_L_MAX: usize = 268; // u64
const O_MAX_MINT: usize = 276; // u64
const O_BREAKER: usize = 284; // u64
const O_LAST_RATIO: usize = 292; // u128
const O_TOTAL_RECEIPT: usize = 308; // u64
const O_LOOKUP_TABLE: usize = 316; // [u8;32] — persistent PDA-authority LUT
const O_FEE_BPS: usize = 348; // u16 — deposit fee skimmed to the fee vault
const O_BUYBURN_POOL: usize = 350; // [u8;32] — the canonical MEME/quote pool for buy_burn
const O_ORACLE_POOL: usize = 382; // [u8;32] — external price oracle pool (PumpSwap)
const O_ORACLE_KIND: usize = 414; // u8 — 0=triangle-only, 1=pumpswap
const O_ORACLE_PRICE_LAST: usize = 415; // u128 — last oracle price (WAD, quote per base)

pub const ORACLE_NONE: u8 = 0;
pub const ORACLE_PUMPSWAP: u8 = 1;
/// Multivendor median index (`price_crawl` PDA + root LUT phone book).
pub const ORACLE_CRAWL: u8 = 2;

#[inline(always)]
fn rd_pubkey(d: &[u8], o: usize) -> Result<Address, ProgramError> {
    d.get(o..o + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::AccountDataTooSmall)
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

/// A typed view over a Config account's raw bytes.
pub struct Config<'a>(pub &'a [u8]);

impl<'a> Config<'a> {
    pub fn load(d: &'a [u8]) -> Result<Self, ProgramError> {
        if d.len() < CONFIG_MIN_SIZE || d[O_TAG] != TAG_INITIALIZED {
            return Err(ProgramError::UninitializedAccount);
        }
        Ok(Config(d))
    }
    pub fn admin(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_ADMIN) }
    pub fn auth_bump(&self) -> u8 { self.0[O_AUTH_BUMP] }
    pub fn cfg_bump(&self) -> u8 { self.0[O_CFG_BUMP] }
    pub fn paused(&self) -> bool { self.0[O_PAUSED] != 0 }
    pub fn usdc_mint(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_USDC_MINT) }
    pub fn mint_a(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_MINT_A) }
    pub fn mint_b(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_MINT_B) }
    pub fn receipt_mint(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_RECEIPT_MINT) }
    pub fn pool_ab(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_POOL_AB) }
    pub fn pool_a_usdc(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_POOL_A_USDC) }
    pub fn pool_b_usdc(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_POOL_B_USDC) }
    pub fn l_min_bps(&self) -> Result<u64, ProgramError> { rd_u64(self.0, O_L_MIN) }
    pub fn l_max_bps(&self) -> Result<u64, ProgramError> { rd_u64(self.0, O_L_MAX) }
    pub fn max_mint_bps(&self) -> Result<u64, ProgramError> { rd_u64(self.0, O_MAX_MINT) }
    pub fn breaker_bps(&self) -> Result<u64, ProgramError> { rd_u64(self.0, O_BREAKER) }
    pub fn last_ratio_wad(&self) -> Result<u128, ProgramError> { rd_u128(self.0, O_LAST_RATIO) }
    pub fn total_receipt(&self) -> Result<u64, ProgramError> { rd_u64(self.0, O_TOTAL_RECEIPT) }
    pub fn fee_bps(&self) -> u16 {
        u16::from_le_bytes([self.0[O_FEE_BPS], self.0[O_FEE_BPS + 1]])
    }
    pub fn buyburn_pool(&self) -> Result<Address, ProgramError> { rd_pubkey(self.0, O_BUYBURN_POOL) }
    pub fn oracle_pool(&self) -> Result<Address, ProgramError> {
        if self.0.len() < O_ORACLE_POOL + 32 {
            return Ok(Address::from([0u8; 32]));
        }
        rd_pubkey(self.0, O_ORACLE_POOL)
    }
    pub fn oracle_kind(&self) -> u8 {
        if self.0.len() <= O_ORACLE_KIND {
            return ORACLE_NONE;
        }
        let k = self.0[O_ORACLE_KIND];
        if (k == ORACLE_PUMPSWAP || k == ORACLE_CRAWL) && self.0.len() < O_ORACLE_PRICE_LAST + 16 {
            return ORACLE_NONE;
        }
        k
    }
    pub fn oracle_price_last_wad(&self) -> Result<u128, ProgramError> {
        if self.0.len() > O_ORACLE_PRICE_LAST + 15 {
            rd_u128(self.0, O_ORACLE_PRICE_LAST)
        } else {
            Ok(0)
        }
    }
    pub fn uses_oracle(&self) -> bool {
        self.oracle_kind() != ORACLE_NONE
    }
    pub fn lookup_table(&self) -> Result<Address, ProgramError> {
        if self.0.len() < O_LOOKUP_TABLE + 32 {
            return Ok(Address::from([0u8; 32]));
        }
        rd_pubkey(self.0, O_LOOKUP_TABLE)
    }
}

/// Parameters for `init_config`, parsed from instruction data (in declared order).
pub struct InitParams {
    pub admin: Address,
    pub auth_bump: u8,
    pub cfg_bump: u8,
    pub usdc_mint: Address,
    pub mint_a: Address,
    pub mint_b: Address,
    pub receipt_mint: Address,
    pub pool_ab: Address,
    pub pool_a_usdc: Address,
    pub pool_b_usdc: Address,
    pub l_min_bps: u64,
    pub l_max_bps: u64,
    pub max_mint_bps: u64,
    pub breaker_bps: u64,
    pub init_ratio_wad: u128,
    pub fee_bps: u16,
    pub buyburn_pool: Address,
    pub oracle_pool: Address,
    pub oracle_kind: u8,
    pub init_oracle_price_wad: u128,
}

/// Write a fresh, initialized Config into `d` (length must be `CONFIG_SIZE`).
pub fn write_init(d: &mut [u8], p: &InitParams) -> Result<(), ProgramError> {
    if d.len() < CONFIG_SIZE {
        return Err(ProgramError::AccountDataTooSmall);
    }
    d[O_TAG] = TAG_INITIALIZED;
    wr(d, O_ADMIN, p.admin.as_array());
    d[O_AUTH_BUMP] = p.auth_bump;
    d[O_CFG_BUMP] = p.cfg_bump;
    d[O_PAUSED] = 0;
    wr(d, O_USDC_MINT, p.usdc_mint.as_array());
    wr(d, O_MINT_A, p.mint_a.as_array());
    wr(d, O_MINT_B, p.mint_b.as_array());
    wr(d, O_RECEIPT_MINT, p.receipt_mint.as_array());
    wr(d, O_POOL_AB, p.pool_ab.as_array());
    wr(d, O_POOL_A_USDC, p.pool_a_usdc.as_array());
    wr(d, O_POOL_B_USDC, p.pool_b_usdc.as_array());
    wr(d, O_L_MIN, &p.l_min_bps.to_le_bytes());
    wr(d, O_L_MAX, &p.l_max_bps.to_le_bytes());
    wr(d, O_MAX_MINT, &p.max_mint_bps.to_le_bytes());
    wr(d, O_BREAKER, &p.breaker_bps.to_le_bytes());
    wr(d, O_LAST_RATIO, &p.init_ratio_wad.to_le_bytes());
    wr(d, O_TOTAL_RECEIPT, &0u64.to_le_bytes());
    wr(d, O_FEE_BPS, &p.fee_bps.to_le_bytes());
    wr(d, O_BUYBURN_POOL, p.buyburn_pool.as_array());
    if d.len() >= O_ORACLE_PRICE_LAST + 16 {
        wr(d, O_ORACLE_POOL, p.oracle_pool.as_array());
        d[O_ORACLE_KIND] = p.oracle_kind;
        wr(d, O_ORACLE_PRICE_LAST, &p.init_oracle_price_wad.to_le_bytes());
    }
    Ok(())
}

/// In-place setters used by the hot instructions.
pub fn set_last_ratio(d: &mut [u8], ratio_wad: u128) {
    wr(d, O_LAST_RATIO, &ratio_wad.to_le_bytes());
}
pub fn set_total_receipt(d: &mut [u8], total: u64) {
    wr(d, O_TOTAL_RECEIPT, &total.to_le_bytes());
}
pub fn set_paused(d: &mut [u8], paused: bool) {
    d[O_PAUSED] = paused as u8;
}
pub fn set_pools(d: &mut [u8], pool_ab: &Address, pool_a_usdc: &Address, pool_b_usdc: &Address) {
    wr(d, O_POOL_AB, pool_ab.as_array());
    wr(d, O_POOL_A_USDC, pool_a_usdc.as_array());
    wr(d, O_POOL_B_USDC, pool_b_usdc.as_array());
}
pub fn set_lookup_table(d: &mut [u8], lut: &Address) {
    wr(d, O_LOOKUP_TABLE, lut.as_array());
}
pub fn set_oracle_price_last(d: &mut [u8], price_wad: u128) {
    if d.len() > O_ORACLE_PRICE_LAST + 15 {
        wr(d, O_ORACLE_PRICE_LAST, &price_wad.to_le_bytes());
    }
}
pub fn set_oracle_kind(d: &mut [u8], kind: u8) {
    if d.len() > O_ORACLE_KIND {
        d[O_ORACLE_KIND] = kind;
    }
}
