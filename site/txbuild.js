// Server-side transaction builder for deposit / withdraw. Builds an UNSIGNED
// VersionedTransaction (fee payer = the user, who is the only required signer —
// the protocol's PDA signs inside the program). The browser passes the serialized
// bytes to the wallet's Wallet-Standard `solana:signAndSendTransaction`. No bundler.
"use strict";
const web3 = require("@solana/web3.js");
const {
  PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram,
} = web3;
const splToken = require("@solana/spl-token");
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} = splToken;
const { pack: packTokenMetadata } = require("@solana/spl-token-metadata");
const { getTokenMetadata } = splToken;
const { createUpdateMetadataAccountV2Instruction } = require("@metaplex-foundation/mpl-token-metadata");

// extra rent for a new TokenMetadata TLV on an existing T22 mint (mirrors spl-token helper)
async function metadataRentTopUp(conn, mintPk, info, updateAuthority, name, symbol, uri) {
  const extLen = packTokenMetadata({
    mint: mintPk, updateAuthority, name, symbol, uri, additionalMetadata: [],
  }).length + 4; // type(2) + length(2) + payload
  const newLen = info.data.length + extLen;
  if (newLen <= info.data.length) return 0;
  const minBal = await conn.getMinimumBalanceForRentExemption(newLen);
  return Math.max(0, minBal - info.lamports);
}

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const metaPda = (mint) => PublicKey.findProgramAddressSync(
  [Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX,
)[0];

const CONFIG_SIZE = 400;
const O_USDC = 36, O_MINT_A = 68, O_MINT_B = 100, O_RECEIPT = 132;
const O_POOL_AB = 164, O_POOL_AQ = 196, O_POOL_BQ = 228, O_L_MAX = 268;

function readBorshStr(buf, off) {
  if (off + 4 > buf.length) return ["", off];
  const len = buf.readUInt32LE(off); off += 4;
  const end = Math.min(off + len, buf.length);
  return [buf.subarray(off, end).toString("utf8").replace(/\0/g, "").trim(), end];
}

async function readMintMeta(conn, mint, t22 = false) {
  const pk = typeof mint === "string" ? new PublicKey(mint) : mint;
  const m = typeof mint === "string" ? mint : mint.toBase58();
  if (t22) {
    try {
      const t = await getTokenMetadata(conn, pk, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (t && (t.name || t.symbol)) return { name: (t.name || "").trim(), symbol: (t.symbol || "").trim(), uri: (t.uri || "").trim() };
    } catch { /* fall through */ }
    return null;
  }
  const ai = await conn.getAccountInfo(metaPda(pk));
  if (!ai || ai.data.length < 70 || ai.data[0] !== 4) return null;
  let off = 65;
  const [name, o1] = readBorshStr(ai.data, off); off = o1;
  const [symbol, o2] = readBorshStr(ai.data, off); off = o2;
  const [uri] = readBorshStr(ai.data, off);
  return name || symbol ? { name, symbol, uri } : null;
}

function pairLeverage(pair) {
  const m = (pair.sym || "").match(/^(\d+)x/i);
  if (m) return parseInt(m[1], 10);
  if (pair.levMax) return Math.round(pair.levMax);
  return 5;
}

// Leg mapping (must match on-chain config + program TAG 13):
//   mintA = config.mint_a @ O_MINT_A=68 → long  (+N× underlying)
//   mintB = config.mint_b @ O_MINT_B=100 → inverse (−N× underlying)
// Launch: ephemeral keypair A → mint_a, B → mint_b. URI side=A|B follows the same mapping.
function canonicalPairMeta(pair, siteOrigin) {
  const origin = (siteOrigin || "https://magicalinternet.money").replace(/\/$/, "");
  const uSym = pair.underlyingSymbol || (pair.sym || "").replace(/^\d+x/i, "") || "asset";
  const lev = pairLeverage(pair);
  const uriOf = (mint, side) => origin + "/api/meta?mint=" + encodeURIComponent(mint) + (side ? "&side=" + side : "");
  const recSym = (pair.sym || "RCPT").slice(0, 10);
  const recName = (pair.name || pair.sym || "Receipt") + "";
  return {
    mintA: {
      name: ("+" + lev + "x " + uSym).slice(0, 32),
      symbol: ("+" + lev + "x" + uSym).slice(0, 10),
      uri: uriOf(pair.mintA, "A"),
    },
    mintB: {
      name: ("-" + lev + "x " + uSym).slice(0, 32),
      symbol: ("-" + lev + "x" + uSym).slice(0, 10),
      uri: uriOf(pair.mintB, "B"),
    },
    receipt: { name: recName, symbol: recSym, uri: uriOf(pair.receiptMint) },
  };
}

function metaNeedsPatch(cur, want) {
  if (!cur) return true;
  return cur.name !== want.name || cur.symbol !== want.symbol || cur.uri !== want.uri;
}

async function mintHasMetadata(conn, mint, t22 = false) {
  const pk = typeof mint === "string" ? new PublicKey(mint) : mint;
  if (t22) {
    try {
      const t = await getTokenMetadata(conn, pk, "confirmed", TOKEN_2022_PROGRAM_ID);
      return !!(t && (t.name || t.symbol));
    } catch { return false; }
  }
  const ai = await conn.getAccountInfo(metaPda(pk));
  return !!(ai && ai.data.length > 1 && ai.data[0] === 4);
}

function rdPk(buf, o) { return new PublicKey(buf.subarray(o, o + 32)); }

function parseConfigPubkey(pubkey, data) {
  if (!data || data.length < CONFIG_SIZE || data[0] !== 1) return null;
  const rd = (o) => rdPk(data, o).toBase58();
  const lmax = Number(data.readBigUInt64LE(O_L_MAX)) / 10000;
  return {
    receiptMint: rd(O_RECEIPT), config: pubkey.toBase58(), mintA: rd(O_MINT_A), mintB: rd(O_MINT_B),
    quoteMint: rd(O_USDC), levMax: lmax,
    pools: { ab: { pool: rd(O_POOL_AB) }, aq: { pool: rd(O_POOL_AQ) }, bq: { pool: rd(O_POOL_BQ) } },
  };
}

async function loadPairFromReceipt(conn, programId, receiptMint) {
  const PROGRAM = new PublicKey(programId);
  const want = new PublicKey(receiptMint).toBuffer();
  const [perPair] = PublicKey.findProgramAddressSync([Buffer.from("config"), want], PROGRAM);
  const per = await conn.getAccountInfo(perPair);
  const parsed = parseConfigPubkey(perPair, per && per.data);
  if (parsed && parsed.receiptMint === receiptMint) return parsed;
  const [bare] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);
  const bareAi = await conn.getAccountInfo(bare);
  const grand = parseConfigPubkey(bare, bareAi && bareAi.data);
  if (grand && grand.receiptMint === receiptMint) return grand;
  const accs = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: CONFIG_SIZE }] });
  for (const { pubkey, account } of accs) {
    const p = parseConfigPubkey(pubkey, account.data);
    if (p && p.receiptMint === receiptMint) return p;
  }
  throw new Error("config not found for " + receiptMint);
}

