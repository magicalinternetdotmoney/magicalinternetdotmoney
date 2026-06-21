//! Pinocchio port of the leverage engine — same economics (`leverage_math`),
//! tiny binary for a cheap mainnet deploy (Anchor build ~390 KB → ~5.6 SOL; this
//! ~25–45 KB → <0.7 SOL).
//!
//! Instructions: 0=rebalance (oracle-free), 1=init_config, 2=deposit,
//! 3=withdraw, 4=set_paused. State lives in the `["config"]` PDA (manual serde,
//! `config.rs`). deposit/withdraw wrap the real CP-Swap deposit/withdraw CPIs
//! (`cpswap_cpi.rs`); the receipt token is the LP claim. Deposit fans 50/50 across
//! +/USDC and −/USDC; withdraw redeems Raydium LP, burns the +/- synth leg, and
//! returns quote to the user (protocol_usdc is pass-through only).
#![no_std]

mod config;
mod cpswap_cpi;
mod hook;
mod pumpswap;
mod lut_cpi;
mod metadata_cpi;
mod metaplex_cpi;
mod token_cpi;
mod validation;

use config::{Config, InitParams};
use leverage_math::{implied_market, partial_ratio_advance, plan_from_market, plan_two_pool_from_oracle_wad, Side, CRANK_ABSORB_BPS};
use config::{ORACLE_PUMPSWAP, ORACLE_NONE};
use pinocchio::{
    cpi::{Seed, Signer},
    entrypoint,
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
// Legacy SPL Token for USDC moves AND for the synthetic mints: the synths must be
// legacy so the transfer hook (invoked from within Token-2022) can mint them without
// re-entering Token-2022. Only the receipt mint and MEME (both Token-2022, only ever
// touched in top-level ixs) go through `token_cpi`. See token_cpi.rs.
use pinocchio_token::instructions::{Burn, MintTo, Transfer};

entrypoint!(process_instruction);

const TAG_REBALANCE: u8 = 0;
const TAG_INIT_CONFIG: u8 = 1;
const TAG_DEPOSIT: u8 = 2;
const TAG_WITHDRAW: u8 = 3;
const TAG_SET_PAUSED: u8 = 4;
const TAG_UPDATE_METADATA: u8 = 5;
const TAG_REGISTER_TRIANGLE: u8 = 6;
const TAG_INIT_EXTRA_METAS: u8 = 7;
const TAG_INIT_LUT: u8 = 8;
const TAG_EXTEND_LUT: u8 = 9;
const TAG_VALIDATE_MINTS: u8 = 10;
const TAG_BUY_BURN: u8 = 11;
const TAG_SEED_PAIR: u8 = 12;
const TAG_BACKFILL_METAPLEX: u8 = 13;
const TAG_BACKFILL_RECEIPT_T22: u8 = 14;

const CONFIG_SEED: &[u8] = b"config";
const AUTHORITY_SEED: &[u8] = b"authority";

const TOKEN_AMOUNT_OFFSET: usize = 64; // SPL Account.amount
const MINT_SUPPLY_OFFSET: usize = 36; // SPL Mint.supply

// ---- small readers ----
#[inline(always)]
fn du64(d: &[u8], o: usize) -> Result<u64, ProgramError> {
    d.get(o..o + 8).and_then(|s| s.try_into().ok()).map(u64::from_le_bytes).ok_or(ProgramError::InvalidInstructionData)
}
#[inline(always)]
fn du128(d: &[u8], o: usize) -> Result<u128, ProgramError> {
    d.get(o..o + 16).and_then(|s| s.try_into().ok()).map(u128::from_le_bytes).ok_or(ProgramError::InvalidInstructionData)
}
#[inline(always)]
fn acct_u64(av: &AccountView, o: usize) -> Result<u64, ProgramError> {
    let d = av.try_borrow()?;
    d.get(o..o + 8).and_then(|s| s.try_into().ok()).map(u64::from_le_bytes).ok_or(ProgramError::InvalidAccountData)
}
#[inline(always)]
fn token_amount(av: &AccountView) -> Result<u64, ProgramError> { acct_u64(av, TOKEN_AMOUNT_OFFSET) }
#[inline(always)]
fn mint_supply(av: &AccountView) -> Result<u64, ProgramError> { acct_u64(av, MINT_SUPPLY_OFFSET) }

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    // Token-2022 transfer-hook Execute is matched by its 8-byte discriminator.
    if data.len() >= 8 && data[..8] == hook::EXECUTE_DISC {
        return hook_execute(accounts);
    }
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match *tag {
        TAG_REBALANCE => rebalance(accounts, rest),
        TAG_INIT_CONFIG => init_config(program_id, accounts, rest),
        TAG_DEPOSIT => deposit(accounts, rest),
        TAG_WITHDRAW => withdraw(accounts, rest),
        TAG_SET_PAUSED => set_paused(accounts, rest),
        TAG_UPDATE_METADATA => update_metadata(accounts, rest),
        TAG_REGISTER_TRIANGLE => register_triangle(accounts),
        TAG_INIT_EXTRA_METAS => init_extra_account_metas(program_id, accounts, rest),
        TAG_INIT_LUT => init_lookup_table(accounts, rest),
        TAG_EXTEND_LUT => extend_lookup_table(accounts, rest),
        TAG_VALIDATE_MINTS => validate_mints(accounts, rest),
        TAG_BUY_BURN => buy_burn(accounts, rest),
        TAG_SEED_PAIR => seed_pair(accounts, rest),
        TAG_BACKFILL_METAPLEX => backfill_metaplex(accounts, rest),
        TAG_BACKFILL_RECEIPT_T22 => backfill_receipt_t22(accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// accounts: 0 admin(signer,w) 1 config(w) 2 usdc_mint 3 mint_a 4 mint_b
///           5 receipt_mint 6 pool_ab 7 pool_a_usdc 8 pool_b_usdc 9 system
/// data: auth_bump(1) cfg_bump(1) l_min(8) l_max(8) max_mint(8) breaker(8)
///       init_ratio(16) lamports(8)
fn init_config(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 9 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let admin = &accounts[0];
    let cfg = &accounts[1];
    let auth_bump = *d.first().ok_or(ProgramError::InvalidInstructionData)?;
    let cfg_bump = *d.get(1).ok_or(ProgramError::InvalidInstructionData)?;
    let params = InitParams {
        admin: *admin.address(),
        auth_bump,
        cfg_bump,
        usdc_mint: *accounts[2].address(),
        mint_a: *accounts[3].address(),
        mint_b: *accounts[4].address(),
        receipt_mint: *accounts[5].address(),
        pool_ab: *accounts[6].address(),
        pool_a_usdc: *accounts[7].address(),
        pool_b_usdc: *accounts[8].address(),
        l_min_bps: du64(d, 2)?,
        l_max_bps: du64(d, 10)?,
        max_mint_bps: du64(d, 18)?,
        breaker_bps: du64(d, 26)?,
        init_ratio_wad: du128(d, 34)?,
        // optional trailing fields (backward-compatible)
        fee_bps: if d.len() >= 60 { u16::from_le_bytes([d[58], d[59]]) } else { 0 },
        buyburn_pool: if d.len() >= 92 {
            Address::from(<[u8; 32]>::try_from(&d[60..92]).unwrap_or([0u8; 32]))
        } else {
            Address::from([0u8; 32])
        },
        oracle_pool: if d.len() >= 124 {
            Address::from(<[u8; 32]>::try_from(&d[92..124]).unwrap_or([0u8; 32]))
        } else {
            Address::from([0u8; 32])
        },
        oracle_kind: if d.len() >= 125 { d[124] } else { ORACLE_NONE },
        init_oracle_price_wad: if d.len() >= 141 {
            du128(d, 125)?
        } else {
            0
        },
    };
    let lamports = du64(d, 50)?;

    // Per-pair config PDA: ["config", receipt_mint]. Multiple pairs can coexist (one
    // config each). The original 3xSOL config at the bare ["config"] PDA is
    // grandfathered — it already exists and every other ix takes config as a passed
    // account, so it keeps working untouched.
    let recv = params.receipt_mint;
    let cfg_bump_s = [cfg_bump];
    let seeds = [Seed::from(CONFIG_SEED), Seed::from(recv.as_array().as_ref()), Seed::from(&cfg_bump_s)];
    CreateAccount {
        from: admin,
        to: cfg,
        lamports,
        space: config::CONFIG_SIZE as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;

    let mut data = accounts[1].try_borrow_mut()?;
    config::write_init(&mut data, &params)
}

fn set_paused(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    // accounts: 0 admin(signer) 1 config(w)
    let want = *d.first().ok_or(ProgramError::InvalidInstructionData)? != 0;
    let admin_key = *accounts[0].address();
    let admin_signed = accounts[0].is_signer();
    let mut data = accounts[1].try_borrow_mut()?;
    let c = Config::load(&data)?;
    if admin_key != c.admin()? || !admin_signed {
        return Err(ProgramError::MissingRequiredSignature);
    }
    config::set_paused(&mut data, want);
    Ok(())
}

/// Register the triangle pools by proving — via instructions-sysvar introspection
/// — that THREE CP-Swap `initialize` instructions are present in THIS transaction,
/// whose mint pairs are {A,B}, {A,USDC}, {B,USDC}. Writes the pool ids to Config.
///
/// accounts: 0 admin(signer) 1 config(w) 2 instructions_sysvar
fn register_triangle(accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let admin_key = *accounts[0].address();
    let admin_signed = accounts[0].is_signer();
    let (a, b, usdc) = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        if admin_key != c.admin()? || !admin_signed {
            return Err(ProgramError::MissingRequiredSignature);
        }
        (c.mint_a()?, c.mint_b()?, c.usdc_mint()?)
    };

    let mut pool_ab: Option<Address> = None;
    let mut pool_au: Option<Address> = None;
    let mut pool_bu: Option<Address> = None;
    let mut count: u8 = 0;
    {
        let sysvar = accounts[2].try_borrow()?;
        let ixs = unsafe {
            pinocchio::sysvars::instructions::Instructions::new_unchecked(&*sysvar)
        };
        for i in 0..ixs.num_instructions() {
            let ix = ixs.load_instruction_at(i as usize)?;
            if ix.get_program_id() != &cpswap_cpi::CP_SWAP_ID {
                continue;
            }
            let d = ix.get_instruction_data();
            if d.len() < 8 || d[..8] != cpswap_cpi::IX_INITIALIZE {
                continue;
            }
            if ix.num_account_metas() < 6 {
                return Err(ProgramError::InvalidArgument);
            }
            let pool = ix.get_instruction_account_at(cpswap_cpi::INIT_POOL_STATE)?.key;
            let t0 = ix.get_instruction_account_at(cpswap_cpi::INIT_TOKEN0)?.key;
            let t1 = ix.get_instruction_account_at(cpswap_cpi::INIT_TOKEN1)?.key;
            count = count.saturating_add(1);
            if cpswap_cpi::is_pair(&t0, &t1, &a, &b) {
                pool_ab = Some(pool);
            } else if cpswap_cpi::is_pair(&t0, &t1, &a, &usdc) {
                pool_au = Some(pool);
            } else if cpswap_cpi::is_pair(&t0, &t1, &b, &usdc) {
                pool_bu = Some(pool);
            } else {
                return Err(ProgramError::InvalidAccountData);
            }
        }
    }
    if count != 3 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let ab = pool_ab.ok_or(ProgramError::InvalidInstructionData)?;
    let au = pool_au.ok_or(ProgramError::InvalidInstructionData)?;
    let bu = pool_bu.ok_or(ProgramError::InvalidInstructionData)?;
    let mut data = accounts[1].try_borrow_mut()?;
    config::set_pools(&mut data, &ab, &au, &bu);
    Ok(())
}

/// Seed the A/B pool with protocol-minted A + B (house liquidity — no user quote,
/// no receipt). Completes the deposit fan-out: `deposit` handles A/Q and B/Q
/// (user quote + minted synthetic); this handles the synthetic/synthetic pair.
///
/// accounts: 0 admin(signer) 1 config 2 authority 3 mint_a(w) 4 mint_b(w)
///   5 protocol_a(w) 6 protocol_b(w) 7 protocol_lp(w) 8 pool_ab(w) 9 lp_mint(w)
///   10 vault_a(w) 11 vault_b(w) 12 cp_authority 13 cp_program 14 token_program
///   15 token_program_2022
/// data: lp_amount(8) max_a(8) max_b(8)
fn seed_pair(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 16 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let lp_amount = du64(d, 0)?;
    let max_a = du64(d, 8)?;
    let max_b = du64(d, 16)?;
    let admin_key = *accounts[0].address();
    let admin_signed = accounts[0].is_signer();
    let auth_bump = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        if admin_key != c.admin()? || !admin_signed {
            return Err(ProgramError::MissingRequiredSignature);
        }
        c.auth_bump()
    };
    let bs = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bs)];

    // mint both synthetic sides (legacy SPL Token) into the protocol's accounts
    MintTo::new(&accounts[3], &accounts[5], &accounts[2], max_a).invoke_signed(&[Signer::from(&seeds)])?;
    MintTo::new(&accounts[4], &accounts[6], &accounts[2], max_b).invoke_signed(&[Signer::from(&seeds)])?;
    // add liquidity to A/B (mint_b takes the "usdc" slot; cpswap_cpi orders internally)
    cpswap_cpi::deposit(
        lp_amount, max_a, max_b, &accounts[2], &accounts[12], &accounts[8], &accounts[7],
        &accounts[5], &accounts[6], &accounts[10], &accounts[11], &accounts[3], &accounts[4],
        &accounts[9], &accounts[14], &accounts[15], &seeds,
    )
}

