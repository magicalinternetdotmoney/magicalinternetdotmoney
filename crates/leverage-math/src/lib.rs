//! Core economics for the dynamic leveraged synthetic pair.
//!
//! This is the piece the design doc left as "TBD / open questions". It is made
//! concrete here as a set of *pure* functions (no Solana / Anchor types) so the
//! economics can be unit-tested in isolation with `cargo test -p leverage-engine`.
//!
//! ## Model (made concrete)
//!
//! `MINTA` is leveraged-long exposure to an underlying `U`; `MINTB` is the
//! inverse. We track a TWAP/oracle reference price `p` for `U` (vs USDC).
//! Between two rebalances the underlying moves by `r = (p_now - p_last)/p_last`.
//!
//! The side that *lost* value is the one we mint more of ("mint the loser"):
//! - `r < 0` (U fell) → the long side `A` is the loser.
//! - `r > 0` (U rose) → the inverse side `B` is the loser.
//!
//! Minting `m` of the loser into a constant-product reserve of size `R` moves
//! its relative price down by `m / (R + m)`. For small moves that is ≈ `m / R`,
//! so to realise a target leverage `L` against an underlying move of `|r|` we
//! mint `m ≈ R · L · |r|`, clamped by a per-rebalance cap and a circuit breaker.
//!
//! The leverage `L` itself is *elastic* (the doc's requirement): it floats in
//! `[L_min, L_max]` (default 2x–5x) and decays from `L_max` toward `L_min` as the
//! loser's outstanding supply grows relative to its reserve — that damping is
//! what keeps "mint the loser" from running away to zero on the very first move.
//!
//! All fixed-point ratios are in basis points (`BPS_DENOM = 10_000`); leverage
//! is also carried in bps, so `3.0x == 30_000`.

/// Basis-point denominator. `10_000 bps == 1.0`.
pub const BPS_DENOM: u128 = 10_000;

/// Fraction of the ratio gap absorbed per crank (hook transfer or manual crank).
/// Lower ⇒ more frequent smaller cranks; 3_000 = 30% of the gap per fire.
pub const CRANK_ABSORB_BPS: u64 = 3_000;

/// Move window for mint sizing — clamps variance so tiny moves still crank and
/// large moves don't dump the reserve in one shot.
pub const CRANK_MOVE_FLOOR_BPS: u64 = 75; // 0.75% effective move minimum
pub const CRANK_MOVE_CAP_BPS: u64 = 200; // 2.0% effective move maximum

/// Which synthetic of the pair a value refers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Leveraged-long synthetic (`MINTA`).
    A,
    /// Inverse synthetic (`MINTB`).
    B,
}

/// Signed return of the underlying between two prices, expressed in basis
/// points: `(price_now - price_last) / price_last * 10_000`.
///
/// Returns `None` if `price_last == 0` or the computation overflows `i128`.
pub fn signed_return_bps(price_last: u64, price_now: u64) -> Option<i64> {
    if price_last == 0 {
        return None;
    }
    let last = price_last as i128;
    let now = price_now as i128;
    let diff = now.checked_sub(last)?;
    let bps = diff.checked_mul(BPS_DENOM as i128)?.checked_div(last)?;
    i64::try_from(bps).ok()
}

/// The loser side and the absolute size of the move (in bps) for a price move.
///
/// `None` means "no move / flat" — caller should mint nothing. A move of exactly
/// zero returns `None` because there is no loser to mint.
pub fn loser_and_abs_bps(price_last: u64, price_now: u64) -> Option<(Side, u64)> {
    let r = signed_return_bps(price_last, price_now)?;
    if r == 0 {
        return None;
    }
    // U fell → long side A loses; U rose → inverse side B loses.
    let side = if r < 0 { Side::A } else { Side::B };
    Some((side, r.unsigned_abs()))
}

/// Elastic target leverage (in bps) for the loser, decaying from `l_max_bps`
/// toward `l_min_bps` as the loser's already-minted supply grows relative to its
/// reserve.
///
/// `ratio = reserve / (reserve + supply)` in `[0, 1]`:
/// - fresh side (`supply ≈ 0`) → `ratio ≈ 1` → leverage ≈ `l_max`.
/// - heavily inflated side (`supply ≫ reserve`) → `ratio → 0` → leverage → `l_min`.
///
/// `l_min_bps` is returned if inputs are degenerate (both zero), guaranteeing a
/// value inside `[l_min_bps, l_max_bps]`.
pub fn elastic_leverage_bps(
    l_min_bps: u64,
    l_max_bps: u64,
    loser_reserve: u64,
    loser_supply: u64,
) -> u64 {
    let lo = l_min_bps.min(l_max_bps);
    let hi = l_min_bps.max(l_max_bps);
    let denom = (loser_reserve as u128).checked_add(loser_supply as u128);
    let ratio_bps = match denom {
        Some(0) | None => return lo,
        Some(d) => (loser_reserve as u128)
            .saturating_mul(BPS_DENOM)
            .checked_div(d)
            .unwrap_or(0),
    };
    // leverage = lo + (hi - lo) * ratio
    let span = (hi - lo) as u128;
    let add = span.saturating_mul(ratio_bps) / BPS_DENOM;
    let lev = lo as u128 + add;
    lev.min(hi as u128) as u64
}

