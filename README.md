# @bankr/launch-sdk

Launch tokens from your app on Base: one transaction from the user's own wallet creates an ERC-20 and its Uniswap v4
pool. Launch on Bankr's launchpad, or create **your own launchpad** and set its trading fee range, your share of every
trade, an address suffix for its tokens and who may launch.

**Bankr indexes every launch on every launchpad, yours included,** so you write no contracts and run no indexer. Read
the launches from Bankr's public Launch API, which needs no key, or from the SDK. The
[Launch API reference](https://docs.bankr.bot/token-launching/launch-sdk/builder-api) and its
[OpenAPI spec](https://docs.bankr.bot/openapi/launches.yaml) document every endpoint.

Bankr, the AI agent for trading and launching tokens at [bankr.bot](https://bankr.bot), runs the contracts behind every
launch. The launcher's wallet signs and pays for each launch, and a first buy paid in a token such as USDC may need one
approval before it. Bankr never holds the launcher's keys and never sends the transaction. Every token has a fixed
supply of 100 billion, no owner and no mint, and trades in a Uniswap v4 pool behind the
[Bankr Hook](https://docs.bankr.bot/token-launching/bankr-hook). Part of every trading fee goes to the coin's holders
just for holding it. There is nothing to stake.

> **Status: alpha**, on npm's `alpha` tag. This release launches on **Base**. Robinhood Chain, Arbitrum and Arc are not
> live in it: the SDK throws `PROVIDER_NOT_DEPLOYED` there until a release adds them.
> [Availability](https://docs.bankr.bot/token-launching/launch-sdk/chains#availability) shows where each chain stands.

## Install

```sh
bun add @bankr/launch-sdk@alpha viem
npm install @bankr/launch-sdk@alpha viem
pnpm add @bankr/launch-sdk@alpha viem
yarn add @bankr/launch-sdk@alpha viem
```

ESM only. Node 22 or later, or any modern browser. `viem` 2.x (2.57.8 or later) is the only peer dependency, and the
SDK has no runtime dependencies.

## Quickstart: your first launch

This launches one token on Bankr's launchpad on Base from a script. Your wallet signs and pays the gas; Bankr prepares
the launch with your key, pins its metadata and indexes it.

You need:

1. **A builder profile**, which is how Bankr credits your launches:
   `bun install -g @bankr/cli`, `bankr login`, then `bankr builder init --slug acme --name "Acme"`.
2. **A Launch prepare key** from [bankr.bot/api-keys](https://bankr.bot/api-keys) (key type **Launch prepare**). It
   can only prepare launches; it cannot trade, move funds or run the agent.
3. **A fresh wallet** with about 0.001 ETH on Base for gas: a launch with no first buy uses about 6 million gas. It
   signs, pays, and receives the creator's fees. Never use a wallet that holds real funds.

Put both secrets in `.env`, and never commit it:

```sh
LAUNCHER_KEY=0x…
BANKR_PREPARE_KEY=bk_usr_…
```

`launch.ts`:

```ts
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  BankrApiResponseError,
  bankrPreparer,
  createLaunchClient,
  isLaunchSdkError,
} from "@bankr/launch-sdk/server";

const launcherKey = process.env.LAUNCHER_KEY as Hex | undefined;
const prepareKey = process.env.BANKR_PREPARE_KEY;
if (!launcherKey || !prepareKey) {
  throw new Error("Set LAUNCHER_KEY and BANKR_PREPARE_KEY in .env");
}

const account = privateKeyToAccount(launcherKey);
const client = createLaunchClient({
  chain: "base",
  walletClient: createWalletClient({ account, chain: base, transport: http() }),
  // Bankr prepares and signs each launch on its launchpad. The key never leaves this process.
  api: { preparer: bankrPreparer({ apiKey: prepareKey }) },
});

try {
  const launch = await client.launch({
    name: "My First Token",
    symbol: "FIRST",
    launcher: account.address,
    metadata: {
      description: "My first launch with the Bankr Launch SDK.",
      // image: "https://your-site.example/logo.png", // optional: Bankr fetches and pins it
    },
  });

  console.log("Token:  ", launch.token);
  console.log("Pool:   ", launch.poolId);
  console.log("Tx:     ", `https://basescan.org/tx/${launch.txHash}`);
  console.log(
    "Indexed:",
    launch.registration?.launches[0]?.status ?? "not yet",
  );
} catch (err) {
  if (!isLaunchSdkError(err)) throw err;
  const detail = err.detail ? ` ${err.detail}` : "";
  const bankr =
    err.cause instanceof BankrApiResponseError
      ? ` (${err.cause.code ?? err.cause.status}: ${err.cause.message})`
      : "";
  console.error(`${err.code}: ${err.message}${detail}${bankr}`);
  process.exitCode = 1;
}
```

Run it with `bun launch.ts`; Bun loads `.env` itself. On Node, save it as `launch.mjs`, delete `type Hex` from the
first import and the `as Hex | undefined` cast, and run `node --env-file=.env launch.mjs`.

You get a token whose address ends in `ba3`, the mark of Bankr's launchpad, registered with Bankr's index once the
launch has 5 confirmations. The [full Quickstart](https://docs.bankr.bot/token-launching/launch-sdk/quickstart)
explains each step, the fees and vesting your launch took by default, and the fix for each likely error.

## Launch from your app

Keep the key on your server behind one route. The user's wallet signs and pays in the browser.

```ts
// Server, e.g. app/api/launch/prepare/route.ts. authorize is required: sign the user in and rate-limit them.
import { createPrepareHandler } from "@bankr/launch-sdk/server";

export const POST = createPrepareHandler({
  apiKey: process.env.BANKR_PREPARE_KEY!,
  authorize: async (req) => {
    const user = await yourSession(req);
    if (!user) throw new Response("Sign in", { status: 401 }); // a thrown Response is returned as is
    if (!(await yourLimiter.take(user.id)))
      throw new Response("Slow down", { status: 429 });
  },
});
```

```ts
// Browser: the user's wallet signs; your route adds the key.
import { createLaunchClient, remotePreparer } from "@bankr/launch-sdk";

const client = createLaunchClient({
  chain: "base",
  walletClient,
  api: { preparer: remotePreparer("/api/launch/prepare") },
});
await client.launch({
  name,
  symbol,
  launcher,
  metadata: { image, description },
});
```

- `yourSession` and `yourLimiter` stand for your own sign-in check and rate limiter.
- Pass `launchpadId` to launch on your own launchpad through the same route. A launchpad with a signer also needs
  its `authorizer` on the client.
- The SDK checks Bankr's answer against your input and the chain before the wallet signs anything.
- The launch is sent with its gas estimate plus 20% (and 960,000 more with a first buy), never above the chain's
  per-transaction limit (16,777,216 on Base), so a launch whose estimate is within 20% of that limit is sent with
  less than the usual headroom.
- `bankrPreparer` and `createPrepareHandler` throw `API_KEY_IN_BROWSER` in a browser, and so does `remotePreparer` if
  a Bankr key is in its headers.

[Launch from your app](https://docs.bankr.bot/token-launching/launch-sdk/launch-from-your-app) covers wagmi, metadata,
limits and errors in your UI. Full versions of both halves:
[`next-server-prepare.ts`](https://github.com/BankrBot/launch-sdk/blob/main/examples/next-server-prepare.ts) and
[`browser-launch.ts`](https://github.com/BankrBot/launch-sdk/blob/main/examples/browser-launch.ts).

## Run your own launchpad

- **Register once** on the chain's launchpad registry, for a one-time bond that is not refunded (currently 0.01 ETH
  on Base; the SDK reads the live amount). The wallet or Safe that registers becomes the operator.
- **Set your terms:** the fee range every launch picks from, and 1 to 4 payees who share up to 95% of each fee after
  Bankr's slice and any referrer.
- **Choose who launches:** anyone (an open launchpad), or only the launches your server signs. Add an address suffix
  of 4 to 6 hex digits if you want one.
- **Bankr indexes every launch on it,** whoever made it. Until Bankr fully opens a chain, launches there on any
  launchpad but Bankr's own are refused (`LAUNCHPAD_GATED`, and `client.status().gated` is `true`), but you can
  register and set up yours as soon as Bankr's contracts are live on the chain.

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  createLaunchClient,
  percentToBps,
  percentToPips,
  type UnsignedTx,
} from "@bankr/launch-sdk";

const operator = privateKeyToAccount(process.env.OPERATOR_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({
  account: operator,
  chain: base,
  transport: http(),
});
const client = createLaunchClient({
  chain: "base",
  publicClient,
  walletClient,
});

// Sends one of the SDK's unsigned transactions from the operator wallet and waits for it.
async function send(tx: UnsignedTx) {
  const hash = await walletClient.sendTransaction(tx);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error(`Transaction ${hash} reverted`);
  return receipt;
}

// Register an open launchpad (no signer). Its one payee takes 50% of what is left
// of each fee after Bankr's slice and any referrer.
const receipt = await send(
  await client.launchpads.register({
    operator: operator.address,
    payees: [{ address: operator.address, shareBps: percentToBps("50") }],
  }),
);
const launchpadId = client.launchpads.launchpadIdFromReceipt(receipt);

// Launches on it pick a steady fee from 1% to 2%, may open at up to 80%, and fall to it within 120 seconds.
await send(
  await client.launchpads.setFeeBounds(launchpadId, {
    minSteadyPips: percentToPips("1"),
    maxSteadyPips: percentToPips("2"),
    maxStartPips: percentToPips("80"),
    maxDecaySecs: 120,
    maxReferrerBps: 0, // 0%: no referrers
  }),
);

// An open launchpad needs no key and no call to Bankr.
const launch = await client.launch({
  name: "Acme Coin",
  symbol: "ACME",
  metadataUri: "ipfs://bafy…", // your token's metadata JSON
  launcher: operator.address,
  launchpadId,
});
```

- **Nothing is sent for you.** Each `client.launchpads` call that changes something checks your input against the
  registry's rules, then returns an unsigned transaction from the operator (from the new operator, for
  `acceptOperator`). A broken rule throws `INVALID_LAUNCHPAD_CONFIG`, and `err.detail` says which.
- **`setPolicy` carries your whole policy as read when it is built,** with your changes merged in. Of two built before
  either lands, the second undoes the first, so put every policy change in one call. Before a queued one runs, build
  it again with `{ expectBasePolicy }` (the policy it was built over, as read or stored as JSON): a changed policy
  throws `STALE_POLICY`.
- **From a Safe,** pass the Safe's address as `operator`, send each transaction through the Safe, and read the id from
  the executed registration's receipt.

[Run your own launchpad](https://docs.bankr.bot/token-launching/launch-sdk/your-own-launchpad) covers policy,
suffixes, signed launches, the exact split and collecting your payees' share.

### Pair with any token

On any launchpad but Bankr's own, a launch can pair with any ERC-20, not only the quotes Bankr lists. A quote Bankr
does not list is the launchpad's and the launcher's risk. Its launches work like any other, with these differences:

- **You set the start price.** Pass `startFdv`: the whole supply's value at launch, in the quote's base units. The SDK
  computes the start tick from it, with no USD bound (`startTickForQuoteFdv`), and refuses one outside -560,000 to
  +200,000 (`MIN_START_TICK`, `MAX_UNLISTED_START_TICK`: above it no built-in curve can place the sale at the largest
  supply).
- **No auto-liquidity.** `autoLpBps` defaults to 0. A launchpad that requires auto-liquidity, or whose decay split has
  some, cannot launch these quotes (`SPLIT_OUT_OF_BOUNDS`).
- **Holders are paid in the quote.** Their half of Bankr's slice is never converted to BNKR, and nothing forwards it
  automatically: no swap wakes the holder leg for an unlisted quote, a holder's own `claim()` does not poke it, and the
  7-day stale path never starts because the pile is never staged. `client.holders.buildClaimAll` adds the poke itself.
  After a single `buildClaim`, or at any time, anyone can send `client.holders.buildConvert(token, sender)` to forward
  it; `getConversion` reports when there is something to forward (`convertDue`).
- **Claim-all leaves unlisted currencies out by default.** `client.fees.buildClaimAll(account, { includeUnlisted:
true })` pays them, last.
- **Pure mode only.** Bankr's API and Bankr's launchpad take listed quotes only (`QUOTE_NOT_ALLOWED`).
  `client.launchpads.setQuoteAllowed` can limit your launchpad to the quotes you name, listed or not.

```ts
await client.launch({
  name: "Meme Pair",
  symbol: "MPAIR",
  metadataUri: "ipfs://bafy…",
  launcher: operator.address,
  launchpadId,
  quote: "0x…", // any ERC-20
  startFdv: 1_000_000n * 10n ** 18n, // 1M of an 18-decimal quote for the whole supply
});
```

A fee-on-transfer token cannot settle on Uniswap v4, so its pool cannot trade. A token that pauses, blocks accounts or
reverts only fails its own pools' trades and payouts: it never affects other pools or currencies.

## Fee recipients, a metadata admin and a scheduled start

Three options any launch can take. Each is part of the launch's signed terms, and `client.parseLaunchReceipt` and
`client.launchInfo` read them back (`feeRecipients`, `metadataAdmin`, `tradingStart`).

**Several fee recipients.** The creator's own take can go to up to 10 wallets. `shareBps` is each one's part of that
take, and the parts add up to 10,000. The split is fixed at launch. After it, each recipient reads and claims its own
part (`client.fees.get(token, wallet)`, `buildClaim`, `buildClaimAll`) and can move its own entry to another wallet
(`buildSetFeeRecipient`), which never touches the others. `feeRecipient` still names a single one; set one of the two.

```ts
await client.launch({
  name: "Acme Coin",
  symbol: "ACME",
  metadataUri: "ipfs://bafy…",
  launcher: operator.address,
  launchpadId,
  feeRecipients: [
    { recipient: "0x…", shareBps: percentToBps("60") }, // the first takes any rounding remainder
    { recipient: "0x…", shareBps: percentToBps("40") },
  ],
});
```

A recipient that is a contract, a Safe included, must have restricted its claims on the fee ledger
(`client.fees.buildSetClaimRestricted`) before the launch, or the launch sets `allowOpenCodeFeeRecipients: true`, which
waives that for all of its recipients. An EOA or a 7702 wallet needs neither. The launch's quote token is never a
recipient, with the waiver or without: a token's own contract could never collect its share.

**A metadata admin.** By default a token's metadata link is fixed from its first block. Name a `metadataAdmin` and
that one account can replace the link (at most 2,048 bytes) after launch, hand the role on in two steps, or renounce
it for good. It changes nothing else: the name, symbol, supply and fees are out of its reach, and the role does not
follow a fee recipient change. The admin is part of the token's address, so set it before you plan.

```ts
// `launch` stands for a launch input like the one above.
const { token } = await client.launch({
  ...launch,
  metadataAdmin: admin.address,
});

await client.metadataAdmin.get(token); // { metadataUri, admin, pendingAdmin }
await send(
  await client.metadataAdmin.buildSetUri(token, admin.address, "ipfs://bafy…"),
);
await send(
  await client.metadataAdmin.buildTransfer(token, admin.address, "0x…"),
); // an offer
await send(await client.metadataAdmin.buildAccept(token, "0x…")); // sent by the account it was offered to
await send(await client.metadataAdmin.buildRenounce(token, admin.address)); // no way back
```

A builder throws `NOT_METADATA_ADMIN` for an account the token would refuse.

**A scheduled start.** Pass `startTime` (a `Date` or Unix seconds) and the launch creates the token and its pool now,
but nothing trades until then: swaps revert and no wallet can move the token. The start must be in the future when the
launch is mined, at most 7 days ahead and within the launchpad's own limit (`policy.maxStartDelay`; 0 means the
launchpad allows none). Nobody can move it or call it off afterwards. Vesting and the opening fee count from the start.

```ts
const { token, tradingStart } = await client.launch({
  ...launch,
  startTime: new Date(Date.now() + 60 * 60 * 1000), // trading opens in an hour
});

const status = await client.tradingStatus(token); // { startTime, blockTime, started, secondsUntilStart }
```

## Curves and your own liquidity bands

A launch's curve is where its sale sits in the pool. Leave `curve` out for the default (`"runner_v1"`), name a
built-in (`"runner_v1"`, `"degen"`, which starts at $2,500, or `"thin_topside"`), or bring your own bands. Your own
bands launch only on a launchpad whose operator allows them (`CURVE_NOT_ALLOWED` otherwise), and Bankr's own launchpad
does not take them yet.

A curve is 1 to 8 bands, outward from the start price. Each band has a width in ticks (a multiple of 200; 200 ticks
is about 2% of price) and a share of the sale in basis points. Each band starts where the one before it ends. The last
band has width 0 and runs to the top of the pool's range. The shares add up to 10,000.

**As bands.** Name the start price too: `startFdvUsd` is the whole supply's value in USD at the start.

```ts
// `launch` stands for a launch input like the ones above.
await client.launch({
  ...launch,
  curve: {
    startFdvUsd: 10_000,
    bands: [
      { widthTicks: 6_800, shareBps: 304 }, // $10K to about $20K: 3.04% of the sale
      { widthTicks: 110_000, shareBps: 9_658 }, // on to about $1.2B: 96.58%
      { widthTicks: 0, shareBps: 38 }, // everything above: 0.38%
    ],
  },
});
```

**As market-cap ranges,** the way Doppler's multicurve takes them: ranges that touch, from the start market cap up,
the last ending at `"max"`, with shares that add up to 10^18. The first range's start is the launch's start FDV in
USD.

```ts
import { parseEther } from "viem";

await client.launch({
  ...launch,
  curve: {
    marketCaps: [
      {
        marketCap: { start: 10_000, end: 19_500 },
        shares: parseEther("0.0304"),
      },
      {
        marketCap: { start: 19_500, end: 1_200_000_000 },
        shares: parseEther("0.9658"),
      },
      {
        marketCap: { start: 1_200_000_000, end: "max" },
        shares: parseEther("0.0038"),
      },
    ],
  },
});
```

**How ranges become bands.** A pool's prices sit on a grid of 200 ticks, about 2% apart, and two things are rounded
down to it. Every launch starts on the grid line at or under its start market cap. Each range then ends on a grid
line at or under its own market cap:

- **`plan()` places the ranges from the launch's start tick,** in pure mode and in API mode. A band ends at or under
  the market cap you asked for, by less than one grid step (about 2%). On a USD start that holds to within one tick
  (0.01%), which is how finely the factory prices the quote. The bands follow the quote's price: the first band
  above is 6,600 or 6,800 ticks wide, depending on where $10,000 falls between two grid lines when you plan.
- **In API mode Bankr picks the start tick,** so `plan()` reads the factory's price, sends Bankr the bands that start
  gives, and checks the start Bankr returns against the price again. If the price moved in between and the bands no
  longer fit, it asks Bankr to prepare again: up to three prepares, then `START_TICK_CHANGED`. A quote Bankr prices
  by signature has no price until Bankr attests one, so its first prepare is often replaced by a second.
- **`curveFromMarketCaps({ ranges })` on its own** does not know the start tick, so it counts the start as on the
  grid, as the built-in curves do, and returns the same bands at any price. On a launch a band then ends at or under
  its market cap by less than two grid steps (about 4%): one for where the start falls in its step, one for the
  range. Bands fixed before the start tick is known cannot do better at every start. Give it `startOffsetTicks`, how
  many ticks the start market cap sits above the launch's start tick, and it places the ranges as `plan()` does.

To launch the same bands whatever the price (a set a launchpad has listed, for example), convert once and launch with
the bands: `curve: { bands: curveFromMarketCaps({ ranges }).bands, startFdvUsd: 10_000 }`. To see the bands a launch
would carry now, plan it with `curve: { marketCaps }` and read `decodeCurve(plan.params.curveId)`.

Shares are never rounded: one that is not a whole number of basis points is refused. A range is one band, so
`numPositions` is 1 or left out. A range that spans no grid line is refused by number. On a quote Bankr does not
list, set `startFdv` as usual: it places the bands, and market-cap ranges are then in the quote's base units, starting
at `startFdv`.

`plan()` holds your bands to the pool's rules before anything is signed. A broken rule throws `INVALID_PARAMS`, and
`err.detail` names the band and says what to change:

- **No thin band.** Every band holds at least a tenth of the liquidity the whole sale would have as one band from the
  start price.
- **No wall.** No band holds more than twice the liquidity the whole sale would have as one band from where that band
  begins. That is about 2% of the sale per 200 ticks.
- **No parked supply.** At least 90% of the sale sells within 120,000 ticks of the start.
- **Liquidity rises once, near the start, when the pool buys its own token** (a buyback share, auto-liquidity, or the
  launchpad's decay auto-liquidity). A band that begins within 6,800 ticks of the start holds at most 13 times the
  thinnest band before it. A band that begins further out holds no more than the band before it. With market-cap
  ranges, end the range before the rise under 1.97 times the start market cap, as the example does at 1.95. A range
  to exactly twice the start ends 7,000 ticks out on about two starts in three, and the band after it is then
  refused.
- **Inside the pool's limits.** The bands end inside the pool's price range, stay under Uniswap v4's cap on liquidity
  at one tick, and leave at most 2 parts per million of the sale unplaced by rounding.

The built-in curves are not held to these rules. `checkCurve` runs the same check on its own, and the launch's
simulation still has the final word.

**Launchpad operators** decide which curves launch on their launchpad. A new launchpad takes the three built-in curves
and no custom bands, until its operator opens it:

```ts
// Open the launchpad to any bands that pass the rules, or list one set of bands.
await send(await client.launchpads.setCurveAllowed(launchpadId, "any", true));
await send(
  await client.launchpads.setCurveAllowed(launchpadId, { bands }, true),
);
await client.launchpads.isCurveAllowed(launchpadId, { bands }); // true
```

**Reading a curve back.** `client.parseLaunchReceipt` and `client.launchInfo` return `curve`: a built-in's `curveId`
and `name`, or your bands as the word the launch carried (`curveTable`), and each band with its pool ticks and share.
`launchInfo` reads the bands from the pool's locked positions, so bands with a built-in curve's exact numbers read as
that built-in. `curveMarketCaps` turns the bands into market-cap ranges for a chart:

```ts
const { curve, startTick, totalSupply } = client.parseLaunchReceipt(receipt);
// The launch's start FDV in the quote's base units; multiply by the quote's price to chart in USD.
const startMarketCap = 1.0001 ** startTick * Number(totalSupply);
const ranges = curveMarketCaps({ bands: curve.bands, startMarketCap });
// [{ marketCap: { start, end }, shares, shareBps, widthTicks }, …]; the last range ends at "max"
```

## Units: pips and bps

Fee rates are in **pips**, where 1,000,000 pips is 100% (Uniswap v4's own unit, and what on-chain events show).
Shares are in **bps**, where 10,000 bps is 100%. The SDK converts from percent exactly; pass percentages as strings.

```ts
import {
  bpsToPercent,
  percentToBps,
  percentToPips,
  pipsToPercent,
} from "@bankr/launch-sdk";

percentToPips("1.75"); // 17_500
pipsToPercent(4_750); // "0.475"
percentToBps("50"); // 5_000
bpsToPercent(875); // "8.75"
```

[Fees](https://docs.bankr.bot/token-launching/launch-sdk/fees#units) has the full conversion table.

## Bankr's launch index

```ts
import { createBankrApi } from "@bankr/launch-sdk";

const { launches } = await createBankrApi().launches({
  chain: "base",
  launchpad: 7n, // your launchpad's id
  visibility: "all",
});
for (const l of launches) {
  console.log(l.symbol, l.tokenAddress, l.launcher, l.deployedAt);
}
```

```sh
curl "https://api.bankr.bot/launches?chain=base&launchpad=7&visibility=all"
```

- **No client, RPC, wallet or key.** Filter by `chain`, `launchpad`, `launcher`, `builder` and more. `client.index`
  is the same index on the client's chain.
- **Launches made with the SDK are hidden by default** from Bankr's Discover pages and from the index's default
  listing, until Bankr lists them on that chain. They are still indexed, tradable and claimable: `visibility: "all"`
  includes them, and reading one launch by its address returns it either way.
- **SDK launches are priced from their trades,** on the chains where Bankr has turned this on
  ([Availability](https://docs.bankr.bot/token-launching/launch-sdk/chains#availability); not Arc yet). Once a
  launch is indexed and has traded on a quote Bankr prices, the index carries its price, market cap and 24h volume,
  usually within a couple of minutes, hidden or listed. Bankr prices the chain's WETH; on Base and Robinhood Chain,
  BNKR, the other tokens Bankr's app pairs launches with and the tokenized stocks it supports; and USDC on Arbitrum.
  It does not price USDC on Base or USDG on Robinhood Chain yet. Launches that moderation hides (name or symbol
  policy, bans, quotas) read `null`, and so do launches with no trade for 30 days; one with no trade for a day can
  also read `null` after Bankr restarts its pricing, until it trades again. Pricing is best effort: up to 5,000
  tracked launches per chain, 250 per launcher and 250 per builder with verified credit; when a chain is full,
  launches without verified credit drop out first, lowest 24h volume first.
  [Market data](https://docs.bankr.bot/token-launching/launch-sdk/launch-index#market-data) has the rules, and
  [Price a launch on-chain](https://docs.bankr.bot/token-launching/launch-sdk/launch-index#price-a-launch-on-chain)
  reads any launch's price from its pool.
- **Registering shows a launch sooner.** In API mode `launch()` registers each launch once it has 5 confirmations;
  in pure mode, create the client with `api: {}` for the same. Otherwise the indexer picks the launch up at the
  chain's full depth (20 confirmations on Base).

[Bankr's launch index](https://docs.bankr.bot/token-launching/launch-sdk/launch-index) lists every field, filter and
limit.

## After launch

Fees, holder rewards and vesting are reads plus unsigned transactions for the account that sends them. These calls
send nothing; your wallet or Safe does.

```ts
import { waitForTransactionReceipt } from "viem/actions";

// Claims `account`'s trading fees on one launch, from every share it holds.
// A claim pays the account that sends it.
for (const tx of await client.fees.buildClaim(token, account.address)) {
  const hash = await walletClient.sendTransaction(tx);
  await waitForTransactionReceipt(client.publicClient, { hash });
}
```

| Namespace              | Methods                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.fees`          | `get`, `buildClaim`, `getOwed`, `buildClaimAll`, `getBalances`, `buildWithdraw`, `getClaimPolicy`, `buildSetClaimRestricted`, `buildSetClaimOperator`, `buildSetFeeRecipient`                                                         |
| `client.holders`       | `get`, `buildClaim`, `buildClaimAll`, `unclaimed`, `buildClaimFor`, `buildClaimPastBnkr`, `getConversion`, `buildConvert`                                                                                                             |
| `client.vesting`       | `get`, `buildRelease`, `buildReleaseToHolders`                                                                                                                                                                                        |
| `client.metadataAdmin` | `get`, `buildSetUri`, `buildTransfer`, `buildAccept`, `buildRenounce`                                                                                                                                                                 |
| `client.launchpads`    | `register`, `launchpadIdFromReceipt`, `setFeeBounds`, `setPolicy`, `setPayees`, `setVanity`, `setSigner`, `setQuoteAllowed`, `setCurveAllowed`, `isCurveAllowed`, `setMetadataUri`, `setPaused`, `transferOperator`, `acceptOperator` |

### Claim everything at once

An account's fees from every launch, referral slices included, collect into one pull balance per currency on the
chain's fee ledger. `client.fees.buildClaimAll(account)` claims all of it: `settle` transactions first, which only
move bucket shares into the balance, then one `withdraw` that pays every currency. It is one transaction when
everything fits, and each carries its gas limit, at most 15,000,000. A currency that refuses its payout (a frozen or
halted quote) is reported `Withheld` and stays in the balance while the others pay.

A currency that is not a quote the factory lists, the chain's BNKR or a launched token (any-quote pairing) is left out
by default and reported in `plan.unlisted`. Anyone can make an account owe in such a currency, as a launch's fee
recipient or as a swap's referrer, and a token that burns gas costs up to 1,000,000 gas on every claim-all. Pass
`{ includeUnlisted: true }` to pay them too: they come last, in withdraws of their own (`step.unlisted`), after every
listed currency has been paid.

```ts
const { txs, plan } = await client.fees.buildClaimAll(account.address);
for (const tx of txs) {
  const hash = await walletClient.sendTransaction(tx);
  await waitForTransactionReceipt(client.publicClient, { hash });
}
```

`client.fees.getOwed(account)` reads what is owed from Bankr's account index, and falls back to scanning the
ledger's logs for a small account (500 shares at most). `planClaimAll` is the planner on its own.

Any wallet may also push an account its fees: `client.fees.buildClaimAll(account, { sender })` builds `settle`
transactions for the account, then `withdrawFor(account, quotes)`, all sent from `sender` and paid only to `account`
(always at least two transactions once a bucket is owed). It is refused with `CLAIM_NOT_ALLOWED` while the account
restricts who may claim for it and `sender` is not one of its claim operators, and for a Bankr puller (the hook's
auto-LP, a protocol sink or a suite contract), which collects its own share.

Anyone may claim on behalf of any account, its fees and its holder rewards alike, and the money only ever goes to
that account. That is every account's default, a contract's included. An account that wants to choose who claims for
it turns this off once with `client.fees.buildSetClaimRestricted(account, true)`, then names the wallets that may with
`client.fees.buildSetClaimOperator`; it can always claim for itself, and the one setting covers the fee ledger and
every coin's holder distributor. A public forwarder (Multicall3, Multicall2, Multicall) is refused as an operator: it
calls for anyone, so naming it reopens the account to everyone. A contract that values itself by its token balance (a
vault, a pool) should restrict itself: otherwise anyone can choose the moment its rewards land. So must a contract
that pays out what the ledger's `collectFees` returns: while it is open, a stranger's settle moves its share where
`collectFees` never returns it. `allowContractFeeRecipient`, `buildSetFeeRecipient` and the pad payees therefore take a
contract (other than a Safe or a 7702 wallet) only once it is restricted. A launch's own fee recipients are held to
more: the factory refuses any contract among them, a Safe included, that has not restricted itself, unless the launch
sets `allowOpenCodeFeeRecipients`.
`client.fees.getClaimPolicy(account, caller)` reads the setting, and whether `caller` may claim for `account`.

Holder rewards across many coins: `client.holders.buildClaimAll(account, tokens)` batches them, 14 coins a
transaction for an open EOA (`claimFor` through Multicall3), and `client.holders.unclaimed(claimAll, receipts)` lists
any coin to retry. Coins on listed quotes come first. Each unlisted quote's coins come after them, in transactions of
their own, at 1.9M gas a coin, so a quote that burns gas only ever delays coins paired with that same quote. After its
claims, a transaction also pokes the holder leg for every coin whose holders' pile is due (`poke` on the coin): only a
swap that asks runs the conversion, so a due pile would otherwise wait. A pile is due once it reaches its quote's floor
and the leg would convert or forward it now; on a quote with no floor (an unlisted one) any pile is. A coin of `tokens`
the account has earned nothing from yet gets that poke too, with no claim, since a waiting pile pays its holders
nothing: it is listed in `coins` after the claimed ones, its `earned` all zero, and `unclaimed` never lists it. The
SDK reads no balance, so name the account's own coins: every named coin with a due pile costs its poke, unless its
distributor excludes the account. A poke that may convert is budgeted 2M gas and one that only forwards 400,000, so a
transaction holds 4 claims with a converting poke each, 10 with a forwarding one, or with no claim 6 converting pokes
or 33 forwarding ones; `maxGasPerTx` under what one coin needs (4,460,000 for a claim with a converting poke) is
refused, `INVALID_PARAMS`. A contract account, or an account that turned "anyone can claim" off, gets
`mode: "direct"`: one `claim()` per coin with rewards, sent by the account itself (a Safe's MultiSend or a 7702
wallet's own batch), then one poke per due pile at 2.1M, because Multicall3's `claimFor` for a restricted account
lands and claims nothing.

Holder rewards need no keeper: every swap accrues the creator's holder share into its coin's stream, and a claim pulls
it from the fee ledger itself when the distributor's balance falls short. Every holder-rewards claim carries its gas
limit (`HOLDER_GAS`: 1.75M a `claim`, 2.45M a `claimFor` or a `claimForMany`'s first account, 1.9M a further one,
enough for one whose BNKR burns its whole payout cap): the distributor hands each capped call (the pull, each payout)
its whole cap or reverts `InsufficientGas`, so send these limits, not a bare estimate. Most of it is headroom: a claim
uses far less than its limit. A claim on a coin quoted in another Bankr launch, by a holder who sat through BNKR
swaps, can need more than 1.75M: `buildClaimFor(token, account, [account])` carries 2.45M. A full claim hands each
payout 1M gas; for an asset whose transfer needs more,
`client.holders.buildClaim(token, account, { leg, gas })` builds a `claimLeg`, which hands it all the gas you give.
`buildClaimFor` refuses more accounts than the chain's per-transaction ceiling holds (8 on Base).

Holders' BNKR comes from the coin's own swaps, with no keeper. Once a coin's holders' pile in the fee ledger reaches
its quote's floor (about $5), a swap that asks for the conversion in its hookData and leaves it its gas converts it,
at most once per 30 minutes per quote and up to 8 coins a batch; on a chain whose holders are paid in the quote
(Arbitrum, Arc) it is forwarded in the quote instead. A swap that does not ask never runs it, at any gas limit, and a
holder's own `claim()` never pays for it either (`buildClaimAll` adds a poke for each due pile, above).
`client.holders.getConversion(token)` says whether a coin's pile is due now:
`due` for a swap that asks and carries the wake's gas, `convertDue` for the convert action (it also counts a pile
already staged in the leg, which no swap wakes for, and the leg's forward rule: QUOTE mode, a queued BNKR swap or
route, a pile 7 days old). A conversion needs a route to BNKR in force (`routed`); a quote without one is due once, to
stage its pile, which then forwards in the quote 7 days later.
`client.holders.buildConvert(token, sender)` is the convert action: anyone may send it, at 2.1M gas.

Routers and wallets that build their own swaps add gas to the simulated limit for each Bankr pool on the route:
`SWAP_GAS_HEADROOM` (960,000) plus, for a pool with an extension, the hook's own figure,
`readExtSwapGasHeadroom(client.publicClient, { hook, poolId })` (`launchInfo` gives both; `swapGasHeadroom` adds the
two). An extension is asked from its pool's first swap and is handed the gas budgets its launch named on every swap;
it can refuse a buy (the swap reverts `ExtensionRefusedBuy`), never a sell. To ask for the conversion, give every
Bankr pool on the route `encodeHookData({ holdersWake: holdersWakeRequest(route, i) })` as its hookData: each request
names the gas the hops after it need, which that pool's conversion and buyback fill leave free. On a route of three
or more Bankr pools, asking only at the first keeps a range of gas limits that revert at the second. A request alone
does not run the conversion: add `holdersWakeSwapGas(request.keepGas)` to the limit at a pool that is `due`. That
figure is sized for the route's first Bankr pool. A later pool's conversion also needs what each Bankr pool before it
takes once the limit is larger: a buyback fill that a bare estimate skips, about 480,000 gas at its 460,000 stipend.
The SDK does not add that, and a conversion short of its gas is skipped; nothing reverts.

If Bankr swaps the token holders' BNKR rewards buy (behind 48 hours' notice), BNKR already earned stays claimable in
the old token: `client.holders.get` lists it under `pastBnkr`, one entry per earlier token, and
`client.holders.buildClaimPastBnkr(token, account, epoch)` claims one.

`client.launchInfo(token)` reads a launch's pool, launchpad, fee schedules, every beneficiary's share, its fee
recipients, metadata admin and trading start and, for a launch with a buyback share, `buybackAt`: the second from which
a swap runs its next buyback fill. `client.tradingStatus(token)` says whether it trades yet. And
`client.verifyTokenInvariants(token, receipt?)` checks a token against what a launch guarantees.

## Entry points

| Import                     | Use it for                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bankr/launch-sdk`        | Everything that is safe in a browser: the launch client, launchpad operations, the index, unit helpers, errors                                                                                                                                                       |
| `@bankr/launch-sdk/server` | The root entry plus the helpers that use your Bankr key or your launchpad's signing key: `bankrPreparer`, `createPrepareHandler`, `createAuthorizeHandler`, `padAuthorizer`, `signLaunchAuthorization`. All but `signLaunchAuthorization` refuse to run in a browser |

## Errors

Every refusal the SDK makes is a `LaunchSdkError` with a stable `code`, a `kind` and a fixed message, so branch on
`code`. Where the SDK can name the bound or field that failed, `err.detail` says which. Any upstream error is on
`err.cause`: for `API_ERROR`, Bankr's own code (for example `LAUNCH_NOT_ALLOWED`) is on `err.cause.code`, and
`launchRevertName(err.cause)` names a contract revert. A wallet or RPC error from viem, such as a rejected signature,
reaches you as viem's own error. Every address the SDK takes (a launch's launcher, fee and vesting recipients, a
launchpad's payees, signer and operator, a token or account you read) must match its EIP-55 checksum when written in
mixed case, so a one-character typo throws `INVALID_PARAMS` instead of being re-checksummed; all-lowercase or
all-uppercase is taken as it is.

| Kind        | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`    | `PROVIDER_NOT_DEPLOYED`, `UNSUPPORTED_CHAIN`, `RPC_REQUIRED`, `WALLET_REQUIRED`, `API_KEY_IN_BROWSER`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `refused`   | `PAUSED`, `LAUNCHPAD_GATED`, `UNKNOWN_LAUNCHPAD`, `LAUNCHPAD_PAUSED`, `AUTHORIZATION_REQUIRED`, `PRICE_ATTESTATION_REQUIRED`, `QUOTE_NOT_ALLOWED`, `CURVE_NOT_ALLOWED`, `DEV_BUY_UNAVAILABLE`, `INVALID_PARAMS`, `INVALID_PERCENT`, `FEE_OUT_OF_BOUNDS`, `SPLIT_OUT_OF_BOUNDS`, `VESTING_OUT_OF_BOUNDS`, `BUILDER_LANE_NOT_ALLOWED`, `CREATOR_CAP_EXCEEDED`, `LAUNCHER_IS_FORWARDER`, `LAUNCHER_MISMATCH`, `FEE_RECIPIENT_CANNOT_CLAIM`, `NOT_A_LAUNCH`, `NOT_A_BENEFICIARY`, `CLAIM_NOT_ALLOWED`, `NO_VESTING`, `NOT_METADATA_ADMIN`, `INVALID_LAUNCHPAD_CONFIG` |
| `execution` | `SIMULATION_REVERTED`, `POOL_ALREADY_INITIALIZED`, `START_TICK_CHANGED`, `PREDICTION_MISMATCH`, `VANITY_UNAVAILABLE`, `AUTHORIZATION_INVALID`, `LAUNCHPAD_TERMS_CHANGED`, `STALE_POLICY`, `RECEIPT_MISSING_LAUNCH`, `RECEIPT_MISSING_LAUNCHPAD`, `TRANSACTION_REVERTED`                                                                                                                                                                                                                                                                                           |
| `api`       | `API_KEY_OVERPRIVILEGED`, `API_ERROR`, `RATE_LIMITED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

[Errors](https://docs.bankr.bot/token-launching/launch-sdk/errors) explains each code and Bankr's API codes.

## What is fixed

- Every token has no owner and no mint. `client.verifyTokenInvariants` checks one for you.
- A launch's fee rates and split are fixed when it launches. Launchpad changes reach future launches only.
- A token's name, symbol and supply never change. Its metadata link is fixed too, unless the launch named a metadata
  admin, who can replace the link and nothing else.
- A scheduled trading start cannot be moved or called off.
- Bankr's slice is fixed in the contracts' code. No setting raises it, Bankr's included.

[Trust, stated plainly](https://docs.bankr.bot/token-launching/launch-sdk/trust) lists every lever Bankr and launchpad
operators hold, and how to check the contracts' owner on-chain.

## Docs

- Start: [Overview](https://docs.bankr.bot/token-launching/launch-sdk/overview) ·
  [Quickstart](https://docs.bankr.bot/token-launching/launch-sdk/quickstart)
- Guides: [Launch from your app](https://docs.bankr.bot/token-launching/launch-sdk/launch-from-your-app) ·
  [Run your own launchpad](https://docs.bankr.bot/token-launching/launch-sdk/your-own-launchpad) ·
  [Bankr's launch index](https://docs.bankr.bot/token-launching/launch-sdk/launch-index)
- Concepts: [Launchpads](https://docs.bankr.bot/token-launching/launch-sdk/launchpads) ·
  [Fees](https://docs.bankr.bot/token-launching/launch-sdk/fees) ·
  [Holder rewards](https://docs.bankr.bot/token-launching/launch-sdk/holder-rewards) ·
  [Attribution](https://docs.bankr.bot/token-launching/launch-sdk/attribution) ·
  [Trust, stated plainly](https://docs.bankr.bot/token-launching/launch-sdk/trust)
- Reference: [SDK reference](https://docs.bankr.bot/token-launching/launch-sdk/options) ·
  [Chains and releases](https://docs.bankr.bot/token-launching/launch-sdk/chains) ·
  [Errors](https://docs.bankr.bot/token-launching/launch-sdk/errors) ·
  [Launch API reference](https://docs.bankr.bot/token-launching/launch-sdk/builder-api)

## Security, changelog and contributing

- **Security:** report vulnerabilities as described in
  [SECURITY.md](https://github.com/BankrBot/launch-sdk/blob/main/SECURITY.md), never in a public issue.
- **Changelog:** [CHANGELOG.md](https://github.com/BankrBot/launch-sdk/blob/main/CHANGELOG.md).
- **Contributing:** [CONTRIBUTING.md](https://github.com/BankrBot/launch-sdk/blob/main/CONTRIBUTING.md).

## License

MIT
