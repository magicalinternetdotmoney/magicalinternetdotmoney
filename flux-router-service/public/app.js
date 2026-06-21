import {
  listWallets,
  connectWallet,
  disconnectWallet,
  connectedWallet,
  signAndSendBase64Tx,
} from "./wallets.js";

const WSOL = "So11111111111111111111111111111111111111112";
const THOOK_3X = "2P7AibymfoondMnceAQzH7iJuiHjDpSmDP3UiYh1pTvB";

const $ = (id) => document.getElementById(id);
let quoteTimer = null;
let arbTimer = null;
let lastQuoteKey = "";

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function api(path) {
  const r = await fetch(path);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || j.message || r.statusText);
  if (j.ok === false) throw new Error(j.message || j.error || "request failed");
  return j;
}

function renderWalletBar() {
  const bar = $("walletBar");
  const w = connectedWallet();
  if (w) {
    bar.innerHTML = `
      <span class="addr">${w.pubkey.slice(0, 4)}…${w.pubkey.slice(-4)}</span>
      <button type="button" id="disconnectBtn">Disconnect</button>`;
    $("disconnectBtn").onclick = async () => {
      await disconnectWallet();
      renderWalletBar();
    };
    return;
  }
  const opts = listWallets().filter((x) => x.installed);
  if (!opts.length) {
    bar.innerHTML = `<span class="warn">Install Phantom / Solflare / Backpack</span>`;
    return;
  }
  bar.innerHTML = opts.map(
    (w) => `<button type="button" class="wallet-btn" data-id="${w.id}">${w.icon} ${w.name}</button>`,
  ).join("");
  bar.querySelectorAll(".wallet-btn").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await connectWallet(btn.dataset.id);
        renderWalletBar();
        scheduleQuote();
        scheduleArb();
      } catch (e) {
        alert(e.message || e);
      }
    };
  });
}

function formatQuote(route) {
  const hookLeg = route.hops?.some((h) => h.thook);
  const hops = route.hops.map(
    (h) => `  ${h.amountIn} → ${h.amountOut} via ${h.pool.slice(0, 8)}…${h.thook ? " [hook — not swappable on Flux]" : ""}`,
  ).join("\n");
  const warn = hookLeg
    ? "\n\n⚠ Hook receipt leg: Flux swap will fail on-chain. Use magicalinternet.money deposit/withdraw."
    : "";
  return `${route.amountIn} → ${route.amountOut}${route.hub ? ` (via ${route.hub.slice(0, 6)}…)` : ""}\n${hops}${warn}`;
}

async function runQuote() {
  const inputMint = $("inputMint").value.trim();
  const outputMint = $("outputMint").value.trim();
  const amountInUi = $("amountIn").value.trim();
  const key = `${inputMint}|${outputMint}|${amountInUi}`;
  if (!inputMint || !outputMint || !amountInUi || key === lastQuoteKey) return;
  lastQuoteKey = key;
  $("quoteOut").textContent = "quoting…";
  try {
    const route = await api(
      `/api/flux/quote?inputMint=${inputMint}&outputMint=${outputMint}&amountInUi=${encodeURIComponent(amountInUi)}`,
    );
    $("quoteOut").textContent = formatQuote(route);
  } catch (e) {
    $("quoteOut").textContent = String(e.message || e);
  }
}

const scheduleQuote = debounce(runQuote, 400);

async function runArbQuote() {
  const amountInUi = $("arbAmount").value.trim();
  if (!amountInUi) return;
  $("arbProfit").textContent = "…";
  $("arbProfit").className = "profit";
  try {
    const arb = await api(`/api/flux/arb?amountInUi=${encodeURIComponent(amountInUi)}`);
    const sign = arb.profitable ? "+" : "";
    $("arbProfit").textContent = `${sign}${arb.profit} SOL (${arb.profitBps} bps)`;
    $("arbProfit").className = arb.profitable ? "profit good" : "profit";
    $("arbBtn").disabled = false;
  } catch (e) {
    $("arbProfit").textContent = String(e.message || e);
    $("arbBtn").disabled = true;
  }
}

const scheduleArb = debounce(runArbQuote, 400);

async function loadPools() {
  try {
    const snap = await api("/api/flux/pools");
    $("poolCount").textContent = snap.indexing ? "indexing…" : String(snap.count);
    if (snap.indexing && !snap.count) {
      $("pools").textContent = "scanning all FluxBeam pools…";
      setTimeout(loadPools, 5000);
      return;
    }
    const thook = snap.pools.filter((p) => p.thook).slice(0, 12);
    const lines = thook.map(
      (p) => `${p.pool.slice(0, 8)}… ${p.reserveA} / ${p.reserveB}`,
    );
    $("pools").textContent =
      `${snap.count} pools (${snap.thookPools} hook)\n` +
      (lines.length ? lines.join("\n") : "(none yet)") +
      (snap.count > 12 ? `\n…and ${snap.count - 12} more` : "");
    setTimeout(loadPools, 60000);
  } catch (e) {
    $("pools").textContent = String(e.message || e);
    setTimeout(loadPools, 10000);
  }
}

$("swapBtn").addEventListener("click", async () => {
  const w = connectedWallet();
  if (!w) return alert("connect wallet first");
  const inputMint = $("inputMint").value.trim();
  const outputMint = $("outputMint").value.trim();
  const amountInUi = $("amountIn").value.trim();
  $("quoteOut").textContent = "building tx…";
  try {
    const tx = await api(
      `/api/tx/flux/swap?owner=${w.pubkey}&inputMint=${inputMint}&outputMint=${outputMint}&amountInUi=${encodeURIComponent(amountInUi)}&slippageBps=100`,
    );
    const sig = await signAndSendBase64Tx(tx.transaction);
    $("quoteOut").textContent = `sent ${sig}`;
  } catch (e) {
    $("quoteOut").textContent = String(e.message || e);
  }
});

$("arbBtn").addEventListener("click", async () => {
  const w = connectedWallet();
  if (!w) return alert("connect wallet first");
  const amountInUi = $("arbAmount").value.trim();
  $("arbProfit").textContent = "building fresh tx…";
  try {
    const tx = await api(
      `/api/tx/flux/arb?owner=${w.pubkey}&amountInUi=${encodeURIComponent(amountInUi)}&slippageBps=300&_=${Date.now()}`,
    );
    if (tx.route?.hops?.some((h) => /PFire|PFIRE/i.test(h.outputMint + h.inputMint))) {
      throw new Error("stale route includes PFIRE — hard refresh (Cmd+Shift+R) and retry");
    }
    $("arbProfit").textContent = "sign in wallet…";
    const sig = await signAndSendBase64Tx(tx.transaction);
    $("arbProfit").textContent = `done ${sig.slice(0, 8)}…`;
    scheduleArb();
  } catch (e) {
    $("arbProfit").textContent = String(e.message || e);
  }
});

["inputMint", "outputMint", "amountIn"].forEach((id) => {
  $(id).addEventListener("input", () => {
    lastQuoteKey = "";
    scheduleQuote();
  });
});
$("arbAmount").addEventListener("input", scheduleArb);

$("inputMint").value = THOOK_3X;
$("outputMint").value = WSOL;
$("amountIn").value = "1";

renderWalletBar();
loadPools();
scheduleQuote();
scheduleArb();