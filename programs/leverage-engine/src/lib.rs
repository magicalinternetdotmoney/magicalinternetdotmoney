//! # Dynamic Leveraged Synthetic Pair — engine (experimental)
//!
//! Builds the design doc literally: a receipt token (Token-2022) whose transfer
//! hook drives elastic "mint the loser" rebalancing of a synthetic pair
//! (`MINTA` / `MINTB`), with three Raydium CP-Swap pools forming the triangle.
//!
//! ## Milestone status
//! - **M1 (this Anchor crate only):** protocol state, `initialize_config`, admin
//!   oracle crank, `deposit` (USDC → receipt + seed **protocol-held** reserves),
//!   elastic mint math, permissionless `rebalance`, receipt transfer hook.
//!   **Not the mainnet deploy** — see `pinocchio-programs/leverage-engine`.
//! - **M2 (Pinocchio mainnet):** real Raydium CP-Swap vault CPIs for
//!   deposit/withdraw/rebalance. Rebalance is oracle-free (vault-implied ratio);
//!   Raydium `observation_state` TWAP is not wired in yet.
//!
//! ## ⚠️ Known, accepted risks (per design)
//! "Mint the loser" has no restoring force: minting into the weak side of x·y=k
//! drives its price toward zero and arbitrage drains the USDC anchor pools. The
//! circuit breaker + per-rebalance cap + elastic leverage decay bound the bleed
//! but do not eliminate it. This is an experimental, high-risk primitive.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::token_interface::{
    mint_to, transfer_checked, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

pub mod cpswap;
pub mod error;
pub mod state;

/// Pure economics, shared with the Pinocchio engine.
pub use leverage_math as math;

use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;
use error::LeverageError;
use math::{plan_rebalance, Side};
use state::{Config, InitConfigParams};

declare_id!("Een1a526XFdTeSBjdBzU83sotriogcj4hBXsaCs8AaHx");

pub const CONFIG_SEED: &[u8] = b"config";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const META_SEED: &[u8] = b"extra-account-metas";

#[program]
pub mod leverage_engine {
    use super::*;

    /// One-time setup. All mints / token accounts are created client-side with
    /// their authority/owner set to the `authority` PDA; here we only validate
    /// and record them.
    pub fn initialize_config(ctx: Context<InitializeConfig>, params: InitConfigParams) -> Result<()> {
        require!(
            params.l_min_bps > 0 && params.l_min_bps <= params.l_max_bps,
            LeverageError::InvalidLeverageBand
        );
        require!(params.price_init > 0, LeverageError::BadPrice);

        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.authority = ctx.accounts.authority.key();
        cfg.authority_bump = ctx.bumps.authority;
        cfg.config_bump = ctx.bumps.config;

        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.mint_a = ctx.accounts.mint_a.key();
        cfg.mint_b = ctx.accounts.mint_b.key();
        cfg.receipt_mint = ctx.accounts.receipt_mint.key();

        cfg.usdc_vault = ctx.accounts.usdc_vault.key();
        cfg.reserve_a = ctx.accounts.reserve_a.key();
        cfg.reserve_b = ctx.accounts.reserve_b.key();

        // Triangle pools are registered later via `register_triangle` (which proves,
        // by introspection, that all three were created in one transaction).
        cfg.pool_ab = Pubkey::default();
        cfg.pool_a_usdc = Pubkey::default();
        cfg.pool_b_usdc = Pubkey::default();

        cfg.lookup_table = Pubkey::default();
        cfg.oracle = ctx.accounts.oracle.key();
        cfg.price_last = params.price_init;
        cfg.price_now = params.price_init;
        cfg.last_rebalance_ts = Clock::get()?.unix_timestamp;

        cfg.l_min_bps = params.l_min_bps;
        cfg.l_max_bps = params.l_max_bps;
        cfg.max_mint_bps = params.max_mint_bps;
        cfg.breaker_bps = params.breaker_bps;
        cfg.min_rebalance_interval = params.min_rebalance_interval;

        cfg.total_usdc_deposited = 0;
        cfg.total_minted_a = 0;
        cfg.total_minted_b = 0;
        cfg.paused = false;
        cfg._reserved = [0u8; 64];
        Ok(())
    }