/// Permissionless buy-and-burn: swap accrued fee (quote/USDC) → MEME via the
/// MEME/quote CP-Swap pool, then burn the MEME. Deflation tied to platform usage.
/// (MEME-quoted fees would skip the swap; this path is the USDC→MEME case.)
///
/// accounts: 0 cranker(signer) 1 config 2 authority(pda) 3 fee_vault(w)
///   4 meme_account(w) 5 meme_mint(w) 6 amm_config 7 cp_authority 8 pool(w)
///   9 input_vault(w) 10 output_vault(w) 11 input_mint 12 output_mint
///   13 observation(w) 14 cp_program 15 quote_token_program 16 meme_token_program
/// data: amount_in(8) min_out(8)
fn buy_burn(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 17 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let amount_in = du64(d, 0)?;
    let min_out = du64(d, 8)?;
    let (auth_bump, bb_pool, quote_mint) = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        (c.auth_bump(), c.buyburn_pool()?, c.usdc_mint()?)
    };
    // HARDENING (red-team): the swap pool must be the config-pinned MEME/quote pool
    // (no attacker-supplied fake pool), the input must be the configured quote, and
    // we must burn exactly the mint we bought.
    if *accounts[8].address() != bb_pool
        || *accounts[11].address() != quote_mint
        || accounts[5].address() != accounts[12].address()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let bs = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bs)];

    let meme_before = token_amount(&accounts[4])?;
    cpswap_cpi::swap_base_input(
        amount_in, min_out, &accounts[2], &accounts[7], &accounts[6], &accounts[8], &accounts[3],
        &accounts[4], &accounts[9], &accounts[10], &accounts[15], &accounts[16], &accounts[11],
        &accounts[12], &accounts[13], &seeds,
    )?;
    let meme_after = token_amount(&accounts[4])?;
    let bought = meme_after.saturating_sub(meme_before);
    if bought > 0 {
        // MEME is Token-2022 — burn it via its own program (accounts[16] = meme_token_program).
        token_cpi::burn(&accounts[4], &accounts[5], &accounts[2], bought, &[Signer::from(&seeds)])?;
    }
    Ok(())
}

