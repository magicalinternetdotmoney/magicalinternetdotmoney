use anchor_lang::prelude::*;

#[error_code]
pub enum LeverageError {
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Invalid leverage band: require 0 < l_min <= l_max")]
    InvalidLeverageBand,
    #[msg("Rebalance called before the minimum interval elapsed")]
    RebalanceTooSoon,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Account is not owned by the protocol authority")]
    BadAuthority,
    #[msg("Mint does not match the configured pair")]
    MintMismatch,
    #[msg("Oracle price must be non-zero")]
    BadPrice,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Expected exactly three CP-Swap initialize instructions in this transaction")]
    TriangleIncomplete,
    #[msg("CP-Swap pools in this transaction do not form the configured A/B, A/USDC, B/USDC triangle")]
    TriangleMismatch,
    #[msg("Triangle already registered")]
    TriangleAlreadyRegistered,
}
