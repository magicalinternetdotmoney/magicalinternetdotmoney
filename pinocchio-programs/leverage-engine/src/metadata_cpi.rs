//! Token-2022 TokenMetadata `UpdateField` CPI — lets the creating user set the
//! receipt token's metadata (name/symbol/uri). The receipt mint carries a
//! MetadataPointer → itself, so the metadata lives on the mint; its update
//! authority is the protocol `authority` PDA, so updates flow through the program.
//!
//! (mintA/mintB metadata are served dynamically off-chain via their MetadataPointer
//! uri — wired later.)

use pinocchio::{
    cpi::{invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};
use pinocchio::error::ProgramError;

/// Token-2022 program id.
pub const TOKEN_2022_ID: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// splDiscriminate("spl_token_metadata_interface:updating_field")
const D_UPDATE_FIELD: [u8; 8] = [221, 233, 49, 45, 181, 202, 220, 200];
// splDiscriminate("spl_token_metadata_interface:initialize_account")
const D_INITIALIZE: [u8; 8] = [210, 225, 30, 162, 88, 184, 77, 141];
const TAG_REALLOCATE: u8 = 29;
const EXT_TOKEN_METADATA: u16 = 19;

/// Max metadata value length we accept on-chain (name/symbol/uri are bounded).
const MAX_VALUE: usize = 256;

/// CPI Token-2022 `UpdateField` to set a standard metadata field on the mint.
/// `field`: 0 = Name, 1 = Symbol, 2 = Uri (matches the borsh `Field` unit variants).
/// `update_authority` (the protocol PDA) signs via `seeds`.
pub fn update_field(
    field: u8,
    value: &[u8],
    metadata_mint: &AccountView,
    update_authority: &AccountView,
    seeds: &[Seed],
) -> ProgramResult {
    if field > 2 || value.len() > MAX_VALUE {
        return Err(ProgramError::InvalidInstructionData);
    }
    // data: disc(8) | field(1) | value: borsh String (u32 len + bytes)
    let mut buf = [0u8; 8 + 1 + 4 + MAX_VALUE];
    buf[0..8].copy_from_slice(&D_UPDATE_FIELD);
    buf[8] = field;
    let vlen = value.len();
    buf[9..13].copy_from_slice(&(vlen as u32).to_le_bytes());
    buf[13..13 + vlen].copy_from_slice(value);
    let data = &buf[..13 + vlen];

    let metas = [
        InstructionAccount::writable(metadata_mint.address()), // metadata == mint (self pointer)
        InstructionAccount::new(update_authority.address(), false, true),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_ID, data, accounts: &metas };
    let views: [&AccountView; 2] = [metadata_mint, update_authority];
    invoke_signed(&ix, &views, &[Signer::from(seeds)])
}

#[inline(always)]
fn wr_u32(buf: &mut [u8], pos: &mut usize, v: u32) {
    buf[*pos..*pos + 4].copy_from_slice(&v.to_le_bytes());
    *pos += 4;
}

fn pack_init_data(name: &[u8], symbol: &[u8], uri: &[u8]) -> Result<([u8; 8 + 4 + 32 + 4 + 10 + 4 + 200], usize), ProgramError> {
    if name.len() > 32 || symbol.len() > 10 || uri.len() > 200 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut buf = [0u8; 8 + 4 + 32 + 4 + 10 + 4 + 200];
    let mut pos = 0;
    buf[pos..pos + 8].copy_from_slice(&D_INITIALIZE);
    pos += 8;
    wr_u32(&mut buf, &mut pos, name.len() as u32);
    buf[pos..pos + name.len()].copy_from_slice(name);
    pos += name.len();
    wr_u32(&mut buf, &mut pos, symbol.len() as u32);
    buf[pos..pos + symbol.len()].copy_from_slice(symbol);
    pos += symbol.len();
    wr_u32(&mut buf, &mut pos, uri.len() as u32);
    buf[pos..pos + uri.len()].copy_from_slice(uri);
    pos += uri.len();
    Ok((buf, pos))
}

/// Token-2022 `Reallocate` to add the TokenMetadata extension slot.
pub fn reallocate_token_metadata(
    mint: &AccountView,
    payer: &AccountView,
    owner: &AccountView,
    system: &AccountView,
    signers: &[Signer],
) -> ProgramResult {
    let data = [TAG_REALLOCATE, 19, 0]; // ExtensionType::TokenMetadata = 19 (u16 le)
    let metas = [
        InstructionAccount::writable(mint.address()),
        InstructionAccount::new(payer.address(), true, true),
        InstructionAccount::new(system.address(), false, false),
        InstructionAccount::new(owner.address(), false, true),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_ID, data: &data, accounts: &metas };
    let views: [&AccountView; 4] = [mint, payer, system, owner];
    invoke_signed(&ix, &views, signers)
}

/// Token-2022 `Initialize` token metadata (mint authority signs).
pub fn initialize_metadata(
    mint: &AccountView,
    update_authority: &AccountView,
    mint_authority: &AccountView,
    name: &[u8],
    symbol: &[u8],
    uri: &[u8],
    signers: &[Signer],
) -> ProgramResult {
    let (buf, len) = pack_init_data(name, symbol, uri)?;
    let data = &buf[..len];
    let metas = [
        InstructionAccount::writable(mint.address()),
        InstructionAccount::new(update_authority.address(), false, false),
        InstructionAccount::new(mint.address(), false, false),
        InstructionAccount::new(mint_authority.address(), false, true),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_ID, data, accounts: &metas };
    let views: [&AccountView; 4] = [mint, update_authority, mint, mint_authority];
    invoke_signed(&ix, &views, signers)
}