async function listPairs(conn, programId) {
  const PROGRAM = new PublicKey(programId);
  const accs = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: CONFIG_SIZE }] });
  const seen = new Set(), out = [];
  for (const { pubkey, account } of accs) {
    const p = parseConfigPubkey(pubkey, account.data);
    if (!p || seen.has(p.receiptMint)) continue;
    seen.add(p.receiptMint);
    out.push(p);
  }
  return out;
}

const CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
// writable: config, mint_a, mint_b, vAbA, vAbB, vAuA, vBuB (bits 0,2,3,4,5,6,8)
const HOOK_WRITABLE_MASK = 0b00101111101;
const HOOK_EMBED_COUNT = 11;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SYS = web3.SystemProgram.programId;
const sd = (s) => Buffer.from(s);
const cpp = (seeds) => PublicKey.findProgramAddressSync(seeds, CP)[0];
const k = (pubkey, isWritable, isSigner = false) => ({ pubkey, isSigner, isWritable });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

function pdas(programId, pair) {
  const PROGRAM = new PublicKey(programId);
  // per-pair config: registry stores it explicitly (3xSOL is grandfathered at the
  // bare ["config"] PDA; new pairs are ["config", receipt]).
  const config = pair && pair.config
    ? new PublicKey(pair.config)
    : PublicKey.findProgramAddressSync([Buffer.from("config"), new PublicKey(pair.receiptMint).toBuffer()], PROGRAM)[0];
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from("authority")], PROGRAM);
  return { PROGRAM, config, authority };
}
const lpOf = (pool) => cpp([sd("pool_lp_mint"), pool.toBuffer()]);
const vaultOf = (pool, mint) => cpp([sd("pool_vault"), pool.toBuffer(), mint.toBuffer()]);
const cpAuth = () => cpp([sd("vault_and_lp_mint_auth_seed")]);