    /// Record the three Raydium CP-Swap pools that form the triangle — and prove,
    /// via **instruction introspection**, that all three were created in *this same
    /// transaction*. The client builds one tx of:
    ///   [ cp_swap.initialize(A,B), cp_swap.initialize(A,USDC),
    ///     cp_swap.initialize(B,USDC), leverage.register_triangle ]
    /// and this handler scans the Instructions sysvar to require exactly three
    /// CP-Swap `initialize` instructions whose mint pairs are {A,B}, {A,USDC},
    /// {B,USDC}. A half-built triangle therefore cannot be registered.
    pub fn register_triangle(ctx: Context<RegisterTriangle>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(
            cfg.pool_ab == Pubkey::default()
                && cfg.pool_a_usdc == Pubkey::default()
                && cfg.pool_b_usdc == Pubkey::default(),
            LeverageError::TriangleAlreadyRegistered
        );

        let ix_sysvar = &ctx.accounts.instructions.to_account_info();
        let (a, b, usdc) = (cfg.mint_a, cfg.mint_b, cfg.usdc_mint);

        let mut pool_ab: Option<Pubkey> = None;
        let mut pool_a_usdc: Option<Pubkey> = None;
        let mut pool_b_usdc: Option<Pubkey> = None;
        let mut cp_init_count: u8 = 0;

        let mut i = 0usize;
        while let Ok(ix) = load_instruction_at_checked(i, ix_sysvar) {
            i += 1;
            if ix.program_id != cpswap::CP_SWAP_ID {
                continue;
            }
            if ix.data.len() < 8 || ix.data[..8] != cpswap::IX_INITIALIZE {
                continue;
            }
            require!(
                ix.accounts.len() >= cpswap::INIT_MIN_ACCOUNTS,
                LeverageError::TriangleMismatch
            );
            cp_init_count = cp_init_count.saturating_add(1);
            let pool = ix.accounts[cpswap::INIT_POOL_STATE].pubkey;
            let t0 = ix.accounts[cpswap::INIT_TOKEN0_MINT].pubkey;
            let t1 = ix.accounts[cpswap::INIT_TOKEN1_MINT].pubkey;

            if cpswap::is_pair(&t0, &t1, &a, &b) {
                pool_ab = Some(pool);
            } else if cpswap::is_pair(&t0, &t1, &a, &usdc) {
                pool_a_usdc = Some(pool);
            } else if cpswap::is_pair(&t0, &t1, &b, &usdc) {
                pool_b_usdc = Some(pool);
            } else {
                return Err(LeverageError::TriangleMismatch.into());
            }
        }

        require!(cp_init_count == 3, LeverageError::TriangleIncomplete);
        cfg.pool_ab = pool_ab.ok_or(LeverageError::TriangleMismatch)?;
        cfg.pool_a_usdc = pool_a_usdc.ok_or(LeverageError::TriangleMismatch)?;
        cfg.pool_b_usdc = pool_b_usdc.ok_or(LeverageError::TriangleMismatch)?;
        Ok(())
    }

