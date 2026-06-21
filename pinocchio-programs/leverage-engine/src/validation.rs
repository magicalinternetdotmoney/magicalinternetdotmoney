//! Strict "pristine synthetic mint" validation.
//!
//! The client pre-creates `mintA`/`mintB` before calling us — Raydium creates the
//! pool vaults/lp/observation internally, so we only own the synthetic mints. We
//! refuse to launch unless those mints are exactly what we expect: PDA-controlled,
//! never pre-minted, unfreezable, plain.
//!
//! The synths are **legacy SPL Token** (NOT Token-2022) on purpose: the receipt's
//! transfer hook mints the synths from inside a Token-2022 transfer, and re-entering
//! Token-2022 there is forbidden — so the synths live on the legacy program and the
//! hook mints them without reentrancy. A legacy mint has no extensions (exactly 82
//! bytes); synth metadata is served off-chain via the indexer's /api/meta.

use pinocchio::{error::ProgramError, AccountView, Address};

/// Legacy SPL Token program id (the synths live here).
pub const TOKEN_LEGACY_ID: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// SPL Mint layout (legacy mint is exactly 82 bytes — no extensions).
const O_MINT_AUTH_OPT: usize = 0; // COption tag (4) @0, pubkey @4..36
const O_SUPPLY: usize = 36; // u64
const O_DECIMALS: usize = 44; // u8
const O_FREEZE_OPT: usize = 46; // COption tag (4) @46, pubkey @50..82
const MINT_LEN: usize = 82;

/// Validate that `av` is a pristine, PDA-controlled **legacy SPL Token** synthetic
/// mint: owned by the legacy Token program, supply 0, mint authority = the PDA,
/// no freeze authority, and exactly the 82-byte base layout (no extensions).
pub fn validate_synthetic_mint(
    av: &AccountView,
    authority: &Address,
    decimals: u8,
) -> Result<(), ProgramError> {
    if av.owner() != &TOKEN_LEGACY_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let d = av.try_borrow()?;
    // legacy mint is exactly 82 bytes — anything larger means an unexpected program/layout
    if d.len() != MINT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    // mint_authority must be Some(authority PDA)
    let auth_some = d[O_MINT_AUTH_OPT..O_MINT_AUTH_OPT + 4] == [1, 0, 0, 0];
    if !auth_some || &d[4..36] != authority.as_array() {
        return Err(ProgramError::InvalidAccountData);
    }
    // supply must be 0 (no pre-mint)
    if d[O_SUPPLY..O_SUPPLY + 8] != [0u8; 8] {
        return Err(ProgramError::InvalidAccountData);
    }
    // decimals must match
    if d[O_DECIMALS] != decimals {
        return Err(ProgramError::InvalidAccountData);
    }
    // freeze_authority must be None
    if d[O_FREEZE_OPT..O_FREEZE_OPT + 4] != [0, 0, 0, 0] {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

// SPL token Account layout (delegacy / state checks for pre-created ATAs).
const O_TA_MINT: usize = 0; // pubkey
const O_TA_OWNER: usize = 32; // pubkey
const O_TA_AMOUNT: usize = 64; // u64
const O_TA_DELEGATE_OPT: usize = 72; // COption tag (4) @72
const O_TA_STATE: usize = 108; // u8 (1 = Initialized, 2 = Frozen)
const TA_BASE_LEN: usize = 165;

/// Validate a pre-created token account: right mint+owner, no delegate, not frozen.
/// (`expected_amount` checked only when `check_amount`.)
pub fn validate_token_account(
    av: &AccountView,
    expected_mint: &Address,
    expected_owner: &Address,
    check_zero_amount: bool,
) -> Result<(), ProgramError> {
    let d = av.try_borrow()?;
    if d.len() < TA_BASE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if &d[O_TA_MINT..O_TA_MINT + 32] != expected_mint.as_array() {
        return Err(ProgramError::InvalidAccountData);
    }
    if &d[O_TA_OWNER..O_TA_OWNER + 32] != expected_owner.as_array() {
        return Err(ProgramError::InvalidAccountData);
    }
    // no delegate
    if d[O_TA_DELEGATE_OPT..O_TA_DELEGATE_OPT + 4] != [0, 0, 0, 0] {
        return Err(ProgramError::InvalidAccountData);
    }
    // initialized, not frozen
    if d[O_TA_STATE] != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    if check_zero_amount && d[O_TA_AMOUNT..O_TA_AMOUNT + 8] != [0u8; 8] {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}
