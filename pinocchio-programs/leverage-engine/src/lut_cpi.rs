//! Address Lookup Table program CPIs (create + extend), PDA-authority signed.
//! The protocol owns a persistent LUT (authority = `authority` PDA) so the
//! deposit/rebalance/hook v0 txs stay under the 1232-byte limit.

use pinocchio::{
    cpi::{invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};
use pinocchio::error::ProgramError;

pub const ALT_PROGRAM_ID: Address = Address::from_str_const("AddressLookupTab1e1111111111111111111111111");

/// Address Lookup Table metadata prefix — addresses start at this offset.
pub const LUT_META_SIZE: usize = 56;

/// Max addresses appended per `extend` call (keeps the instruction-data buffer on the stack).
pub const MAX_EXTEND: usize = 12;

/// Read the pubkey at `index` in a lookup table account (0-based).
#[inline(always)]
pub fn address_at(data: &[u8], index: usize) -> Result<Address, ProgramError> {
    let off = LUT_META_SIZE.saturating_add(index.saturating_mul(32));
    let bytes: [u8; 32] = data
        .get(off..off + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok(Address::from(bytes))
}

/// CPI `CreateLookupTable` (ix index 0): data = u32(0) | recent_slot(u64) | bump(u8).
/// accounts: [lut(w), authority(signer), payer(w,signer), system].
pub fn create(
    authority: &AccountView,
    payer: &AccountView,
    lut: &AccountView,
    system: &AccountView,
    recent_slot: u64,
    lut_bump: u8,
    authority_seeds: &[Seed],
) -> ProgramResult {
    let mut data = [0u8; 4 + 8 + 1];
    // index 0 = CreateLookupTable
    data[4..12].copy_from_slice(&recent_slot.to_le_bytes());
    data[12] = lut_bump;
    let metas = [
        InstructionAccount::writable(lut.address()),
        InstructionAccount::new(authority.address(), false, true),
        InstructionAccount::new(payer.address(), true, true),
        InstructionAccount::readonly(system.address()),
    ];
    let ix = InstructionView { program_id: &ALT_PROGRAM_ID, data: &data, accounts: &metas };
    let views: [&AccountView; 4] = [lut, authority, payer, system];
    invoke_signed(&ix, &views, &[Signer::from(authority_seeds)])
}

/// CPI `ExtendLookupTable` (ix index 2): data = u32(2) | num(u64) | addresses.
/// accounts: [lut(w), authority(signer), payer(w,signer), system].
pub fn extend(
    authority: &AccountView,
    payer: &AccountView,
    lut: &AccountView,
    system: &AccountView,
    addresses: &[u8], // packed 32-byte addresses
    authority_seeds: &[Seed],
) -> ProgramResult {
    if addresses.is_empty() || addresses.len() % 32 != 0 || addresses.len() > MAX_EXTEND * 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let n = (addresses.len() / 32) as u64;
    let mut data = [0u8; 4 + 8 + MAX_EXTEND * 32];
    data[0..4].copy_from_slice(&2u32.to_le_bytes()); // index 2 = ExtendLookupTable
    data[4..12].copy_from_slice(&n.to_le_bytes());
    data[12..12 + addresses.len()].copy_from_slice(addresses);
    let total = 12 + addresses.len();
    let metas = [
        InstructionAccount::writable(lut.address()),
        InstructionAccount::new(authority.address(), false, true),
        InstructionAccount::new(payer.address(), true, true),
        InstructionAccount::readonly(system.address()),
    ];
    let ix = InstructionView { program_id: &ALT_PROGRAM_ID, data: &data[..total], accounts: &metas };
    let views: [&AccountView; 4] = [lut, authority, payer, system];
    invoke_signed(&ix, &views, &[Signer::from(authority_seeds)])
}
