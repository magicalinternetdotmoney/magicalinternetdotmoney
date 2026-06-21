//! Token-2022 transfer-hook interface bits for the receipt token.
//!
//! The receipt mint has a TransferHook extension → this program. On every receipt
//! transfer, Token-2022 CPIs our `Execute` (matched by discriminator), passing the
//! standard 4 accounts + the extras resolved from the ExtraAccountMetaList PDA
//! (`["extra-account-metas", receipt_mint]`). Those extras are the rebalance
//! accounts, so a receipt transfer triggers a rebalance ("transferrer pays").

/// splDiscriminate("spl-transfer-hook-interface:execute") — also the TLV type
/// under which the meta list is stored.
pub const EXECUTE_DISC: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];

/// Each `ExtraAccountMeta` is 35 bytes: discriminator(1) + address_config(32) +
/// is_signer(1) + is_writable(1).
pub const META_LEN: usize = 35;

/// On-chain size of an ExtraAccountMetaList holding `n` metas:
/// type_disc(8) + tlv_len(4) + podslice_count(4) + n*35.
pub const fn size_of(n: usize) -> usize {
    16 + n * META_LEN
}