/// Strictly validate the pre-created synthetic mints are pristine (PDA-controlled,
/// supply 0, unfreezable, MetadataPointer-only). Called as a guard before/at launch.
///
/// accounts: 0 authority(pda) 1 mint_a 2 mint_b
/// data: decimals(1)
fn validate_mints(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let decimals = *d.first().ok_or(ProgramError::InvalidInstructionData)?;
    let authority = *accounts[0].address();
    validation::validate_synthetic_mint(&accounts[1], &authority, decimals)?;
    validation::validate_synthetic_mint(&accounts[2], &authority, decimals)?;
    Ok(())
}

/// Create the protocol's persistent Address Lookup Table (authority = PDA),
/// storing its address in Config. The client passes the same `recent_slot` used
/// to derive `lut`, and the LUT pda bump.
///
/// accounts: 0 admin(signer,w) 1 config(w) 2 authority(pda) 3 lut(w) 4 alt_program 5 system
/// data: recent_slot(8) lut_bump(1)
fn init_lookup_table(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let recent_slot = du64(d, 0)?;
    let lut_bump = *d.get(8).ok_or(ProgramError::InvalidInstructionData)?;
    let admin_key = *accounts[0].address();
    let admin_signed = accounts[0].is_signer();
    let lut_key = *accounts[3].address();
    let auth_bump = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        if admin_key != c.admin()? || !admin_signed {
            return Err(ProgramError::MissingRequiredSignature);
        }
        c.auth_bump()
    };
    let bs = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bs)];
    lut_cpi::create(&accounts[2], &accounts[0], &accounts[3], &accounts[5], recent_slot, lut_bump, &seeds)?;
    let mut data = accounts[1].try_borrow_mut()?;
    config::set_lookup_table(&mut data, &lut_key);
    Ok(())
}

