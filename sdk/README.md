# sdk/

Public SDKs for [Magical Internet Money](https://magicalinternet.money).

## [`searchergap`](./searchergap) — `@magicalinternet/searchergap`

A searcher SDK that hands bots the **exact arbitrage gap** on the leveraged-
synthetic CP-Swap triangle (+leg/USDC, −leg/USDC, +leg/−leg). Most protocols
hide their MEV; this one publishes it — because the design is oracle-free, the
searcher *is* the oracle, and a legible gap is how the peg stays honest.

- **triangleGap** — riskless cyclic arb across the three pools (atomic, bundle-shaped)
- **simulateCrank** — what a receipt-transfer / crank would mint (donate) + the loser drop, with the one-crank-per-slot guard modelled
- **pegGap** — leg pool price vs your own underlying feed (the protocol lags; that lag is the arb)

BigInt-exact port of the on-chain rebalance math, so a sim equals what executes.

```bash
npm i @magicalinternet/searchergap @solana/web3.js
RPC_URL=https://… npx searchergap scan
```

See [`searchergap/README.md`](./searchergap/README.md) for the full API and the
honest notes on how the rebalance actually moves price (it *donates* into the
vaults — no swap, quote untouched).

> Experimental · unaudited · mainnet-alpha · here be dragons.
