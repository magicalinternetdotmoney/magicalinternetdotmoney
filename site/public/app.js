/* Magical Internet Money — SPA (vanilla, zero-dep).
 * REAL data only: wallets via the Wallet Standard + injected providers; balances,
 * pairs, charts, APY and contracts all read from chain through the indexer (/api/*).
 * Nothing is fabricated. The program is not deployed yet, so there are no pairs and
 * mutating actions (launch / deposit / withdraw) are gated off until /api/status
 * reports deployed:true and the on-chain tx-builder is wired at launch. */
(function () {
  "use strict";
  var QUOTE = "USDC";
  var USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  var WSOL_MINT = "So11111111111111111111111111111111111111112";
  var USDC_LOGO = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png";
  var MEME_MINT_ADDR = "CNBuoZWcqAvVZJCrPFF1XQXeeXJsZKj7SUKZoE6Vpump";
  var THEMES = [
    { a: "#2fe6c0", b: "#a06bff" }, { a: "#f2c14e", b: "#ff5470" },
    { a: "#7ad9ff", b: "#2fe6c0" }, { a: "#ff8fb0", b: "#a06bff" },
  ];

  var S = {
    status: null,                         // {deployed, programId, pairs} from /api/status
    walletOpen: false, wallets: [],       // detected wallets (real)
    connected: false, walletRef: null, addr: null, pubkey: null,
    sol: null, usdc: null, balErr: null,  // real on-chain balances
    view: "home", cStep: 1, fact: "", sideA: "", sideB: USDC_MINT, sideAInfo: null, sideBInfo: null, recSym: "TRI", recName: "Triad Receipt", emoji: "✦", themeIdx: 0,
    seed: 5000, levMax: 5, memeAmt: 1000000, memeBal: null,
    mode: "deposit", depAmt: 1, wdPct: 50, busy: null, receiptRaw: null, receiptUi: null,
    activePair: null, pTab: "trade", tf: "1D", hoverF: null, contractsOpen: false, playbookOpen: true, copied: null,
    fluxOpen: false, fluxQuote: "USDC", fluxAmt: 1,
    note: null,
    exploreQ: "", exploreSort: "tvl", exploreOrder: "desc",
  };

  var BAL_MS = 5000, PAIRS_MS = 30000;

  // ---- URL routing (History API deeplinks) ----
  var VALID_TF = { "1H": 1, "1D": 1, "1W": 1, "1M": 1, ALL: 1 };
  var VALID_SORT = { tvl: 1, apr: 1, sym: 1, name: 1 };
  function parseLocation(loc) {
    loc = loc || window.location;
    var path = (loc.pathname || "/").replace(/\/+$/, "") || "/";
    var q = new URLSearchParams(loc.search || "");
    var route = { view: "home", cStep: 1, pairId: null, pTab: "trade", tf: "1D", exploreQ: "", exploreSort: "tvl", exploreOrder: "desc" };
    if (path === "/launch/deploy") { route.view = "create"; route.cStep = 2; }
    else if (path === "/launch") { route.view = "create"; route.cStep = 1; }
    else if (path.indexOf("/pair/") === 0) {
      route.view = "provide";
      try { route.pairId = decodeURIComponent(path.slice(6)); } catch (x) { route.pairId = path.slice(6); }
    }
    var tab = q.get("tab");
    if (tab === "charts" || tab === "trade") route.pTab = tab;
    var tf = q.get("tf");
    if (tf && VALID_TF[tf]) route.tf = tf;
    if (q.has("q")) route.exploreQ = q.get("q") || "";
    var sort = q.get("sort");
    if (sort && VALID_SORT[sort]) route.exploreSort = sort;
    if (q.get("order") === "asc") route.exploreOrder = "asc";
    return route;
  }
  function routeFromState() {
    var r = { view: S.view, cStep: S.cStep, pTab: S.pTab, tf: S.tf, exploreQ: S.exploreQ, exploreSort: S.exploreSort, exploreOrder: S.exploreOrder, pairId: null };
    if (S.view === "provide" && S.activePair) r.pairId = S.activePair.receiptMint || S.activePair.sym;
    return r;
  }
  function buildUrl(route) {
    var path = "/";
    if (route.view === "create") path = route.cStep === 2 ? "/launch/deploy" : "/launch";
    else if (route.view === "provide" && route.pairId) path = "/pair/" + encodeURIComponent(route.pairId);
    var q = new URLSearchParams();
    if (route.view === "provide") {
      if (route.pTab === "charts") q.set("tab", "charts");
      if (route.tf && route.tf !== "1D") q.set("tf", route.tf);
    } else if (route.view === "home") {
      if (route.exploreQ) q.set("q", route.exploreQ);
      if (route.exploreSort !== "tvl") q.set("sort", route.exploreSort);
      if (route.exploreOrder !== "desc") q.set("order", "asc");
    }
    var qs = q.toString();
    return path + (qs ? "?" + qs : "");
  }
  function applyRoute(route) {
    S.view = route.view;
    if (route.view === "create") S.cStep = route.cStep;
    if (route.view === "home") {
      S.exploreQ = route.exploreQ;
      S.exploreSort = route.exploreSort;
      S.exploreOrder = route.exploreOrder;
      S.activePair = null;
    }
    if (route.view === "provide") {
      S.pTab = route.pTab;
      S.tf = VALID_TF[route.tf] ? route.tf : "1D";
    }
  }
  function findPairById(id) {
    if (!id) return null;
    var pairs = DATA.pairs || [], decoded = id;
    try { decoded = decodeURIComponent(id); } catch (x) {}
    return pairs.find(function (x) { return x.sym === decoded || x.receiptMint === decoded; }) || null;
  }
  function pairFromRoute(route) {
    if (!route.pairId) return null;
    var p = findPairById(route.pairId);
    if (p) return p;
    return { sym: route.pairId, name: route.pairId, receiptMint: MINTRE.test(route.pairId) ? route.pairId : null, theme: THEMES[0] };
  }
  function activatePair(p) {
    if (!p) return;
    S.view = "provide";
    S.activePair = p;
    S.recSym = p.sym;
    S.receiptRaw = null;
    S.receiptUi = null;
    S.themeIdx = THEMES.indexOf(THEMES.find(function (t) { return p.theme && t.a === p.theme.a; }));
    if (S.themeIdx < 0) S.themeIdx = 0;
    S.note = null;
  }
  function syncUrl(replace) {
    var url = buildUrl(routeFromState());
    if (replace) history.replaceState(history.state, "", url);
    else history.pushState(history.state, "", url);
  }
  function resolveRoutePair(route, cb) {
    if (route.view !== "provide" || !route.pairId) return cb && cb();
    activatePair(pairFromRoute(route));
    api("/api/pairs?sort=tvl&order=desc").then(function (d) {
      DATA.pairs = d.pairs || [];
      var fresh = findPairById(route.pairId);
      if (fresh) activatePair(fresh);
      else S.note = "Pair not found — it may not be indexed yet.";
      if (S.pubkey) loadBalances();
      ensureData(cb);
    }).catch(function () { ensureData(cb); });
  }

  // ---- data cache (indexer) ----
  var DATA = { pairs: null, series: {}, apy: {}, contracts: {} };
  function api(p) { return fetch(p).then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { return Object.assign({ _err: r.status }, j); }); }); }
  function pairsUrl() {
    return "/api/pairs?q=" + encodeURIComponent(S.exploreQ) + "&sort=" + encodeURIComponent(S.exploreSort) + "&order=" + encodeURIComponent(S.exploreOrder);
  }
  function pairKey(p) { return (p && (p.receiptMint || p.sym)) || ""; }
  function pairSymLabel(p) { return (p && (p.symDisplay || p.sym)) || ""; }
  function ckey() { return pairKey(S.activePair) + "|" + S.tf; }
  function fetchPairs(force) {
    if (!force && DATA.pairs != null && S.view !== "home") return Promise.resolve();
    return api(pairsUrl()).then(function (d) {
      DATA.pairs = d.pairs || [];
      if (S.activePair) {
        var fresh = DATA.pairs.find(function (x) {
          return x.receiptMint === S.activePair.receiptMint || (!S.activePair.receiptMint && x.sym === S.activePair.sym);
        });
        if (fresh) S.activePair = fresh;
      }
      render();
    });
  }
  function ensureData(cb) {
    var jobs = [];
    if (!DATA.pairs) jobs.push(fetchPairs(true));
    if (S.view === "provide" && S.activePair) {
      var pk = pairKey(S.activePair), k = pk + "|" + S.tf;
      if (!DATA.series[k]) jobs.push(api("/api/charts?receipt=" + encodeURIComponent(pk) + "&tf=" + S.tf).then(function (d) { DATA.series[k] = d.points || []; }));
      if (!DATA.apy[pk]) jobs.push(api("/api/apy?receipt=" + encodeURIComponent(pk)).then(function (d) { DATA.apy[pk] = d; }));
      if (!DATA.contracts[pk]) jobs.push(api("/api/contracts?sym=" + encodeURIComponent(pk) + "&quote=" + QUOTE).then(function (d) { DATA.contracts[pk] = d.contracts || []; }));
    }
    if (!jobs.length) return cb && cb();
    Promise.all(jobs).then(function () { render(); cb && cb(); }).catch(function () { render(); });
  }

  // ---- helpers ----
  function fmtUsd(n) { if (n == null) return "—"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K"; return "$" + (+n).toFixed(2); }
  function fmtN(n) { if (n == null) return "—"; if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"; return (+n).toFixed(2); }
  function launchMemeOn() { return S.memeAmt > 0; }
  function launchSolNeed() {
    if (typeof window.MIMLaunchSolNeed === "function") return window.MIMLaunchSolNeed(launchMemeOn());
    var pools = launchMemeOn() ? 5 : 3;
    var lamports = pools * 195000000 + 85000000;
    return { lamports: lamports, sol: (lamports / 1e9).toFixed(2), pools: pools, poolFeesSol: (pools * 0.15).toFixed(2), desc: "0.15 SOL × " + pools + " Raydium pool fees + account rent" };
  }
  function launchSolShort() {
    if (S.sol == null) return null;
    var gap = parseFloat(launchSolNeed().sol) - S.sol;
    return gap > 0.001 ? gap : 0;
  }
  function launchSolGuardMsg() {
    var need = launchSolNeed();
    if (!S.pubkey) return "connect a wallet first";
    if (S.sol == null) return "loading SOL balance…";
    var short = launchSolShort();
    if (short) return "need ~" + need.sol + " SOL for Raydium fees + rent (you have ~" + S.sol.toFixed(2) + ", short ~" + short.toFixed(2) + ")";
    return null;
  }
  function toRgba(hex, a) { var h = hex.replace("#", ""); return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")"; }
  function esc(s) { return ("" + s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function shortAddr(a) { return a ? a.slice(0, 4) + "…" + a.slice(-4) : ""; }
  function fmtPrice(n) { if (n == null) return "—"; if (n >= 1) return "$" + n.toFixed(n >= 100 ? 2 : 4); if (n >= 0.0001) return "$" + n.toFixed(6); return "$" + n.toExponential(2); }
  function tokenLogoIcon(logo, size, border) {
    size = size || 22;
    if (!logo) return "";
    border = border != null ? border : (size >= 28 ? "2px solid rgba(255,255,255,0.1)" : "1px solid rgba(255,255,255,0.12)");
    return '<span style="flex:none; width:' + size + "px; height:" + size + "px; border-radius:50%; overflow:hidden; border:" + border + '; background:#14141e; display:inline-flex; align-items:center; justify-content:center; box-shadow:0 0 0 1px rgba(0,0,0,0.35);">' +
      '<img src="' + esc(logo) + '" alt="" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'" style="width:100%; height:100%; object-fit:cover; display:block;"/>' +
      "</span>";
  }
  function glyphIcon(glyph, bg, size) {
    size = size || 22;
    return '<span style="flex:none; width:' + size + "px; height:" + size + "px; border-radius:50%; background:" + bg + '; display:inline-flex; align-items:center; justify-content:center; font-size:' + Math.round(size * 0.45) + "px; font-weight:700; color:#07070b;\">" + esc(glyph) + "</span>";
  }
  function usdcIcon(size) { return tokenLogoIcon(USDC_LOGO, size); }
  function underlyingLogo() {
    var p = S.activePair;
    return (p && p.underlyingLogo) || (S.sideAInfo && S.sideAInfo.logo) || null;
  }
  function underlyingIcon(size) {
    var logo = underlyingLogo();
    if (logo) return tokenLogoIcon(logo, size);
    return pairIcon(S.activePair || { theme: THEMES[S.themeIdx] }, size);
  }
  function pairIcon(p, size) {
    size = size || 28;
    var logo = p && (p.logo || p.underlyingLogo);
    if (logo) return tokenLogoIcon(logo, size);
    var th = (p && p.theme) || THEMES[0];
    return '<span style="flex:none; display:flex;"><span style="width:' + size + "px; height:" + size + "px; border-radius:50%; background:" + th.a + '; border:2px solid #0c0c16;"></span><span style="width:' + size + "px; height:" + size + "px; border-radius:50%; background:" + th.b + "; border:2px solid #0c0c16; margin-left:-" + Math.round(size * 0.35) + 'px;"></span></span>';
  }
  function tokenAvatar(tk, size) {
    size = size || 42;
    if (tk.logo) return tokenLogoIcon(tk.logo, size);
    return '<span style="flex:none; width:' + size + "px; height:" + size + "px; border-radius:50%; background:" + tk.bg + '; display:flex; align-items:center; justify-content:center; font-size:' + Math.round(size * 0.42) + "px; font-weight:700; color:#07070b;\">" + esc(tk.glyph) + "</span>";
  }
  function tokenPill(iconHtml, label) {
    return '<span style="flex:none; display:flex; align-items:center; gap:8px; padding:7px 12px 7px 8px; border-radius:999px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08);">' + iconHtml + '<span style="font-weight:600; font-size:14px; color:#eaeaf2;">' + esc(label) + "</span></span>";
  }
  var MINTRE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var WSOL_MINT = "So11111111111111111111111111111111111111112";
  var X_URL = "https://x.com/_magicalmoney";
  var X_HANDLE = "@_magicalmoney";
  var GITHUB_URL = "https://github.com/magicalinternetdotmoney/magicalinternetdotmoney";
  var CA_URL = "https://solscan.io/token/" + MEME_MINT_ADDR;
  var FOOT_LINK_STYLE = "color:#7e7e97; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,0.12);";
  var X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  function xLink(icon) {
    return extLink(X_URL, icon
      ? "display:flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:10px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.03); color:#7e7e97; text-decoration:none; flex:none;"
      : "color:#7e7e97; text-decoration:none; border-bottom:1px dashed rgba(255,255,255,0.12);", icon ? X_ICON : X_HANDLE);
  }
  function caLink() {
    return extLink(CA_URL, FOOT_LINK_STYLE, "ca");
  }
  function siteFoot() {
    return '<div style="text-align:center; padding:20px 0 4px; font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#54546a;">' + xLink(false) + " · " + extLink(GITHUB_URL, FOOT_LINK_STYLE, "github") + " · " + caLink() + " · unaudited · experimental</div>";
  }
  function jupSwapUrl(buyMint) {
    return "https://jup.ag/swap?sell=" + encodeURIComponent(WSOL_MINT) + "&buy=" + encodeURIComponent(buyMint);
  }
  function synthLev(sym, levMax) {
    var m = (sym || "").match(/^(\d+)x/i);
    return m ? parseInt(m[1], 10) : levMax;
  }
  function deployed() { return true; }
  function aprLabel(p) {
    if (!p) return "no data yet";
    if (p.apr != null && Math.abs(p.apr) >= 0.05) return p.apr.toFixed(1) + "% APR";
    if (p.nav != null) return "APY building…";
    if (p.tvl != null) return "seed only";
    return "no data yet";
  }
  function navOf(pk) {
    var s = DATA.series[pk + "|" + S.tf];
    if (s && s.length) return s[s.length - 1].nav;
    var p = (DATA.pairs || []).find(function (x) { return x.receiptMint === pk || x.sym === pk; });
    return p && p.nav != null ? p.nav : null;
  }
  var TF_STEP = { "1H": [5, "m"], "1D": [2, "h"], "1W": [1, "d"], "1M": [2, "d"], ALL: [1, "w"] };

  // ===== wallet adapter (Wallet Standard + injected) =====
  var WALLET = {
    found: [],
    _wsInit: false,
    add: function (w) {
      var i = this.found.findIndex(function (x) { return x.name === w.name; });
      if (i < 0) { this.found.push(w); return; }
      // injected providers are more reliable for connect + sign on Solana dapps
      if (w.kind === "legacy" && this.found[i].kind === "standard") this.found[i] = w;
    },
    initStandard: function () {
      if (this._wsInit) return;
      this._wsInit = true;
      var self = this;
      var apiObj = { register: function () { for (var i = 0; i < arguments.length; i++) self.addStandard(arguments[i]); return function () {}; } };
      try {
        window.addEventListener("wallet-standard:register-wallet", function (e) { try { e.detail(apiObj); } catch (x) {} });
      } catch (x) {}
    },
    detect: function () {
      this.initStandard();
      this.found = [];
      var self = this;
      try {
        var apiObj = { register: function () { for (var i = 0; i < arguments.length; i++) self.addStandard(arguments[i]); return function () {}; } };
        window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: apiObj }));
      } catch (x) {}
      // Legacy injected providers (preferred when both exist — see add())
      var ph = (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null);
      if (ph) this.add({ name: "Phantom", icon: "👻", kind: "legacy", ref: ph });
      if (window.solflare && window.solflare.isSolflare) this.add({ name: "Solflare", icon: "🔆", kind: "legacy", ref: window.solflare });
      if (window.backpack) this.add({ name: "Backpack", icon: "🎒", kind: "legacy", ref: window.backpack });
      return this.found;
    },
    addStandard: function (w) {
      try {
        var chains = w.chains || [];
        var solana = chains.some(function (c) { return ("" + c).indexOf("solana:") === 0; });
        if (!solana) return;
        if (!w.features || !w.features["standard:connect"]) return;
        this.add({ name: w.name, icon: w.icon || "✦", kind: "standard", ref: w });
      } catch (x) {}
    },
    acctAddr: function (acct) {
      if (!acct) return null;
      return acct.address || acct.publicKey || (typeof acct === "string" ? acct : null);
    },
    connect: function (entry) {
      if (entry.kind === "standard") {
        return Promise.resolve(entry.ref.features["standard:connect"].connect()).then(function (res) {
          var acct = (res && res.accounts && res.accounts[0]) || (entry.ref.accounts && entry.ref.accounts[0]);
          var addr = WALLET.acctAddr(acct);
          if (!addr) throw new Error("no account — unlock your wallet and approve the connection");
          return ("" + addr);
        });
      }
      var prov = entry.ref;
      if (prov.isConnected && prov.publicKey) return Promise.resolve(prov.publicKey.toString());
      return Promise.resolve(prov.connect({ onlyIfTrusted: false })).then(function (r) {
        var pk = (r && r.publicKey) || prov.publicKey;
        if (!pk) throw new Error("no publicKey");
        return pk.toString();
      }).catch(function (err) {
        if (prov.publicKey) return prov.publicKey.toString();
        throw err;
      });
    },
    disconnect: function (entry) {
      try {
        if (!entry) return;
        if (entry.kind === "standard") { var d = entry.ref.features && entry.ref.features["standard:disconnect"]; if (d) d.disconnect(); }
        else if (entry.ref.disconnect) entry.ref.disconnect();
      } catch (x) {}
    },
  };
  WALLET.initStandard();
  var _web3P = null;
  function web3Mod() {
    if (!_web3P) _web3P = import("https://esm.sh/@solana/web3.js@1.95.3");
    return _web3P;
  }
  function txBytes(txB64) {
    return Uint8Array.from(atob(txB64), function (c) { return c.charCodeAt(0); });
  }
  function deserializeTx(txB64) {
    return web3Mod().then(function (m) { return m.VersionedTransaction.deserialize(txBytes(txB64)); });
  }
  function rpcSendRaw(serialized) {
    var u8 = serialized instanceof Uint8Array ? serialized : new Uint8Array(serialized);
    var b64 = btoa(String.fromCharCode.apply(null, u8));
    return fetch("/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }] }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    });
  }
  function sigStr(r) {
    var sig = (r && r.signature) || r;
    return sig && sig.toString ? sig.toString() : sig;
  }
  function stdAccount(entry) {
    return entry && entry.kind === "standard" && entry.ref.accounts && entry.ref.accounts[0];
  }
  // sign+send a server-prepared VersionedTransaction (Wallet Standard or legacy injected provider).
  function signAndSend(txB64) {
    if (typeof txB64 !== "string") return Promise.reject(new Error("bad transaction payload"));
    var entry = S.walletRef;
    if (!entry) return Promise.reject(new Error("no wallet connected"));
    var bytes = txBytes(txB64);
    if (entry.kind === "standard") {
      var account = stdAccount(entry);
      if (!account) return Promise.reject(new Error("no wallet account — disconnect and reconnect"));
      var sendF = entry.ref.features && entry.ref.features["solana:signAndSendTransaction"];
      if (sendF) {
        return Promise.resolve(sendF.signAndSendTransaction({ account: account, transaction: bytes, chain: "solana:mainnet" })).then(function (out) {
          return out && out[0] ? out[0].signature : null;
        });
      }
      var signF = entry.ref.features && entry.ref.features["solana:signTransaction"];
      if (!signF) return Promise.reject(new Error("wallet can't sign transactions"));
      return Promise.resolve(signF.signTransaction({ account: account, transaction: bytes, chain: "solana:mainnet" })).then(function (out) {
        var signed = (out && out.signedTransaction) || (out && out[0] && out[0].signedTransaction) || out;
        return rpcSendRaw(signed);
      });
    }
    return deserializeTx(txB64).then(function (vtx) {
      var prov = entry.ref;
      if (prov.signAndSendTransaction) {
        return Promise.resolve(prov.signAndSendTransaction(vtx)).then(sigStr);
      }
      if (prov.signTransaction) {
        return Promise.resolve(prov.signTransaction(vtx)).then(function (signed) {
          return rpcSendRaw(signed.serialize());
        });
      }
      throw new Error("wallet can't sign transactions — try Phantom or Solflare");
    });
  }
  function signAndSendAll(txs) {
    return txs.reduce(function (p, t) {
      return p.then(function () {
        var raw = typeof t === "string" ? t : (t && t.tx);
        if (!raw) return Promise.reject(new Error("bad transaction in batch"));
        return signAndSend(raw);
      });
    }, Promise.resolve());
  }
  function fluxQuoteBal() {
    if (S.fluxQuote === "SOL") return S.sol;
    return S.usdc;
  }
  function fluxQuoteMint() {
    return S.fluxQuote === "SOL" ? WSOL_MINT : USDC_MINT;
  }
  function fluxReceiptEst(nav) {
    if (!nav || nav <= 0) return null;
    var q = S.fluxAmt;
    if (S.fluxQuote === "USDC") return q / nav;
    return null;
  }
  function loadBalances() {
    if (!S.pubkey) return;
    S.balErr = null;
    api("/api/balance?owner=" + encodeURIComponent(S.pubkey)).then(function (d) {
      if (d && d.error) { S.balErr = d.message || d.error; S.sol = null; S.usdc = null; }
      else { S.sol = d.sol; S.usdc = d.usdc; }
      render();
    }).catch(function (e) { S.balErr = "" + e; render(); });
    api("/api/tokenbalance?owner=" + S.pubkey + "&mint=" + MEME_MINT_ADDR).then(function (d) {
      if (d && !d.error) { S.memeBal = d.uiAmount; render(); }
    });
    if (S.view === "provide" && S.activePair) A._reloadReceipt();
  }
  function startBalPoll() {
    clearInterval(A._balIv);
    if (!S.pubkey) return;
    A._balIv = setInterval(loadBalances, BAL_MS);
  }
  function stopBalPoll() { clearInterval(A._balIv); }
  function startPairsPoll() {
    clearInterval(A._pairsIv);
    A._pairsIv = setInterval(function () { if (S.view === "home" || S.view === "provide") fetchPairs(true); }, PAIRS_MS);
  }

  // ===== actions =====
  var A = {
    openWallet: function () { WALLET.detect(); S.wallets = WALLET.found; S.walletOpen = true; render(); },
    closeWallet: function () { S.walletOpen = false; render(); },
    pickWallet: function (e) {
      var i = +e.currentTarget.getAttribute("data-arg"), entry = S.wallets[i];
      if (!entry) return;
      WALLET.connect(entry).then(function (addr) {
        S.walletRef = entry; S.connected = true; S.pubkey = addr; S.addr = shortAddr(addr); S.walletOpen = false;
        S.sol = null; S.usdc = null;
        try { render(); } catch (e) { console.error("render after connect", e); }
        loadBalances(); startBalPoll();
      }).catch(function (err) { S.note = "wallet connect failed: " + (err.message || err); render(); });
    },
    disconnect: function () { stopBalPoll(); WALLET.disconnect(S.walletRef); S.walletRef = null; S.connected = false; S.addr = null; S.pubkey = null; S.sol = null; S.usdc = null; S.view = "home"; S.activePair = null; syncUrl(); render(); },
    goHome: function () { S.view = "home"; S.activePair = null; S.note = null; syncUrl(); fetchPairs(true); render(); },
    goCreate: function () { S.view = "create"; S.cStep = 1; S.activePair = null; syncUrl(); if (S.pubkey) loadBalances(); render(); },
    goProvideNew: function () {
      var pairs = DATA.pairs || [];
      if (!pairs.length) { S.note = "No pairs are live yet — launch one first."; render(); return; }
      A.openPairBy(pairs[0]);
    },
    openPair: function (e) { var i = +e.currentTarget.getAttribute("data-arg"); A.openPairBy((DATA.pairs || [])[i]); },
    openPairBy: function (p) { if (!p) return; activatePair(p); syncUrl(); loadBalances(); ensureData(); A._reloadReceipt(); render(); },
    copyShareLink: function () {
      var url = window.location.origin + buildUrl(routeFromState());
      try { if (navigator.clipboard) navigator.clipboard.writeText(url); } catch (x) {}
      S.copied = "__share__"; render();
      clearTimeout(A._cp); A._cp = setTimeout(function () { S.copied = null; render(); }, 1300);
    },
    onExploreQ: function (e) { S.exploreQ = e.target.value; clearTimeout(A._eq); A._eq = setTimeout(function () { syncUrl(true); fetchPairs(true); }, 280); },
    setExploreSort: function (e) { S.exploreSort = e.currentTarget.getAttribute("data-arg"); syncUrl(true); fetchPairs(true); },
    toggleExploreOrder: function () { S.exploreOrder = S.exploreOrder === "desc" ? "asc" : "desc"; syncUrl(true); fetchPairs(true); },
    onFact: function (e) { S.fact = e.target.value; render(); },
    onSideA: function (e) { S.sideA = e.target.value.trim(); A._lookup("A", S.sideA); render(); },
    onSideB: function (e) { S.sideB = e.target.value.trim(); A._lookup("B", S.sideB); render(); },
    setSideA: function (e) { S.sideA = e.currentTarget.getAttribute("data-arg"); A._lookup("A", S.sideA); render(); },
    setSideB: function (e) { S.sideB = e.currentTarget.getAttribute("data-arg"); A._lookup("B", S.sideB); render(); },
    _lookup: function (side, ca) {
      A._lt = A._lt || {};
      clearTimeout(A._lt[side]);
      var key = "side" + side + "Info";
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) { S[key] = null; return; }
      // USDC is the quote — constant $1 anchor, resolved instantly (no Raydium lookup / no "resolving…").
      if (ca === USDC_MINT) { S[key] = { symbol: "USDC", name: "USD Coin", priceUsd: 1, isQuote: true, hasUsdcPool: true }; return; }
      S[key] = { loading: true };
      A._lt[side] = setTimeout(function () {
        api("/api/underlying?ca=" + encodeURIComponent(ca)).then(function (d) { S[key] = d; render(); }).catch(function () { S[key] = { error: "lookup failed" }; render(); });
      }, 450);
    },
    onRecSym: function (e) { S.recSym = e.target.value.toUpperCase().slice(0, 7); render(); },
    onRecName: function (e) { S.recName = e.target.value; render(); },
    onEmoji: function (e) { S.emoji = e.target.value.slice(0, 2); render(); },
    setTheme: function (e) { S.themeIdx = +e.currentTarget.getAttribute("data-arg"); render(); },
    toStep2: function () { S.cStep = 2; syncUrl(); render(); },
    toStep1: function () { S.cStep = 1; syncUrl(); render(); },
    onSeed: function (e) { S.seed = +e.target.value; render(); },
    onLevMax: function (e) { S.levMax = +e.target.value; render(); },
    onMemeAmt: function (e) { S.memeAmt = +e.target.value; render(); },
    setDeposit: function () { S.mode = "deposit"; render(); },
    setWithdraw: function () { S.mode = "withdraw"; render(); },
    setTrade: function () { S.pTab = "trade"; syncUrl(true); render(); },
    setCharts: function () { S.pTab = "charts"; syncUrl(true); ensureData(); render(); },
    setTf: function (e) { S.tf = e.currentTarget.getAttribute("data-arg"); S.hoverF = null; syncUrl(true); ensureData(); render(); },
    toggleContracts: function () { S.contractsOpen = !S.contractsOpen; render(); },
    togglePlaybook: function () { S.playbookOpen = !S.playbookOpen; render(); },
    setDepAmt: function (e) { S.depAmt = +e.currentTarget.getAttribute("data-arg"); render(); },
    setWdPct: function (e) { S.wdPct = +e.currentTarget.getAttribute("data-arg"); render(); },
    onPay: function (e) { var v = +e.target.value; if (S.mode === "deposit") S.depAmt = v; else S.wdPct = v; render(); },
    copyAddr: function (e) { var addr = e.currentTarget.getAttribute("data-arg"); try { navigator.clipboard && navigator.clipboard.writeText(addr); } catch (x) {} S.copied = addr; render(); clearTimeout(A._cp); A._cp = setTimeout(function () { S.copied = null; render(); }, 1300); },
    gatedAction: function () { S.note = deployed() ? "tx-builder not wired for this pair yet." : "Mainnet program isn't deployed yet."; render(); },
    solGuard: function () { S.note = launchSolGuardMsg() || "need more SOL to deploy"; render(); },
    doDeposit: function () {
      if (S.busy || !S.activePair || !S.pubkey) return;
      var usdc = Math.floor(Math.min(S.depAmt, S.usdc || 0) * 1e6);
      if (usdc <= 0) { S.note = "enter a USDC amount"; render(); return; }
      S.busy = "deposit"; S.note = "preparing deposit…"; render();
      api("/api/tx/deposit?sym=" + encodeURIComponent(pairKey(S.activePair)) + "&owner=" + S.pubkey + "&usdc=" + usdc).then(function (d) {
        if (d.error || !d.tx) throw new Error(d.message || d.error || "build failed");
        S.note = "approve in your wallet…"; render();
        return signAndSend(d.tx);
      }).then(function () { S.busy = null; S.note = "deposit submitted ✓"; loadBalances(); A._reloadReceipt(); render(); })
        .catch(function (e) { S.busy = null; S.note = "deposit failed: " + (e.message || e); render(); });
    },
    toggleFlux: function () { S.fluxOpen = !S.fluxOpen; render(); },
    setFluxQuote: function (e) { S.fluxQuote = e.currentTarget.getAttribute("data-arg"); var mx = fluxQuoteBal(); if (mx != null) S.fluxAmt = Math.min(S.fluxAmt, Math.max(0.01, mx)); render(); },
    onFluxAmt: function (e) { S.fluxAmt = +e.target.value; render(); },
    setFluxAmt: function (e) { S.fluxAmt = +e.currentTarget.getAttribute("data-arg"); render(); },
    doFluxbeamPool: function () {
      if (S.busy || !S.activePair || !S.pubkey) return;
      var nav = navOf(pairKey(S.activePair));
      var mx = fluxQuoteBal();
      if (mx == null || S.fluxAmt <= 0 || S.fluxAmt > mx) { S.note = "enter a valid " + S.fluxQuote + " amount"; render(); return; }
      if (!nav) { S.note = "NAV not available yet"; render(); return; }
      S.busy = "flux"; S.note = "building FluxBeam pool…"; render();
      api("/api/tx/fluxbeam-pool?sym=" + encodeURIComponent(pairKey(S.activePair)) + "&owner=" + S.pubkey + "&quoteMint=" + fluxQuoteMint() + "&quoteUi=" + S.fluxAmt).then(function (d) {
        if (d.error || !d.txs || !d.txs.length) throw new Error(d.message || d.error || "build failed");
        var pre = d.txs.filter(function (t) { return t.step !== "pool"; });
        var pool = d.txs.find(function (t) { return t.step === "pool"; });
        S.note = "approve " + pre.length + " setup txs…"; render();
        return signAndSendAll(pre).then(function () {
          if (!pool) return d;
          S.note = "waiting for LUT…"; render();
          return new Promise(function (r) { setTimeout(r, 3000); }).then(function () {
            S.note = "approve pool create (hook + fund)…"; render();
            return signAndSend(pool.tx).then(function () { return d; });
          });
        });
      }).then(function (d) {
        S.busy = null; S.note = "FluxBeam pool live · " + (d.pool || "").slice(0, 8) + "…"; loadBalances(); A._reloadReceipt(); render();
      }).catch(function (e) { S.busy = null; S.note = "FluxBeam failed: " + (e.message || e); render(); });
    },
    doWithdraw: function () {
      if (S.busy || !S.activePair || !S.pubkey) return;
      var bal = S.receiptRaw ? BigInt(S.receiptRaw) : 0n;
      var amt = (bal * BigInt(S.wdPct)) / 100n;
      if (amt <= 0n) { S.note = "nothing to withdraw"; render(); return; }
      S.busy = "withdraw"; S.note = "preparing withdraw…"; render();
      api("/api/tx/withdraw?sym=" + encodeURIComponent(pairKey(S.activePair)) + "&owner=" + S.pubkey + "&receipt=" + amt.toString()).then(function (d) {
        if (d.error || !d.tx) throw new Error(d.message || d.error || "build failed");
        S.note = "approve in your wallet…"; render();
        return signAndSend(d.tx);
      }).then(function () { S.busy = null; S.note = "withdraw submitted ✓"; loadBalances(); A._reloadReceipt(); render(); })
        .catch(function (e) { S.busy = null; S.note = "withdraw failed: " + (e.message || e); render(); });
    },
    doLaunch: function () {
      if (S.busy) return;
      if (!S.pubkey) { S.note = "connect a wallet first"; render(); return; }
      if (!deployed()) { S.note = "program not deployed"; render(); return; }
      var a = S.sideAInfo;
      if (!a || !a.priceUsd || !(a.hasPriceAnchor || a.hasUsdcPool)) { S.note = "side A needs a token with a live price pool — we look up Raydium then PumpSwap automatically"; render(); return; }
      if (typeof window.MIMLaunch !== "function") { S.note = "launch engine still loading — try again"; render(); return; }
      var seedUsdc = Math.min(S.seed, S.usdc != null ? Math.floor(S.usdc) : S.seed);
      if (seedUsdc < 1) { S.note = "you need USDC to seed the pools"; render(); return; }
      var solGuard = launchSolGuardMsg();
      if (solGuard) { S.note = solGuard; render(); return; }
      var memeWhole = Math.min(S.memeAmt, S.memeBal != null ? Math.floor(S.memeBal / 2) : S.memeAmt);
      // On-chain PumpSwap oracle is wired only when the auto-lookup resolved a PumpSwap pool
      // (Raydium USDC pools use triangle-only rebalancing — no oracle fields needed).
      var pumpPool = a.pool && a.pool.type === "pumpswap" && a.pool.id && a.pool.baseVault && a.pool.quoteVault;
      var oracleWad = a.priceUsd ? BigInt(Math.max(1, Math.round(a.priceUsd * 1e9))) : 0n;
      var params = {
        programId: S.status.programId, owner: S.pubkey, sym: S.recSym, name: S.recName,
        assetUsd: a.priceUsd, seedUsdc: seedUsdc, lev: S.levMax, quoteMint: USDC_MINT,
        memeMint: MEME_MINT_ADDR, memePerPool: (BigInt(Math.round(memeWhole)) * 1000000n).toString(),
        underlyingMint: S.sideA, underlyingSymbol: S.sideAInfo.symbol, theme: THEMES[S.themeIdx],
        oraclePool: pumpPool ? a.pool.id : null,
        initOraclePriceWad: pumpPool ? oracleWad.toString() : "0",
        oracleBaseVault: pumpPool ? a.pool.baseVault : null,
        oracleQuoteVault: pumpPool ? a.pool.quoteVault : null,
      };
      S.busy = "launch"; S.note = "launching " + S.recSym + "…"; render();
      window.MIMLaunch(params, S.walletRef, function (msg) { S.note = msg; render(); })
        .then(function (pair) {
          if (S.sideAInfo) { pair.underlyingMint = S.sideA; pair.underlyingLogo = S.sideAInfo.logo; pair.underlyingSymbol = S.sideAInfo.symbol; }
          S.busy = null; S.note = "🎉 " + pair.sym + " launched — 5 AMMs live!"; DATA.pairs = null; A.openPairBy(pair);
        })
        .catch(function (e) { S.busy = null; S.note = "launch failed: " + (e.message || e); render(); });
    },
    _reloadReceipt: function () {
      if (!S.activePair || !S.pubkey || !S.activePair.receiptMint) return;
      api("/api/tokenbalance?owner=" + S.pubkey + "&mint=" + S.activePair.receiptMint).then(function (d) {
        if (d && !d.error) { S.receiptRaw = d.amount; S.receiptUi = d.uiAmount; render(); }
      });
    },
    dismissNote: function () { S.note = null; render(); },
    stop: function (e) { e.stopPropagation(); },
  };

  // ===== chart math (from fetched series) =====
  function chart() {
    var pts = S.activePair ? DATA.series[pairKey(S.activePair) + "|" + S.tf] : null;
    if (!pts || pts.length < 2) return null;
    var n = pts.length, W = 320;
    var xc = function (i) { return (i / (n - 1)) * W; };
    var aHi = -1e9, aLo = 1e9; pts.forEach(function (p) { aHi = Math.max(aHi, p.mint); aLo = Math.min(aLo, p.redeem); });
    var aPad = (aHi - aLo) * 0.25 || 0.01; aHi += aPad; aLo -= aPad;
    var yA = function (v) { return 10 + (1 - (v - aLo) / (aHi - aLo)) * 130; };
    var mintArr = pts.map(function (p, i) { return xc(i).toFixed(1) + "," + yA(p.mint).toFixed(1); });
    var redeemArr = pts.map(function (p, i) { return xc(i).toFixed(1) + "," + yA(p.redeem).toFixed(1); });
    var spreadFill = "M" + mintArr.join(" L ") + " L " + redeemArr.slice().reverse().join(" L ") + " Z";
    var bHi = 0; pts.forEach(function (p) { bHi = Math.max(bHi, p.nav); }); bHi *= 1.08;
    var yB = function (v) { return 8 + (1 - v / bHi) * 114; };
    var vaArr = pts.map(function (p, i) { return xc(i).toFixed(1) + "," + yB(p.va).toFixed(1); });
    var navArr = pts.map(function (p, i) { return xc(i).toFixed(1) + "," + yB(p.nav).toFixed(1); });
    var aArea = "M0," + yB(0).toFixed(1) + " L " + vaArr.join(" L ") + " L " + W + "," + yB(0).toFixed(1) + " Z";
    var bArea = "M" + vaArr.join(" L ") + " L " + navArr.slice().reverse().join(" L ") + " Z";
    var last = pts[n - 1], first = pts[0], chgN = ((last.nav - first.nav) / first.nav) * 100;
    var st = TF_STEP[S.tf] || [1, "d"];
    var lbl = function (k) { return k <= 0 ? "now" : "−" + k * st[0] + st[1]; };
    var hov = S.hoverF, H = { hoverOn: false };
    if (hov != null) {
      var hi = Math.max(0, Math.min(n - 1, Math.round(hov * (n - 1)))), pt = pts[hi];
      H = { hoverOn: true, hoverPct: ((hi / (n - 1)) * 100).toFixed(2) + "%", hovMint: "$" + pt.mint.toFixed(4), hovRedeem: "$" + pt.redeem.toFixed(4), hovLabel: lbl(n - 1 - hi), crossX: xc(hi).toFixed(1), cyMint: yA(pt.mint).toFixed(1), cyRedeem: yA(pt.redeem).toFixed(1) };
    }
    return {
      last: last, chgN: chgN, xStart: lbl(n - 1),
      spreadFill: spreadFill, mintLine: mintArr.join(" "), redeemLine: redeemArr.join(" "),
      aArea: aArea, bArea: bArea, vaLine: vaArr.join(" "), navTopLine: navArr.join(" "), H: H,
    };
  }

  // ===== template =====
  function btn(act, arg, style, inner, extra) { return '<button data-act="' + act + '"' + (arg != null ? ' data-arg="' + esc(arg) + '"' : "") + ' data-press style="' + style + '"' + (extra || "") + ">" + inner + "</button>"; }
  var LOGO = '<svg width="26" height="25" viewBox="0 0 96 92" fill="none" style="flex:none;"><path d="M48 8 L88 80 L8 80 Z" stroke="url(#navg)" stroke-width="4" stroke-linejoin="round"/><circle cx="48" cy="8" r="8" fill="#2fe6c0"/><circle cx="88" cy="80" r="8" fill="#a06bff"/><circle cx="8" cy="80" r="8" fill="#f2c14e"/><defs><linearGradient id="navg" x1="0" y1="0" x2="96" y2="92"><stop offset="0" stop-color="#2fe6c0"/><stop offset="1" stop-color="#a06bff"/></linearGradient></defs></svg>';
  var BG = '<div style="position:fixed; inset:0; background-image:linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px); background-size:48px 48px; -webkit-mask-image:radial-gradient(90% 60% at 50% 20%, #000 0%, transparent 85%); mask-image:radial-gradient(90% 60% at 50% 20%, #000 0%, transparent 85%); pointer-events:none;"></div>' +
    '<div style="position:fixed; top:-14%; left:8%; width:40vw; height:40vw; max-width:620px; max-height:620px; background:radial-gradient(circle, rgba(47,230,192,0.13), transparent 65%); filter:blur(20px); pointer-events:none; animation:mim-floaty 12s ease-in-out infinite;"></div>' +
    '<div style="position:fixed; bottom:-16%; right:6%; width:42vw; height:42vw; max-width:640px; max-height:640px; background:radial-gradient(circle, rgba(160,107,255,0.15), transparent 65%); filter:blur(20px); pointer-events:none; animation:mim-floaty 15s ease-in-out infinite reverse;"></div>';

  function extLink(href, style, inner) {
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" style="' + style + '">' + inner + "</a>";
  }
  function legMints(pk) {
    pk = pk || "";
    var contracts = pk ? (DATA.contracts[pk] || []) : [];
    var plus = contracts.find(function (c) { return c.leg === "long"; });
    var minus = contracts.find(function (c) { return c.leg === "inverse"; });
    var p = pk && S.activePair && pairKey(S.activePair) === pk ? S.activePair : null;
    var dispSym = (p && pairSymLabel(p)) || pk;
    var lev = synthLev(dispSym, p && p.levMax);
    var u = (p && p.underlyingSymbol) || (dispSym ? dispSym.replace(/^\d+x/i, "") : "") || "asset";
    return {
      plusSym: (plus && plus.symbol) || ("+" + lev + "x" + u),
      minusSym: (minus && minus.symbol) || ("-" + lev + "x" + u),
      plusMint: (plus && plus.addr) || (p && p.mintA) || null,
      minusMint: (minus && minus.addr) || (p && p.mintB) || null,
    };
  }
  function playbookItem(icon, title, body, accent, extra) {
    return '<div style="display:flex; gap:12px; padding:12px 0; border-top:1px solid rgba(255,255,255,0.06);"><span style="flex:none; width:28px; height:28px; border-radius:8px; background:rgba(255,255,255,0.04); display:flex; align-items:center; justify-content:center; font-size:14px; color:' + accent + ';">' + icon + '</span><div style="flex:1; min-width:0;"><div style="font-size:13px; font-weight:600; color:#eaeaf2; margin-bottom:4px;">' + esc(title) + '</div><div style="font-size:12px; color:#7e7e97; line-height:1.5;">' + body + "</div>" + (extra || "") + "</div></div>";
  }
  function playbookCard(sym, compact) {
    var legs = legMints(sym);
    var jupRow = (legs.plusMint || legs.minusMint) ? '<div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">' +
      (legs.plusMint ? extLink(jupSwapUrl(legs.plusMint), "flex:1; min-width:120px; display:flex; align-items:center; justify-content:center; padding:10px 12px; border-radius:10px; border:1px solid rgba(47,230,192,0.28); background:rgba(47,230,192,0.07); color:#2fe6c0; font-size:12px; font-weight:600; text-decoration:none;", esc(legs.plusSym) + " on Jupiter ↗") : "") +
      (legs.minusMint ? extLink(jupSwapUrl(legs.minusMint), "flex:1; min-width:120px; display:flex; align-items:center; justify-content:center; padding:10px 12px; border-radius:10px; border:1px solid rgba(160,107,255,0.28); background:rgba(160,107,255,0.07); color:#cdbcff; font-size:12px; font-weight:600; text-decoration:none;", esc(legs.minusSym) + " on Jupiter ↗") : "") +
      "</div>" : "";
    var body = '<div style="padding-top:4px;">' + playbookItem("↻", "Transfer receipt to rebalance", "Deposit/withdraw <span style=\"color:#cfcfe0;\">mints or burns</span> receipt (1:1 with LP) — that is <span style=\"color:#cfcfe0;\">not</span> a transfer, so the hook does not fire. To rebalance, <span style=\"color:#cfcfe0;\">move receipt tokens</span> (wallet → wallet). That transfer hits the Token-2022 hook and triggers the crank to mint into the winning/losing leg.", "#f2c14e") +
      playbookItem("◎", "Trade leveraged tokens on Jupiter", "People grab the +/− synths on Jupiter once there's pool liquidity. You don't need the receipt for directional exposure.", "#2fe6c0", jupRow) + "</div>";
    if (compact) {
      return '<div style="border-radius:18px; padding:14px 16px; background:rgba(47,230,192,0.05); border:1px solid rgba(47,230,192,0.18);"><div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;"><span style="width:7px; height:7px; border-radius:50%; background:#f2c14e; box-shadow:0 0 8px #f2c14e;"></span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#f2c14e;">mainnet alpha · unaudited</span></div><div style="font-size:12.5px; color:#9494ad; line-height:1.55;">LPs: deposit/withdraw mints receipt — rebalancing needs a receipt <span style="color:#cfcfe0;">transfer</span> (transfer hook). Traders: swap +/− legs on Jupiter.</div>' + jupRow + '</div>';
    }
    var head = btn("togglePlaybook", null, "width:100%; display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border:none; background:none; cursor:pointer;", '<span style="display:flex; align-items:center; gap:8px;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#cfcfe0; letter-spacing:0.08em;">HOW IT WORKS</span><span style="width:7px; height:7px; border-radius:50%; background:#f2c14e; box-shadow:0 0 8px #f2c14e;"></span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:9.5px; color:#f2c14e;">alpha</span></span><span style="color:#7e7e97; font-size:12px; transform:rotate(' + (S.playbookOpen ? "180deg" : "0deg") + '); display:inline-block;">▾</span>');
    var foot = '<div style="padding:0 16px 12px; font-size:10.5px; color:#54546a; line-height:1.45; border-top:1px solid rgba(255,255,255,0.06); padding-top:10px;">' + xLink(false) + " · " + caLink() + " · unaudited · experimental</div>";
    return '<div style="border-radius:18px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); overflow:hidden;">' + head +
      (S.playbookOpen ? '<div style="padding:0 16px 4px;">' + body + "</div>" + foot : "") + "</div>";
  }

  function banner() {
    // honest chain-status strip — shown when connected so users know actions are gated
    if (!S.connected) return "";
    var dep = deployed();
    var bg = dep ? "rgba(47,230,192,0.08)" : "rgba(242,193,78,0.09)", bd = dep ? "rgba(47,230,192,0.25)" : "rgba(242,193,78,0.3)", fg = dep ? "#2fe6c0" : "#f2c14e";
    var msg = dep ? "mainnet alpha · unaudited · program " + shortAddr(S.status.programId) : "testnet preview · mainnet program not deployed yet — launching & deposits are disabled";
    return '<div style="border-radius:12px; padding:9px 13px; background:' + bg + "; border:1px solid " + bd + '; display:flex; align-items:center; gap:9px;"><span style="flex:none; width:7px; height:7px; border-radius:50%; background:' + fg + "; box-shadow:0 0 8px " + fg + ';"></span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:' + fg + '; line-height:1.4;">' + esc(msg) + "</span></div>";
  }
  function noteToast() {
    if (!S.note) return "";
    return '<div data-act="dismissNote" style="position:fixed; left:50%; bottom:24px; transform:translateX(-50%); z-index:90; max-width:90vw; padding:12px 16px; border-radius:12px; background:#16161f; border:1px solid rgba(255,255,255,0.14); box-shadow:0 12px 30px rgba(0,0,0,0.5); cursor:pointer; animation:mim-pop .25s ease;"><span style="font-size:12.5px; color:#eaeaf2;">' + esc(S.note) + '</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10px; color:#54546a; margin-left:10px;">tap to dismiss</span></div>';
  }

  function view() {
    var th = THEMES[S.themeIdx] || THEMES[0];
    var sym = (S.view === "provide" && S.activePair ? pairSymLabel(S.activePair) : S.recSym) || "TRI";
    var factName = S.fact || "your pair", quote = QUOTE;
    var html = '<div style="position:relative; min-height:100vh; width:100%; background:radial-gradient(120% 80% at 50% -10%, #14122a 0%, #0a0a14 44%, #07070b 100%); overflow-x:hidden;">' + BG;

    // NAV
    html += '<div style="position:relative; z-index:20; width:100%; display:flex; justify-content:center; padding:18px clamp(14px,3vw,32px) 0;"><div style="width:100%; max-width:620px; display:flex; align-items:center; justify-content:space-between; gap:12px;"><div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">';
    if (S.connected && S.view !== "home") html += btn("goHome", null, "width:32px; height:32px; flex:none; border-radius:10px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.03); color:#cfcfe0; font-size:16px; cursor:pointer;", "&larr;");
    html += LOGO + '<span style="font-weight:600; font-size:15px; letter-spacing:-0.01em; color:#f4f4fb; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;">Magical Internet Money</span></div>';
    html += '<div style="display:flex; align-items:center; gap:8px; flex:none;">' + xLink(true);
    if (S.connected) html += btn("disconnect", null, "display:flex; align-items:center; gap:7px; padding:8px 12px; border:1px solid rgba(255,255,255,0.1); border-radius:999px; background:rgba(255,255,255,0.03); font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:#cfcfe0; cursor:pointer; white-space:nowrap; flex:none;", '<span style="width:6px;height:6px;border-radius:50%;background:#2fe6c0;box-shadow:0 0 8px #2fe6c0;animation:mim-dot 1.8s ease-in-out infinite;"></span>' + esc(S.addr || ""));
    html += "</div></div></div>";

    if (!S.connected) html += connectView();
    else if (S.view === "home") html += homeView();
    else if (S.view === "create") html += createView(th, sym, factName, quote);
    else if (S.view === "provide") html += provideView(th, sym, quote);

    if (S.walletOpen) html += walletModal();
    html += noteToast();
    html += "</div>";
    return html;
  }

  function connectView() {
    return '<div style="position:relative; z-index:10; min-height:calc(100vh - 80px); display:flex; align-items:center; justify-content:center; padding:32px clamp(16px,4vw,40px) 60px;"><div style="width:100%; max-width:460px; display:flex; flex-direction:column; align-items:center; text-align:center; gap:26px;">' +
      '<div style="position:relative; width:140px; height:140px; display:flex; align-items:center; justify-content:center; animation:mim-rise .7s ease both;"><svg width="140" height="140" viewBox="0 0 160 160" style="position:absolute; inset:0; animation:mim-spin 26s linear infinite;"><circle cx="80" cy="80" r="70" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1" stroke-dasharray="2 7"/></svg><svg width="96" height="92" viewBox="0 0 96 92" fill="none" style="filter:drop-shadow(0 0 16px rgba(160,107,255,0.45));"><path d="M48 8 L88 80 L8 80 Z" stroke="url(#sg)" stroke-width="2.5" stroke-linejoin="round" fill="rgba(160,107,255,0.05)"/><circle cx="48" cy="8" r="6.5" fill="#2fe6c0"/><circle cx="88" cy="80" r="6.5" fill="#a06bff"/><circle cx="8" cy="80" r="6.5" fill="#f2c14e"/><defs><linearGradient id="sg" x1="0" y1="0" x2="96" y2="92"><stop offset="0" stop-color="#2fe6c0"/><stop offset="1" stop-color="#a06bff"/></linearGradient></defs></svg></div>' +
      '<div style="animation:mim-rise .7s ease .08s both;"><h1 style="margin:0; font-size:clamp(36px,8vw,52px); line-height:1.0; font-weight:700; letter-spacing:-0.025em; color:#f4f4fb;">Magical Internet<br>Money</h1><p style="margin:18px auto 0; max-width:390px; font-size:16px; line-height:1.55; color:#9494ad;">mainnet alpha — launch a pair via <span style="color:#cfcfe0;">~10 wallet txs</span> (Raydium triangle + receipt), or deposit USDC for receipt LPs. <span style="color:#7e7e97; font-size:13px;">Unaudited · verify on-chain.</span></p></div>' +
      '<div style="width:100%; max-width:340px; display:flex; flex-direction:column; gap:12px; animation:mim-rise .7s ease .16s both;">' + btn("openWallet", null, "width:100%; padding:17px; border:none; border-radius:14px; font-size:16px; font-weight:600; color:#07070b; background:linear-gradient(100deg,#2fe6c0,#7ad9ff 35%,#a06bff); background-size:220% auto; box-shadow:0 12px 34px -10px rgba(122,150,255,0.6); cursor:pointer; animation:mim-shimmer 4s linear infinite;", "Connect Wallet") +
      '<div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#54546a; letter-spacing:0.03em;">' + xLink(false) + " · " + extLink(GITHUB_URL, FOOT_LINK_STYLE, "github") + " · " + caLink() + " · unaudited · experimental · here be dragons</div></div></div></div>";
  }

  function statCard(label, val, accent) {
    var bg = accent ? "rgba(47,230,192,0.06)" : "rgba(255,255,255,0.025)", bd = accent ? "rgba(47,230,192,0.18)" : "rgba(255,255,255,0.07)", fg = accent ? "#2fe6c0" : "#f4f4fb";
    return '<div style="flex:1; border-radius:16px; padding:13px 16px; background:' + bg + "; border:1px solid " + bd + ';"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10px; color:#7e7e97; letter-spacing:0.1em;">' + label + '</div><div style="font-size:18px; font-weight:700; color:' + fg + '; margin-top:4px; font-variant-numeric:tabular-nums;">' + val + "</div></div>";
  }
  function homeView() {
    var pairs = DATA.pairs;
    var loaded = pairs != null;
    pairs = pairs || [];
    var tvlSum = pairs.reduce(function (m, p) { return m + (p.tvl || 0); }, 0);
    var aprs = pairs.map(function (p) { return p.apr; }).filter(function (x) { return x != null && Math.abs(x) >= 0.05; });
    var top = aprs.length ? Math.max.apply(null, aprs) : null;
    var sortChips = [["tvl", "TVL"], ["apr", "APR"], ["sym", "Symbol"], ["name", "Name"]].map(function (c) {
      var on = S.exploreSort === c[0];
      return btn("setExploreSort", c[0], "padding:5px 10px; border-radius:8px; cursor:pointer; font-family:'IBM Plex Mono',monospace; font-size:10px; border:1px solid " + (on ? "#a06bff" : "rgba(255,255,255,0.1)") + "; background:" + (on ? "rgba(160,107,255,0.14)" : "rgba(255,255,255,0.02)") + "; color:" + (on ? "#cdbcff" : "#9494ad") + ";", c[1]);
    }).join("");
    var pairRows = pairs.map(function (p, i) {
      return btn("openPair", i, "display:flex; align-items:center; gap:12px; padding:11px 10px; border:none; border-radius:12px; background:none; cursor:pointer; text-align:left; width:100%;",
        pairIcon(p, 28) +
        '<span style="flex:1; min-width:0;"><span style="display:block; font-size:14px; font-weight:600; color:#eaeaf2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(p.name) + '</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#7e7e97;">' + esc(pairSymLabel(p)) + (p.underlyingSymbol && !p.symCollides ? " · " + esc(p.underlyingSymbol) : "") + '</span></span>' +
        '<span style="flex:none; text-align:right;"><span style="display:block; font-family:\'IBM Plex Mono\',monospace; font-size:13px; color:#f4f4fb;">' + fmtUsd(p.tvl) + '</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#2fe6c0;">' + esc(aprLabel(p)) + "</span></span>");
    }).join("");
    var emptyMsg = S.exploreQ ? "No pairs match your search." : (deployed() ? "No pairs on-chain yet — be the first to launch." : "The mainnet program isn’t deployed yet.");
    var emptyPairs = '<div style="padding:22px 10px; text-align:center;"><div style="font-size:13px; color:#9494ad;">' + emptyMsg + '</div><div style="font-size:12px; color:#54546a; margin-top:6px; line-height:1.5;">Markets are discovered via getProgramAccounts — no manual registry needed.</div></div>';
    var exploreBar = '<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px;">' +
      inp("onExploreQ", S.exploreQ, "search name, symbol, mint…", "flex:1; min-width:140px; padding:10px 12px; border-radius:10px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.25); color:#f4f4fb; font-size:13px; outline:none;") +
      '<div style="display:flex; gap:5px; flex-wrap:wrap;">' + sortChips + btn("toggleExploreOrder", null, "padding:5px 10px; border-radius:8px; cursor:pointer; font-family:'IBM Plex Mono',monospace; font-size:10px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.03); color:#cfcfe0;", S.exploreOrder === "desc" ? "↓" : "↑") + "</div></div>";
    return '<div style="position:relative; z-index:10; width:100%; display:flex; justify-content:center; padding:18px clamp(14px,3vw,32px) 60px;"><div style="width:100%; max-width:620px; display:flex; flex-direction:column; gap:16px;">' +
      banner() +
      '<div style="display:flex; gap:10px;">' + statCard("TOTAL TVL", pairs.length ? fmtUsd(tvlSum) : "—") + statCard("PAIRS LIVE", "" + pairs.length) + statCard("TOP APR", top != null ? top.toFixed(1) + "%" : "—", true) + "</div>" +
      '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px,1fr)); gap:14px;">' +
      btn("goCreate", null, "text-align:left; cursor:pointer; border-radius:22px; padding:22px; background:linear-gradient(150deg, rgba(47,230,192,0.10), rgba(160,107,255,0.10)); border:1px solid rgba(255,255,255,0.1); display:flex; flex-direction:column; gap:12px;", '<span style="width:46px; height:46px; border-radius:13px; background:rgba(47,230,192,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">✦</span><span style="font-size:19px; font-weight:700; color:#f4f4fb;">Launch a pair</span><span style="font-size:13px; line-height:1.45; color:#9494ad;">spin up the receipt mint + three AMMs, set your token metadata, seed it. ~30 seconds.</span>') +
      btn("goProvideNew", null, "text-align:left; cursor:pointer; border-radius:22px; padding:22px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:12px;", '<span style="width:46px; height:46px; border-radius:13px; background:rgba(160,107,255,0.15); display:flex; align-items:center; justify-content:center; font-size:22px;">◆</span><span style="font-size:19px; font-weight:700; color:#f4f4fb;">Provide liquidity</span><span style="font-size:13px; line-height:1.45; color:#9494ad;">deposit USDC into a live pair, hold the receipt, earn the arbitrage. redeem anytime.</span>') + "</div>" +
      playbookCard(null, true) +
      '<div style="border-radius:20px; padding:16px 18px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06);"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:8px;">markets · on-chain</div>' + exploreBar + '<div style="display:flex; flex-direction:column; gap:4px;">' + (!loaded ? '<div style="color:#54546a;font-size:13px;padding:8px;">loading…</div>' : (pairRows || emptyPairs)) + "</div></div>" + siteFoot() + "</div></div>";
  }

  function inp(act, value, ph, style, attrs) { return '<input data-act="' + act + '" value="' + esc(value) + '" placeholder="' + esc(ph || "") + '"' + (attrs || "") + ' style="' + style + '"/>'; }
  var PRESETS = {
    A: [["SOL", "So11111111111111111111111111111111111111112"], ["BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"], ["JUP", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"]],
    B: [["USDC", USDC_MINT], ["MEME", "CNBuoZWcqAvVZJCrPFF1XQXeeXJsZKj7SUKZoE6Vpump"]],
  };
  function underField(side, ca, info, ist, label, ph) {
    var mono = "font-size:10.5px;margin-top:5px;font-family:'IBM Plex Mono',monospace;";
    var chip = "";
    if (ca && MINTRE.test(ca)) {
      if (!info || info.loading) chip = '<div style="' + mono + "color:#7e7e97;\">resolving…</div>";
      else if (info.error || !(info.hasPriceAnchor || info.hasUsdcPool)) chip = '<div style="' + mono + "color:#ff5470;\">" + (info.error ? "token not found" : "no price pool found (tried Raydium + PumpSwap)") + "</div>";
      else chip = '<div style="display:flex; align-items:center; gap:7px; margin-top:5px;">' + (info.logo ? tokenLogoIcon(info.logo, 18) : "") + '<div style="' + mono + "color:#2fe6c0;\">" + esc(info.symbol) + " · " + fmtPrice(info.priceUsd) + (info.isQuote ? " · quote ✓" : " · anchor ✓") + "</div></div>";
    } else if (ca) chip = '<div style="' + mono + "color:#54546a;\">not a valid mint</div>";
    var chips = PRESETS[side].map(function (p) {
      var on = ca === p[1];
      return btn("setSide" + side, p[1], "padding:4px 9px; border-radius:8px; cursor:pointer; font-family:'IBM Plex Mono',monospace; font-size:10px; border:1px solid " + (on ? "#a06bff" : "rgba(255,255,255,0.1)") + "; background:" + (on ? "rgba(160,107,255,0.14)" : "rgba(255,255,255,0.02)") + "; color:" + (on ? "#cdbcff" : "#9494ad") + ";", esc(p[0]));
    }).join("");
    return '<div style="flex:1; min-width:0;"><div style="font-size:12px; color:#9494ad; margin-bottom:6px;">' + label + "</div>" + inp("onSide" + side, ca, ph, ist) + '<div style="display:flex; gap:5px; margin-top:6px; flex-wrap:wrap;">' + chips + "</div>" + chip + "</div>";
  }
  function createView(th, sym, factName, quote) {
    var title = S.cStep === 1 ? "Define your pair" : "Seed & deploy";
    var h = '<div style="position:relative; z-index:10; width:100%; display:flex; justify-content:center; padding:18px clamp(14px,3vw,32px) 60px;"><div style="width:100%; max-width:560px; display:flex; flex-direction:column; gap:16px;">' + (S.connected ? '<div style="max-width:560px;">' + banner() + "</div>" : "") + '<div style="display:flex; align-items:center; gap:10px;"><div style="font-size:22px; font-weight:700; color:#f4f4fb;">' + title + '</div><div style="flex:1;"></div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#7e7e97;">step ' + S.cStep + " / 2</div></div>";
    var ist = "width:100%; padding:13px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.25); color:#f4f4fb; font-size:15px; outline:none;";
    if (S.cStep === 1) {
      var uLogo = S.sideAInfo && S.sideAInfo.logo;
      var qLogo = (S.sideBInfo && S.sideBInfo.logo) || (S.sideB === USDC_MINT ? USDC_LOGO : null);
      var lev = synthLev(S.recSym, S.levMax), u = (S.sideAInfo && S.sideAInfo.symbol) || "asset";
      var tokens = [
        { sym: sym, name: S.recName || "Triad Receipt", badge: "RECEIPT", bFg: "#07070b", bBg: "#2fe6c0", bg: "linear-gradient(120deg, " + th.a + ", " + th.b + ")", glyph: S.emoji || "✦", logo: uLogo, api: "creator-set" },
        { sym: ("+" + lev + "x" + u).slice(0, 10), name: "+" + lev + "x " + u + " · long", badge: "LONG", bFg: "#0c0c16", bBg: th.a, bg: th.a, glyph: "+", logo: uLogo, api: "/api/meta" },
        { sym: ("-" + lev + "x" + u).slice(0, 10), name: "-" + lev + "x " + u + " · inverse", badge: "INV", bFg: "#0c0c16", bBg: th.b, bg: th.b, glyph: "−", logo: qLogo, api: "/api/meta" },
      ].map(function (tk) {
        return '<div style="display:flex; align-items:center; gap:13px; padding:13px 14px; border-radius:14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07);">' + tokenAvatar(tk, 42) + '<div style="flex:1; min-width:0;"><div style="display:flex; align-items:center; gap:8px;"><span style="font-size:15px; font-weight:600; color:#f4f4fb;">' + esc(tk.sym) + '</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:9px; padding:2px 6px; border-radius:5px; color:' + tk.bFg + "; background:" + tk.bBg + ';">' + tk.badge + '</span></div><div style="font-size:12px; color:#9494ad; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(tk.name) + '</div></div><span style="flex:none; font-family:\'IBM Plex Mono\',monospace; font-size:9.5px; color:#54546a;">' + tk.api + "</span></div>";
      }).join("");
      var themeBtns = THEMES.map(function (t, i) { return btn("setTheme", i, "flex:1; height:38px; border-radius:11px; cursor:pointer; border:2px solid " + (S.themeIdx === i ? "#f4f4fb" : "rgba(255,255,255,0.12)") + "; background:linear-gradient(120deg, " + t.a + ", " + t.b + ");", ""); }).join("");
      h += '<div style="display:flex; flex-direction:column; gap:14px;"><div style="border-radius:20px; padding:18px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:14px;"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase;">the facts · you set the metadata</div>' +
        '<div><div style="font-size:12px; color:#9494ad; margin-bottom:6px;">name your play (the headline)</div>' + inp("onFact", S.fact, "e.g. 3x SOL", ist) + "</div>" +
        '<div style="display:flex; gap:10px;">' + underField("A", S.sideA, S.sideAInfo, ist, "leverage this token · CA", "paste a mint, or tap below") + underField("B", S.sideB, S.sideBInfo, ist, "against · quote", "USDC") + "</div>" +
        '<div style="font-size:11px; color:#54546a; line-height:1.45; margin-top:-4px;">paste side A’s mint — we auto-resolve its price from <span style="color:#9494ad;">Raydium</span> then <span style="color:#9494ad;">PumpSwap</span>. You’ll see anchor ✓ when a pool is found. side B is the quote (USDC).</div>' +
        '<div style="display:flex; gap:10px;"><div style="flex:1;"><div style="font-size:12px; color:#9494ad; margin-bottom:6px;">receipt symbol</div>' + inp("onRecSym", S.recSym, "TRI", ist + " text-transform:uppercase;", ' maxlength="7"') + '</div><div style="flex:none; width:84px;"><div style="font-size:12px; color:#9494ad; margin-bottom:6px;">icon</div>' + inp("onEmoji", S.emoji, "", "width:100%; padding:13px 0; border-radius:12px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.25); color:#f4f4fb; font-size:18px; outline:none; text-align:center;", ' maxlength="2"') + "</div></div>" +
        '<div><div style="font-size:12px; color:#9494ad; margin-bottom:6px;">receipt name</div>' + inp("onRecName", S.recName, "My Triad Receipt", ist) + "</div>" +
        '<div><div style="font-size:12px; color:#9494ad; margin-bottom:8px;">colorway</div><div style="display:flex; gap:10px;">' + themeBtns + "</div></div></div>" +
        '<div style="border-radius:20px; padding:18px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06);"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:12px;">3 tokens · metadata served live via /api/meta</div><div style="display:flex; flex-direction:column; gap:10px;">' + tokens + '</div><div style="font-size:11px; color:#54546a; margin-top:12px; line-height:1.45;">+/− legs are named from leverage × underlying (e.g. +5x SOL / −5x SOL). You only name the receipt.</div></div>' +
        btn("toStep2", null, "width:100%; padding:16px; border:none; border-radius:14px; font-size:15.5px; font-weight:600; color:#07070b; background:linear-gradient(100deg,#2fe6c0,#a06bff); cursor:pointer;", "Next · seed &amp; deploy") + "</div>";
    } else {
      var half = S.seed / 2, dep = deployed(), launchIcon = underlyingIcon(40);
      var launchHead = '<div style="display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:16px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); margin-bottom:4px;">' + launchIcon + '<div style="flex:1; min-width:0;"><div style="font-size:16px; font-weight:700; color:#f4f4fb;">' + esc(sym) + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#7e7e97; margin-top:2px;">' + (S.sideAInfo && S.sideAInfo.symbol ? esc(S.sideAInfo.symbol) + " · " : "") + esc(S.recName || factName) + "</div></div></div>";
      var levL = synthLev(S.recSym, S.levMax), uL = (S.sideAInfo && S.sideAInfo.symbol) || "asset";
      var plusLeg = "+" + levL + "x" + uL, minusLeg = "−" + levL + "x" + uL;
      var amms = [
        { n: "1", pair: plusLeg + " / " + minusLeg, role: "primary leverage engine", bg: "rgba(47,230,192,0.14)", fg: "#2fe6c0", seed: fmtUsd(S.seed) },
        { n: "2", pair: plusLeg + " / " + quote, role: "USD anchor + TWAP", bg: "rgba(242,193,78,0.14)", fg: "#f2c14e", seed: fmtUsd(half) },
        { n: "3", pair: minusLeg + " / " + quote, role: "USD anchor + TWAP", bg: "rgba(160,107,255,0.14)", fg: "#a06bff", seed: fmtUsd(half) },
        { n: "4", pair: plusLeg + " / MEME", role: "MEME demand", bg: "rgba(255,84,112,0.14)", fg: "#ff5470", seed: fmtN(S.memeAmt) + " MEME" },
        { n: "5", pair: minusLeg + " / MEME", role: "MEME demand", bg: "rgba(122,217,255,0.14)", fg: "#7ad9ff", seed: fmtN(S.memeAmt) + " MEME" },
      ].map(function (m) { return '<div style="display:flex; align-items:center; gap:12px; padding:12px 14px; border-radius:13px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07);"><span style="flex:none; width:24px; height:24px; border-radius:7px; background:' + m.bg + "; color:" + m.fg + '; font-family:\'IBM Plex Mono\',monospace; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center;">' + m.n + '</span><div style="flex:1;"><div style="font-size:13.5px; color:#eaeaf2; font-weight:500;">' + m.pair + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#7e7e97; margin-top:2px;">' + m.role + '</div></div><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#9494ad;">' + m.seed + "</span></div>"; }).join("");
      var solNeed = launchSolNeed(), solShort = launchSolShort(), solOk = S.sol != null && !solShort;
      var solCardBorder = solShort ? "rgba(255,84,112,0.45)" : (solOk ? "rgba(47,230,192,0.35)" : "rgba(242,193,78,0.28)");
      var solCardBg = solShort ? "rgba(255,84,112,0.07)" : "rgba(242,193,78,0.06)";
      var solBalLine = S.sol != null
        ? (solShort ? '<span style="color:#ff5470;">short ~' + solShort.toFixed(2) + " SOL</span> · you have ~" + S.sol.toFixed(2) : '<span style="color:#2fe6c0;">balance ok</span> · you have ~' + S.sol.toFixed(2))
        : (S.pubkey ? "loading wallet balance…" : "connect wallet to check balance");
      var solCard = '<div style="border-radius:20px; padding:18px; background:' + solCardBg + "; border:1px solid " + solCardBorder + ';"><div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase;">SOL for pool fees + rent</span><span style="font-variant-numeric:tabular-nums;"><span style="font-size:24px; font-weight:700; color:#f2c14e;">~' + solNeed.sol + '</span><span style="font-size:14px; color:#7e7e97;"> SOL</span></span></div><div style="font-size:12px; color:#7e7e97; line-height:1.5;">' + esc(solNeed.desc) + " · pool fees " + solNeed.poolFeesSol + " SOL<br/>" + solBalLine + "</div></div>";
      var launchBlocked = !dep || !!launchSolGuardMsg() || S.busy;
      var ctaLabel = !dep ? "Deploy disabled · program not live" : (S.busy === "launch" ? "launching…" : (solShort ? "Add ~" + solShort.toFixed(2) + " SOL to deploy" : (S.sol == null && S.pubkey ? "loading SOL balance…" : "Deploy " + esc(sym) + " + 5 AMMs")));
      var cta = launchBlocked
        ? btn(solShort && dep ? "solGuard" : "gatedAction", null, "flex:1; padding:16px; border:1px solid rgba(255,255,255,0.1); border-radius:14px; font-size:15.5px; font-weight:600; color:#54546a; background:rgba(255,255,255,0.06); cursor:not-allowed;", ctaLabel)
        : btn("doLaunch", null, "flex:1; padding:16px; border:none; border-radius:14px; font-size:15.5px; font-weight:600; color:#07070b; background:linear-gradient(100deg,#2fe6c0,#a06bff); cursor:pointer;", ctaLabel);
      h += '<div style="display:flex; flex-direction:column; gap:14px;">' + launchHead + '<div style="border-radius:20px; padding:18px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.08);"><div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase;">seed liquidity</span><span style="font-variant-numeric:tabular-nums;"><span style="font-size:24px; font-weight:700; color:#f4f4fb;">$' + Math.min(S.seed, S.usdc != null ? Math.floor(S.usdc) : S.seed).toLocaleString() + '</span></span></div><input data-act="onSeed" type="range" min="0" max="' + (S.usdc != null ? Math.max(1, Math.floor(S.usdc)) : 50000) + '" step="' + (S.usdc != null && S.usdc < 100 ? "0.5" : "10") + '" value="' + Math.min(S.seed, S.usdc != null ? Math.floor(S.usdc) : S.seed) + '" style="width:100%; accent-color:#a06bff; margin-bottom:8px;"/><div style="font-size:12px; color:#7e7e97;">split 50/50 to seed the 2 USDC pools' + (S.usdc != null ? " · your balance: $" + fmtN(S.usdc) : "") + "</div></div>" +
        solCard +
        '<div style="border-radius:20px; padding:18px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.08);"><div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase;">max leverage band</span><span style="font-variant-numeric:tabular-nums;"><span style="font-size:24px; font-weight:700; color:#2fe6c0;">' + S.levMax + '</span><span style="font-size:15px; color:#7e7e97;">×</span></span></div><input data-act="onLevMax" type="range" min="2" max="10" step="1" value="' + S.levMax + '" style="width:100%; accent-color:#2fe6c0;"/></div>' +
        '<div style="border-radius:20px; padding:18px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,84,112,0.18);"><div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase;">MEME per pool</span><span style="font-variant-numeric:tabular-nums;">' + (function () { var mx = S.memeBal != null ? Math.floor(S.memeBal / 2) : 5000000; var v = Math.min(S.memeAmt, mx); return '<span style="font-size:24px; font-weight:700; color:#ff5470;">' + fmtN(v) + '</span><span style="font-size:14px; color:#7e7e97;"> MEME</span></span></div><input data-act="onMemeAmt" type="range" min="0" max="' + Math.max(1, mx) + '" step="' + Math.max(1, Math.round(mx / 200)) + '" value="' + v + '" style="width:100%; accent-color:#ff5470; margin-bottom:8px;"/><div style="font-size:12px; color:#7e7e97;">seeds BOTH MEME pools (' + fmtN(v) + " each = " + fmtN(v * 2) + " total)" + (S.memeBal != null ? " · your MEME: " + fmtN(S.memeBal) : "") + " · set to 0 to skip MEME pools (~" + (typeof window.MIMLaunchSolNeed === "function" ? window.MIMLaunchSolNeed(false).sol : "0.68") + " SOL instead)</div></div>"; })() +
        '<div style="border-radius:16px; padding:15px 16px; background:rgba(242,193,78,0.06); border:1px solid rgba(242,193,78,0.22); display:flex; flex-direction:column; gap:10px;"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10px; color:#f2c14e; letter-spacing:0.12em;">YOU PROVIDE FROM YOUR WALLET</div>' +
        [["USDC seed", "$" + S.seed.toLocaleString(), "split across the 2 USDC pools"], ["MEME", fmtN(S.memeAmt * 2) + " MEME", fmtN(S.memeAmt) + " into each MEME pool"], ["SOL", "~" + solNeed.sol + " SOL", solNeed.desc]].map(function (r) { return '<div style="display:flex; align-items:baseline; gap:8px;"><span style="font-size:13px; color:#eaeaf2; min-width:74px;">' + r[0] + '</span><span style="flex:1; height:1px; background:rgba(255,255,255,0.07);"></span><span style="text-align:right;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:13px; color:#f4f4fb;">' + r[1] + '</span><span style="display:block; font-size:10px; color:#7e7e97;">' + r[2] + "</span></span></div>"; }).join("") + "</div>" +
        '<div style="border-radius:20px; padding:18px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06);"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:12px;">5 AMMs · triangle atomic + 2 MEME pools</div><div style="display:flex; flex-direction:column; gap:8px;">' + amms + "</div></div>" +
        '<div style="display:flex; gap:10px;">' + btn("toStep1", null, "flex:none; width:54px; padding:16px 0; border:1px solid rgba(255,255,255,0.1); border-radius:14px; background:rgba(255,255,255,0.03); color:#cfcfe0; font-size:15px; cursor:pointer;", "&larr;") + cta + '</div><div style="text-align:center; font-size:10.5px; color:#54546a;">5 AMMs total · the 3 USDC pools fire atomically (all-or-nothing introspection) + 2 MEME pools · receipt mint + metadata</div></div>';
    }
    return h + siteFoot() + "</div></div>";
  }

  function provideView(th, sym, quote) {
    var pk = pairKey(S.activePair);
    var apyObj = DATA.apy[pk] || {};
    var apyVal = apyObj.total;
    var nav = navOf(pk);
    var navRate = nav != null ? "$" + nav.toFixed(3) : "—";
    var pairTitle = (S.activePair && S.activePair.name) || sym;
    var h = '<div style="position:relative; z-index:10; width:100%; display:flex; justify-content:center; padding:18px clamp(14px,3vw,32px) 60px;"><div style="width:100%; max-width:480px; display:flex; flex-direction:column; gap:14px;">' + banner();
    var shareCopied = S.copied === "__share__";
    var symLbl = pairSymLabel(S.activePair) || sym;
    h += '<div style="display:flex; align-items:center; gap:13px; padding:4px 2px;">' + pairIcon(S.activePair, 36) + '<div style="flex:1; min-width:0;"><div style="font-size:17px; font-weight:700; color:#f4f4fb; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(pairTitle) + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#7e7e97;">' + esc(symLbl) + " receipt" + (S.activePair && S.activePair.underlyingSymbol && !S.activePair.symCollides ? " · " + esc(S.activePair.underlyingSymbol) : "") + " · " + navRate + '</div></div><div style="flex:none; display:flex; align-items:center; gap:8px;"><div style="text-align:right;"><div style="font-size:15px; font-weight:700; color:#2fe6c0;">' + (apyVal != null ? apyVal.toFixed(1) + "%" : "—") + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:9.5px; color:#7e7e97;">EST APY · USD-eq</div></div>' + btn("copyShareLink", null, "flex:none; padding:7px 10px; border-radius:10px; border:1px solid " + (shareCopied ? "rgba(47,230,192,0.45)" : "rgba(255,255,255,0.1)") + "; background:" + (shareCopied ? "rgba(47,230,192,0.08)" : "rgba(255,255,255,0.03)") + "; color:" + (shareCopied ? "#2fe6c0" : "#cfcfe0") + "; font-family:'IBM Plex Mono',monospace; font-size:10px; cursor:pointer; white-space:nowrap;", shareCopied ? "copied ✓" : "share ↗") + "</div></div>";
    function tabBg(on, g) { return on ? "linear-gradient(100deg," + g + ")" : "transparent"; }
    h += playbookCard(pk, false);
    h += '<div style="display:flex; gap:6px; padding:5px; border-radius:14px; background:rgba(0,0,0,0.25);">' + btn("setTrade", null, "flex:1; padding:10px 0; border:none; border-radius:10px; font-size:13.5px; font-weight:600; cursor:pointer; color:" + (S.pTab === "trade" ? "#07070b" : "#9494ad") + "; background:" + tabBg(S.pTab === "trade", "#2fe6c0,#7ad9ff") + ";", "Provide") + btn("setCharts", null, "flex:1; padding:10px 0; border:none; border-radius:10px; font-size:13.5px; font-weight:600; cursor:pointer; color:" + (S.pTab === "charts" ? "#07070b" : "#9494ad") + "; background:" + tabBg(S.pTab === "charts", "#7ad9ff,#a06bff") + ";", "Charts") + "</div>";
    if (S.pTab === "trade") h += tradeCard(th, sym, quote, nav);
    else h += chartsView(th, sym, quote, apyObj);
    h += contractsCard(pk);
    return h + siteFoot() + "</div></div>";
  }

  function tradeCard(th, sym, quote, nav) {
    var isDep = S.mode === "deposit", dep = deployed();
    var usdc = S.usdc, hasNav = nav != null;
    var depAmt = usdc != null ? Math.min(S.depAmt, usdc) : S.depAmt;
    var payAmount = isDep ? Math.round(depAmt).toLocaleString() : (S.wdPct + "%");
    var recvAmount = isDep ? (hasNav ? fmtN(depAmt / nav) : "—") : (hasNav ? "—" : "—");
    var canDo = dep;
    var payIcon = isDep ? usdcIcon(22) : underlyingIcon(22);
    var recvIcon = isDep ? underlyingIcon(22) : usdcIcon(22);
    var payLabel = isDep ? quote : sym;
    var recvLabel = isDep ? sym : quote;
    var maxDep = usdc != null ? Math.max(0, Math.floor(usdc)) : 0;
    var chips = (isDep ? [["$500", 500], ["$2.5K", 2500], ["$10K", 10000], ["MAX", maxDep]] : [["25%", 25], ["50%", 50], ["75%", 75], ["100%", 100]]).map(function (c) {
      var on = (isDep ? S.depAmt : S.wdPct) === c[1];
      return btn(isDep ? "setDepAmt" : "setWdPct", c[1], "flex:1; padding:7px 0; border-radius:9px; border:1px solid " + (on ? "#a06bff" : "rgba(255,255,255,0.1)") + "; background:" + (on ? "rgba(160,107,255,0.14)" : "rgba(255,255,255,0.02)") + "; color:" + (on ? "#cdbcff" : "#9494ad") + "; font-family:'IBM Plex Mono',monospace; font-size:11.5px; font-weight:500; cursor:pointer;", c[0]);
    }).join("");
    var tabBtn = function (act, on, g, lbl) { return btn(act, null, "flex:1; padding:11px 0; border:none; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; color:" + (on ? "#07070b" : "#9494ad") + "; background:" + (on ? "linear-gradient(100deg," + g + ")" : "transparent") + ";", lbl); };
    var balLabel = isDep ? (usdc != null ? fmtN(usdc) + " " + quote : (S.balErr ? "balance error" : "loading…")) : (S.receiptUi != null ? fmtN(S.receiptUi) + " " + sym : "loading…");
    var h = '<div style="border-radius:24px; padding:18px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.08);"><div style="display:flex; gap:6px; padding:5px; border-radius:14px; background:rgba(0,0,0,0.25); margin-bottom:18px;">' + tabBtn("setDeposit", isDep, "#2fe6c0,#7ad9ff", "Deposit") + tabBtn("setWithdraw", !isDep, "#7ad9ff,#a06bff", "Withdraw") + "</div>" +
      '<div style="border-radius:16px; padding:15px 16px; background:rgba(0,0,0,0.22); border:1px solid rgba(255,255,255,0.06);"><div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;"><span style="font-size:12px; color:#9494ad;">' + (isDep ? "you deposit" : "you withdraw") + '</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#7e7e97;">balance ' + balLabel + '</span></div><div style="display:flex; align-items:center; justify-content:space-between; gap:12px;"><span style="font-size:30px; font-weight:700; color:#f4f4fb; font-variant-numeric:tabular-nums; white-space:nowrap;">' + payAmount + '</span>' + tokenPill(payIcon, payLabel) + '</div><input data-act="onPay" type="range" min="0" max="' + (isDep ? Math.max(1, maxDep) : 100) + '" step="1" value="' + (isDep ? S.depAmt : S.wdPct) + '" style="width:100%; accent-color:#a06bff; margin-top:12px;"/><div style="display:flex; gap:7px; margin-top:8px;">' + chips + "</div></div>" +
      '<div style="display:flex; justify-content:center; margin:-9px 0; position:relative; z-index:2;"><div style="width:34px; height:34px; border-radius:11px; background:#14141e; border:1px solid rgba(255,255,255,0.1); display:flex; align-items:center; justify-content:center; color:#9494ad; font-size:16px;">↓</div></div>' +
      '<div style="border-radius:16px; padding:15px 16px; background:rgba(0,0,0,0.22); border:1px solid rgba(255,255,255,0.06);"><div style="font-size:12px; color:#9494ad; margin-bottom:8px;">you receive</div><div style="display:flex; align-items:center; justify-content:space-between; gap:12px;"><span style="font-size:30px; font-weight:700; color:#2fe6c0; font-variant-numeric:tabular-nums; white-space:nowrap;">' + recvAmount + '</span>' + tokenPill(recvIcon, recvLabel) + "</div></div>" +
      '<div style="display:flex; justify-content:space-between; padding:13px 4px 4px; font-family:\'IBM Plex Mono\',monospace; font-size:11.5px; color:#7e7e97;"><span>1 ' + esc(sym) + " = " + (nav != null ? "$" + nav.toFixed(3) : "—") + "</span><span>" + (isDep ? "fee 0.00%" : "redeem to " + quote) + "</span></div>" +
      btn(canDo ? (isDep ? "doDeposit" : "doWithdraw") : "gatedAction", null, "width:100%; margin-top:8px; padding:16px; border:" + (canDo ? "none" : "1px solid rgba(255,255,255,0.1)") + "; border-radius:14px; font-size:15.5px; font-weight:600; color:" + (canDo ? "#07070b" : "#54546a") + "; background:" + (canDo ? "linear-gradient(100deg,#2fe6c0,#a06bff)" : "rgba(255,255,255,0.06)") + "; cursor:" + (canDo ? "pointer" : "not-allowed") + "; opacity:" + (S.busy ? "0.6" : "1") + ";", S.busy ? "submitting…" : (canDo ? (isDep ? "Deposit " + quote : "Withdraw to " + quote) : "Not live yet · program not deployed")) +
      '<div style="margin-top:10px; padding:10px 12px; border-radius:10px; background:rgba(242,193,78,0.06); border:1px solid rgba(242,193,78,0.18); font-size:11px; color:#9494ad; line-height:1.45;"><span style="color:#f2c14e; font-family:\'IBM Plex Mono\',monospace; font-size:10px;">rebalancing</span> · deposit/withdraw only mints/burns receipt (not a transfer). send receipt to another wallet to fire the hook + crank.</div></div>' +
      fluxbeamCard(sym, nav);
    return h;
  }

  function fluxbeamCard(sym, nav) {
    var qBal = fluxQuoteBal();
    var qMax = qBal != null ? (S.fluxQuote === "SOL" ? Math.max(0.01, qBal - 0.05) : Math.max(1, Math.floor(qBal))) : 1;
    var amt = Math.min(S.fluxAmt, qMax);
    var recEst = nav && S.fluxQuote === "USDC" ? (amt / nav) : null;
    var recLbl = recEst != null ? fmtN(recEst) + " " + sym : (S.receiptUi != null ? "≈ " + fmtN(amt / nav) + " " + sym : "—");
    var qIcon = S.fluxQuote === "SOL" ? glyphIcon("◎", "linear-gradient(135deg,#9945ff,#14f195)", 22) : usdcIcon(22);
    var tabQ = function (lbl, on) {
      return btn("setFluxQuote", lbl, "flex:1; padding:8px 0; border-radius:9px; border:1px solid " + (on ? "#7ad9ff" : "rgba(255,255,255,0.1)") + "; background:" + (on ? "rgba(122,217,255,0.14)" : "rgba(255,255,255,0.02)") + "; color:" + (on ? "#7ad9ff" : "#9494ad") + "; font-size:12.5px; font-weight:600; cursor:pointer;", lbl);
    };
    var chips = [["25%", 0.25], ["50%", 0.5], ["MAX", 1]].map(function (c) {
      var v = c[1] === 1 ? qMax : +(qMax * c[1]).toFixed(S.fluxQuote === "SOL" ? 3 : 0);
      var on = Math.abs(amt - v) < (S.fluxQuote === "SOL" ? 0.001 : 0.5);
      return btn("setFluxAmt", v, "flex:1; padding:6px 0; border-radius:8px; border:1px solid " + (on ? "#7ad9ff" : "rgba(255,255,255,0.1)") + "; background:" + (on ? "rgba(122,217,255,0.12)" : "transparent") + "; color:" + (on ? "#7ad9ff" : "#9494ad") + "; font-family:'IBM Plex Mono',monospace; font-size:10.5px; cursor:pointer;", c[0]);
    }).join("");
    var body = S.fluxOpen
      ? '<div style="padding:14px 16px 16px; display:flex; flex-direction:column; gap:12px;">' +
        '<div style="font-size:12px; color:#7e7e97; line-height:1.45;">Seed a FluxBeam pool: LUT setup + one atomic create (setup + hook transfer + fund).</div>' +
        '<div style="display:flex; gap:6px;">' + tabQ("USDC", S.fluxQuote === "USDC") + tabQ("SOL", S.fluxQuote === "SOL") + "</div>" +
        '<div style="border-radius:14px; padding:12px 14px; background:rgba(0,0,0,0.22); border:1px solid rgba(255,255,255,0.06);"><div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="font-size:11.5px; color:#9494ad;">quote side</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#7e7e97;">' + (qBal != null ? fmtN(qBal) + " " + S.fluxQuote : "…") + '</span></div><div style="display:flex; align-items:center; justify-content:space-between; gap:10px;"><span style="font-size:26px; font-weight:700; color:#f4f4fb;">' + (S.fluxQuote === "SOL" ? amt.toFixed(3) : Math.round(amt).toLocaleString()) + '</span>' + tokenPill(qIcon, S.fluxQuote) + '</div><input data-act="onFluxAmt" type="range" min="' + (S.fluxQuote === "SOL" ? "0.01" : "1") + '" max="' + qMax + '" step="' + (S.fluxQuote === "SOL" ? "0.01" : "1") + '" value="' + amt + '" style="width:100%; accent-color:#7ad9ff; margin-top:10px;"/><div style="display:flex; gap:6px; margin-top:6px;">' + chips + "</div></div>" +
        '<div style="display:flex; justify-content:space-between; font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#7e7e97;"><span>receipt deposit ≈ ' + recLbl + "</span><span>nav $" + (nav != null ? nav.toFixed(3) : "—") + "</span></div>" +
        btn(S.pubkey && amt > 0 ? "doFluxbeamPool" : "gatedAction", null, "width:100%; padding:13px; border:none; border-radius:12px; font-size:14px; font-weight:600; color:#07070b; background:linear-gradient(100deg,#7ad9ff,#a06bff); cursor:" + (S.busy ? "wait" : "pointer") + "; opacity:" + (S.busy ? "0.6" : "1") + ";", S.busy === "flux" ? "creating pool…" : "Create FluxBeam pool") +
        "</div>"
      : "";
    return '<div style="border-radius:18px; background:rgba(255,255,255,0.02); border:1px solid rgba(122,217,255,0.15); overflow:hidden; margin-top:4px;">' +
      btn("toggleFlux", null, "width:100%; display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border:none; background:none; cursor:pointer;",
        '<span style="display:flex; align-items:center; gap:8px;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#7ad9ff; letter-spacing:0.08em;">FLUXBEAM POOL</span><span style="font-size:10px; color:#54546a;">optional</span></span><span style="color:#7e7e97; font-size:12px; transform:rotate(' + (S.fluxOpen ? "180deg" : "0deg") + '); display:inline-block;">▾</span>') +
      body + "</div>";
  }

  function chartsView(th, sym, quote, apyObj) {
    var c = chart();
    var apyVal = apyObj.total;
    var apyHead = apyVal != null ? apyVal.toFixed(1) + "%" : "—";
    var h = '<div style="display:flex; flex-direction:column; gap:14px;"><div style="border-radius:18px; padding:16px; background:linear-gradient(150deg, rgba(47,230,192,0.07), rgba(160,107,255,0.05)); border:1px solid rgba(255,255,255,0.08);"><div style="display:flex; align-items:flex-end; justify-content:space-between; gap:10px; flex-wrap:wrap;"><div><div style="font-size:30px; font-weight:700; color:#2fe6c0; line-height:1; font-variant-numeric:tabular-nums;">' + apyHead + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:9.5px; color:#7e7e97; margin-top:6px; letter-spacing:0.06em;">EST APY · USD-EQUIV · QUOTE ' + quote + '</div></div></div><div style="font-size:10.5px; color:#54546a; margin-top:10px; line-height:1.4;">' + (apyVal != null ? "observed from on-chain nav growth — not an assumed rate." : "APY appears once the indexer has ≥2 on-chain observations of this pair.") + "</div></div>";
    if (!c) return h + '<div style="border-radius:20px; padding:28px 16px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.07); text-align:center;"><div style="font-size:13px; color:#9494ad;">No price history yet.</div><div style="font-size:11.5px; color:#54546a; margin-top:6px; line-height:1.5;">The indexer builds this chart from real pool reserves as it polls. It fills in once the pair has on-chain activity.</div></div></div>';
    var last = c.last, chgCol = c.chgN >= 0 ? "#2fe6c0" : "#ff5470";
    var tfChips = ["1H", "1D", "1W", "1M", "ALL"].map(function (t) { var on = S.tf === t; return btn("setTf", t, "flex:1; padding:7px 0; border-radius:9px; border:1px solid " + (on ? "#a06bff" : "rgba(255,255,255,0.1)") + "; background:" + (on ? "rgba(160,107,255,0.16)" : "rgba(255,255,255,0.02)") + "; color:" + (on ? "#cdbcff" : "#9494ad") + "; font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:600; cursor:pointer;", t); }).join("");
    h += '<div style="border-radius:20px; padding:16px 16px 12px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.07);"><div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:4px; flex-wrap:wrap;"><div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.1em; text-transform:uppercase;">receipt quote cost</div><div style="font-size:12.5px; color:#7e7e97; margin-top:3px;">' + esc(sym) + " / " + quote + ' · redeemable vs mintable</div></div><div style="text-align:right;"><div style="font-size:22px; font-weight:700; color:#f4f4fb; font-variant-numeric:tabular-nums;">$' + last.nav.toFixed(4) + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:' + chgCol + ';">' + (c.chgN >= 0 ? "+" : "") + c.chgN.toFixed(2) + "% · " + S.tf + '</div></div></div><div style="display:flex; gap:14px; margin:6px 0 4px; font-family:\'IBM Plex Mono\',monospace; font-size:10.5px;"><span style="color:#a06bff;">■ mint (ask) $' + last.mint.toFixed(4) + '</span><span style="color:#2fe6c0;">■ redeem (bid) $' + last.redeem.toFixed(4) + '</span></div>' +
      '<div id="chart-spread" style="position:relative; width:100%; touch-action:none; cursor:crosshair;"><svg width="100%" viewBox="0 0 320 150" preserveAspectRatio="none" style="display:block; height:clamp(150px,30vw,200px);"><defs><linearGradient id="spreadg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(160,107,255,0.18)"/><stop offset="1" stop-color="rgba(47,230,192,0.10)"/></linearGradient></defs><path d="' + c.spreadFill + '" fill="url(#spreadg)"/><polyline points="' + c.redeemLine + '" fill="none" stroke="#2fe6c0" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><polyline points="' + c.mintLine + '" fill="none" stroke="#a06bff" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>' +
      (c.H.hoverOn ? '<line x1="' + c.H.crossX + '" y1="0" x2="' + c.H.crossX + '" y2="150" stroke="rgba(255,255,255,0.35)" stroke-width="1" vector-effect="non-scaling-stroke"/><circle cx="' + c.H.crossX + '" cy="' + c.H.cyMint + '" r="3.4" fill="#a06bff" stroke="#0c0c16" stroke-width="1.5"/><circle cx="' + c.H.crossX + '" cy="' + c.H.cyRedeem + '" r="3.4" fill="#2fe6c0" stroke="#0c0c16" stroke-width="1.5"/>' : "") + "</svg>" +
      (c.H.hoverOn ? '<div style="position:absolute; top:2px; left:' + c.H.hoverPct + '; transform:translateX(-50%); pointer-events:none; background:#14141e; border:1px solid rgba(255,255,255,0.12); border-radius:9px; padding:7px 9px; white-space:nowrap; box-shadow:0 8px 20px rgba(0,0,0,0.5);"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:9px; color:#7e7e97; margin-bottom:3px;">' + c.H.hovLabel + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#a06bff;">mint ' + c.H.hovMint + '</div><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#2fe6c0;">redeem ' + c.H.hovRedeem + "</div></div>" : "") + "</div>" +
      '<div style="display:flex; justify-content:space-between; font-family:\'IBM Plex Mono\',monospace; font-size:9.5px; color:#54546a; margin-top:6px;"><span>' + c.xStart + '</span><span>now</span></div><div style="display:flex; gap:6px; margin-top:10px;">' + tfChips + "</div></div>";
    var levC = synthLev(sym, S.activePair && S.activePair.levMax), uC = (S.activePair && S.activePair.underlyingSymbol) || sym.replace(/^\d+x/i, "") || "asset";
    var plusLbl = "+" + levC + "x " + uC, minusLbl = "−" + levC + "x " + uC;
    h += '<div style="border-radius:20px; padding:16px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.07);"><div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; flex-wrap:wrap; gap:6px;"><div style="font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#9494ad; letter-spacing:0.1em; text-transform:uppercase;">backing · per receipt</div><div style="display:flex; gap:12px; font-family:\'IBM Plex Mono\',monospace; font-size:10.5px;"><span style="color:' + th.a + ';">■ ' + esc(plusLbl) + ' $' + last.va.toFixed(3) + '</span><span style="color:' + th.b + ';">■ ' + esc(minusLbl) + ' $' + last.vb.toFixed(3) + '</span></div></div><svg width="100%" viewBox="0 0 320 130" preserveAspectRatio="none" style="display:block; height:clamp(120px,24vw,160px); margin-top:6px;"><path d="' + c.aArea + '" fill="' + toRgba(th.a, 0.2) + '"/><path d="' + c.bArea + '" fill="' + toRgba(th.b, 0.2) + '"/><polyline points="' + c.vaLine + '" fill="none" stroke="' + th.a + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/><polyline points="' + c.navTopLine + '" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg><div style="font-size:10.5px; color:#54546a; margin-top:8px; line-height:1.4;">the heavier band is the side the crank minted into — “mint the loser” drift, in USD terms.</div></div>';
    return h + "</div>";
  }

  function contractsCard(sym) {
    var rows = (DATA.contracts[sym] || []).map(function (c, i) {
      var isC = S.copied === c.addr, dots = ["linear-gradient(120deg,#2fe6c0,#a06bff)", "#2fe6c0", "#a06bff", "#cfcfe0", "#f2c14e", "#f2c14e", "#ff5470", "#7ad9ff"];
      var sub = c.name && c.name !== c.label ? c.name : (c.tag || "");
      return btn("copyAddr", c.addr, "display:flex; align-items:center; gap:10px; padding:11px 12px; border:1px solid " + (isC ? "rgba(47,230,192,0.45)" : "rgba(255,255,255,0.07)") + "; border-radius:11px; background:" + (isC ? "rgba(47,230,192,0.08)" : "rgba(255,255,255,0.02)") + "; cursor:pointer; text-align:left; width:100%;",
        '<span style="flex:none; width:8px; height:8px; border-radius:50%; background:' + (dots[i] || "#cfcfe0") + ';"></span><span style="flex:1; min-width:0;"><span style="display:block; font-size:11.5px; color:#cfcfe0; font-weight:500;">' + esc(c.label) + '</span><span style="display:block; font-family:\'IBM Plex Mono\',monospace; font-size:10px; color:#54546a; margin-top:1px;">' + esc(sub) + '</span><span style="display:block; font-family:\'IBM Plex Mono\',monospace; font-size:10.5px; color:#7e7e97; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; user-select:all; margin-top:2px;">' + esc(c.addr) + '</span></span><span style="flex:none; font-family:\'IBM Plex Mono\',monospace; font-size:10px; color:' + (isC ? "#2fe6c0" : "#54546a") + ';">' + (isC ? "copied ✓" : "copy") + "</span>");
    }).join("");
    var empty = '<div style="color:#54546a;font-size:11px;padding:10px; line-height:1.5;">addresses appear once the pair is deployed on-chain.</div>';
    return '<div style="border-radius:18px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); overflow:hidden;">' + btn("toggleContracts", null, "width:100%; display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border:none; background:none; cursor:pointer;", '<span style="display:flex; align-items:center; gap:8px;"><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#cfcfe0; letter-spacing:0.08em;">CONTRACTS &amp; MINTS</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:9.5px; color:#54546a;">tap to copy</span></span><span style="color:#7e7e97; font-size:12px; transform:rotate(' + (S.contractsOpen ? "180deg" : "0deg") + '); display:inline-block;">▾</span>') +
      (S.contractsOpen ? '<div style="padding:0 12px 12px; display:flex; flex-direction:column; gap:6px;">' + (rows || empty) + '<div style="font-size:10px; color:#54546a; margin-top:4px; padding:0 2px; line-height:1.4;">3 USDC pools on-chain in config · 2 MEME pools discovered via Raydium when seeded at launch. receipt = Token-2022 (hook); legs = SPL.</div></div>' : "") + "</div>";
  }

  function walletModal() {
    var list;
    if (!S.wallets.length) {
      list = '<div style="padding:8px 2px 4px;"><div style="font-size:13px; color:#9494ad; line-height:1.5;">No Solana wallet detected in this browser.</div><div style="display:flex; flex-direction:column; gap:10px; margin-top:14px;">' +
        ['<a href="https://phantom.app/" target="_blank" rel="noopener">Phantom 👻</a>', '<a href="https://solflare.com/" target="_blank" rel="noopener">Solflare 🔆</a>', '<a href="https://backpack.app/" target="_blank" rel="noopener">Backpack 🎒</a>']
          .map(function (a) { return a.replace("<a ", '<a style="display:flex; align-items:center; justify-content:space-between; padding:13px 15px; border:1px solid rgba(255,255,255,0.09); border-radius:13px; background:rgba(255,255,255,0.03); color:#eaeaf2; text-decoration:none; font-size:14px;" '); }).join("") +
        "</div></div>";
    } else {
      list = '<div style="display:flex; flex-direction:column; gap:10px;">' + S.wallets.map(function (w, i) {
        var ico = (typeof w.icon === "string" && w.icon.indexOf("data:") === 0) ? '<img src="' + esc(w.icon) + '" style="width:36px;height:36px;border-radius:10px;" alt=""/>' : '<span style="flex:none; width:36px; height:36px; border-radius:10px; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; font-size:18px;">' + esc(w.icon || "✦") + "</span>";
        return btn("pickWallet", i, "display:flex; align-items:center; gap:13px; padding:14px; border:1px solid rgba(255,255,255,0.09); border-radius:14px; background:rgba(255,255,255,0.03); cursor:pointer; text-align:left; width:100%;", ico + '<span style="flex:1; font-size:14.5px; font-weight:600; color:#eaeaf2;">' + esc(w.name) + '</span><span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:#54546a;">' + (w.kind === "standard" ? "standard" : "detected") + "</span>");
      }).join("") + "</div>";
    }
    return '<div data-act="closeWallet" style="position:fixed; inset:0; z-index:80; background:rgba(5,5,9,0.72); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; padding:18px; animation:mim-fadein .2s ease;"><div data-act="stop" style="width:min(420px,100%); background:#0e0e18; border:1px solid rgba(255,255,255,0.1); border-radius:22px; padding:24px; animation:mim-pop .3s cubic-bezier(.2,.9,.3,1);"><div style="font-size:18px; font-weight:600; color:#f4f4fb; margin-bottom:4px;">Connect a wallet</div><div style="font-size:12.5px; color:#7e7e97; margin-bottom:18px;">pick your poison. mainnet stakes.</div>' + list + "</div></div>";
  }

  // ===== render + events =====
  function render() {
    // Preserve focus + caret across the full-innerHTML re-render. Without this, every
    // keystroke recreates the <input> and focus is lost, so text fields can't be typed in.
    var ae = document.activeElement;
    var fkey = ae && ae.getAttribute ? ae.getAttribute("data-act") : null;
    var selS = null, selE = null;
    if (fkey) { try { selS = ae.selectionStart; selE = ae.selectionEnd; } catch (e) {} }
    document.getElementById("app").innerHTML = view();
    if (fkey) {
      var r = document.querySelector('[data-act="' + fkey + '"]');
      if (r && r.focus) {
        r.focus();
        try { if (selS != null) r.setSelectionRange(selS, selE); } catch (e) {}
      }
    }
    var sp = document.getElementById("chart-spread");
    if (sp) {
      var move = function (clientX, el) { var r = el.getBoundingClientRect(); S.hoverF = Math.max(0, Math.min(1, (clientX - r.left) / r.width)); render(); };
      sp.addEventListener("mousemove", function (e) { move(e.clientX, e.currentTarget); });
      sp.addEventListener("mouseleave", function () { if (S.hoverF != null) { S.hoverF = null; render(); } });
      sp.addEventListener("touchmove", function (e) { if (e.touches && e.touches[0]) move(e.touches[0].clientX, e.currentTarget); });
    }
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]"); if (a) return; // let real links through
    // clicks on form fields must NOT trigger their data-act handler (that re-renders
    // and steals focus); their value is handled by the "input" listener instead.
    var t = e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
    var el = e.target.closest("[data-act]"); if (!el) return;
    var f = A[el.getAttribute("data-act")]; if (f) { f({ currentTarget: el, target: e.target, stopPropagation: function () { e.stopPropagation(); } }); }
  });
  document.addEventListener("input", function (e) { var el = e.target.closest("[data-act]"); if (!el) return; var f = A[el.getAttribute("data-act")]; if (f) f({ currentTarget: el, target: el }); });

  // boot: restore route from URL, then load real data
  var bootRoute = parseLocation();
  applyRoute(bootRoute);
  history.replaceState({ mim: 1 }, "", buildUrl(bootRoute));

  window.addEventListener("popstate", function () {
    var r = parseLocation();
    applyRoute(r);
    if (r.view === "provide" && r.pairId) {
      resolveRoutePair(r, function () { if (S.connected && S.pubkey) A._reloadReceipt(); render(); });
    } else {
      if (r.view === "home") fetchPairs(true);
      if (r.view === "create" && S.pubkey) loadBalances();
      render();
    }
  });

  api("/api/status").then(function (d) { S.status = d; render(); }).catch(function () {});
  A._lookup("B", S.sideB);
  WALLET.detect();
  startPairsPoll();
  resolveRoutePair(bootRoute, function () {
    if (bootRoute.view === "home") fetchPairs(true);
    else render();
  });
  render();
})();