/// Append addresses to the protocol LUT (PDA-authority signs).
///
/// accounts: 0 admin(signer,w) 1 config 2 authority(pda) 3 lut(w) 4 alt_program 5 system
/// data: packed 32-byte addresses
fn extend_lookup_table(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let admin_key = *accounts[0].address();
    let admin_signed = accounts[0].is_signer();
    let auth_bump = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        if admin_key != c.admin()? || !admin_signed {
            return Err(ProgramError::MissingRequiredSignature);
        }
        c.auth_bump()
    };
    let bs = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bs)];
    lut_cpi::extend(&accounts[2], &accounts[0], &accounts[3], &accounts[5], d, &seeds)
}

/// Set a receipt-token metadata field (the "2nd ix after init"). The receipt mint
/// carries a Token-2022 MetadataPointer → itself; this CPIs `UpdateField` (PDA is
/// the metadata update authority) so the creating user names their receipt token.
///
/// accounts: 0 admin(signer) 1 config 2 authority(pda) 3 receipt_mint(w)
///           4 token_2022_program
/// data: field(1: 0=name,1=symbol,2=uri) value(rest = utf8 bytes)
fn update_metadata(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let field = *d.first().ok_or(ProgramError::InvalidInstructionData)?;
    let value = &d[1..];
    let admin_key = *accounts[0].address();
    let admin_signed = accounts[0].is_signer();
    let receipt_key = *accounts[3].address();
    let auth_bump = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        if admin_key != c.admin()? || !admin_signed {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if receipt_key != c.receipt_mint()? {
            return Err(ProgramError::InvalidAccountData);
        }
        c.auth_bump()
    };
    let bump_s = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bump_s)];
    metadata_cpi::update_field(field, value, &accounts[3], &accounts[2], &seeds)
}

/// Backfill Metaplex metadata on receipt / mintA / mintB when launch skipped the step.
///
/// accounts: 0 admin(signer,w) 1 config 2 authority(pda) 3 mint 4 metadata_pda(w)
///           5 system_program 6 metaplex_program
/// data: kind(1: 0=receipt,1=mintA,2=mintB) name_len(1) name symbol_len(1) symbol uri_len(2) uri
fn backfill_metaplex(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if *accounts[6].address() != metaplex_cpi::METAPLEX_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let kind = *d.first().ok_or(ProgramError::InvalidInstructionData)?;
    let mut o = 1usize;
    let name_len = *d.get(o).ok_or(ProgramError::InvalidInstructionData)? as usize;
    o += 1;
    let name = d.get(o..o + name_len).ok_or(ProgramError::InvalidInstructionData)?;
    o += name_len;
    let symbol_len = *d.get(o).ok_or(ProgramError::InvalidInstructionData)? as usize;
    o += 1;
    let symbol = d.get(o..o + symbol_len).ok_or(ProgramError::InvalidInstructionData)?;
    o += symbol_len;
    let uri_len = d.get(o..o + 2).and_then(|s| s.try_into().ok()).map(u16::from_le_bytes).ok_or(ProgramError::InvalidInstructionData)? as usize;
    o += 2;
    let uri = d.get(o..o + uri_len).ok_or(ProgramError::InvalidInstructionData)?;

    let admin_key = *accounts[0].address();
    if !accounts[0].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mint_key = *accounts[3].address();
    let auth_bump = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        if admin_key != c.admin()? {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if kind == 0 {
            return Err(ProgramError::InvalidInstructionData); // receipt = T22 metadata (TAG 14), not Metaplex
        }
        let expected = match kind {
            1 => c.mint_a()?,
            2 => c.mint_b()?,
            _ => return Err(ProgramError::InvalidInstructionData),
        };
        if mint_key != expected {
            return Err(ProgramError::InvalidAccountData);
        }
        c.auth_bump()
    };
    // mint authority must be the protocol PDA
    {
        let md = accounts[3].try_borrow()?;
        if md.len() < 36 || md[0] != 1 {
            return Err(ProgramError::InvalidAccountData);
        }
        let auth_bytes: [u8; 32] = md[4..36].try_into().map_err(|_| ProgramError::InvalidAccountData)?;
        let auth = Address::from(auth_bytes);
        if auth != *accounts[2].address() {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    // metadata PDA must not exist yet
    if accounts[4].lamports() > 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let bump_s = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bump_s)];
    metaplex_cpi::create_metadata_v3(
        &accounts[4],
        &accounts[3],
        &accounts[2],
        &accounts[0],
        &accounts[0],
        &accounts[5],
        name,
        symbol,
        uri,
        &[Signer::from(&seeds)],
    )
}

