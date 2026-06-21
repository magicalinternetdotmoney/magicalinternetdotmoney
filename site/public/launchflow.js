/* Browser launch flow. Loads web3.js + spl-token from a CDN, builds the whole launch
 * (synths + T22 receipt + per-pair config + atomic triangle + 2 MEME pools + authority
 * handoff). Two wallet approvals: (1) LUT create + extend chunks, (2) everything else.
 * Each batch is sent + retried until complete — the triangle keeps failing until the LUT lands.
 * Exposes window.MIMLaunch(params, walletEntry, onProgress) → resolves to the pair. */
(function () {
  "use strict";
  var W3 = "https://esm.sh/@solana/web3.js@1.95.3";
  var SPL = "https://esm.sh/@solana/spl-token@0.4.9?deps=@solana/web3.js@1.95.3";
  var MPL = "https://esm.sh/@metaplex-foundation/mpl-token-metadata@2.13.0?deps=@solana/web3.js@1.95.3";
  var SPLMETA = "https://esm.sh/@solana/spl-token-metadata@0.1.6?deps=@solana/web3.js@1.95.3";
  var CP, AMM0, FEE, D_INIT, PROGRAM_DEFAULT = "J345oy4ctuut7vu9zABu9UeuSQSptVeQjmmmsi33enqe";

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var POOL_FEE_LAMPORTS = 150000000n; // Raydium CPMM create-pool fee (0.15 SOL each)
  var POOL_RENT_LAMPORTS = 45000000n; // LP mint + vaults + observation + pool state (per pool)
  var SETUP_RENT_LAMPORTS = 95000000n; // mints, receipt T22+metadata, LUT, config, ATAs, hook metas (incl. oracle)
  var TX_FEE_LAMPORTS = 5000000n; // priority + signatures across the launch batch

  var SOL_GUARD_BUFFER = 10000000n; // 0.01 SOL headroom so the 3rd pool fee doesn't clip

  function estimateLaunchSolLamports(memeOn) {
    var pools = memeOn ? 5n : 3n;
    return pools * (POOL_FEE_LAMPORTS + POOL_RENT_LAMPORTS) + SETUP_RENT_LAMPORTS + TX_FEE_LAMPORTS + SOL_GUARD_BUFFER;
  }

  function formatSol(lamports) {
    return (Number(lamports) / 1e9).toFixed(2);
  }

  function decodeTxErr(err, logs) {
    if (!err && !logs) return null;
    var text = JSON.stringify(err || "");
    if (logs) {
      for (var i = logs.length - 1; i >= 0; i--) {
        var line = logs[i];
        if (line.indexOf("insufficient lamports") >= 0) return "insufficient SOL: " + line.replace(/^Program log: /, "");
        if (line.indexOf("already in use") >= 0 || line.indexOf("AlreadyInUse") >= 0) return "already done on-chain";
        if (line.indexOf("failed:") >= 0 && line.indexOf("success") < 0) return line;
      }
    }
    if (text.indexOf("InsufficientFundsForRent") >= 0) return "account rent underfunded in instruction (refresh and relaunch)";
    if (text.indexOf("InsufficientFunds") >= 0 || text.indexOf("insufficient") >= 0) return "wallet SOL too low for this step — check balance after pool fees";
    if (text.indexOf("AlreadyInUse") >= 0 || text.indexOf("already in use") >= 0) return "already done on-chain";
    return text !== "null" ? text : "transaction failed on-chain";
  }

  function errIsBenignDone(err) {
    if (!err) return false;
    var t = JSON.stringify(err);
    return t.indexOf("AlreadyInUse") >= 0 || t.indexOf("already in use") >= 0;
  }

  window.MIMLaunchSolNeed = function (memeOn) {
    var on = !!memeOn;
    var lamports = estimateLaunchSolLamports(on);
    var pools = on ? 5 : 3;
    return {
      lamports: Number(lamports),
      sol: formatSol(lamports),
      pools: pools,
      poolFeesSol: (Number(POOL_FEE_LAMPORTS) * pools / 1e9).toFixed(2),
      desc: "0.15 SOL × " + pools + " Raydium pool fees + account rent",
    };
  };

  window.MIMLaunch = async function (params, wallet, onProgress) {
    if (typeof globalThis.Buffer === "undefined") {
      var bufMod = await import("https://esm.sh/buffer@6.0.3");
      globalThis.Buffer = window.Buffer = bufMod.Buffer; // web3.js + our builders need a global Buffer
    }
    var web3 = await import(W3);
    var spl = await import(SPL);
    var mpl = await import(MPL);
    var splMeta = await import(SPLMETA);
    var PublicKey = web3.PublicKey, Keypair = web3.Keypair, TI = web3.TransactionInstruction,
      TM = web3.TransactionMessage, VT = web3.VersionedTransaction, SystemProgram = web3.SystemProgram,
      CB = web3.ComputeBudgetProgram, ALT = web3.AddressLookupTableProgram;
    var SYSVAR_RENT = web3.SYSVAR_RENT_PUBKEY, SYSVAR_IX = web3.SYSVAR_INSTRUCTIONS_PUBKEY;
    CP = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    AMM0 = new PublicKey("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
    FEE = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
    D_INIT = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
    var TOK = spl.TOKEN_PROGRAM_ID, T22 = spl.TOKEN_2022_PROGRAM_ID, ATA = spl.ASSOCIATED_TOKEN_PROGRAM_ID;
    var prog = function (a) { return progress(onProgress, a); };

    var conn = new web3.Connection(location.origin + "/api/rpc", "confirmed");
    var PROGRAM = new PublicKey(params.programId || PROGRAM_DEFAULT);
    var me = new PublicKey(params.owner);
    var DEC = 6, ONE = 1000000n;
    var U = new PublicKey(params.quoteMint || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    var MEME = params.memeMint ? new PublicKey(params.memeMint) : null;
    var memePer = BigInt(params.memePerPool || "0");
    var memeOn = !!(MEME && memePer > 0n);
    var lev = parseInt(params.lev || "5", 10);
    var assetUsd = parseFloat(params.assetUsd || "1");
    var seedUsdc = parseFloat(params.seedUsdc || "10");

    var sd = function (s) { return Buffer.from(s); };
    var cpp = function (s) { return PublicKey.findProgramAddressSync(s, CP)[0]; };
    var ord = function (x, y) { return Buffer.compare(x.toBuffer(), y.toBuffer()) <= 0 ? [x, y] : [y, x]; };
    var cpAuth = cpp([sd("vault_and_lp_mint_auth_seed")]);
    var poolOf = function (x, y) { var o = ord(x, y); return cpp([sd("pool"), AMM0.toBuffer(), o[0].toBuffer(), o[1].toBuffer()]); };
    var vaultOf = function (p, m) { return cpp([sd("pool_vault"), p.toBuffer(), m.toBuffer()]); };
    var lpOf = function (p) { return cpp([sd("pool_lp_mint"), p.toBuffer()]); };
    var ata = function (m, o, pr) { return spl.getAssociatedTokenAddressSync(m, o, true, pr); };
    var k = function (pk, w, s) { return { pubkey: pk, isSigner: !!s, isWritable: !!w }; };
    var u64 = function (n) { var b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    var u128 = function (n) { var b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(n) & ((1n << 64n) - 1n)); b.writeBigUInt64LE(BigInt(n) >> 64n, 8); return b; };

    function cpInit(x, y, ax, ay, px, py) {
      var o = ord(x, y), t0 = o[0], t1 = o[1];
      var a0 = t0.equals(x) ? ax : ay, a1 = t0.equals(x) ? ay : ax;
      var p0 = t0.equals(x) ? px : py, p1 = t0.equals(x) ? py : px;
      var pool = poolOf(x, y), lp = lpOf(pool);
      return { pool: pool, ix: new TI({ programId: CP, data: Buffer.concat([D_INIT, u64(a0), u64(a1), u64(0n)]),
        keys: [k(me, false, true), k(AMM0, false), k(cpAuth, false), k(pool, true), k(t0, false), k(t1, false), k(lp, true),
          k(ata(t0, me, p0), true), k(ata(t1, me, p1), true), k(ata(lp, me, TOK), true),
          k(vaultOf(pool, t0), true), k(vaultOf(pool, t1), true), k(FEE, true), k(cpp([sd("observation"), pool.toBuffer()]), true),
          k(TOK, false), k(p0, false), k(p1, false), k(ATA, false), k(SystemProgram.programId, false), k(SYSVAR_RENT, false)] }) };
    }

    // ephemeral keypairs
    var A = Keypair.generate(), B = Keypair.generate(), R = Keypair.generate();
    var cfg = PublicKey.findProgramAddressSync([Buffer.from("config"), R.publicKey.toBuffer()], PROGRAM);
    var cfgPda = cfg[0], cfgBump = cfg[1];
    var authPair = PublicKey.findProgramAddressSync([Buffer.from("authority")], PROGRAM);
    var authority = authPair[0], authBump = authPair[1];

    var halfUsd = seedUsdc / 2;
    var usdcPer = BigInt(Math.round(halfUsd * 1e6));
    var aSeed = BigInt(Math.max(1, Math.round((halfUsd / assetUsd) * 1e6)));
    var bSeed = BigInt(Math.round(halfUsd * 1e6));
    var aTot = aSeed * (memeOn ? 3n : 2n), bTot = bSeed * (memeOn ? 3n : 2n);

    prog("preparing transactions…");
    var solBal = BigInt(await conn.getBalance(me, "confirmed"));
    var needSol = estimateLaunchSolLamports(memeOn);
    if (solBal < needSol) {
      throw new Error("need ~" + formatSol(needSol) + " SOL for Raydium fees + rent (you have ~" + formatSol(solBal) + ") — add SOL and retry");
    }
    var bh = (await conn.getLatestBlockhash("confirmed")).blockhash;
    var slot = await conn.getSlot("confirmed");
    var mintRent = await conn.getMinimumBalanceForRentExemption(spl.MINT_SIZE);
    var recLen = spl.getMintLen([spl.ExtensionType.TransferHook, spl.ExtensionType.MetadataPointer]);
    var cLam = BigInt(await conn.getMinimumBalanceForRentExemption(432));

    // build the LUT + a LOCAL lookup-table account so we can compile the triangle v0 now
    var lutIxAndKey = ALT.createLookupTable({ authority: me, payer: me, recentSlot: slot - 1 });
    var createLutIx = lutIxAndKey[0], lut = lutIxAndKey[1];
    var inits = [cpInit(A.publicKey, B.publicKey, aSeed, bSeed, TOK, TOK), cpInit(A.publicKey, U, aSeed, usdcPer, TOK, TOK), cpInit(B.publicKey, U, bSeed, usdcPer, TOK, TOK)];
    var registerIx = new TI({ programId: PROGRAM, keys: [k(me, false, true), k(cfgPda, true), k(SYSVAR_IX, false)], data: Buffer.from([6]) });
    var addrSet = {}; inits.forEach(function (i) { i.ix.keys.forEach(function (m) { addrSet[m.pubkey.toBase58()] = 1; }); }); registerIx.keys.forEach(function (m) { addrSet[m.pubkey.toBase58()] = 1; }); addrSet[PROGRAM.toBase58()] = 1;
    var addrs = Object.keys(addrSet).map(function (s) { return new PublicKey(s); }).filter(function (x) { return !x.equals(me); });
    var EXTEND_CHUNK = 20;
    var extendChunks = [];
    for (var ci = 0; ci < addrs.length; ci += EXTEND_CHUNK) extendChunks.push(addrs.slice(ci, ci + EXTEND_CHUNK));
    var lutAccount = new web3.AddressLookupTableAccount({ key: lut, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: me, addresses: addrs } });
    var lutDefs = [{ label: "create lookup table", ixs: [createLutIx].concat(extendChunks.length ? [ALT.extendLookupTable({ payer: me, authority: me, lookupTable: lut, addresses: extendChunks[0] })] : []), signers: [] }];
    for (var ei = 1; ei < extendChunks.length; ei++) {
      lutDefs.push({ label: "extend lookup table " + (ei + 1) + "/" + extendChunks.length, ixs: [ALT.extendLookupTable({ payer: me, authority: me, lookupTable: lut, addresses: extendChunks[ei] })], signers: [] });
    }

    // ---- rebuildable step definitions (so we can re-sign on blockhash expiry) ----
    var mkMint = function (kp) { return [SystemProgram.createAccount({ fromPubkey: me, newAccountPubkey: kp.publicKey, lamports: mintRent, space: spl.MINT_SIZE, programId: TOK }), spl.createInitializeMint2Instruction(kp.publicKey, DEC, me, null, TOK)]; };
    var METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    var metaPda = function (mint) { return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0]; };
    var metaUri = function (mint, side) { var u = location.origin + "/api/meta?mint=" + encodeURIComponent(mint.toBase58()); return side ? u + "&side=" + side : u; };
    var uSym = params.underlyingSymbol || "asset";
    var recSymStr = (params.sym || "RCPT") + "";
    var levM = recSymStr.match(/^(\d+)x/i);
    var lev = levM ? parseInt(levM[1], 10) : parseInt(params.lev || "5", 10);
    var synthA = { name: ("+" + lev + "x " + uSym).slice(0, 32), symbol: ("+" + lev + "x" + uSym).slice(0, 10) };
    var synthB = { name: ("-" + lev + "x " + uSym).slice(0, 32), symbol: ("-" + lev + "x" + uSym).slice(0, 10) };
    var metaplexV3 = function (mint, name, symbol, uri) {
      return mpl.createCreateMetadataAccountV3Instruction({
        metadata: metaPda(mint), mint: mint, mintAuthority: me, payer: me, updateAuthority: me,
      }, {
        createMetadataAccountArgsV3: {
          data: { name: name.slice(0, 32), symbol: symbol.slice(0, 10), uri: uri.slice(0, 200), sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null },
          isMutable: true, collectionDetails: null,
        },
      });
    };
    var recName = (params.name || params.sym || "Receipt") + "";
    var recSym = (params.sym || "RCPT").slice(0, 10);
    var recUri = metaUri(R.publicKey);
    var metaIxs = [
      metaplexV3(A.publicKey, synthA.name, synthA.symbol, metaUri(A.publicKey, "A")),
      metaplexV3(B.publicKey, synthB.name, synthB.symbol, metaUri(B.publicKey, "B")),
    ];
    // Pre-fund mint + on-mint TokenMetadata TLV in one tx (reallocate-after-init → UninitializedAccount).
    var recMetaPacked = splMeta.pack({
      mint: R.publicKey, updateAuthority: authority, name: recName, symbol: recSym, uri: recUri, additionalMetadata: [],
    });
    var recMetaLen = spl.TYPE_SIZE + spl.LENGTH_SIZE + recMetaPacked.length;
    var recRent = (await conn.getMinimumBalanceForRentExemption(recLen + recMetaLen)) + 10000000;
    var receiptCreateIxs = [
      SystemProgram.createAccount({ fromPubkey: me, newAccountPubkey: R.publicKey, lamports: recRent, space: recLen, programId: T22 }),
      spl.createInitializeTransferHookInstruction(R.publicKey, me, PROGRAM, T22),
      spl.createInitializeMetadataPointerInstruction(R.publicKey, me, R.publicKey, T22),
      spl.createInitializeMintInstruction(R.publicKey, DEC, me, null, T22),
      splMeta.createInitializeInstruction({
        programId: T22, metadata: R.publicKey, updateAuthority: authority, mint: R.publicKey,
        mintAuthority: me, name: recName, symbol: recSym, uri: recUri,
      }),
    ];
    var ataA = ata(A.publicKey, me, TOK), ataB = ata(B.publicKey, me, TOK);
    var D1 = Keypair.generate().publicKey, D2 = Keypair.generate().publicKey, D3 = Keypair.generate().publicKey;
    var hasPumpOracle = !!(params.oraclePool && params.oracleBaseVault && params.oracleQuoteVault);
    var oraclePool = hasPumpOracle ? new PublicKey(params.oraclePool) : PublicKey.default;
    var oracleKind = hasPumpOracle ? 1 : 0;
    var initOracleWad = hasPumpOracle && params.initOraclePriceWad ? BigInt(params.initOraclePriceWad) : 0n;
    var initConfigData = Buffer.concat([
      Buffer.from([1, authBump, cfgBump]), u64(20000n), u64(BigInt(lev) * 10000n), u64(2000n), u64(5000n), u128(ONE), u64(cLam),
      oraclePool.toBuffer(), Buffer.from([oracleKind]), u128(initOracleWad),
    ]);
    var initConfigIx = new TI({ programId: PROGRAM,
      keys: [k(me, true, true), k(cfgPda, true), k(U, false), k(A.publicKey, false), k(B.publicKey, false), k(R.publicKey, false), k(D1, false), k(D2, false), k(D3, false), k(SystemProgram.programId, false)],
      data: initConfigData });
    var defs = [
      { label: "create MINTA + MINTB", ixs: mkMint(A).concat(mkMint(B)), signers: [A, B] },
      { label: "create receipt (T22 + hook + metadata)", ixs: receiptCreateIxs, signers: [R] },
      { label: "metaplex metadata (MINTA/MINTB)", ixs: metaIxs, signers: [] },
      { label: "mint seed liquidity", ixs: [spl.createAssociatedTokenAccountIdempotentInstruction(me, ataA, me, A.publicKey, TOK), spl.createMintToInstruction(A.publicKey, ataA, me, aTot, [], TOK), spl.createAssociatedTokenAccountIdempotentInstruction(me, ataB, me, B.publicKey, TOK), spl.createMintToInstruction(B.publicKey, ataB, me, bTot, [], TOK)], signers: [] },
      { label: "init config", ixs: [initConfigIx], signers: [] },
      { label: "fire the 3 USDC pools (atomic)", ixs: [CB.setComputeUnitLimit({ units: 1400000 })].concat(inits.map(function (i) { return i.ix; })).concat([registerIx]), signers: [], lookups: [lutAccount] },
    ];
    var memePools = {};
    if (memeOn) {
      var am = cpInit(A.publicKey, MEME, aSeed, memePer, TOK, T22), bm = cpInit(B.publicKey, MEME, bSeed, memePer, TOK, T22);
      defs.push({ label: "MINTA / MEME pool", ixs: [CB.setComputeUnitLimit({ units: 450000 }), am.ix], signers: [] });
      defs.push({ label: "MINTB / MEME pool", ixs: [CB.setComputeUnitLimit({ units: 450000 }), bm.ix], signers: [] });
      memePools = { am: am.pool, bm: bm.pool };
    }
    defs.push({ label: "hand minting to the program", ixs: [spl.createSetAuthorityInstruction(A.publicKey, me, spl.AuthorityType.MintTokens, authority, [], TOK), spl.createSetAuthorityInstruction(B.publicKey, me, spl.AuthorityType.MintTokens, authority, [], TOK), spl.createSetAuthorityInstruction(R.publicKey, me, spl.AuthorityType.MintTokens, authority, [], T22)], signers: [] });
    var metaPair = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), R.publicKey.toBuffer()], PROGRAM);
    var hookMetaList = metaPair[0], hookMetaBump = metaPair[1];
    var hookEmbeds = [cfgPda, authority, A.publicKey, B.publicKey,
      vaultOf(inits[0].pool, A.publicKey), vaultOf(inits[0].pool, B.publicKey),
      vaultOf(inits[1].pool, A.publicKey), vaultOf(inits[1].pool, U),
      vaultOf(inits[2].pool, B.publicKey), vaultOf(inits[2].pool, U), TOK];
    if (oracleKind === 1 && params.oracleBaseVault && params.oracleQuoteVault) {
      hookEmbeds = hookEmbeds.concat([
        oraclePool,
        new PublicKey(params.oracleBaseVault),
        new PublicKey(params.oracleQuoteVault),
      ]);
    }
    var hookCount = hookEmbeds.length;
    if (hookCount < 11 || hookCount > 16) throw new Error("invalid hook embed count: " + hookCount);
    var hookMetaRent = BigInt(await conn.getMinimumBalanceForRentExemption(16 + hookCount * 35));
    var hookMask = 0;
    for (var hi = 0; hi < hookCount; hi++) {
      if (hi === 0 || hi === 2 || hi === 3 || (hi >= 4 && hi <= 9)) hookMask |= (1 << hi);
    }
    var initHookIx = new TI({ programId: PROGRAM,
      keys: [k(me, true, true), k(hookMetaList, true), k(R.publicKey, false), k(SystemProgram.programId, false)]
        .concat(hookEmbeds.map(function (pk) { return k(pk, false); })),
      data: Buffer.concat([Buffer.from([7]), u64(hookMetaRent), Buffer.from([hookCount]),
        Buffer.from([hookMask & 0xff, (hookMask >> 8) & 0xff]), Buffer.from([hookMetaBump])]) });
    defs.push({ label: "init transfer-hook extras", ixs: [CB.setComputeUnitLimit({ units: 200000 }), initHookIx], signers: [], hookReceipt: R.publicKey });

    async function hookMetaReady(receiptPk) {
      try {
        var ai = await conn.getAccountInfo(hookMetaList, "confirmed");
        return !!(ai && ai.owner && ai.owner.equals(PROGRAM));
      } catch (e) { return false; }
    }

    async function mintExists(pk, prog) {
      try {
        var ai = await conn.getAccountInfo(pk, "confirmed");
        return !!(ai && ai.owner && ai.owner.equals(prog));
      } catch (e) { return false; }
    }

    async function receiptReady() {
      if (!(await mintExists(R.publicKey, T22))) return false;
      try {
        var md = await spl.getTokenMetadata(conn, R.publicKey, "confirmed", T22);
        return !!(md && (md.name || md.symbol));
      } catch (e) { return false; }
    }

    async function stepAlreadyDone(d) {
      if (d.label === "create MINTA + MINTB") return (await mintExists(A.publicKey, TOK)) && (await mintExists(B.publicKey, TOK));
      if (d.label === "create receipt (T22 + hook + metadata)") return receiptReady();
      if (d.label === "init transfer-hook extras") return hookMetaReady(R.publicKey);
      return false;
    }

    // build vtxs for the given defs at a blockhash, ephemeral-sign, then wallet signs the batch
    async function buildSigned(blockhash, defList) {
      var vtxs = defList.map(function (d) {
        var msg = new TM({ payerKey: me, recentBlockhash: blockhash, instructions: d.ixs }).compileToV0Message(d.lookups || []);
        var vtx = new VT(msg); if (d.signers.length) vtx.sign(d.signers); return vtx;
      });
      return signAll(wallet, vtxs, VT);
    }

    // sign → send → retry until every tx in the batch lands (re-prompts on blockhash expiry)
    async function landBatch(defList, approveMsg, progressMsg) {
      var bhInfo = await conn.getLatestBlockhash("confirmed");
      var lastValid = bhInfo.lastValidBlockHeight;
      prog(approveMsg);
      var signed = await buildSigned(bhInfo.blockhash, defList);
      var pend = signed.map(function (vtx, i) { return { i: i, vtx: vtx, sig: null, done: false, err: null }; });
      var round = 0, lastErr = null, staleRounds = 0;
      for (var pi = 0; pi < pend.length; pi++) {
        var pd = pend[pi];
        if (await stepAlreadyDone(defList[pd.i])) pd.done = true;
      }
      while (pend.some(function (x) { return !x.done; }) && round < 60) {
        round++;
        var height = await conn.getBlockHeight("confirmed").catch(function () { return 0; });
        if (height && height > lastValid) {
          var pidx = pend.filter(function (x) { return !x.done; }).map(function (x) { return x.i; });
          prog("blockhash expired — re-approve the remaining " + pidx.length + " in your wallet…");
          var nb = await conn.getLatestBlockhash("confirmed"); lastValid = nb.lastValidBlockHeight;
          var re = await buildSigned(nb.blockhash, pidx.map(function (i) { return defList[i]; }));
          pidx.forEach(function (i, j) { var pj = pend.find(function (x) { return x.i === i; }); pj.vtx = re[j]; pj.sig = null; pj.err = null; });
        }
        var next = pend.find(function (x) { return !x.done; });
        if (next && await stepAlreadyDone(defList[next.i])) {
          next.done = true; lastErr = null; staleRounds = 0;
        } else if (next && !next.sig) {
          try { next.sig = await conn.sendRawTransaction(next.vtx.serialize(), { skipPreflight: true, maxRetries: 2 }); }
          catch (e) { lastErr = (e && e.message) || "send failed"; next.sig = null; }
        }
        await sleep(1600);
        var liveTx = pend.filter(function (x) { return !x.done && x.sig; });
        var progressed = false;
        if (liveTx.length) {
          try {
            var st = await conn.getSignatureStatuses(liveTx.map(function (x) { return x.sig; }));
            liveTx.forEach(function (x, idx) {
              var s = st.value[idx];
              if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) { x.done = true; progressed = true; }
              else if (s && s.err) {
                if (errIsBenignDone(s.err)) { x.done = true; progressed = true; lastErr = null; }
                else { x.err = s.err; x.sig = null; lastErr = decodeTxErr(s.err, null); }
              }
            });
          } catch (e) { lastErr = "RPC error checking tx status"; }
          for (var li = 0; li < liveTx.length; li++) {
            var item = liveTx[li]; if (item.done) continue;
            try {
              var fetched = await conn.getTransaction(item.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
              if (fetched && fetched.meta && !fetched.meta.err) { item.done = true; progressed = true; lastErr = null; }
              else if (fetched && fetched.meta && fetched.meta.err) {
                if (errIsBenignDone(fetched.meta.err)) { item.done = true; progressed = true; lastErr = null; }
                else { item.err = fetched.meta.err; item.sig = null; lastErr = decodeTxErr(fetched.meta.err, fetched.meta.logMessages); }
              }
            } catch (e) {}
          }
        }
        staleRounds = progressed ? 0 : staleRounds + 1;
        if (staleRounds >= 12 && next && await stepAlreadyDone(defList[next.i])) {
          next.done = true; lastErr = null;
        }
        var doneN = pend.filter(function (x) { return x.done; }).length;
        var pending = pend.find(function (x) { return !x.done; });
        var stepHint = pending ? " · " + defList[pending.i].label : "";
        var errHint = lastErr ? " — " + lastErr : "";
        prog(progressMsg + " " + doneN + "/" + pend.length + stepHint + (round > 1 ? " (retrying)" : "") + errHint);
      }
      if (pend.some(function (x) { return !x.done; })) {
        var fail = pend.find(function (x) { return x.err; });
        var label = fail ? defList[fail.i].label : "launch";
        var detail = lastErr || (fail && JSON.stringify(fail.err)) || "RPC unreachable — refresh and retry the last step";
        throw new Error(label + " failed: " + detail);
      }
    }

    await landBatch(lutDefs, "approve lookup-table transactions in your wallet…", "landing lookup table…");
    await landBatch(defs, "approve launch transactions in your wallet…", "landing launch…");

    // build the registry entry + persist
    var pair = { sym: params.sym, name: params.name, receiptMint: R.publicKey.toBase58(), config: cfgPda.toBase58(),
      theme: params.theme || { a: "#2fe6c0", b: "#a06bff" }, quote: "USDC", quoteMint: U.toBase58(),
      underlyingMint: params.underlyingMint || null,
      mintA: A.publicKey.toBase58(), mintB: B.publicKey.toBase58(), tradeFeeBps: 25, memeMint: MEME ? MEME.toBase58() : null,
      pools: {
        ab: { pool: inits[0].pool.toBase58(), vaultA: vaultOf(inits[0].pool, A.publicKey).toBase58(), vaultB: vaultOf(inits[0].pool, B.publicKey).toBase58() },
        aq: { pool: inits[1].pool.toBase58(), vaultA: vaultOf(inits[1].pool, A.publicKey).toBase58(), vaultQ: vaultOf(inits[1].pool, U).toBase58() },
        bq: { pool: inits[2].pool.toBase58(), vaultB: vaultOf(inits[2].pool, B.publicKey).toBase58(), vaultQ: vaultOf(inits[2].pool, U).toBase58() } } };
    if (memeOn) { pair.pools.am = { pool: memePools.am.toBase58() }; pair.pools.bm = { pool: memePools.bm.toBase58() }; }
    return pair;
  };

  function progress(cb, msg) { try { cb && cb(msg); } catch (e) {} }

  // sign every tx with the wallet (Wallet Standard one-by-one, or legacy signAllTransactions)
  async function signAll(entry, vtxs, VT) {
    if (entry.kind === "standard") {
      var f = entry.ref.features && entry.ref.features["solana:signTransaction"];
      if (!f) throw new Error("wallet can't sign transactions");
      var account = entry.ref.accounts && entry.ref.accounts[0];
      if (!account) throw new Error("no wallet account — disconnect and reconnect");
      var signed = [];
      for (var i = 0; i < vtxs.length; i++) {
        var out = await f.signTransaction({ account: account, transaction: vtxs[i].serialize(), chain: "solana:mainnet" });
        var bytes = (out && out.signedTransaction) || (out && out[0] && out[0].signedTransaction);
        if (!bytes) throw new Error("wallet returned no signed transaction");
        signed.push(VT.deserialize(bytes));
      }
      return signed;
    }
    // legacy injected — expects deserialized VersionedTransaction objects
    if (entry.ref && entry.ref.signAllTransactions) return entry.ref.signAllTransactions(vtxs);
    if (entry.ref && entry.ref.signTransaction) {
      var r = [];
      for (var j = 0; j < vtxs.length; j++) r.push(await entry.ref.signTransaction(vtxs[j]));
      return r;
    }
    throw new Error("wallet can't sign transactions");
  }
})();