function hookVaults(pair) {
  const mintA = new PublicKey(pair.mintA);
  const mintB = new PublicKey(pair.mintB);
  const usdc = new PublicKey(pair.quoteMint);
  const poolAB = new PublicKey(pair.pools.ab.pool);
  const poolAU = new PublicKey(pair.pools.aq.pool);
  const poolBU = new PublicKey(pair.pools.bq.pool);
  return {
    vAbA: vaultOf(poolAB, mintA),
    vAbB: vaultOf(poolAB, mintB),
    vAuA: vaultOf(poolAU, mintA),
    vAuU: vaultOf(poolAU, usdc),
    vBuB: vaultOf(poolBU, mintB),
    vBuU: vaultOf(poolBU, usdc),
  };
}

function hookMetaPda(programId, receiptMint) {
  const PROGRAM = new PublicKey(programId);
  const receipt = new PublicKey(receiptMint);
  return PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), receipt.toBuffer()], PROGRAM);
}

async function hookMetaExists(conn, programId, receiptMint) {
  const [metaList] = hookMetaPda(programId, receiptMint);
  const ai = await conn.getAccountInfo(metaList, "confirmed");
  return !!(ai && ai.owner.equals(new PublicKey(programId)));
}

// read vault reserves + LP supply for one anchor pool
async function readReserves(conn, vaultSynth, vaultU, lpMint) {
  const r = await conn.getMultipleAccountsInfo([vaultSynth, vaultU, lpMint], "confirmed");
  const rawAmt = (ai) => (ai ? ai.data.readBigUInt64LE(64) : 0n);
  const rawSupply = (ai) => (ai ? ai.data.readBigUInt64LE(36) : 0n);
  return { synthRes: rawAmt(r[0]), uRes: rawAmt(r[1]), lpSupply: rawSupply(r[2]) };
}

async function protoLpBalance(conn, authority, lpMint) {
  const ata = getAssociatedTokenAddressSync(lpMint, authority, true);
  const ai = await conn.getAccountInfo(ata, "confirmed");
  return ai ? ai.data.readBigUInt64LE(64) : 0n;
}

function legDepositMath({ synthRes, uRes, lpSupply, usdc, slippageBps }) {
  if (uRes === 0n || lpSupply === 0n) throw new Error("pool not seeded");
  const lpAmount = (usdc * lpSupply) / uRes;
  if (lpAmount === 0n) throw new Error("amount too small");
  const synthNeeded = (synthRes * lpAmount) / lpSupply;
  const maxSynth = synthNeeded + (synthNeeded * BigInt(slippageBps)) / 10000n + 1n;
  return { lpAmount, maxSynth };
}

function depositLegIx({
  PROGRAM, config, authority, owner, usdcMint, mintSynth, receipt,
  pool, lpMint, vaultSynth, vaultU, userUsdc, protoUsdc, userReceipt,
  protoSynth, protoLp, lpAmount, usdc, maxSynth, feeVault,
}) {
  const keys = [
    k(owner, true, true), k(config, true), k(authority, false), k(usdcMint, false), k(mintSynth, true),
    k(receipt, true), k(userUsdc, true), k(protoUsdc, true), k(userReceipt, true), k(protoSynth, true),
    k(protoLp, true), k(pool, true), k(lpMint, true), k(vaultSynth, true), k(vaultU, true),
    k(cpAuth(), false), k(CP, false), k(TOKEN_PROGRAM_ID, false), k(TOKEN_2022_PROGRAM_ID, false),
  ];
  if (feeVault) keys.push(k(feeVault, true));
  return new TransactionInstruction({
    programId: PROGRAM,
    keys,
    data: Buffer.concat([Buffer.from([2]), u64(lpAmount), u64(usdc), u64(maxSynth)]),
  });
}