/// Backfill Token-2022 on-mint metadata for the receipt (Metaplex rejects T22 mints).
///
/// accounts: 0 admin(signer,w) 1 config 2 authority(pda) 3 receipt_mint(w)
///           4 system_program 5 token_2022_program
/// data: name_len(1) name symbol_len(1) symbol uri_len(2) uri
fn backfill_receipt_t22(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let mut o = 0usize;
    let name_len = *d.get(o).ok_or(ProgramError::InvalidInstructionData)? as usize;
    o += 1;
    let name = d.get(o..o + name_len).ok_or(ProgramError::InvalidInstructionData)?;
    o += name_len;
    let symbol_len = *d.get(o).ok_or(ProgramError::InvalidInstructionData)? as usize;
    o += 1;
    let symbol = d.get(o..o + symbol_len).ok_or(ProgramError::InvalidInstructionData)?;
    o += symbol_len;
    let uri_len = d.get(o..o + 2).and_then(|s| s.try_into().ok()).map(u16::from_le_bytes).ok_or(ProgramError::InvalidInstructionData)? as usize;
    o += 2;
    let uri = d.get(o..o + uri_len).ok_or(ProgramError::InvalidInstructionData)?;

    let admin_key = *accounts[0].address();
    if !accounts[0].is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let receipt_key = *accounts[3].address();
    let auth_bump = {
        let data = accounts[1].try_borrow()?;
        let c = Config::load(&data)?;
        if admin_key != c.admin()? {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if receipt_key != c.receipt_mint()? {
            return Err(ProgramError::InvalidAccountData);
        }
        c.auth_bump()
    };
    let bump_s = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bump_s)];
    let signers = [Signer::from(&seeds)];
    // Reallocate is done client-side (rent transfer + initialize). CPI Reallocate fails when
    // the authority PDA has no initialized system account.
    metadata_cpi::initialize_metadata(&accounts[3], &accounts[2], &accounts[2], name, symbol, uri, &signers)
}

/// Oracle-free rebalance. Reads last_ratio + params from Config, all 6 vaults +
/// 2 mint supplies on-chain, mints the loser into both its pools, writes the new
/// ratio back to Config.
///
/// accounts: 0 config(w) 1 authority 2 mint_a(w) 3 mint_b(w)
///           4 vault_ab_a(w) 5 vault_ab_b(w) 6 vault_ausdc_a(w) 7 vault_ausdc_usdc
///           8 vault_busdc_b(w) 9 vault_busdc_usdc 10 token_program
/// data: user_leverage_bps(8)
fn rebalance(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    run_rebalance(accounts, 0, du64(d, 0)?)
}

