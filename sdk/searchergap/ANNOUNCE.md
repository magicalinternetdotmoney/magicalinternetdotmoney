# searchergap — launch copy

Drafts for the `@magicalinternet/searchergap` launch. Voice: founder, first
person, honest. Tweets are roughly within 280 chars; trim before posting.

---

## Announcement thread

**1/**
we just did something no launchpad ever did on purpose:

we published the searcher's edge.

`npm i @magicalinternet/searchergap`

every arbitrage gap on our leverage triangle — the exact math, the unsigned bundle, handed to the bots. 🧵

**2/**
a market on Magical Internet Money isn't one token. it's three Raydium CP-Swap pools:

  +leg / USDC
  −leg / USDC
  +leg / −leg

oracle-free. it rebalances by *minting the loser*, fired by a Token-2022 transfer hook. perpetual, on-chain, arbitrageable.

**3/**
the SDK is a BigInt-exact port of the on-chain rebalance math — your sim == what executes. no guessing.

• `triangleGap` — riskless cyclic arb
• `simulateCrank` — what a receipt-transfer mints + the loser drop
• `pegGap` — leg vs your underlying feed
• tx builders that return *unsigned* bundles

**4/**
why give the alpha away?

because oracle-free means **the searcher is the oracle.** our leg only tracks SOL because someone arbs it against the real market. no bots, no peg, no product.

the arb isn't a tax we pay. it's the plumbing we run on.

**5/**
and it's *structural*, not predatory. triangle + peg arb keep the legs honest — they don't sandwich a degen's swap.

MEV as plumbing, not a mugging. that's a cleaner pitch than any launchpad got to make.

**6/**
the honest part: i ran it across every live market and it found **$0.**

the tool doesn't lie — the pools are thin and already coherent. it even proves the crank leaves no gap (`crankThenTriangleGap` → 0).

a detector that tells you the truth, including "nothing here yet."

**7/**
so come make it lie.

deepen the pools. fire the crank. bring your own underlying feed. the gaps are real the second the flow shows up — and now you have the exact math to size them.

`RPC_URL=… npx searchergap scan`

**8/**
unaudited · mainnet-alpha · here be dragons 🐉

code: github.com/magicalinternetdotmoney
app: magicalinternet.money

built for searchers, on purpose, from day one.

---

## Origin story thread — "pump won because it built for bots"

**1/**
everyone has a theory for why pump.fun won. fair launch. memes. timing.

mine's narrower and i think it's the real one:

pump didn't launch tokens. it laid out the cleanest **surface for searchers** anyone had ever shipped. 🧵

**2/**
think about what a bonding curve actually *is* to a bot.

atomic. deterministic. on-chain-priceable. a searcher can simulate the exact fill, bundle a snipe through Jito with a tip, and know the outcome before it lands.

that's not a token. that's a *machine bots can read.*

**3/**
now look at the launchpad graveyard. off-chain matching. opaque allocation. LP someone had to hand-seed.

illegible to bots → no bot liquidity → the thing felt like a morgue. dead on arrival, every time.

**4/**
here's the part founders miss: searchers are **liquidity of last resort** and **free price-discovery labor.**

when bots are always there, the place *looks alive* — because the bid is always there. legibility to machines is what made pump feel like a casino that never closed.

**5/**
and pump kept feeding them. the Raydium migration wasn't a footnote — it was a **scheduled, knowable MEV event.** searchers planned around it for weeks. the whole lifecycle was bot-shaped.

**6/**
i'll be honest about the dark side, because it matters. a lot of that searcher flow was **toxic** — sniping and sandwiching pump's own retail.

searcher-friendliness bootstraps liquidity. it can also hollow out trust. meteoric and durable aren't the same coin.

**7/**
so when i built Magical Internet Money i took the lesson and tried to keep the good half:

build for searchers from day one — but make the MEV **structural, not predatory.** triangle and peg arb keep my legs honest. they don't mug the guy clicking buy.

**8/**
and i went further than pump ever did. pump *hid* the edge and let bots discover it.

i **published** it. literally shipped the SDK that computes the gap, fires the crank, builds the bundle. `npm i @magicalinternet/searchergap`.

**9/**
because my design is oracle-free, the searcher isn't a parasite on the system — the searcher *is* the system. they're my oracle. my peg. my liquidity.

so i'm not hiding from them behind a curve. i'm handing them the map: keep me honest, get paid.

**10/**
pump proved searcher-friendliness is the cheat code.

i'm trying to prove you can pull it without the mugging.

here be dragons. 🐉
magicalinternet.money
