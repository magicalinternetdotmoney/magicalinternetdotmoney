//! Metaplex Token Metadata `CreateMetadataAccountV3` CPI — backfill on-chain metadata
//! for mints whose authority already lives at the protocol `authority` PDA.

use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};
use pinocchio::error::ProgramError;

pub const METAPLEX_ID: Address =
    Address::from_str_const("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const SYSTEM_ID: Address =
    Address::from_str_const("11111111111111111111111111111111");

const DISC_CREATE_V3: u8 = 33;
const MAX_NAME: usize = 32;
const MAX_SYMBOL: usize = 10;
const MAX_URI: usize = 200;
// disc(1) + name(4+32) + symbol(4+10) + uri(4+200) + fee(2) + opts(4) + mut(1) + details(1)
const MAX_DATA: usize = 1 + 4 + MAX_NAME + 4 + MAX_SYMBOL + 4 + MAX_URI + 2 + 4 + 1 + 1;

#[inline(always)]
fn wr_u32(buf: &mut [u8], pos: &mut usize, v: u32) {
    buf[*pos..*pos + 4].copy_from_slice(&v.to_le_bytes());
    *pos += 4;
}

fn pack_create_v3(name: &[u8], symbol: &[u8], uri: &[u8]) -> Result<([u8; MAX_DATA], usize), ProgramError> {
    if name.len() > MAX_NAME || symbol.len() > MAX_SYMBOL || uri.len() > MAX_URI {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut buf = [0u8; MAX_DATA];
    let mut pos = 0;
    buf[pos] = DISC_CREATE_V3;
    pos += 1;
    wr_u32(&mut buf, &mut pos, name.len() as u32);
    buf[pos..pos + name.len()].copy_from_slice(name);
    pos += name.len();
    wr_u32(&mut buf, &mut pos, symbol.len() as u32);
    buf[pos..pos + symbol.len()].copy_from_slice(symbol);
    pos += symbol.len();
    wr_u32(&mut buf, &mut pos, uri.len() as u32);
    buf[pos..pos + uri.len()].copy_from_slice(uri);
    pos += uri.len();
    // seller_fee_basis_points = 0
    pos += 2;
    // creators / collection / uses = None
    buf[pos] = 0;
    pos += 1;
    buf[pos] = 0;
    pos += 1;
    buf[pos] = 0;
    pos += 1;
    // is_mutable = true
    buf[pos] = 1;
    pos += 1;
    // collection_details = None
    buf[pos] = 0;
    pos += 1;
    Ok((buf, pos))
}

/// CPI Metaplex `CreateMetadataAccountV3`. `mint_authority` (the protocol PDA) signs.
pub fn create_metadata_v3(
    metadata: &AccountView,
    mint: &AccountView,
    mint_authority: &AccountView,
    payer: &AccountView,
    update_authority: &AccountView,
    system_program: &AccountView,
    name: &[u8],
    symbol: &[u8],
    uri: &[u8],
    signers: &[Signer],
) -> ProgramResult {
    let (buf, len) = pack_create_v3(name, symbol, uri)?;
    let data = &buf[..len];
    let metas = [
        InstructionAccount::writable(metadata.address()),
        InstructionAccount::new(mint.address(), false, false),
        InstructionAccount::new(mint_authority.address(), false, true),
        InstructionAccount::new(payer.address(), true, true), // payer must sign in CPI
        InstructionAccount::new(update_authority.address(), false, false),
        InstructionAccount::new(system_program.address(), false, false),
    ];
    let ix = InstructionView {
        program_id: &METAPLEX_ID,
        data,
        accounts: &metas,
    };
    let views: [&AccountView; 6] = [metadata, mint, mint_authority, payer, update_authority, system_program];
    invoke_signed(&ix, &views, signers)
}