    /// Create the protocol's persistent Address Lookup Table, owned by the
    /// `authority` PDA (so the program — not a hot wallet — controls it). The LUT
    /// address derives from `[authority, recent_slot]`; the client passes the same
    /// `recent_slot` it used to derive the `lookup_table` account.
    pub fn init_lookup_table(ctx: Context<InitLookupTable>, recent_slot: u64) -> Result<()> {
        use anchor_lang::solana_program::address_lookup_table::instruction::create_lookup_table;
        let cfg = &mut ctx.accounts.config;
        require!(cfg.lookup_table == Pubkey::default(), LeverageError::TriangleAlreadyRegistered);

        let (ix, lut) = create_lookup_table(
            ctx.accounts.authority.key(),
            ctx.accounts.admin.key(),
            recent_slot,
        );
        require_keys_eq!(lut, ctx.accounts.lookup_table.key(), LeverageError::TriangleMismatch);

        let bump = cfg.authority_bump;
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.lookup_table.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.lut_program.to_account_info(),
            ],
            &[&[AUTHORITY_SEED, &[bump]]],
        )?;
        cfg.lookup_table = lut;
        Ok(())
    }

    /// Append addresses to the protocol LUT (PDA-authority signs). Called in
    /// chunks; the client supplies the deterministic triangle / reserve / config
    /// addresses (they need not exist yet — a LUT stores plain pubkeys).
    pub fn extend_lookup_table(
        ctx: Context<ExtendLookupTable>,
        addresses: Vec<Pubkey>,
    ) -> Result<()> {
        use anchor_lang::solana_program::address_lookup_table::instruction::extend_lookup_table;
        require!(!addresses.is_empty(), LeverageError::ZeroAmount);
        let bump = ctx.accounts.config.authority_bump;
        let ix = extend_lookup_table(
            ctx.accounts.lookup_table.key(),
            ctx.accounts.authority.key(),
            Some(ctx.accounts.admin.key()),
            addresses,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.lookup_table.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.lut_program.to_account_info(),
            ],
            &[&[AUTHORITY_SEED, &[bump]]],
        )?;
        Ok(())
    }

    /// Admin pause / unpause.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Oracle crank. Pushes a new reference price, shifting the previous
    /// `price_now` into `price_last` (the basis the next rebalance reads).
    ///
    /// M1: admin-signed trusted push. M2: replace with a permissionless on-chain
    /// read of the Raydium MINTA/USDC TWAP (validated against the stored oracle).
    pub fn update_oracle(ctx: Context<AdminOnly>, price: u64) -> Result<()> {
        require!(price > 0, LeverageError::BadPrice);
        let cfg = &mut ctx.accounts.config;
        cfg.price_last = cfg.price_now;
        cfg.price_now = price;
        Ok(())
    }

    /// Deposit USDC → receive receipt tokens 1:1, and seed the synthetic reserves
    /// equally so there is a book for the rebalance to act on.
    ///
    /// M2 replaces the reserve mints with Raydium CP-Swap add-liquidity CPI.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, LeverageError::ZeroAmount);
        require!(!ctx.accounts.config.paused, LeverageError::Paused);

        // Pull USDC from the depositor into the protocol vault.
        transfer_checked(
            CpiContext::new(
                ctx.accounts.usdc_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        let bump = ctx.accounts.config.authority_bump;
        let signer: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[bump]]];

        // Mint receipt 1:1 to the depositor (Token-2022, carries the hook).
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.receipt_token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.receipt_mint.to_account_info(),
                    to: ctx.accounts.depositor_receipt.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        // Seed both synthetic reserves equally (50/50 by nominal units).
        let half = amount / 2;
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.synthetic_token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint_a.to_account_info(),
                    to: ctx.accounts.reserve_a.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                signer,
            ),
            half,
        )?;
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.synthetic_token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint_b.to_account_info(),
                    to: ctx.accounts.reserve_b.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                signer,
            ),
            half,
        )?;

        let cfg = &mut ctx.accounts.config;
        cfg.total_usdc_deposited = cfg.total_usdc_deposited.saturating_add(amount);
        cfg.total_minted_a = cfg.total_minted_a.saturating_add(half);
        cfg.total_minted_b = cfg.total_minted_b.saturating_add(half);
        Ok(())
    }

    /// Permissionless rebalance crank — applies the elastic "mint the loser" step
    /// using the cached oracle prices. No-op (Ok) if paused, flat, or called
    /// before `min_rebalance_interval` elapsed, so it is always safe to call.
    pub fn rebalance(ctx: Context<Rebalance>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        apply_rebalance(
            &mut ctx.accounts.config,
            &ctx.accounts.mint_a,
            &ctx.accounts.mint_b,
            &ctx.accounts.reserve_a,
            &ctx.accounts.reserve_b,
            &ctx.accounts.authority,
            &ctx.accounts.synthetic_token_program,
            now,
        )
    }

    /// Sets up the receipt mint's `ExtraAccountMetaList` so Token-2022 passes the
    /// rebalance accounts into the hook.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        // Indices 0-3: source, mint(receipt), destination, owner. Index 4: this list.
        let account_metas = vec![
            // 5: config PDA
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal { bytes: CONFIG_SEED.to_vec() }],
                false,
                true,
            )?,
            // 6: authority PDA
            ExtraAccountMeta::new_with_seeds(
                &[Seed::Literal { bytes: AUTHORITY_SEED.to_vec() }],
                false,
                false,
            )?,
            // 7: mint_a (writable — minted into)
            ExtraAccountMeta::new_with_pubkey(&cfg.mint_a, false, true)?,
            // 8: mint_b (writable)
            ExtraAccountMeta::new_with_pubkey(&cfg.mint_b, false, true)?,
            // 9: reserve_a (writable)
            ExtraAccountMeta::new_with_pubkey(&cfg.reserve_a, false, true)?,
            // 10: reserve_b (writable)
            ExtraAccountMeta::new_with_pubkey(&cfg.reserve_b, false, true)?,
            // 11: synthetic token program
            ExtraAccountMeta::new_with_pubkey(&ctx.accounts.synthetic_token_program.key(), false, false)?,
        ];

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        let mint = ctx.accounts.receipt_mint.key();
        let signer_seeds: &[&[&[u8]]] =
            &[&[META_SEED, mint.as_ref(), &[ctx.bumps.extra_account_meta_list]]];

        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;
        Ok(())
    }

    /// Receipt-token transfer hook (CPI'd by Token-2022 on every receipt
    /// transfer). Applies the rebalance — the transferrer pays the compute.
    ///
    /// Crucially this must **never** fail a benign transfer, so it short-circuits
    /// to `Ok` on pause / flat / interval-not-elapsed instead of erroring.
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        apply_rebalance(
            &mut ctx.accounts.config, // Box<Account<Config>> derefs to &mut Account
            &ctx.accounts.mint_a,
            &ctx.accounts.mint_b,
            &ctx.accounts.reserve_a,
            &ctx.accounts.reserve_b,
            &ctx.accounts.authority,
            &ctx.accounts.synthetic_token_program,
            now,
        )
    }

    /// Fallback so Token-2022's `Execute` discriminator routes to `transfer_hook`.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