/// Amount of the loser synthetic to mint this rebalance.
///
/// `m = loser_reserve · (abs_return_bps · leverage_bps / 10_000)`, with the
/// minted *fraction* clamped to `max_mint_bps`, and **zero** when the move is at
/// or beyond `breaker_bps` (circuit breaker — minting pauses on extreme moves to
/// avoid vaporising the loser reserve in a black-swan candle).
///
/// Returns the minted amount, or `None` on overflow.
pub fn loser_mint_amount(
    loser_reserve: u64,
    abs_return_bps: u64,
    leverage_bps: u64,
    max_mint_bps: u64,
    breaker_bps: u64,
) -> Option<u64> {
    if abs_return_bps == 0 || loser_reserve == 0 {
        return Some(0);
    }
    if breaker_bps != 0 && abs_return_bps >= breaker_bps {
        // Circuit breaker tripped: mint nothing this rebalance.
        return Some(0);
    }
    // fraction (bps) = abs_return_bps * leverage_bps / 10_000
    let mut frac_bps = (abs_return_bps as u128)
        .checked_mul(leverage_bps as u128)?
        .checked_div(BPS_DENOM)?;
    let cap = max_mint_bps as u128;
    if cap != 0 && frac_bps > cap {
        frac_bps = cap;
    }
    let minted = (loser_reserve as u128)
        .checked_mul(frac_bps)?
        .checked_div(BPS_DENOM)?;
    u64::try_from(minted).ok()
}

/// Effective realised leverage (in bps) of a rebalance, for dashboards /
/// telemetry: the loser's implied price move `minted / (reserve + minted)`
/// divided by the underlying move `abs_return_bps`.
///
/// Returns `None` if there was no underlying move.
pub fn effective_leverage_bps(
    loser_reserve: u64,
    minted: u64,
    abs_return_bps: u64,
) -> Option<u64> {
    if abs_return_bps == 0 {
        return None;
    }
    let denom = (loser_reserve as u128).checked_add(minted as u128)?;
    if denom == 0 {
        return Some(0);
    }
    let implied_move_bps = (minted as u128).checked_mul(BPS_DENOM)?.checked_div(denom)?;
    let lev = implied_move_bps
        .checked_mul(BPS_DENOM)?
        .checked_div(abs_return_bps as u128)?;
    u64::try_from(lev).ok()
}

/// Convenience: run the full rebalance decision end-to-end.
///
/// Returns `(loser_side, minted_amount, effective_leverage_bps)`, or `None` when
/// there is nothing to do (flat move) / on overflow. `minted_amount == 0` with a
/// `Some` result means the circuit breaker tripped or the move rounded to zero.
#[allow(clippy::too_many_arguments)]
pub fn plan_rebalance(
    price_last: u64,
    price_now: u64,
    reserve_a: u64,
    reserve_b: u64,
    supply_a: u64,
    supply_b: u64,
    l_min_bps: u64,
    l_max_bps: u64,
    max_mint_bps: u64,
    breaker_bps: u64,
) -> Option<(Side, u64, u64)> {
    let (side, abs_bps) = loser_and_abs_bps(price_last, price_now)?;
    let (reserve, supply) = match side {
        Side::A => (reserve_a, supply_a),
        Side::B => (reserve_b, supply_b),
    };
    let lev = elastic_leverage_bps(l_min_bps, l_max_bps, reserve, supply);
    let minted = loser_mint_amount(reserve, abs_bps, lev, max_mint_bps, breaker_bps)?;
    let eff = effective_leverage_bps(reserve, minted, abs_bps).unwrap_or(0);
    Some((side, minted, eff))
}

/// Clamp a *user-specified* leverage into the protocol's safety band.
///
/// Leverage is user-chosen per deposit (the design's "variable leverage"); the
/// band `[l_min_bps, l_max_bps]` is only a guardrail.
pub fn clamp_leverage_bps(user_bps: u64, l_min_bps: u64, l_max_bps: u64) -> u64 {
    let lo = l_min_bps.min(l_max_bps);
    let hi = l_min_bps.max(l_max_bps);
    user_bps.clamp(lo, hi)
}

/// A "mint the loser into BOTH pools" plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RebalancePlan {
    pub side: Side,
    /// Loser amount to mint + sell into the MINTA/MINTB pool.
    pub amount_pair_pool: u64,
    /// Loser amount to mint + sell into the loser/USDC pool.
    pub amount_usdc_pool: u64,
    /// Effective (clamped) leverage used, in bps.
    pub leverage_bps: u64,
    /// Absolute underlying move, in bps.
    pub abs_return_bps: u64,
}

/// Plan a rebalance that mints the loser into **both** pools it lives in — the
/// MINTA/MINTB pool *and* the loser/USDC pool — so the loser's price falls by the
/// same `~L·|r|` in each.
///
/// This is the correction to the naive "mint into the pair pool only" design:
/// pushing both venues together removes the buy-cheap-in-pair / dump-into-USDC
/// arbitrage that would otherwise drain the USDC anchor, because there is no
/// longer a price gap between the two venues to harvest. The invariant the
/// caller gets is `amount_pair/pair_reserve == amount_usdc/usdc_reserve` (both
/// pools move by the same fraction), modulo per-pool caps.
///
/// Loser tokens are freshly minted (the program is the mint authority) and sold
/// into each pool via a CP-Swap `swap_base_input`; proceeds accrue to the
/// protocol. `user_leverage_bps` is the depositor-chosen leverage, clamped to the
/// band. Returns `None` on a flat move (nothing to do) or overflow.
#[allow(clippy::too_many_arguments)]
pub fn plan_two_pool_rebalance(
    price_last: u64,
    price_now: u64,
    reserve_a_in_pair: u64,
    reserve_b_in_pair: u64,
    reserve_a_in_a_usdc: u64,
    reserve_b_in_b_usdc: u64,
    user_leverage_bps: u64,
    l_min_bps: u64,
    l_max_bps: u64,
    max_mint_bps: u64,
    breaker_bps: u64,
) -> Option<RebalancePlan> {
    let (side, abs_bps) = loser_and_abs_bps(price_last, price_now)?;
    let leverage_bps = clamp_leverage_bps(user_leverage_bps, l_min_bps, l_max_bps);
    let (pair_reserve, usdc_reserve) = match side {
        Side::A => (reserve_a_in_pair, reserve_a_in_a_usdc),
        Side::B => (reserve_b_in_pair, reserve_b_in_b_usdc),
    };
    let amount_pair_pool =
        loser_mint_amount(pair_reserve, abs_bps, leverage_bps, max_mint_bps, breaker_bps)?;
    let amount_usdc_pool =
        loser_mint_amount(usdc_reserve, abs_bps, leverage_bps, max_mint_bps, breaker_bps)?;
    Some(RebalancePlan {
        side,
        amount_pair_pool,
        amount_usdc_pool,
        leverage_bps,
        abs_return_bps: abs_bps,
    })
}