function withdrawLegIx({
  PROGRAM, config, authority, owner, usdcMint, mintSynth, receipt,
  pool, lpMint, vaultSynth, vaultU, userUsdc, protoUsdc, userReceipt,
  protoSynth, protoLp, receiptAmount,
}) {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      k(owner, true, true), k(config, true), k(authority, false), k(usdcMint, false), k(mintSynth, true),
      k(receipt, true), k(userUsdc, true), k(protoUsdc, true), k(userReceipt, true), k(protoSynth, true),
      k(protoLp, true), k(pool, true), k(lpMint, true), k(vaultSynth, true), k(vaultU, true),
      k(cpAuth(), false), k(CP, false), k(TOKEN_PROGRAM_ID, false), k(TOKEN_2022_PROGRAM_ID, false), k(MEMO, false),
    ],
    data: Buffer.concat([Buffer.from([3]), u64(receiptAmount)]),
  });
}

// Build a deposit tx: user USDC fans 50/50 across +/USDC and −/USDC; receipt 1:1 per-leg LP.
async function buildDeposit(conn, { programId, user, pair, usdcAmount, slippageBps = 100, feeVault = null }) {
  const { PROGRAM, config, authority } = pdas(programId, pair);
  const usdcMint = new PublicKey(pair.quoteMint);
  const mintA = new PublicKey(pair.mintA);
  const mintB = new PublicKey(pair.mintB);
  const receipt = new PublicKey(pair.receiptMint);
  const poolAq = new PublicKey(pair.pools.aq.pool);
  const poolBq = new PublicKey(pair.pools.bq.pool);
  const owner = new PublicKey(user);

  const lpMintAq = lpOf(poolAq);
  const lpMintBq = lpOf(poolBq);
  const vaultAqA = vaultOf(poolAq, mintA);
  const vaultAqU = vaultOf(poolAq, usdcMint);
  const vaultBqB = vaultOf(poolBq, mintB);
  const vaultBqU = vaultOf(poolBq, usdcMint);

  const [resAq, resBq] = await Promise.all([
    readReserves(conn, vaultAqA, vaultAqU, lpMintAq),
    readReserves(conn, vaultBqB, vaultBqU, lpMintBq),
  ]);

  const usdc = BigInt(usdcAmount);
  const usdcA = usdc / 2n;
  const usdcB = usdc - usdcA;
  const legA = legDepositMath({ ...resAq, usdc: usdcA, slippageBps });
  const legB = legDepositMath({ ...resBq, usdc: usdcB, slippageBps });

  const protoUsdc = getAssociatedTokenAddressSync(usdcMint, authority, true);
  const protoA = getAssociatedTokenAddressSync(mintA, authority, true);
  const protoB = getAssociatedTokenAddressSync(mintB, authority, true);
  const protoLpAq = getAssociatedTokenAddressSync(lpMintAq, authority, true);
  const protoLpBq = getAssociatedTokenAddressSync(lpMintBq, authority, true);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, owner);
  const userReceipt = getAssociatedTokenAddressSync(receipt, owner, false, TOKEN_2022_PROGRAM_ID);
  const feeVaultPk = feeVault ? new PublicKey(feeVault) : null;

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, protoUsdc, authority, usdcMint, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, protoA, authority, mintA, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, protoB, authority, mintB, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, protoLpAq, authority, lpMintAq, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, protoLpBq, authority, lpMintBq, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, userReceipt, owner, receipt, TOKEN_2022_PROGRAM_ID),
    depositLegIx({
      PROGRAM, config, authority, owner, usdcMint, mintSynth: mintA, receipt,
      pool: poolAq, lpMint: lpMintAq, vaultSynth: vaultAqA, vaultU: vaultAqU,
      userUsdc, protoUsdc, userReceipt, protoSynth: protoA, protoLp: protoLpAq,
      lpAmount: legA.lpAmount, usdc: usdcA, maxSynth: legA.maxSynth, feeVault: feeVaultPk,
    }),
    depositLegIx({
      PROGRAM, config, authority, owner, usdcMint, mintSynth: mintB, receipt,
      pool: poolBq, lpMint: lpMintBq, vaultSynth: vaultBqB, vaultU: vaultBqU,
      userUsdc, protoUsdc, userReceipt, protoSynth: protoB, protoLp: protoLpBq,
      lpAmount: legB.lpAmount, usdc: usdcB, maxSynth: legB.maxSynth, feeVault: feeVaultPk,
    }),
  ];
  return {
    tx: await pack(conn, owner, ixs),
    usdcA: usdcA.toString(), usdcB: usdcB.toString(),
    lpA: legA.lpAmount.toString(), lpB: legB.lpAmount.toString(),
    receiptMinted: (legA.lpAmount + legB.lpAmount).toString(),
  };
}

