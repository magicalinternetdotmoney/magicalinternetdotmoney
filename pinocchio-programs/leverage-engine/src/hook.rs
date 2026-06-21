//! Token-2022 transfer-hook interface bits for the receipt token.

use crate::price_crawl::{HOOK_BASE_VAULT_DATA_OFF, HOOK_QUOTE_VAULT_DATA_OFF};

/// splDiscriminate("spl-transfer-hook-interface:execute")
pub const EXECUTE_DISC: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];

pub const META_LEN: usize = 35;

pub const fn size_of(n: usize) -> usize {
    16 + n * META_LEN
}

pub const META_DISC_LITERAL: u8 = 0;
pub const META_DISC_PUBKEY_DATA: u8 = 2;

/// 11 rebalance + crawl(w) + 2 boxed reserve token accounts (disc-2).
pub const CRAWL_HOOK_META_COUNT: usize = 14;
/// Literal embeds for patch/init (reserve pubkeys live in `price_crawl` box).
pub const CRAWL_HOOK_PATCH_EMBED_COUNT: usize = 12;
/// Execute-account index of `price_crawl` when resolving boxed keys (5 + embed 11).
pub const CRAWL_BOX_ACCOUNT_INDEX: u8 = 16;

#[inline(always)]
fn write_literal_meta(buf: &mut [u8], key: &[u8; 32], writable: bool) {
    buf[0] = META_DISC_LITERAL;
    buf[1..33].copy_from_slice(key);
    buf[33] = 0;
    buf[34] = writable as u8;
}

#[inline(always)]
fn write_pubkey_data_meta(buf: &mut [u8], source_index: u8, data_offset: u8, writable: bool) {
    buf[0] = META_DISC_PUBKEY_DATA;
    buf[1] = 2;
    buf[2] = source_index;
    buf[3] = data_offset;
    buf[4..33].fill(0);
    buf[33] = 0;
    buf[34] = writable as u8;
}

/// 0–11 literal; 12–13 read base/quote vault pubkeys from `price_crawl` box.
#[inline(never)]
pub fn write_crawl_hook_metas(buf: &mut [u8], entries: &[([u8; 32], bool); 12], writable_mask: u16) {
    buf[0..8].copy_from_slice(&EXECUTE_DISC);
    let n = CRAWL_HOOK_META_COUNT;
    let tlv_len = (4 + n * META_LEN) as u32;
    buf[8..12].copy_from_slice(&tlv_len.to_le_bytes());
    buf[12..16].copy_from_slice(&(n as u32).to_le_bytes());
    let mut o = 16;
    for i in 0..CRAWL_HOOK_PATCH_EMBED_COUNT {
        write_literal_meta(&mut buf[o..], &entries[i].0, (writable_mask >> i) & 1 == 1);
        o += META_LEN;
    }
    write_pubkey_data_meta(
        &mut buf[o..],
        CRAWL_BOX_ACCOUNT_INDEX,
        HOOK_BASE_VAULT_DATA_OFF,
        (writable_mask >> 12) & 1 == 1,
    );
    o += META_LEN;
    write_pubkey_data_meta(
        &mut buf[o..],
        CRAWL_BOX_ACCOUNT_INDEX,
        HOOK_QUOTE_VAULT_DATA_OFF,
        (writable_mask >> 13) & 1 == 1,
    );
}