/// Shared elastic "mint the loser" step used by both the crank and the hook.
///
/// Soft no-op (returns `Ok`) when paused, flat, or inside the rebalance interval.
#[allow(clippy::too_many_arguments)]
fn apply_rebalance<'info>(
    config: &mut Account<'info, Config>,
    mint_a: &InterfaceAccount<'info, Mint>,
    mint_b: &InterfaceAccount<'info, Mint>,
    reserve_a: &InterfaceAccount<'info, TokenAccount>,
    reserve_b: &InterfaceAccount<'info, TokenAccount>,
    authority: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
    now_ts: i64,
) -> Result<()> {
    if config.paused {
        return Ok(());
    }
    if now_ts.saturating_sub(config.last_rebalance_ts) < config.min_rebalance_interval {
        return Ok(());
    }

    let plan = plan_rebalance(
        config.price_last,
        config.price_now,
        reserve_a.amount,
        reserve_b.amount,
        mint_a.supply,
        mint_b.supply,
        config.l_min_bps,
        config.l_max_bps,
        config.max_mint_bps,
        config.breaker_bps,
    );

    // Flat move (None) → nothing to do, but still advance the basis so the next
    // window measures from here.
    let (side, minted, _eff) = match plan {
        Some(p) => p,
        None => {
            config.last_rebalance_ts = now_ts;
            config.price_last = config.price_now;
            return Ok(());
        }
    };

    if minted > 0 {
        let bump = config.authority_bump;
        let signer: &[&[&[u8]]] = &[&[AUTHORITY_SEED, &[bump]]];
        let (mint_ai, reserve_ai) = match side {
            Side::A => (mint_a.to_account_info(), reserve_a.to_account_info()),
            Side::B => (mint_b.to_account_info(), reserve_b.to_account_info()),
        };
        mint_to(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                MintTo {
                    mint: mint_ai,
                    to: reserve_ai,
                    authority: authority.to_account_info(),
                },
                signer,
            ),
            minted,
        )?;
        match side {
            Side::A => config.total_minted_a = config.total_minted_a.saturating_add(minted),
            Side::B => config.total_minted_b = config.total_minted_b.saturating_add(minted),
        }
    }

    // Advance the basis: this rebalance has consumed the move.
    config.last_rebalance_ts = now_ts;
    config.price_last = config.price_now;
    Ok(())
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: PDA mint/owner authority, validated by seeds.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,

    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,
    pub receipt_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(token::authority = authority)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(token::mint = mint_a, token::authority = authority)]
    pub reserve_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(token::mint = mint_b, token::authority = authority)]
    pub reserve_b: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: external oracle / TWAP source (M2: a CP-Swap observation_state).
    pub oracle: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitLookupTable<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: authority PDA = LUT authority.
    #[account(mut, seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: derived LUT account, validated against the CPI-derived address.
    #[account(mut)]
    pub lookup_table: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = anchor_lang::solana_program::address_lookup_table::program::ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExtendLookupTable<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: authority PDA = LUT authority.
    #[account(mut, seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the protocol LUT.
    #[account(mut, address = config.lookup_table)]
    pub lookup_table: UncheckedAccount<'info>,
    /// CHECK: Address Lookup Table program.
    #[account(address = anchor_lang::solana_program::address_lookup_table::program::ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterTriangle<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump, has_one = admin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: Instructions sysvar, validated by address; read for introspection.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: authority PDA, validated by seeds.
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = config.mint_a)]
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = config.mint_b)]
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = config.receipt_mint)]
    pub receipt_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub depositor_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub depositor_receipt: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.reserve_a)]
    pub reserve_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.reserve_b)]
    pub reserve_b: Box<InterfaceAccount<'info, TokenAccount>>,

    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub synthetic_token_program: Interface<'info, TokenInterface>,
    pub receipt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Rebalance<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    /// CHECK: authority PDA, validated by seeds.
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, address = config.mint_a)]
    pub mint_a: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.mint_b)]
    pub mint_b: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.reserve_a)]
    pub reserve_a: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.reserve_b)]
    pub reserve_b: InterfaceAccount<'info, TokenAccount>,
    pub synthetic_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList PDA for the receipt mint.
    #[account(
        mut,
        seeds = [META_SEED, receipt_mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.receipt_mint)]
    pub receipt_mint: InterfaceAccount<'info, Mint>,
    pub synthetic_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Order of the first four accounts is fixed by the transfer-hook interface
/// (source, mint, destination, owner); the rest come from `ExtraAccountMetaList`.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint, token::authority = owner)]
    pub source_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = mint)]
    pub destination_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: source owner; SystemAccount or PDA.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList PDA.
    #[account(seeds = [META_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: authority PDA.
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, address = config.mint_a)]
    pub mint_a: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.mint_b)]
    pub mint_b: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.reserve_a)]
    pub reserve_a: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.reserve_b)]
    pub reserve_b: InterfaceAccount<'info, TokenAccount>,
    pub synthetic_token_program: Interface<'info, TokenInterface>,
}