// Build a withdraw tx: burn receipt proportionally across both anchor pools.
async function buildWithdraw(conn, { programId, user, pair, receiptAmount }) {
  const { PROGRAM, config, authority } = pdas(programId, pair);
  const usdcMint = new PublicKey(pair.quoteMint);
  const mintA = new PublicKey(pair.mintA);
  const mintB = new PublicKey(pair.mintB);
  const receipt = new PublicKey(pair.receiptMint);
  const poolAq = new PublicKey(pair.pools.aq.pool);
  const poolBq = new PublicKey(pair.pools.bq.pool);
  const owner = new PublicKey(user);

  const lpMintAq = lpOf(poolAq);
  const lpMintBq = lpOf(poolBq);
  const vaultAqA = vaultOf(poolAq, mintA);
  const vaultAqU = vaultOf(poolAq, usdcMint);
  const vaultBqB = vaultOf(poolBq, mintB);
  const vaultBqU = vaultOf(poolBq, usdcMint);

  const [protoLpA, protoLpB] = await Promise.all([
    protoLpBalance(conn, authority, lpMintAq),
    protoLpBalance(conn, authority, lpMintBq),
  ]);
  const totalLp = protoLpA + protoLpB;
  if (totalLp === 0n) throw new Error("no protocol LP to redeem");

  const R = BigInt(receiptAmount);
  const burnA = (R * protoLpA) / totalLp;
  const burnB = R - burnA;
  if (burnA === 0n && burnB === 0n) throw new Error("receipt amount too small");

  const protoUsdc = getAssociatedTokenAddressSync(usdcMint, authority, true);
  const protoA = getAssociatedTokenAddressSync(mintA, authority, true);
  const protoB = getAssociatedTokenAddressSync(mintB, authority, true);
  const protoLpAq = getAssociatedTokenAddressSync(lpMintAq, authority, true);
  const protoLpBq = getAssociatedTokenAddressSync(lpMintBq, authority, true);
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, owner);
  const userReceipt = getAssociatedTokenAddressSync(receipt, owner, false, TOKEN_2022_PROGRAM_ID);

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, userUsdc, owner, usdcMint, TOKEN_PROGRAM_ID),
  ];
  if (burnA > 0n) {
    ixs.push(withdrawLegIx({
      PROGRAM, config, authority, owner, usdcMint, mintSynth: mintA, receipt,
      pool: poolAq, lpMint: lpMintAq, vaultSynth: vaultAqA, vaultU: vaultAqU,
      userUsdc, protoUsdc, userReceipt, protoSynth: protoA, protoLp: protoLpAq,
      receiptAmount: burnA,
    }));
  }
  if (burnB > 0n) {
    ixs.push(withdrawLegIx({
      PROGRAM, config, authority, owner, usdcMint, mintSynth: mintB, receipt,
      pool: poolBq, lpMint: lpMintBq, vaultSynth: vaultBqB, vaultU: vaultBqU,
      userUsdc, protoUsdc, userReceipt, protoSynth: protoB, protoLp: protoLpBq,
      receiptAmount: burnB,
    }));
  }
  return { tx: await pack(conn, owner, ixs), burnA: burnA.toString(), burnB: burnB.toString() };
}