/// Shared oracle-free rebalance core, used by the `rebalance` crank (base = 0) and
/// the transfer hook (base = 5, after the standard transfer-hook accounts).
///
/// layout from `base`: 0 config(w) 1 authority 2 mint_a(w) 3 mint_b(w)
///   4 vault_ab_a(w) 5 vault_ab_b(w) 6 vault_ausdc_a(w) 7 vault_ausdc_usdc
///   8 vault_busdc_b(w) 9 vault_busdc_usdc 10 token_program
/// When config.oracle_kind == pumpswap, also pass:
///   11 oracle_pool 12 oracle_base_vault 13 oracle_quote_vault
/// `user_leverage_bps == 0` ⇒ use the config's l_max (full leverage, elastic-capped).
fn run_rebalance(accounts: &mut [AccountView], base: usize, user_leverage_bps: u64) -> ProgramResult {
    if accounts.len() < base + 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (last_ratio, l_min, l_max, max_mint, breaker, auth_bump, paused, oracle_kind, oracle_pool, oracle_last) = {
        let data = accounts[base].try_borrow()?;
        let c = Config::load(&data)?;
        let kind = c.oracle_kind();
        let pool = if kind == ORACLE_PUMPSWAP { c.oracle_pool()? } else { Address::from([0u8; 32]) };
        let last = if kind == ORACLE_PUMPSWAP { c.oracle_price_last_wad()? } else { 0 };
        (
            c.last_ratio_wad()?,
            c.l_min_bps()?,
            c.l_max_bps()?,
            c.max_mint_bps()?,
            c.breaker_bps()?,
            c.auth_bump(),
            c.paused(),
            kind,
            pool,
            last,
        )
    };
    if paused {
        return Ok(());
    }
    let leverage = if user_leverage_bps == 0 { l_max } else { user_leverage_bps };

    let res_ab_a = token_amount(&accounts[base + 4])?;
    let res_ab_b = token_amount(&accounts[base + 5])?;
    let res_ausdc_a = token_amount(&accounts[base + 6])?;
    let res_ausdc_usdc = token_amount(&accounts[base + 7])?;
    let res_busdc_b = token_amount(&accounts[base + 8])?;
    let res_busdc_usdc = token_amount(&accounts[base + 9])?;
    let supply_a = mint_supply(&accounts[base + 2])?;
    let supply_b = mint_supply(&accounts[base + 3])?;

    let market = match implied_market(res_ausdc_a, res_ausdc_usdc, res_busdc_b, res_busdc_usdc, supply_a, supply_b) {
        Some(m) => m,
        None => return Ok(()),
    };

    let oracle_now_wad = if oracle_kind == ORACLE_PUMPSWAP {
        if oracle_pool == Address::from([0u8; 32]) || accounts.len() < base + 13 {
            return Ok(());
        }
        let (base_vault, quote_vault) = pumpswap::validate_pool(&accounts[base + 11], &oracle_pool)?;
        if accounts[base + 12].address() != &base_vault || accounts[base + 13].address() != &quote_vault {
            return Err(ProgramError::InvalidAccountData);
        }
        let base_res = token_amount(&accounts[base + 12])?;
        let quote_res = token_amount(&accounts[base + 13])?;
        match pumpswap::price_wad(base_res, quote_res) {
            Some(p) => p,
            None => return Ok(()),
        }
    } else {
        0
    };

    let plan = if oracle_kind == ORACLE_PUMPSWAP {
        match plan_two_pool_from_oracle_wad(
            oracle_last, oracle_now_wad, res_ab_a, res_ab_b, res_ausdc_a, res_busdc_b, supply_a, supply_b,
            leverage, l_min, l_max, max_mint, breaker,
        ) {
            Some(p) => p,
            None => {
                let mut data = accounts[base].try_borrow_mut()?;
                config::set_oracle_price_last(
                    &mut data,
                    partial_ratio_advance(oracle_last, oracle_now_wad, CRANK_ABSORB_BPS),
                );
                config::set_last_ratio(
                    &mut data,
                    partial_ratio_advance(last_ratio, market.ratio_wad, CRANK_ABSORB_BPS),
                );
                return Ok(());
            }
        }
    } else {
        match plan_from_market(
            last_ratio, &market, res_ab_a, res_ab_b, res_ausdc_a, res_busdc_b, supply_a, supply_b,
            leverage, l_min, l_max, max_mint, breaker,
        ) {
            Some(p) => p,
            None => {
                let mut data = accounts[base].try_borrow_mut()?;
                config::set_last_ratio(
                    &mut data,
                    partial_ratio_advance(last_ratio, market.ratio_wad, CRANK_ABSORB_BPS),
                );
                return Ok(());
            }
        }
    };

    let bump_s = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bump_s)];
    let authority = &accounts[base + 1];
    let (mint, pair_vault, usdc_vault) = match plan.side {
        Side::A => (&accounts[base + 2], &accounts[base + 4], &accounts[base + 6]),
        Side::B => (&accounts[base + 3], &accounts[base + 5], &accounts[base + 8]),
    };
    // legacy SPL Token MintTo: the hook calls this from inside a Token-2022 transfer,
    // so the synth mint MUST be legacy (minting a T22 synth here would re-enter T22).
    if plan.amount_pair_pool > 0 {
        MintTo::new(mint, pair_vault, authority, plan.amount_pair_pool).invoke_signed(&[Signer::from(&seeds)])?;
    }
    if plan.amount_usdc_pool > 0 {
        MintTo::new(mint, usdc_vault, authority, plan.amount_usdc_pool).invoke_signed(&[Signer::from(&seeds)])?;
    }

    // Partial basis advance — repeated transfers keep cranking until caught up.
    let mut data = accounts[base].try_borrow_mut()?;
    if oracle_kind == ORACLE_PUMPSWAP {
        config::set_oracle_price_last(
            &mut data,
            partial_ratio_advance(oracle_last, oracle_now_wad, CRANK_ABSORB_BPS),
        );
    }
    config::set_last_ratio(
        &mut data,
        partial_ratio_advance(last_ratio, market.ratio_wad, CRANK_ABSORB_BPS),
    );
    Ok(())
}

/// Token-2022 transfer-hook `Execute`: a receipt transfer triggers a rebalance.
/// Standard accounts 0..4 (source, mint, destination, owner, meta_list); the
/// rebalance accounts are the resolved extras starting at index 5.
fn hook_execute(accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    // leverage 0 ⇒ config l_max. Hook must not brick transfers, so a too-small
    // account set (e.g. meta list not initialised) is a soft no-op.
    if accounts.len() < 5 + 10 {
        return Ok(());
    }
    let need = {
        let data = accounts[5].try_borrow()?;
        let c = Config::load(&data)?;
        if c.oracle_kind() == ORACLE_PUMPSWAP { 13 } else { 10 }
    };
    if accounts.len() < 5 + need {
        return Ok(());
    }
    run_rebalance(accounts, 5, 0)
}