// ---------------------------------------------------------------------------
// Oracle-free model: derive everything from on-chain pool reserves + supplies.
// ---------------------------------------------------------------------------

/// WAD fixed-point scale for prices/ratios (1e9).
pub const WAD: u128 = 1_000_000_000;

/// Market state implied purely by on-chain state — no external oracle.
///
/// Prices come from the USDC-anchored pools (`price = usdc_reserve / token_reserve`),
/// market caps from the synthetic supplies. The A/B price `ratio` is the leverage
/// signal: its move since the last rebalance picks the loser and the magnitude.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImpliedMarket {
    /// USDC per A, WAD-scaled.
    pub price_a_wad: u128,
    /// USDC per B, WAD-scaled.
    pub price_b_wad: u128,
    /// supply_a · price_a (implied market cap of A, USDC units).
    pub mcap_a: u128,
    /// supply_b · price_b.
    pub mcap_b: u128,
    /// price_a / price_b, WAD-scaled — the leverage signal.
    pub ratio_wad: u128,
}

/// Compute the implied market from the four USDC-pool reserves + the two synthetic
/// supplies. Returns `None` if a token reserve is zero (no price) or on overflow.
pub fn implied_market(
    a_reserve_in_a_usdc: u64,
    usdc_reserve_in_a_usdc: u64,
    b_reserve_in_b_usdc: u64,
    usdc_reserve_in_b_usdc: u64,
    supply_a: u64,
    supply_b: u64,
) -> Option<ImpliedMarket> {
    if a_reserve_in_a_usdc == 0 || b_reserve_in_b_usdc == 0 {
        return None;
    }
    let price_a = (usdc_reserve_in_a_usdc as u128)
        .checked_mul(WAD)?
        .checked_div(a_reserve_in_a_usdc as u128)?;
    let price_b = (usdc_reserve_in_b_usdc as u128)
        .checked_mul(WAD)?
        .checked_div(b_reserve_in_b_usdc as u128)?;
    if price_b == 0 {
        return None;
    }
    let ratio_wad = price_a.checked_mul(WAD)?.checked_div(price_b)?;
    // Mcaps are diagnostic only; never fail the hook/crank if they overflow.
    let mcap_a = (supply_a as u128)
        .checked_mul(price_a)
        .and_then(|v| v.checked_div(WAD))
        .unwrap_or(0);
    let mcap_b = (supply_b as u128)
        .checked_mul(price_b)
        .and_then(|v| v.checked_div(WAD))
        .unwrap_or(0);
    Some(ImpliedMarket {
        price_a_wad: price_a,
        price_b_wad: price_b,
        mcap_a,
        mcap_b,
        ratio_wad,
    })
}

/// Median of non-zero WAD samples. Returns `0` when every sample is zero.
pub fn median_wad(samples: &[u128]) -> u128 {
    let mut v: [u128; 32] = [0; 32];
    let mut n = 0usize;
    for &s in samples {
        if s > 0 && n < v.len() {
            v[n] = s;
            n += 1;
        }
    }
    if n == 0 {
        return 0;
    }
    let slice = &mut v[..n];
    slice.sort_unstable();
    if n % 2 == 1 {
        slice[n / 2]
    } else {
        let a = slice[n / 2 - 1];
        let b = slice[n / 2];
        (a / 2).saturating_add(b / 2).saturating_add((a % 2 + b % 2) / 2)
    }
}

/// Advance `last` toward `now` by `absorb_bps / 10_000` of the gap (signed).
/// Used after each crank so repeated transfers keep firing until caught up.
pub fn partial_ratio_advance(last_wad: u128, now_wad: u128, absorb_bps: u64) -> u128 {
    if absorb_bps == 0 {
        return last_wad;
    }
    if absorb_bps >= BPS_DENOM as u64 {
        return now_wad;
    }
    let gap = (now_wad as i128).saturating_sub(last_wad as i128);
    let delta = gap.saturating_mul(absorb_bps as i128) / BPS_DENOM as i128;
    let new = (last_wad as i128).saturating_add(delta);
    if new <= 0 {
        last_wad
    } else {
        new as u128
    }
}

/// Clamp the underlying move used for mint sizing (not for loser-side pick).
pub fn clamp_crank_move_bps(abs_bps: u64) -> u64 {
    abs_bps.clamp(CRANK_MOVE_FLOOR_BPS, CRANK_MOVE_CAP_BPS)
}