async function pack(conn, payer, ixs) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  return Buffer.from(vtx.serialize()).toString("base64");
}

// Patch existing on-chain metadata (URIs, names) to canonical values.
async function buildPatchMetadata(conn, { programId, user, pair, siteOrigin, force = false }) {
  const { PROGRAM, config, authority } = pdas(programId, pair);
  const owner = new PublicKey(user);
  const configPk = new PublicKey(pair.config);
  const want = canonicalPairMeta(pair, siteOrigin);
  const [curA, curB, curR] = await Promise.all([
    readMintMeta(conn, pair.mintA, false),
    readMintMeta(conn, pair.mintB, false),
    readMintMeta(conn, pair.receiptMint, true),
  ]);
  const txs = [];
  const metaplexData = (m) => ({
    name: m.name.slice(0, 32), symbol: m.symbol.slice(0, 10), uri: m.uri.slice(0, 200),
    sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null,
  });
  for (const s of [
    { mint: pair.mintA, want: want.mintA, cur: curA, label: "patch MINTA (+)" },
    { mint: pair.mintB, want: want.mintB, cur: curB, label: "patch MINTB (−)" },
  ]) {
    if (!force && !metaNeedsPatch(s.cur, s.want)) continue;
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createUpdateMetadataAccountV2Instruction(
        { metadata: metaPda(new PublicKey(s.mint)), updateAuthority: owner },
        { updateMetadataAccountArgsV2: { data: metaplexData(s.want), updateAuthority: null, primarySaleHappened: null, isMutable: null } },
      ),
    ];
    txs.push({ label: s.label, tx: await pack(conn, owner, ixs) });
  }
  if (force || metaNeedsPatch(curR, want.receipt)) {
    const receipt = new PublicKey(pair.receiptMint);
    const recIxs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 })];
    for (const [field, val] of [[0, want.receipt.name], [1, want.receipt.symbol], [2, want.receipt.uri]]) {
      recIxs.push(new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          k(owner, true, true), k(configPk, false), k(authority, false), k(receipt, true),
          k(TOKEN_2022_PROGRAM_ID, false),
        ],
        data: Buffer.concat([Buffer.from([5, field]), Buffer.from(val.slice(0, 256), "utf8")]),
      }));
    }
    txs.push({ label: "patch receipt (LP)", tx: await pack(conn, owner, recIxs) });
  }
  return { txs, want, current: { mintA: curA, mintB: curB, receipt: curR } };
}