/// Initialize the receipt mint's ExtraAccountMetaList (`["extra-account-metas",
/// receipt_mint]`) so Token-2022 passes the rebalance accounts into the hook.
///
/// accounts: 0 payer(signer,w) 1 extra_meta_list(pda,w) 2 receipt_mint 3 system
///           4.. the `count` extra accounts to embed (config, authority, mint_a,
///           mint_b, the 6 vaults, token_program), in hook order.
/// data: lamports(8) count(1) writable_mask(u16 LE) meta_bump(1)
fn init_extra_account_metas(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    let lamports = du64(d, 0)?;
    let count = *d.get(8).ok_or(ProgramError::InvalidInstructionData)? as usize;
    let mask = u16::from_le_bytes([
        *d.get(9).ok_or(ProgramError::InvalidInstructionData)?,
        *d.get(10).ok_or(ProgramError::InvalidInstructionData)?,
    ]);
    let bump = *d.get(11).ok_or(ProgramError::InvalidInstructionData)?;
    if accounts.len() < 4 + count || count > 16 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let receipt_key = *accounts[2].address();

    // collect the embed addresses BEFORE the mutable borrow of the list account
    let mut entries: [([u8; 32], bool); 16] = [([0u8; 32], false); 16];
    for i in 0..count {
        entries[i] = (*accounts[4 + i].address().as_array(), (mask >> i) & 1 == 1);
    }

    let seeds = [
        Seed::from(b"extra-account-metas".as_ref()),
        Seed::from(receipt_key.as_array().as_ref()),
        Seed::from(core::slice::from_ref(&bump)),
    ];
    CreateAccount {
        from: &accounts[0],
        to: &accounts[1],
        lamports,
        space: hook::size_of(count) as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;

    let mut data = accounts[1].try_borrow_mut()?;
    data[0..8].copy_from_slice(&hook::EXECUTE_DISC);
    let tlv_len = (4 + count * hook::META_LEN) as u32;
    data[8..12].copy_from_slice(&tlv_len.to_le_bytes());
    data[12..16].copy_from_slice(&(count as u32).to_le_bytes());
    let mut o = 16;
    for entry in entries.iter().take(count) {
        data[o] = 0; // literal-pubkey discriminator
        data[o + 1..o + 33].copy_from_slice(&entry.0);
        data[o + 33] = 0; // is_signer
        data[o + 34] = entry.1 as u8; // is_writable
        o += hook::META_LEN;
    }
    Ok(())
}

/// Deposit USDC → add liquidity to the A/USDC pool → protocol LP → mint receipt.
///
/// Deposit quote into one anchor pool (+/USDC or −/USDC). Call twice (A then B) to
/// fan the user's quote across both legs; receipt mints 1:1 with each pool's LP.
///
/// accounts: 0 user(signer,w) 1 config(w) 2 authority 3 usdc_mint 4 mint_synth(w)
///           5 receipt_mint(w) 6 user_usdc(w) 7 protocol_usdc(w) 8 user_receipt(w)
///           9 protocol_synth(w) 10 protocol_lp(w) 11 pool(w) 12 lp_mint(w)
///           13 vault_synth(w) 14 vault_usdc(w) 15 cp_authority 16 cp_program
///           17 token_program 18 token_program_2022 [19 fee_vault(w) optional]
/// data: lp_amount(8) usdc_amount(8) max_synth(8)
fn deposit(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 19 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let user = &accounts[0];
    let cfg = &accounts[1];
    let authority = &accounts[2];
    let usdc_mint = &accounts[3];
    let mint_synth = &accounts[4];
    let receipt_mint = &accounts[5];
    let user_usdc = &accounts[6];
    let protocol_usdc = &accounts[7];
    let user_receipt = &accounts[8];
    let protocol_synth = &accounts[9];
    let protocol_lp = &accounts[10];
    let pool = &accounts[11];
    let lp_mint = &accounts[12];
    let vault_synth = &accounts[13];
    let vault_usdc = &accounts[14];
    let cp_authority = &accounts[15];
    let token_program = &accounts[17];
    let token_program_2022 = &accounts[18];

    let lp_amount = du64(d, 0)?;
    let usdc_amount = du64(d, 8)?;
    let max_synth = du64(d, 16)?;

    let (auth_bump, paused) = {
        let data = cfg.try_borrow()?;
        let c = Config::load(&data)?;
        // multi-pair safety: synth mint + pool must be a matched leg of THIS config.
        let leg_a = *mint_synth.address() == c.mint_a()?
            && *pool.address() == c.pool_a_usdc()?;
        let leg_b = *mint_synth.address() == c.mint_b()?
            && *pool.address() == c.pool_b_usdc()?;
        if *usdc_mint.address() != c.usdc_mint()?
            || *receipt_mint.address() != c.receipt_mint()?
            || (!leg_a && !leg_b)
        {
            return Err(ProgramError::InvalidAccountData);
        }
        (c.auth_bump(), c.paused())
    };
    if paused {
        return Err(ProgramError::InvalidAccountData);
    }
    let bump_s = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bump_s)];

    // 1. pull USDC from the user
    Transfer::new(user_usdc, protocol_usdc, user, usdc_amount).invoke()?;
    // 1.5 optional fee skim → fee_vault (accounts[19]) when config.fee_bps > 0.
    // This is the flywheel faucet: deposit fees accrue quote that buy_burn consumes.
    if accounts.len() > 19 {
        let fee_bps = {
            let data = cfg.try_borrow()?;
            Config::load(&data)?.fee_bps()
        };
        if fee_bps > 0 {
            let fee = ((usdc_amount as u128) * (fee_bps as u128) / 10_000) as u64;
            if fee > 0 {
                Transfer::new(protocol_usdc, &accounts[19], authority, fee)
                    .invoke_signed(&[Signer::from(&seeds)])?;
            }
        }
    }
    // 2. mint the matching synthetic leg (legacy SPL Token; we are mint authority)
    MintTo::new(mint_synth, protocol_synth, authority, max_synth).invoke_signed(&[Signer::from(&seeds)])?;
    // 3. add liquidity → protocol LP
    cpswap_cpi::deposit(
        lp_amount, max_synth, usdc_amount, authority, cp_authority, pool, protocol_lp, protocol_synth,
        protocol_usdc, vault_synth, vault_usdc, mint_synth, usdc_mint, lp_mint, token_program,
        token_program_2022, &seeds,
    )?;
    // 4. mint receipt (Token-2022, 1:1 with LP) to the user
    token_cpi::mint_to(receipt_mint, user_receipt, authority, lp_amount, &[Signer::from(&seeds)])?;
    // 4.5 return any quote dust — protocol_usdc is a pass-through, not a vault.
    let quote_left = token_amount(protocol_usdc)?;
    if quote_left > 0 {
        Transfer::new(protocol_usdc, user_usdc, authority, quote_left)
            .invoke_signed(&[Signer::from(&seeds)])?;
    }
    // 5. bookkeeping
    let new_total = {
        let data = cfg.try_borrow()?;
        Config::load(&data)?.total_receipt()?.saturating_add(lp_amount)
    };
    let mut data = accounts[1].try_borrow_mut()?;
    config::set_total_receipt(&mut data, new_total);
    Ok(())
}