/// Signed return (bps) of the A/B ratio between two WAD values.
pub fn ratio_return_bps(last_wad: u128, now_wad: u128) -> Option<i64> {
    if last_wad == 0 {
        return None;
    }
    let diff = (now_wad as i128).checked_sub(last_wad as i128)?;
    let bps = diff.checked_mul(BPS_DENOM as i128)?.checked_div(last_wad as i128)?;
    i64::try_from(bps).ok()
}

/// Plan a two-pool rebalance using an external oracle price (WAD, quote per base).
///
/// Loser selection follows the oracle move (fell → A, rose → B); mint sizing uses
/// the triangle pool reserves with elastic leverage decay on the pair reserve.
#[allow(clippy::too_many_arguments)]
pub fn plan_two_pool_from_oracle_wad(
    oracle_last_wad: u128,
    oracle_now_wad: u128,
    reserve_a_in_pair: u64,
    reserve_b_in_pair: u64,
    reserve_a_in_a_usdc: u64,
    reserve_b_in_b_usdc: u64,
    supply_a: u64,
    supply_b: u64,
    user_leverage_bps: u64,
    l_min_bps: u64,
    l_max_bps: u64,
    max_mint_bps: u64,
    breaker_bps: u64,
) -> Option<RebalancePlan> {
    let r = ratio_return_bps(oracle_last_wad, oracle_now_wad)?;
    if r == 0 {
        return None;
    }
    let side = if r < 0 { Side::A } else { Side::B };
    let abs_bps = r.unsigned_abs();
    let sized_bps = clamp_crank_move_bps(abs_bps);

    let (pair_reserve, usdc_pool_reserve, supply) = match side {
        Side::A => (reserve_a_in_pair, reserve_a_in_a_usdc, supply_a),
        Side::B => (reserve_b_in_pair, reserve_b_in_b_usdc, supply_b),
    };

    let pick = if user_leverage_bps == 0 { l_max_bps } else { user_leverage_bps };
    let user = clamp_leverage_bps(pick, l_min_bps, l_max_bps);
    let elastic = elastic_leverage_bps(l_min_bps, l_max_bps, pair_reserve, supply);
    let leverage_bps = user.min(elastic);

    if breaker_bps != 0 && abs_bps >= breaker_bps {
        return Some(RebalancePlan {
            side,
            amount_pair_pool: 0,
            amount_usdc_pool: 0,
            leverage_bps,
            abs_return_bps: abs_bps,
        });
    }

    let amount_pair_pool =
        loser_mint_amount(pair_reserve, sized_bps, leverage_bps, max_mint_bps, 0)?;
    let amount_usdc_pool =
        loser_mint_amount(usdc_pool_reserve, sized_bps, leverage_bps, max_mint_bps, 0)?;
    Some(RebalancePlan {
        side,
        amount_pair_pool,
        amount_usdc_pool,
        leverage_bps,
        abs_return_bps: abs_bps,
    })
}