// Init on-chain metadata: MINTA/MINTB via Metaplex (TAG 13), receipt via T22 (TAG 14).
async function buildBackfillMetadata(conn, { programId, user, pair, siteOrigin, skipExisting = true }) {
  const { PROGRAM, config, authority } = pdas(programId, pair);
  const owner = new PublicKey(user);
  const want = canonicalPairMeta(pair, siteOrigin);
  const enc = (name, symbol, uri) => {
    const nameB = Buffer.from(name.slice(0, 32), "utf8");
    const symB = Buffer.from(symbol.slice(0, 10), "utf8");
    const uriB = Buffer.from(uri.slice(0, 200), "utf8");
    return { nameB, symB, uriB };
  };
  const txs = [];
  // legacy SPL synths → Metaplex
  for (const s of [
    { kind: 1, mint: new PublicKey(pair.mintA), name: want.mintA.name, symbol: want.mintA.symbol, uri: want.mintA.uri, label: "MINTA metadata (+)" },
    { kind: 2, mint: new PublicKey(pair.mintB), name: want.mintB.name, symbol: want.mintB.symbol, uri: want.mintB.uri, label: "MINTB metadata (−)" },
  ]) {
    if (skipExisting && await mintHasMetadata(conn, s.mint, false)) continue;
    const { nameB, symB, uriB } = enc(s.name, s.symbol, s.uri);
    const data = Buffer.concat([
      Buffer.from([13, s.kind, nameB.length]), nameB,
      Buffer.from([symB.length]), symB,
      Buffer.from([uriB.length & 0xff, (uriB.length >> 8) & 0xff]), uriB,
    ]);
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          k(owner, true, true), k(config, false), k(authority, false), k(s.mint, false),
          k(metaPda(s.mint), true), k(SYS, false), k(METAPLEX, false),
        ],
        data,
      }),
    ];
    txs.push({ label: s.label, tx: await pack(conn, owner, ixs) });
  }
  // Token-2022 receipt → on-mint metadata (Metaplex rejects T22 mints with 0x99)
  const rec = enc(want.receipt.name, want.receipt.symbol, want.receipt.uri);
  const recData = Buffer.concat([
    Buffer.from([14, rec.nameB.length]), rec.nameB,
    Buffer.from([rec.symB.length]), rec.symB,
    Buffer.from([rec.uriB.length & 0xff, (rec.uriB.length >> 8) & 0xff]), rec.uriB,
  ]);
  if (!(skipExisting && await mintHasMetadata(conn, pair.receiptMint, true))) {
    const receipt = new PublicKey(pair.receiptMint);
    const recInfo = await conn.getAccountInfo(receipt);
    if (!recInfo) throw new Error("receipt mint not found");
    const extraRent = await metadataRentTopUp(conn, receipt, recInfo, authority, want.receipt.name, want.receipt.symbol, want.receipt.uri);
    const recIxs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })];
    if (extraRent > 0) recIxs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: receipt, lamports: extraRent }));
    recIxs.push(new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        k(owner, true, true), k(config, false), k(authority, false), k(receipt, true),
        k(SYS, false), k(TOKEN_2022_PROGRAM_ID, false),
      ],
      data: recData,
    }));
    txs.push({ label: "receipt metadata (LP)", tx: await pack(conn, owner, recIxs) });
  }
  return { txs };
}

// Create the receipt mint's ExtraAccountMetaList so Token-2022 (and wallets) can
// resolve the rebalance accounts required on every receipt transfer.
async function buildInitHookMetas(conn, { programId, user, pair }) {
  const { PROGRAM, config, authority } = pdas(programId, pair);
  const owner = new PublicKey(user);
  const receipt = new PublicKey(pair.receiptMint);
  const mintA = new PublicKey(pair.mintA);
  const mintB = new PublicKey(pair.mintB);
  const [metaList, metaBump] = hookMetaPda(programId, pair.receiptMint);
  if (await hookMetaExists(conn, programId, pair.receiptMint)) {
    return { tx: null, metaList: metaList.toBase58(), skipped: true };
  }
  const v = hookVaults(pair);
  const embeds = [
    config, authority, mintA, mintB,
    v.vAbA, v.vAbB, v.vAuA, v.vAuU, v.vBuB, v.vBuU,
    TOKEN_PROGRAM_ID,
  ];
  if (embeds.length !== HOOK_EMBED_COUNT) throw new Error("unexpected hook embed count");
  const metaRent = BigInt(await conn.getMinimumBalanceForRentExemption(16 + HOOK_EMBED_COUNT * 35));
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        k(owner, true, true), k(metaList, true), k(receipt, false), k(SYS, false),
        ...embeds.map((pk) => k(pk, false)),
      ],
      data: Buffer.concat([
        Buffer.from([7]),
        u64(metaRent),
        Buffer.from([HOOK_EMBED_COUNT]),
        Buffer.from([HOOK_WRITABLE_MASK & 0xff, (HOOK_WRITABLE_MASK >> 8) & 0xff]),
        Buffer.from([metaBump]),
      ]),
    }),
  ];
  return { tx: await pack(conn, owner, ixs), metaList: metaList.toBase58(), skipped: false };
}

module.exports = {
  buildDeposit, buildWithdraw, buildBackfillMetadata, buildPatchMetadata, buildInitHookMetas,
  loadPairFromReceipt, listPairs, hookMetaExists, hookVaults,
  mintHasMetadata, readMintMeta, canonicalPairMeta, pairLeverage,
};
