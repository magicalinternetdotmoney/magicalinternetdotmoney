//! `MintTo` / `Burn` against **Token-2022**.
//!
//! Our synthetic mints (mintA/mintB), the receipt mint, and MEME are all Token-2022
//! (the receipt needs the transfer hook; the synths are validated as T22; MEME is a
//! T22 pump.fun mint). `pinocchio-token`'s built-in MintTo/Burn hardcode the LEGACY
//! SPL Token program id, which a Token-2022 mint rejects — so we issue these two
//! instructions directly against Token-2022. USDC moves stay on legacy `Transfer`.

use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

/// Token-2022 program id.
pub const TOKEN_2022_ID: Address =
    Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const TAG_MINT_TO: u8 = 7; // SPL/Token-2022 MintTo
const TAG_BURN: u8 = 8; // SPL/Token-2022 Burn

#[inline(always)]
fn ix9(tag: u8, amount: u64) -> [u8; 9] {
    let mut d = [0u8; 9];
    d[0] = tag;
    d[1..9].copy_from_slice(&amount.to_le_bytes());
    d
}

/// Token-2022 `MintTo`: mint `amount` of `mint` into `account`; `authority` signs
/// (pass `&[Signer::from(&seeds)]` for the PDA mint-authority).
pub fn mint_to(
    mint: &AccountView,
    account: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    let data = ix9(TAG_MINT_TO, amount);
    let metas = [
        InstructionAccount::writable(mint.address()),
        InstructionAccount::writable(account.address()),
        InstructionAccount::new(authority.address(), false, true),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[mint, account, authority], signers)
}

/// Token-2022 `Burn`: burn `amount` of `mint` from `account`; `authority` signs.
/// Pass `&[]` when the authority is a real transaction signer (user withdraw),
/// or `&[Signer::from(&seeds)]` when the PDA authority burns (buy_burn).
pub fn burn(
    account: &AccountView,
    mint: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    let data = ix9(TAG_BURN, amount);
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(mint.address()),
        InstructionAccount::new(authority.address(), false, true),
    ];
    let ix = InstructionView { program_id: &TOKEN_2022_ID, data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, mint, authority], signers)
}