/// Withdraw one anchor leg: burn receipt → redeem Raydium LP → burn synth → return USDC.
/// Call twice (A then B) to fully redeem a fan-out deposit.
///
/// accounts: 0 user(signer,w) 1 config(w) 2 authority 3 usdc_mint 4 mint_synth(w)
///           5 receipt_mint(w) 6 user_usdc(w) 7 protocol_usdc(w) 8 user_receipt(w)
///           9 protocol_synth(w) 10 protocol_lp(w) 11 pool(w) 12 lp_mint(w)
///           13 vault_synth(w) 14 vault_usdc(w) 15 cp_authority 16 cp_program
///           17 token_program 18 token_program_2022 19 memo_program
/// data: receipt_amount(8)
fn withdraw(accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if accounts.len() < 20 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let user = &accounts[0];
    let cfg = &accounts[1];
    let authority = &accounts[2];
    let usdc_mint = &accounts[3];
    let mint_synth = &accounts[4];
    let receipt_mint = &accounts[5];
    let user_usdc = &accounts[6];
    let protocol_usdc = &accounts[7];
    let user_receipt = &accounts[8];
    let protocol_synth = &accounts[9];
    let protocol_lp = &accounts[10];
    let pool = &accounts[11];
    let lp_mint = &accounts[12];
    let vault_synth = &accounts[13];
    let vault_usdc = &accounts[14];
    let cp_authority = &accounts[15];
    let token_program = &accounts[17];
    let token_program_2022 = &accounts[18];
    let memo_program = &accounts[19];

    let receipt_amount = du64(d, 0)?;
    let auth_bump = {
        let data = cfg.try_borrow()?;
        let c = Config::load(&data)?;
        let leg_a = *mint_synth.address() == c.mint_a()?
            && *pool.address() == c.pool_a_usdc()?;
        let leg_b = *mint_synth.address() == c.mint_b()?
            && *pool.address() == c.pool_b_usdc()?;
        if *usdc_mint.address() != c.usdc_mint()?
            || *receipt_mint.address() != c.receipt_mint()?
            || (!leg_a && !leg_b)
        {
            return Err(ProgramError::InvalidAccountData);
        }
        c.auth_bump()
    };
    let bump_s = [auth_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bump_s)];

    // 1. burn the user's receipt (Token-2022; user signs directly)
    token_cpi::burn(user_receipt, receipt_mint, user, receipt_amount, &[])?;
    // 2. redeem the matching Raydium LP (receipt is 1:1 with LP; CP-Swap burns LP tokens)
    let synth_before = token_amount(protocol_synth)?;
    let usdc_before = token_amount(protocol_usdc)?;
    cpswap_cpi::withdraw(
        receipt_amount, 0, 0, authority, cp_authority, pool, protocol_lp, protocol_synth,
        protocol_usdc, vault_synth, vault_usdc, mint_synth, usdc_mint, lp_mint, token_program,
        token_program_2022, memo_program, &seeds,
    )?;
    let synth_out = token_amount(protocol_synth)?.saturating_sub(synth_before);
    let usdc_out = token_amount(protocol_usdc)?.saturating_sub(usdc_before);

    // 3. burn the +/- synth leg pulled from the pool
    if synth_out > 0 {
        Burn::new(protocol_synth, mint_synth, authority, synth_out)
            .invoke_signed(&[Signer::from(&seeds)])?;
    }
    // 4. send all redeemed quote to the user — protocol does not custody USDC
    if usdc_out > 0 {
        Transfer::new(protocol_usdc, user_usdc, authority, usdc_out).invoke_signed(&[Signer::from(&seeds)])?;
    }
    // 5. bookkeeping
    let new_total = {
        let data = cfg.try_borrow()?;
        Config::load(&data)?.total_receipt()?.saturating_sub(receipt_amount)
    };
    let mut data = accounts[1].try_borrow_mut()?;
    config::set_total_receipt(&mut data, new_total);
    Ok(())
}