/// Plan a rebalance from the implied market — the oracle-free entry point.
///
/// The loser is whichever synthetic the A/B ratio moved *against* since the last
/// rebalance (ratio fell → A underperformed → A is the loser; rose → B). Leverage
/// is the user's pick, clamped to the band AND capped by the supply-aware elastic
/// decay (`elastic_leverage_bps`) so an already-inflated side de-levers — this is
/// where supply + reserves enter the model. The loser is then minted into both its
/// pool vaults sized to its reserve in each.
///
/// `last_ratio_wad` is the ratio recorded at the previous rebalance (stored in
/// Config). Returns `None` on a flat ratio / overflow.
#[allow(clippy::too_many_arguments)]
pub fn plan_from_market(
    last_ratio_wad: u128,
    market: &ImpliedMarket,
    reserve_a_in_pair: u64,
    reserve_b_in_pair: u64,
    reserve_a_in_a_usdc: u64,
    reserve_b_in_b_usdc: u64,
    supply_a: u64,
    supply_b: u64,
    user_leverage_bps: u64,
    l_min_bps: u64,
    l_max_bps: u64,
    max_mint_bps: u64,
    breaker_bps: u64,
) -> Option<RebalancePlan> {
    let r = ratio_return_bps(last_ratio_wad, market.ratio_wad)?;
    if r == 0 {
        return None;
    }
    let side = if r < 0 { Side::A } else { Side::B };
    let abs_bps = r.unsigned_abs();
    let sized_bps = clamp_crank_move_bps(abs_bps);

    let (pair_reserve, usdc_pool_reserve, supply) = match side {
        Side::A => (reserve_a_in_pair, reserve_a_in_a_usdc, supply_a),
        Side::B => (reserve_b_in_pair, reserve_b_in_b_usdc, supply_b),
    };

    // 0 ⇒ full band (hook + crank default), clamped then elastically capped.
    let pick = if user_leverage_bps == 0 { l_max_bps } else { user_leverage_bps };
    let user = clamp_leverage_bps(pick, l_min_bps, l_max_bps);
    let elastic = elastic_leverage_bps(l_min_bps, l_max_bps, pair_reserve, supply);
    let leverage_bps = user.min(elastic);

    // Breaker trips on the *actual* ratio move; sizing uses the clamped move.
    if breaker_bps != 0 && abs_bps >= breaker_bps {
        return Some(RebalancePlan {
            side,
            amount_pair_pool: 0,
            amount_usdc_pool: 0,
            leverage_bps,
            abs_return_bps: abs_bps,
        });
    }

    let amount_pair_pool =
        loser_mint_amount(pair_reserve, sized_bps, leverage_bps, max_mint_bps, 0)?;
    let amount_usdc_pool =
        loser_mint_amount(usdc_pool_reserve, sized_bps, leverage_bps, max_mint_bps, 0)?;
    Some(RebalancePlan {
        side,
        amount_pair_pool,
        amount_usdc_pool,
        leverage_bps,
        abs_return_bps: abs_bps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const L_MIN: u64 = 20_000; // 2.0x
    const L_MAX: u64 = 50_000; // 5.0x
    const MAX_MINT: u64 = 2_000; // 20% of reserve per rebalance
    const BREAKER: u64 = 5_000; // pause minting on >= 50% moves

    #[test]
    fn signed_return_basic() {
        assert_eq!(signed_return_bps(100, 101), Some(100)); // +1%
        assert_eq!(signed_return_bps(100, 99), Some(-100)); // -1%
        assert_eq!(signed_return_bps(100, 100), Some(0));
        assert_eq!(signed_return_bps(0, 100), None);
    }

    #[test]
    fn loser_is_long_when_underlying_falls() {
        let (side, abs) = loser_and_abs_bps(100, 95).unwrap();
        assert_eq!(side, Side::A);
        assert_eq!(abs, 500); // 5%
    }

    #[test]
    fn loser_is_inverse_when_underlying_rises() {
        let (side, abs) = loser_and_abs_bps(100, 110).unwrap();
        assert_eq!(side, Side::B);
        assert_eq!(abs, 1000); // 10%
    }

    #[test]
    fn flat_move_has_no_loser() {
        assert_eq!(loser_and_abs_bps(100, 100), None);
    }

    #[test]
    fn elastic_leverage_high_when_reserve_dominates() {
        // fresh side: supply ~ 0 → near L_MAX
        let lev = elastic_leverage_bps(L_MIN, L_MAX, 1_000_000, 0);
        assert_eq!(lev, L_MAX);
    }

    #[test]
    fn elastic_leverage_low_when_supply_dominates() {
        // supply ≫ reserve → toward L_MIN
        let lev = elastic_leverage_bps(L_MIN, L_MAX, 1, 1_000_000);
        assert!(lev >= L_MIN && lev <= L_MIN + 100, "got {lev}");
    }

    #[test]
    fn elastic_leverage_midpoint() {
        // reserve == supply → ratio 0.5 → midpoint of the band (3.5x)
        let lev = elastic_leverage_bps(L_MIN, L_MAX, 1_000, 1_000);
        assert_eq!(lev, 35_000);
    }

    #[test]
    fn elastic_leverage_stays_in_band_and_handles_zero() {
        assert_eq!(elastic_leverage_bps(L_MIN, L_MAX, 0, 0), L_MIN);
        let lev = elastic_leverage_bps(L_MIN, L_MAX, 12345, 67890);
        assert!(lev >= L_MIN && lev <= L_MAX);
    }

    #[test]
    fn mint_scales_with_move_and_leverage() {
        // 1% move at 3x → 3% of a 1_000_000 reserve = 30_000
        let m = loser_mint_amount(1_000_000, 100, 30_000, MAX_MINT, BREAKER).unwrap();
        assert_eq!(m, 30_000);
    }

    #[test]
    fn mint_is_capped_by_max_mint_bps() {
        // 10% move at 5x would be 50% of reserve, capped to 20%.
        let m = loser_mint_amount(1_000_000, 1_000, 50_000, MAX_MINT, BREAKER).unwrap();
        assert_eq!(m, 200_000); // 20%
    }

    #[test]
    fn circuit_breaker_pauses_minting() {
        // 60% move >= 50% breaker → mint nothing.
        let m = loser_mint_amount(1_000_000, 6_000, 50_000, MAX_MINT, BREAKER).unwrap();
        assert_eq!(m, 0);
    }

    #[test]
    fn mint_zero_inputs() {
        assert_eq!(loser_mint_amount(0, 100, 30_000, MAX_MINT, BREAKER), Some(0));
        assert_eq!(
            loser_mint_amount(1_000_000, 0, 30_000, MAX_MINT, BREAKER),
            Some(0)
        );
    }

    #[test]
    fn mint_does_not_panic_on_extremes() {
        // Huge reserve, large-but-sub-breaker move, uncapped: the u64 result
        // overflows, so we expect a graceful `None` (not a panic).
        let m = loser_mint_amount(u64::MAX, 4_999, 50_000, 0, BREAKER);
        assert!(m.is_none());
    }

    #[test]
    fn mint_with_cap_stays_in_u64_on_extremes() {
        // The same extreme, but with a sane per-rebalance cap, stays representable.
        let m = loser_mint_amount(u64::MAX, 4_999, 50_000, MAX_MINT, BREAKER).unwrap();
        // capped at 20% of u64::MAX
        assert_eq!(m, (u64::MAX as u128 * 2_000 / 10_000) as u64);
    }

    #[test]
    fn effective_leverage_recovers_target_for_small_moves() {
        // mint 30_000 into 1_000_000 reserve for a 1% move → ~2.91x
        // (implied move = 30_000/1_030_000 ≈ 2.91%, /1% ≈ 2.91x). For small moves
        // this approaches the 3x target; the gap is the constant-product curvature.
        let eff = effective_leverage_bps(1_000_000, 30_000, 100).unwrap();
        assert!(eff >= 28_000 && eff <= 30_000, "got {eff}");
    }

    #[test]
    fn plan_rebalance_end_to_end_down_move() {
        // Underlying down 1% from a fresh book → long side A is the loser, minted
        // at ~L_MAX (5x) because both sides start with no extra supply.
        let (side, minted, eff) = plan_rebalance(
            100, 99, 1_000_000, 1_000_000, 0, 0, L_MIN, L_MAX, MAX_MINT, BREAKER,
        )
        .unwrap();
        assert_eq!(side, Side::A);
        // 1% * 5x = 5% of 1_000_000 = 50_000
        assert_eq!(minted, 50_000);
        assert!(eff > 0);
    }

    #[test]
    fn plan_rebalance_flat_is_none() {
        assert!(plan_rebalance(
            100, 100, 1_000_000, 1_000_000, 0, 0, L_MIN, L_MAX, MAX_MINT, BREAKER
        )
        .is_none());
    }

    // --- two-pool ("mint the loser into both pools") model ---

    #[test]
    fn user_leverage_is_clamped_to_band() {
        assert_eq!(clamp_leverage_bps(10_000, L_MIN, L_MAX), L_MIN); // 1x → 2x floor
        assert_eq!(clamp_leverage_bps(99_000, L_MIN, L_MAX), L_MAX); // 9.9x → 5x cap
        assert_eq!(clamp_leverage_bps(35_000, L_MIN, L_MAX), 35_000); // 3.5x kept
    }

    #[test]
    fn two_pool_down_move_targets_long_side_in_both_pools() {
        // U down 1%, user picks 3x. Loser is A; mint A into the A/B pool and the
        // A/USDC pool. Pair pool A reserve 1_000_000, A/USDC pool A reserve 400_000.
        let p = plan_two_pool_rebalance(
            100, 99, 1_000_000, 1_000_000, 400_000, 500_000, 30_000, L_MIN, L_MAX, MAX_MINT,
            BREAKER,
        )
        .unwrap();
        assert_eq!(p.side, Side::A);
        assert_eq!(p.leverage_bps, 30_000);
        // 1% * 3x = 3% of each side's reserve
        assert_eq!(p.amount_pair_pool, 30_000); // 3% of 1_000_000
        assert_eq!(p.amount_usdc_pool, 12_000); // 3% of 400_000
    }

    #[test]
    fn two_pool_keeps_both_venues_in_lockstep_no_arb_gap() {
        // The anti-arb invariant: both pools move by the SAME fraction, so there
        // is no price gap to harvest between the pair pool and the USDC pool.
        let pair_reserve = 1_234_567u64;
        let usdc_reserve = 987_654u64;
        let p = plan_two_pool_rebalance(
            100, 97, pair_reserve, 1_000_000, usdc_reserve, 1_000_000, 40_000, L_MIN, L_MAX,
            10_000, // wide cap so neither side clips
            BREAKER,
        )
        .unwrap();
        // amount/reserve should match to within rounding (bps granularity).
        let frac_pair = p.amount_pair_pool as u128 * BPS_DENOM / pair_reserve as u128;
        let frac_usdc = p.amount_usdc_pool as u128 * BPS_DENOM / usdc_reserve as u128;
        let diff = frac_pair.abs_diff(frac_usdc);
        assert!(diff <= 1, "pools drift apart: {frac_pair} vs {frac_usdc}");
    }

    #[test]
    fn two_pool_up_move_targets_inverse_side() {
        let p = plan_two_pool_rebalance(
            100, 105, 1_000_000, 800_000, 400_000, 600_000, 50_000, L_MIN, L_MAX, MAX_MINT,
            BREAKER,
        )
        .unwrap();
        assert_eq!(p.side, Side::B);
        // capped at 20% of each B reserve (5% move * 5x = 25% → clipped to 20%)
        assert_eq!(p.amount_pair_pool, 160_000); // 20% of 800_000
        assert_eq!(p.amount_usdc_pool, 120_000); // 20% of 600_000
    }

    #[test]
    fn two_pool_circuit_breaker_zeroes_both() {
        let p = plan_two_pool_rebalance(
            100, 40, 1_000_000, 1_000_000, 400_000, 400_000, 30_000, L_MIN, L_MAX, MAX_MINT,
            BREAKER,
        )
        .unwrap();
        assert_eq!(p.amount_pair_pool, 0);
        assert_eq!(p.amount_usdc_pool, 0);
    }

    #[test]
    fn two_pool_flat_is_none() {
        assert!(plan_two_pool_rebalance(
            100, 100, 1_000_000, 1_000_000, 1, 1, 30_000, L_MIN, L_MAX, MAX_MINT, BREAKER
        )
        .is_none());
    }

    // --- oracle-free implied-market model ---

    #[test]
    fn implied_market_prices_and_mcaps() {
        // A/USDC: 1000 A, 2000 USDC → price_a = 2.0 ; B/USDC: 1000 B, 1000 USDC → 1.0
        let m = implied_market(1_000, 2_000, 1_000, 1_000, 500, 800).unwrap();
        assert_eq!(m.price_a_wad, 2 * WAD);
        assert_eq!(m.price_b_wad, WAD);
        assert_eq!(m.ratio_wad, 2 * WAD); // A is 2x B
        assert_eq!(m.mcap_a, 500 * 2); // supply_a · price_a
        assert_eq!(m.mcap_b, 800 * 1);
    }

    #[test]
    fn implied_market_zero_reserve_is_none() {
        assert!(implied_market(0, 2_000, 1_000, 1_000, 1, 1).is_none());
    }

    #[test]
    fn median_wad_odd_and_even() {
        assert_eq!(median_wad(&[3 * WAD, 1 * WAD, 2 * WAD]), 2 * WAD);
        assert_eq!(median_wad(&[4 * WAD, 2 * WAD]), 3 * WAD);
        assert_eq!(median_wad(&[0, 0]), 0);
    }

    #[test]
    fn ratio_return_directions() {
        assert_eq!(ratio_return_bps(2 * WAD, 2 * WAD), Some(0));
        assert_eq!(ratio_return_bps(2 * WAD, 198 * WAD / 100), Some(-100)); // −1%
        assert_eq!(ratio_return_bps(2 * WAD, 202 * WAD / 100), Some(100)); // +1%
        assert_eq!(ratio_return_bps(0, WAD), None);
    }

    #[test]
    fn plan_from_market_ratio_fell_makes_a_the_loser() {
        // A/USDC moved 1000A/2000U → 1100A/1980U (A cheaper); B/USDC unchanged.
        // ratio drops → A underperformed → A is the loser, minted into both pools.
        let m = implied_market(1_100, 1_980, 1_000, 1_000, 0, 0).unwrap();
        let last = 2 * WAD; // previous ratio was exactly 2.0
        let p = plan_from_market(
            last, &m, 1_000_000, 1_000_000, 1_100, 1_000, 0, 0, 30_000, L_MIN, L_MAX, MAX_MINT,
            BREAKER,
        )
        .unwrap();
        assert_eq!(p.side, Side::A);
        assert!(p.amount_pair_pool > 0 && p.amount_usdc_pool > 0);
    }

    #[test]
    fn plan_from_market_elastic_caps_user_leverage_when_supply_inflated() {
        // Loser side A with supply ≫ pair reserve → elastic decay forces ~L_MIN,
        // overriding a 5x user pick.
        let m = implied_market(1_100, 1_980, 1_000, 1_000, 0, 0).unwrap();
        let p = plan_from_market(
            2 * WAD, &m, 1_000, 1_000_000, 1_100, 1_000, 10_000_000, 1_000, 50_000, L_MIN, L_MAX,
            10_000, BREAKER,
        )
        .unwrap();
        assert!(p.leverage_bps <= L_MIN + 100, "elastic did not cap leverage: {}", p.leverage_bps);
    }

    #[test]
    fn plan_from_market_flat_ratio_is_none() {
        let m = implied_market(1_000, 2_000, 1_000, 1_000, 0, 0).unwrap();
        assert!(plan_from_market(
            2 * WAD, &m, 1_000_000, 1_000_000, 1_000, 1_000, 0, 0, 30_000, L_MIN, L_MAX, MAX_MINT,
            BREAKER
        )
        .is_none());
    }

    /// Mainnet 5xBTC pair snapshot (Jun 2026) — hook must plan a non-zero mint.
    #[test]
    fn plan_from_market_mainnet_5xbtc_snapshot_mints() {
        let last = 61_619_745_271_372u128;
        let m = implied_market(502, 119_871_040, 23_161_458, 90_290_933, 2_350, 135_000_000)
            .expect("implied_market");
        let p = plan_from_market(
            last, &m, 729, 44_421_117, 502, 23_161_458, 2_350, 135_000_000, 80_000, 20_000,
            80_000, 2_000, 5_000,
        )
        .expect("plan");
        assert_eq!(p.side, Side::A);
        assert!(p.amount_pair_pool > 0, "pair pool mint");
        assert!(p.amount_usdc_pool > 0, "usdc pool mint");
    }

    #[test]
    fn partial_ratio_advance_leaves_headroom_for_followup_cranks() {
        let last = 100 * WAD;
        let now = 110 * WAD;
        let mid = partial_ratio_advance(last, now, CRANK_ABSORB_BPS);
        assert!(mid > last && mid < now, "partial advance");
        assert!(ratio_return_bps(mid, now).unwrap() != 0, "gap remains");
    }

    #[test]
    fn crank_move_clamp_reduces_mint_variance() {
        let m = implied_market(1_000, 2_000, 1_000, 2_000, 0, 0).unwrap();
        let now = m.ratio_wad;
        // +0.5% ratio move (below floor → sizes at CRANK_MOVE_FLOOR_BPS)
        let small_last = now * 995 / 1000;
        let small = plan_from_market(
            small_last, &m, 1_000_000, 1_000_000, 1_000, 1_000, 0, 0, 50_000, L_MIN, L_MAX,
            MAX_MINT, BREAKER,
        );
        // +5% ratio move (above cap → sizes at CRANK_MOVE_CAP_BPS)
        let big_last = now * 95 / 100;
        let big = plan_from_market(
            big_last, &m, 1_000_000, 1_000_000, 1_000, 1_000, 0, 0, 50_000, L_MIN, L_MAX, MAX_MINT,
            BREAKER,
        );
        let (small, big) = (small.expect("small"), big.expect("big"));
        // Floor/cap should keep mint sizes within a modest band (5% vs 0.5% raw move).
        let ratio = big.amount_pair_pool as f64 / small.amount_pair_pool as f64;
        assert!(
            ratio < 3.0,
            "mint variance ratio {ratio} (cap {}/floor {})",
            CRANK_MOVE_CAP_BPS,
            CRANK_MOVE_FLOOR_BPS
        );
    }
}

#[cfg(test)]
mod redteam {
    //! Adversarial coverage: a fuzz sweep over extreme inputs (invariants must
    //! never break / panic) and a multi-round drain simulation answering the core
    //! red-team question — does "mint the loser into both pools" drain the quote
    //! anchor? (Structural answer: no — the rebalance only ADDS loser tokens, it
    //! never removes quote, so the protocol cannot drain the anchor.)
    use super::*;

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0
        }
        fn range(&mut self, lo: u64, hi: u64) -> u64 {
            if hi <= lo {
                lo
            } else {
                lo + self.next() % (hi - lo + 1)
            }
        }
        /// extreme-biased pick: 0 / 1 / small / medium / huge
        fn pick(&mut self) -> u64 {
            match self.next() % 6 {
                0 => 0,
                1 => 1,
                2 => self.range(2, 1_000),
                3 => self.range(1_000, 1_000_000_000),
                4 => self.range(1_000_000_000, u64::MAX / 4),
                _ => u64::MAX / 2,
            }
        }
    }

    const L_MIN: u64 = 20_000;
    const L_MAX: u64 = 50_000;

    #[test]
    fn fuzz_pipeline_never_breaks_invariants() {
        let mut r = Lcg(0x00C0_FFEE_1234_5678);
        let mut produced = 0u64;
        for _ in 0..1_000_000 {
            let (a_au, u_au, b_bu, u_bu) = (r.pick(), r.pick(), r.pick(), r.pick());
            let (sa, sb) = (r.pick(), r.pick());
            let (ra_pair, rb_pair) = (r.pick(), r.pick());
            let last_ratio = (r.pick() as u128).max(1);
            let user_lev = r.range(0, 100_000);
            let cap = r.range(0, 5_000);
            let breaker = r.range(0, 10_000);

            if let Some(m) = implied_market(a_au, u_au, b_bu, u_bu, sa, sb) {
                if let Some(p) = plan_from_market(
                    last_ratio, &m, ra_pair, rb_pair, a_au, b_bu, sa, sb, user_lev, L_MIN, L_MAX,
                    cap, breaker,
                ) {
                    produced += 1;
                    // leverage always inside the band
                    assert!(p.leverage_bps >= L_MIN && p.leverage_bps <= L_MAX);
                    // circuit breaker → both legs zero
                    if breaker != 0 && p.abs_return_bps >= breaker {
                        assert_eq!(p.amount_pair_pool, 0);
                        assert_eq!(p.amount_usdc_pool, 0);
                    }
                    // per-leg mint never exceeds the cap fraction of its reserve
                    if cap != 0 {
                        let (pr, ur) = match p.side {
                            Side::A => (ra_pair, a_au),
                            Side::B => (rb_pair, b_bu),
                        };
                        assert!(p.amount_pair_pool as u128 <= (pr as u128) * (cap as u128) / 10_000 + 1);
                        assert!(p.amount_usdc_pool as u128 <= (ur as u128) * (cap as u128) / 10_000 + 1);
                    }
                }
            }
        }
        assert!(produced > 0, "fuzz produced no plans — coverage bug");
    }

    #[test]
    fn drain_sim_protocol_never_touches_the_quote_anchor() {
        let (cap, breaker) = (2_000u64, 5_000u64);
        // A/B, A/USDC, B/USDC reserves
        let (mut a_ab, mut b_ab) = (1_000_000u64, 1_000_000u64);
        let (mut a_au, mut u_au) = (1_000_000u64, 1_000_000u64);
        let (mut b_bu, mut u_bu) = (1_000_000u64, 1_000_000u64);
        let (mut sup_a, mut sup_b) = (3_000_000u64, 3_000_000u64);
        let mut last_ratio = WAD;
        let mut r = Lcg(0x0DEA_DBEE_FF00_D001);
        let mut total_minted: u128 = 0;
        let mut quote_touched_by_protocol: u128 = 0;

        for _ in 0..2000 {
            // external trade shock in A/USDC (x*y=k)
            let k = a_au as u128 * u_au as u128;
            let amt = r.range(1, 50_000);
            if r.next() % 2 == 0 {
                a_au = a_au.saturating_add(amt);
                u_au = ((k / a_au.max(1) as u128) as u64).max(1);
            } else {
                u_au = u_au.saturating_add(amt);
                a_au = ((k / u_au.max(1) as u128) as u64).max(1);
            }
            // sometimes shock B/USDC too
            if r.next() % 3 == 0 {
                let k2 = b_bu as u128 * u_bu as u128;
                b_bu = b_bu.saturating_add(r.range(1, 50_000));
                u_bu = ((k2 / b_bu.max(1) as u128) as u64).max(1);
            }

            let (u_au_pre, u_bu_pre) = (u_au, u_bu); // quote BEFORE rebalance
            if let Some(m) = implied_market(a_au, u_au, b_bu, u_bu, sup_a, sup_b) {
                if let Some(p) = plan_from_market(
                    last_ratio, &m, a_ab, b_ab, a_au, b_bu, sup_a, sup_b, L_MAX, L_MIN, L_MAX, cap,
                    breaker,
                ) {
                    match p.side {
                        Side::A => {
                            a_ab = a_ab.saturating_add(p.amount_pair_pool);
                            a_au = a_au.saturating_add(p.amount_usdc_pool);
                            sup_a = sup_a
                                .saturating_add(p.amount_pair_pool)
                                .saturating_add(p.amount_usdc_pool);
                        }
                        Side::B => {
                            b_ab = b_ab.saturating_add(p.amount_pair_pool);
                            b_bu = b_bu.saturating_add(p.amount_usdc_pool);
                            sup_b = sup_b
                                .saturating_add(p.amount_pair_pool)
                                .saturating_add(p.amount_usdc_pool);
                        }
                    }
                    total_minted += p.amount_pair_pool as u128 + p.amount_usdc_pool as u128;
                    last_ratio = m.ratio_wad;
                }
            }
            // the rebalance must NOT have changed the quote reserves
            quote_touched_by_protocol += (u_au.abs_diff(u_au_pre) + u_bu.abs_diff(u_bu_pre)) as u128;
        }

        assert_eq!(quote_touched_by_protocol, 0, "protocol moved quote reserves!");
        assert!(u_au > 0 && u_bu > 0, "quote anchor drained to zero");
        assert!(total_minted > 0, "no minting happened across 2000 rounds");
    }
}
