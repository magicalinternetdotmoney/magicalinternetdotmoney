// Lightweight multi-wallet connector (Phantom, Solflare, Backpack, Jupiter-compatible).
const WALLETS = [
  {
    id: "phantom",
    name: "Phantom",
    icon: "👻",
    get() {
      const p = window.phantom?.solana;
      return p?.isPhantom ? p : null;
    },
  },
  {
    id: "solflare",
    name: "Solflare",
    icon: "🔥",
    get() {
      const s = window.solflare;
      return s?.isSolflare || s?.publicKey ? s : null;
    },
  },
  {
    id: "backpack",
    name: "Backpack",
    icon: "🎒",
    get() {
      const b = window.backpack;
      return b ? b : null;
    },
  },
  {
    id: "jupiter",
    name: "Jupiter",
    icon: "🪐",
    get() {
      const j = window.jupiter?.solana || window.Jupiter?.solana;
      return j || null;
    },
  },
  {
    id: "coinbase",
    name: "Coinbase",
    icon: "🔵",
    get() {
      const c = window.coinbaseSolana;
      return c || null;
    },
  },
];

let active = null;

export function listWallets() {
  return WALLETS.map((w) => {
    const provider = w.get();
    return { id: w.id, name: w.name, icon: w.icon, installed: !!provider };
  });
}

export function connectedWallet() {
  return active;
}

export async function connectWallet(id) {
  const spec = WALLETS.find((w) => w.id === id);
  if (!spec) throw new Error("unknown wallet");
  const provider = spec.get();
  if (!provider) throw new Error(`${spec.name} not installed`);

  if (!provider.publicKey) {
    const resp = await provider.connect?.();
    if (!resp?.publicKey && !provider.publicKey) throw new Error("connect failed");
  }

  active = { id, name: spec.name, provider, pubkey: provider.publicKey.toString() };
  return active;
}

export async function disconnectWallet() {
  try {
    await active?.provider?.disconnect?.();
  } catch { /* ignore */ }
  active = null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signAndSendBase64Tx(b64) {
  if (!active) throw new Error("wallet not connected");
  const { VersionedTransaction } = await import("https://esm.sh/@solana/web3.js@1.98.0");
  const tx = VersionedTransaction.deserialize(b64ToBytes(b64));
  const provider = active.provider;

  if (provider.signAndSendTransaction) {
    const { signature } = await provider.signAndSendTransaction(tx);
    return signature;
  }

  const signed = await provider.signTransaction(tx);
  const { Connection } = await import("https://esm.sh/@solana/web3.js@1.98.0");
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const sig = await conn.sendRawTransaction(signed.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}