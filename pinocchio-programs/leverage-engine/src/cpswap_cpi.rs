//! Raw CP-Swap `deposit` / `withdraw` CPIs (no IDL crate — built from the live
//! account order + discriminators, validated on the fork).

use pinocchio::{
    cpi::{invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

/// Raydium CP-Swap program id.
pub const CP_SWAP_ID: Address = Address::from_str_const("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
/// SPL Memo program id.
pub const MEMO_ID: Address = Address::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const D_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const D_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const D_SWAP_BASE_INPUT: [u8; 8] = [143, 190, 90, 218, 196, 30, 51, 222];

/// CP-Swap `swap_base_input` — swap `amount_in` of the input token for ≥ `min_out`
/// of the output. `owner` (the PDA) signs via `seeds`. Used by `buy_burn`.
#[allow(clippy::too_many_arguments)]
pub fn swap_base_input(
    amount_in: u64,
    min_out: u64,
    owner: &AccountView,
    cp_authority: &AccountView,
    amm_config: &AccountView,
    pool: &AccountView,
    input_token_account: &AccountView,
    output_token_account: &AccountView,
    input_vault: &AccountView,
    output_vault: &AccountView,
    input_token_program: &AccountView,
    output_token_program: &AccountView,
    input_mint: &AccountView,
    output_mint: &AccountView,
    observation: &AccountView,
    seeds: &[Seed],
) -> ProgramResult {
    let mut data = [0u8; 24];
    data[0..8].copy_from_slice(&D_SWAP_BASE_INPUT);
    data[8..16].copy_from_slice(&amount_in.to_le_bytes());
    data[16..24].copy_from_slice(&min_out.to_le_bytes());
    let metas = [
        InstructionAccount::new(owner.address(), false, true),
        InstructionAccount::readonly(cp_authority.address()),
        InstructionAccount::readonly(amm_config.address()),
        InstructionAccount::writable(pool.address()),
        InstructionAccount::writable(input_token_account.address()),
        InstructionAccount::writable(output_token_account.address()),
        InstructionAccount::writable(input_vault.address()),
        InstructionAccount::writable(output_vault.address()),
        InstructionAccount::readonly(input_token_program.address()),
        InstructionAccount::readonly(output_token_program.address()),
        InstructionAccount::readonly(input_mint.address()),
        InstructionAccount::readonly(output_mint.address()),
        InstructionAccount::writable(observation.address()),
    ];
    let ix = InstructionView { program_id: &CP_SWAP_ID, data: &data, accounts: &metas };
    let views: [&AccountView; 13] = [
        owner, cp_authority, amm_config, pool, input_token_account, output_token_account,
        input_vault, output_vault, input_token_program, output_token_program, input_mint,
        output_mint, observation,
    ];
    invoke_signed(&ix, &views, &[Signer::from(seeds)])
}
/// CP-Swap `initialize` discriminator (for triangle introspection).
pub const IX_INITIALIZE: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
// account indices within `initialize`: pool_state=3, token_0_mint=4, token_1_mint=5
pub const INIT_POOL_STATE: usize = 3;
pub const INIT_TOKEN0: usize = 4;
pub const INIT_TOKEN1: usize = 5;

/// True if `{t0,t1}` is the unordered pair `{a,b}`.
pub fn is_pair(t0: &Address, t1: &Address, a: &Address, b: &Address) -> bool {
    (t0 == a && t1 == b) || (t0 == b && t1 == a)
}

/// True if `a` sorts before-or-equal `b` (CP-Swap token_0 is the byte-smaller mint).
#[inline(always)]
fn a_is_token0(a: &AccountView, b: &AccountView) -> bool {
    *a.address() <= *b.address()
}

fn lp_ix_data(disc: [u8; 8], lp_amount: u64, lim0: u64, lim1: u64) -> [u8; 32] {
    let mut d = [0u8; 32];
    d[0..8].copy_from_slice(&disc);
    d[8..16].copy_from_slice(&lp_amount.to_le_bytes());
    d[16..24].copy_from_slice(&lim0.to_le_bytes());
    d[24..32].copy_from_slice(&limend(lim1));
    d
}
#[inline(always)]
fn limend(x: u64) -> [u8; 8] {
    x.to_le_bytes()
}

/// CP-Swap `deposit` (add liquidity). `max_a`/`max_usdc` are the slippage caps on
/// the two sides; the pool pulls the amounts needed for `lp_amount`. Accounts are
/// reordered internally to CP-Swap's token_0 < token_1 convention. `owner` is the
/// PDA that signs via `seeds`.
#[allow(clippy::too_many_arguments)]
pub fn deposit<'a>(
    lp_amount: u64,
    max_a: u64,
    max_usdc: u64,
    owner: &AccountView,
    cp_authority: &AccountView,
    pool: &AccountView,
    owner_lp: &AccountView,
    owner_a: &AccountView,
    owner_usdc: &AccountView,
    vault_a: &AccountView,
    vault_usdc: &AccountView,
    mint_a: &AccountView,
    mint_usdc: &AccountView,
    lp_mint: &AccountView,
    token_program: &AccountView,
    token_program_2022: &AccountView,
    seeds: &[Seed],
) -> ProgramResult {
    let a0 = a_is_token0(mint_a, mint_usdc);
    let (oa0, oa1, v0, v1, m0, m1, lim0, lim1) = if a0 {
        (owner_a, owner_usdc, vault_a, vault_usdc, mint_a, mint_usdc, max_a, max_usdc)
    } else {
        (owner_usdc, owner_a, vault_usdc, vault_a, mint_usdc, mint_a, max_usdc, max_a)
    };
    let data = lp_ix_data(D_DEPOSIT, lp_amount, lim0, lim1);
    let metas = [
        InstructionAccount::new(owner.address(), false, true),
        InstructionAccount::readonly(cp_authority.address()),
        InstructionAccount::writable(pool.address()),
        InstructionAccount::writable(owner_lp.address()),
        InstructionAccount::writable(oa0.address()),
        InstructionAccount::writable(oa1.address()),
        InstructionAccount::writable(v0.address()),
        InstructionAccount::writable(v1.address()),
        InstructionAccount::readonly(token_program.address()),
        InstructionAccount::readonly(token_program_2022.address()),
        InstructionAccount::readonly(m0.address()),
        InstructionAccount::readonly(m1.address()),
        InstructionAccount::writable(lp_mint.address()),
    ];
    let ix = InstructionView { program_id: &CP_SWAP_ID, data: &data, accounts: &metas };
    let views: [&AccountView; 13] = [
        owner, cp_authority, pool, owner_lp, oa0, oa1, v0, v1, token_program, token_program_2022,
        m0, m1, lp_mint,
    ];
    invoke_signed(&ix, &views, &[Signer::from(seeds)])
}

/// CP-Swap `withdraw` (redeem LP). `min_a`/`min_usdc` are slippage floors.
#[allow(clippy::too_many_arguments)]
pub fn withdraw<'a>(
    lp_amount: u64,
    min_a: u64,
    min_usdc: u64,
    owner: &AccountView,
    cp_authority: &AccountView,
    pool: &AccountView,
    owner_lp: &AccountView,
    owner_a: &AccountView,
    owner_usdc: &AccountView,
    vault_a: &AccountView,
    vault_usdc: &AccountView,
    mint_a: &AccountView,
    mint_usdc: &AccountView,
    lp_mint: &AccountView,
    token_program: &AccountView,
    token_program_2022: &AccountView,
    memo_program: &AccountView,
    seeds: &[Seed],
) -> ProgramResult {
    let a0 = a_is_token0(mint_a, mint_usdc);
    let (oa0, oa1, v0, v1, m0, m1, lim0, lim1) = if a0 {
        (owner_a, owner_usdc, vault_a, vault_usdc, mint_a, mint_usdc, min_a, min_usdc)
    } else {
        (owner_usdc, owner_a, vault_usdc, vault_a, mint_usdc, mint_a, min_usdc, min_a)
    };
    let data = lp_ix_data(D_WITHDRAW, lp_amount, lim0, lim1);
    let metas = [
        InstructionAccount::new(owner.address(), false, true),
        InstructionAccount::readonly(cp_authority.address()),
        InstructionAccount::writable(pool.address()),
        InstructionAccount::writable(owner_lp.address()),
        InstructionAccount::writable(oa0.address()),
        InstructionAccount::writable(oa1.address()),
        InstructionAccount::writable(v0.address()),
        InstructionAccount::writable(v1.address()),
        InstructionAccount::readonly(token_program.address()),
        InstructionAccount::readonly(token_program_2022.address()),
        InstructionAccount::readonly(m0.address()),
        InstructionAccount::readonly(m1.address()),
        InstructionAccount::writable(lp_mint.address()),
        InstructionAccount::readonly(memo_program.address()),
    ];
    let ix = InstructionView { program_id: &CP_SWAP_ID, data: &data, accounts: &metas };
    let views: [&AccountView; 14] = [
        owner, cp_authority, pool, owner_lp, oa0, oa1, v0, v1, token_program, token_program_2022,
        m0, m1, lp_mint, memo_program,
    ];
    invoke_signed(&ix, &views, &[Signer::from(seeds)])
}
