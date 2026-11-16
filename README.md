# @bankr/launch-sdk

Run a launchpad of your own on Bankr's contracts, and launch coins on it from your app. You set the launchpad's
parameters: the trading fee, your share of every trade, the supply, the wallet cap, vesting, buybacks,
auto-liquidity, the holders' share and which features a launch may use. Each launch picks inside your ranges, and
what it picks is **frozen for that coin when it launches**: no later change, yours or Bankr's, reaches a coin that
is already trading.

One transaction from the launcher's own wallet creates the ERC-20 and its Uniswap v4 pool behind the
[Bankr Hook](https://docs.bankr.bot/token-launching/bankr-hook). Bankr never holds the launcher's keys and never
sends the transaction. Every coin has a fixed supply, no owner and no mint, and part of every trading fee goes to
its holders just for holding it. **Bankr indexes every launch on every launchpad, yours included,** so you write no
contracts and run no indexer: read the launches from Bankr's public
[Launch API](https://docs.bankr.bot/token-launching/launch-sdk/builder-api) or from the SDK.

> **Status: alpha**, on npm's `alpha` tag. This is the SDK's **version 1** line, built for Bankr's configurable
> suite ("suite 4"). Base's suite 4 record ships from the next release, where `suite: 4` launches on Base. On
> every other chain it throws `PROVIDER_NOT_DEPLOYED`, or runs against a suite you deployed (pass its record as
> `addresses` with `fork: true`). A client is on suite 4 only when it asks for it. The suite live on Base today
> ("suite 3") is the default, and is still launched, read and claimed with this SDK: see
> [Suite 3](#suite-3-the-suite-live-today).

## Install

```sh
bun add @bankr/launch-sdk@alpha viem
npm install @bankr/launch-sdk@alpha viem
pnpm add @bankr/launch-sdk@alpha viem
yarn add @bankr/launch-sdk@alpha viem
```

ESM only. Node 22 or later, or any modern browser. `viem` 2.x (2.57.8 or later) is the only peer dependency, and the
SDK has no runtime dependencies.

## Getting started

### 1. Launch your own launchpad, with your own parameters

A launchpad is a row in Bankr's settings contract that you operate. Registering it costs a one-time bond that is
not refunded (the SDK reads the live amount). The wallet or Safe that registers becomes its operator.

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
  suite: 4,
  publicClient,
  walletClient,
});
const { launchpads, settings } = client.suite4();

// Sends one of the SDK's unsigned transactions from the operator wallet and waits for it.
async function send(tx: UnsignedTx) {
  const hash = await walletClient.sendTransaction(tx);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error(`Transaction ${hash} reverted`);
  return receipt;
}

// Register an open launchpad (no signer: anyone may launch on it). Its one payee takes half of what is left of
// each fee after Bankr's slice and any referrer.
const receipt = await send(
  await launchpads.register({
    operator: operator.address,
    payees: [{ address: operator.address, shareBps: percentToBps("50") }],
    metadataUri: "https://acme.example/launchpad.json",
  }),
);
const launchpadId = launchpads.launchpadIdFromReceipt(receipt);

// Your parameters, in one transaction. A knob is { min, max, default }: a launch names a value inside the range or
// takes the default. Anything you leave out stays as a new launchpad starts (the tables below).
await send(
  await launchpads.configure(launchpadId, {
    knobs: {
      // A launch picks a fee from 1% to 2%, and takes 1% when it names none.
      steadyPips: {
        min: percentToPips("1"),
        max: percentToPips("2"),
        default: percentToPips("1"),
      },
      // Every coin has a supply of one billion, in whole tokens.
      supply: {
        min: 1_000_000_000,
        max: 1_000_000_000,
        default: 1_000_000_000,
      },
      // No wallet cap: a length of 0 is the off state.
      capSecs: { min: 0, max: 0, default: 0 },
      // A fifth of the creator side buys the coin back, unless a launch says otherwise.
      buybackBps: { min: 0, max: 5_000, default: 2_000 },
    },
    switches: { allocations: false }, // no builder allocations on this launchpad
  }),
);

const pad = await settings.pad(launchpadId);
pad.atLaunch.knobs.steadyPips; // { min: 10000n, max: 20000n, default: 10000n }: what a launch meets now
```

- **Nothing is sent for you.** Every builder returns an unsigned transaction from the account the contract
  requires (your operator; for a Safe, pass the Safe's address as `operator` and send each one through it). A value
  outside Bankr's limits or the contracts' own rules throws `INVALID_LAUNCHPAD_CONFIG` before anyone signs, and
  `err.detail` says which.
- **Every feature has an off state**: the wallet cap, vesting, buyback, auto-liquidity, the holders' share of the
  creator side, the opening fee, the dev buy, referrers, extensions, own bands, a scheduled start, a metadata admin
  and takeover. [A launchpad's knobs](#a-launchpads-knobs) and [switches](#a-launchpads-switches) list each one.
- **Takeover is off on your launchpad.** Bankr can move the creator's share of an abandoned coin only on its own
  launchpad, and on yours only if you switch it on (`launchpads.setTakeover`). Bankr cannot switch it on for you.
- **Your changes reach future launches only.** So do Bankr's. A coin keeps the terms of its launch.
- **Who launches.** An open launchpad takes any launcher. Name a `signer` and only the launches your server signs
  go through ([`pad-authorize-route.ts`](https://github.com/BankrBot/launch-sdk/blob/main/examples/pad-authorize-route.ts)).
  Until Bankr fully opens a chain, launches there on any launchpad but Bankr's own are refused (`LAUNCHPAD_GATED`;
  `client.status().gated` is `true`), but you can register and configure yours as soon as the suite is live.

The whole flow as a script: [`own-launchpad.ts`](https://github.com/BankrBot/launch-sdk/blob/main/examples/own-launchpad.ts).

### 2. Launch a coin

```ts
const launch = await client.launch({
  name: "Acme Coin",
  symbol: "ACME",
  metadataUri: "ipfs://bafy…", // your coin's metadata JSON
  launcher: operator.address,
  launchpadId,
});
launch.token; // the coin
```

A launch with nothing set takes the launchpad's defaults. To name a term, pass its option: each is checked against
the launchpad's range by the chain itself.

```ts
const plan = await client.plan({
  name: "Acme Coin",
  symbol: "ACME",
  metadataUri: "ipfs://bafy…",
  launcher: operator.address,
  launchpadId,
  schedule: {
    startPips: percentToPips("2"),
    steadyPips: percentToPips("2"),
    decaySecs: 0,
  },
  holderShareBps: percentToBps("25"), // a quarter of the creator's own take goes to the coin's holders
  vesting: { bps: percentToBps("10") }, // 10% of supply to the creator, on the launchpad's schedule
  devBuy: { amount: 10n ** 16n }, // 0.01 ETH of the coin for the launcher, in the launch transaction
});
plan.suite4?.terms; // the terms the coin will freeze: fees, shares, cap, clocks, takeover
plan.predictedToken; // the coin's address, before anything is signed
const tx = client.buildLaunchTx(plan); // for wagmi, a Safe or a bundler; or client.launch(input) sends it
```

- **The chain decides.** `plan()` reads the launchpad, fills what you left out from its defaults, asks the settings
  contract's own launch check (`resolve`) for the terms the coin would freeze, predicts the coin's address and
  simulates. No range of a launchpad or of Bankr is typed in the SDK.
- **A launch is pinned to what its plan showed.** If the terms or the coin's address differ when it lands, it
  reverts (`TERMS_CHANGED`) and `launch()` plans again, at most twice, and sends the new plan on the terms then in
  force. A change of the launchpad's payees stops it instead (`LAUNCHPAD_TERMS_CHANGED`). To review every change
  before a signature, call `plan()` and `buildLaunchTx()` yourself and compare `plan.suite4?.resolvedHash`.
  `pin: false` takes whatever is in force at inclusion.
- **A refusal reads in the chain's own numbers**: `OUTSIDE_LAUNCHPAD_RANGE` ("The wallet cap's length is fixed at 1
  day on this launchpad."), `NOT_ALLOWED_BY_LAUNCHPAD` for a feature the launchpad switched off, `HARD_BOUND` for
  one of the few bounds no setting moves, and the fee, split and vesting codes for those terms.
- **An option for a feature the launch leaves off is refused, never dropped** (`OPTION_FOR_FEATURE_OFF`): a buyback
  interval with no buyback share, a compound band with no auto-liquidity, a fee ceiling with no extension.
- **Pure mode.** A suite 4 launch needs only an RPC. Bankr's own launchpad (id 0) is signed through Bankr's API,
  which serves suite 4 in a later release, so in this one launch on a launchpad of your own.

## Extensions

An extension adds its own fee to a pool's swaps, on top of the launch's own fee. The hook binds it at launch for
the pool's whole life: nobody can change, add or remove one afterwards. Bankr ships three presets, and each is one
option on a launch. The option is the same on both suites. The limits, the ceiling and the switches below are
suite 4's, where the launchpad sets them; suite 3's are fixed in its contracts and are listed under
[Extensions on suite 3](#extensions-on-suite-3).

```ts
await client.launch({
  ...launch, // a launch input like the ones above
  extension: {
    preset: "sniper_tax",
    buyPips: percentToPips("5"), // buys pay 5% more
    sellPips: percentToPips("2"), // sells pay 2% more
    endSecs: 300, // for the first 5 minutes, then nothing
  },
});
```

| Preset     | `preset`            | Parameters                                   | On a new launchpad                                                                            |
| ---------- | ------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sniper Tax | `"sniper_tax"` or 1 | `buyPips`, `sellPips`, `endSecs`             | Buy 1 to 100,000 pips, sell 0 to 100,000; ends at most 3,600 seconds after launch             |
| Decay Tax  | `"decay_tax"` or 2  | `startBuyPips`, `startSellPips`, `decaySecs` | Each start 0 to 100,000 pips, not both 0; falls to 0 over at most 604,800 seconds (7 days)    |
| Pump Brake | `"pump_brake"` or 3 | `brakePips`, `thresholdTicks`                | 1 to 100,000 pips on buys while the price is at least 6,932 ticks (about 2x) above its launch |

- **The launchpad sets the limits.** Each preset is allowed or not per launchpad, with its longest window and its
  lowest brake threshold (`launchpads.setPresetLimits`); a preset's window always outlasts the launch's own opening
  fee. A parameter outside throws `EXTENSION_OUT_OF_BOUNDS`, and `err.detail` names the bound.
- **A preset has two spellings.** A launch names it `"sniper_tax"`, `"decay_tax"` or `"pump_brake"`. The settings
  name it as `EXTENSION_PRESETS` does: `launchpads.setPresetLimits(id, "sniperTax", …)`, and `"decayTax"`,
  `"pumpBrake"` and `"raffleRun"` likewise, which are also the keys of `settings.presets()`.
- **The fee has a ceiling.** The extension's fee and the launch's own fee together never pass the pool's ceiling:
  the launchpad's `feeCeilingPips` (10% on a new one), or the launch's own `feeCeilingPips` inside that range.
- **Who is paid.** Bankr takes its cut of an extension's fee (2/7 today, set by Bankr and frozen per coin). The rest
  goes to the launch's first fee recipient, or to the `payee` you name. A launch with several fee recipients must
  name it.
- **Who allows it.** The launchpad's switches say which kinds launch on it: `extPresets` (on for a new launchpad),
  and `extQuoteOnly` and `extCallsOut` for custom code (off until the operator switches them on, with the
  `extMaxPips` knob as the most such code may declare). Bankr's allowlist holds a key per extension. An extension
  that charges launches only on a launchpad that keeps `extOwnerSwitch` on: Bankr's stop for that extension then
  reaches the coin, and that is frozen with it. `plan()` reads all of it before a salt is mined and throws
  `EXTENSION_NOT_ALLOWED` with the reason.
- **Swaps need more gas.** Every swap of a pool with an extension adds `plan.extension.swapGasHeadroom` to its gas
  limit, on top of the 960,000 every Bankr pool takes (see [After launch](#after-launch)).

`client.previewExtension(extension, { launchpadId })` reads the same answers without planning a launch, for a
confirm screen: a `label` and `description` in Bankr's own words, the `terms` the hook will bind, the `feeTable`
second by second, the payee split, `warnings`, and `refusal`, the reason `plan()` would refuse it now. A plan
carries the same object as `plan.extension`, rebuilt from the terms the launch pins.

**Raw forms.** A preset can be named by its id and ABI-encoded parameters (`{ presetId: 1, params: "0x…" }`; Raffle
Run, id 4, is a reference extension and is named only this way), and custom code the allowlist holds by its code
hash can be bound by address:

```ts
extension: {
  address: "0x…",
  codehash: "0x…", // the hook checks the address holds exactly this code
  maxBuyPips: 20_000, // the most it may add to a buy, in pips
  maxSellPips: 20_000,
  quoteOnly: true, // it only quotes a fee; false if the hook also calls it after each swap
  sunsetSecs: 0, // never asked again from this second after launch; 0 = never ends
}
```

Custom code is unreviewed: the preview shows its declared maximum, not what it will charge, and it may refuse buys
(never sells).

## The holders' share

Holding a coin earns from it. There is nothing to stake: a holder's rewards accrue by balance, and it claims them
whenever it likes. Three things feed a coin's holders, and each is fixed for the coin at its launch:

| Source                                       | Who sets it                                                      | A new launchpad                                                                     | A launch names it with                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Part of Bankr's slice of every fee**       | Bankr (`settings.protocol().holdersShareBps`)                    | Half of Bankr's slice. It has no off state: it always streams to the coin's holders | -                                                                                                                                               |
| **Part of the creator side of every fee**    | The launchpad's `holdersBps` knob                                | 0 to 10,000 bps, default 1,167                                                      | `holderShareBps`: bps of the creator's own take, what the creator keeps after auto-liquidity and the buyback. 10,000 sends all of it to holders |
| **A slice of the supply, vested to holders** | The launchpad's `vestToHoldersBps` and `vestToHoldersSecs` knobs | Up to 5,000 bps over 1 day to 365 days; none unless the launch asks                 | `vestToHolders: { bps, cliffSeconds, durationSeconds }`                                                                                         |

```ts
await client.launch({
  ...launch,
  holderShareBps: percentToBps("100"), // the creator's whole take goes to holders
  vestToHolders: {
    bps: percentToBps("5"),
    cliffSeconds: 0,
    durationSeconds: 30 * 86_400,
  },
  holderStream: { seconds: 7 * 86_400, restartBps: 500 }, // where the launchpad's ranges allow it: a new one fixes both
});
```

- **What holders are paid in.** The creator side's part is paid in the coin's quote. Bankr's part is converted to
  BNKR by the coin's holder leg where that leg has a route for the quote, and paid in the quote where it has none
  (every quote on a chain without BNKR). Which of the two is frozen with the coin (`terms.holderConverts`).
- **Rewards stream.** A deposit is paid out over the coin's stream length (1 day on a new launchpad) so that
  nobody can buy, trigger a payout and sell. `holderStream` names the length and the restart share inside the
  launchpad's `rewardStreamSecs` and `rewardRestartBps` knobs.
- **A coin keeps its leg for life.** `client.suite4().holderLegs.ofCoin(token)` reads it, `.pile(token)` what waits
  there and when it is due, and `.buildPoke(token, from)` moves it along; anyone may send that.

## What freezes

Everything a launch resolves to is written once into the coin's own contracts and never read from the settings
again. `plan.suite4?.terms` shows it before the launch (`plan.suite4` is set on every suite 4 plan);
`client.suite4().coinTerms` reads it after.

| Frozen at launch                                                                                          | Where it came from                                                |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| The buy and sell fee schedules, the referrer's rate                                                       | The launch, inside the launchpad's ranges                         |
| Bankr's cut of each fee, its floor, the holders' half of it, Bankr's cut of an extension's fee            | Bankr's settings at that block                                    |
| The launchpad's payees and their shares, and its decay split                                              | The launchpad at that block                                       |
| The holders', auto-liquidity and buyback shares of the creator side; the fee recipients                   | The launch                                                        |
| The supply, the wallet cap's size and end, who may end it early, the metadata size limit                  | The launch and the launchpad                                      |
| The creator's vest, each allocation's schedule, a vest to holders                                         | The launch                                                        |
| Auto-liquidity's floor, cap, cadence and band; the buyback's cadence; the reward stream                   | The launch, the launchpad and the quote's row                     |
| The extension, its code hash, budgets, maxima and payee; the fee ceiling; whether Bankr's stop reaches it | The launch and the launchpad                                      |
| Whether the coin can be taken over, and the notice and grace a takeover must give                         | The launchpad's switch; Bankr's clock (48 hours and 7 days today) |
| The coin's holder leg, and whether it converts Bankr's part to BNKR                                       | The suite's wiring at that block                                  |
| The trading start                                                                                         | The launch                                                        |

```ts
const { coinTerms } = client.suite4();
const record = coinTerms.fromReceipt(receipt); // or: await coinTerms.frozen(token)
const check = await coinTerms.verify(token, record); // the record hashes to the coin's fingerprint,
// and every word of it is still what the coin's own contracts hold
```

- **A change reaches future launches only.** Bankr's changes take effect in one transaction with no waiting period,
  and so do a launchpad's; neither can touch a coin that has launched. That is also why a launch is pinned: the
  terms you were shown are the terms the coin gets, or the launch reverts.
- **What can still act on a live coin** is only what its own frozen terms grant: a takeover where the coin froze it
  on, after the frozen notice; ending a wallet cap early by the frozen controller; Bankr's stop for an extension
  where the coin froze that; the metadata admin the launch named; and each recipient over its own share.
  [Trust, stated plainly](https://docs.bankr.bot/token-launching/launch-sdk/trust) lists every lever.
- **Fixed for every coin**: no owner, no mint, 18 decimals; a name, symbol and supply that never change; a
  scheduled trading start that cannot be moved or called off. `client.verifyTokenInvariants(token, receipt)` holds
  a coin to its own record.

## Every option, with its default

### The client

`createLaunchClient(options)`:

| Option                   | Default                | What it is                                                                                                                                                                                      |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`                  | required               | `"base"`, `"robinhood"`, `"arbitrum"` or `"arc"`. There is no default chain                                                                                                                     |
| `suite`                  | 3                      | Which of Bankr's suites the client is on. Ask for the configurable suite with `suite: 4`; a fork's `addresses` that name `settings` are suite 4's too. A coin stays on the suite it launched on |
| `publicClient`           | built from `rpcUrl`    | Any viem public client, for reads and simulations                                                                                                                                               |
| `rpcUrl`                 | the chain's public RPC | Required on Arc, recommended on Robinhood                                                                                                                                                       |
| `walletClient`           | none                   | Signs `launch()`; not needed to plan or to build unsigned transactions                                                                                                                          |
| `authorizer`             | none                   | Signs launches on a launchpad that has a signer                                                                                                                                                 |
| `builderCodes`           | none                   | ERC-8021 builder codes appended to launch calldata                                                                                                                                              |
| `appendBankrBuilderCode` | `false`                | Also append Bankr's own builder code                                                                                                                                                            |
| `api`                    | `false` (pure mode)    | API mode: `launch()` registers each launch with Bankr's index and, with a `preparer`, Bankr's prepare endpoint builds it. The `preparer` is suite 3's in this version                           |
| `addresses`              | the suite's record     | A fork's or a test's suite, merged over the record of the client's own suite; a record that names `settings` is suite 4's                                                                       |
| `fork`                   | `false`                | Launch on a suite this SDK version has not shipped (your own deploy, an anvil fork). Never against a live chain                                                                                 |

### A launch

`client.plan(input)` and `client.launch(input)`. Only `name`, `symbol` and `launcher` are required. "The launchpad's"
means the default of that launchpad's knob at the block the launch is planned, read from the chain; the figures in
brackets are a new launchpad's.

| Option                                                    | Default                                                              | What it names                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `symbol`                                          | required                                                             | 1 to 100 and 1 to 20 characters                                                                                                   |
| `launcher`                                                | required                                                             | The account that sends the launch: it pays any dev buy and is the default fee and vesting recipient                               |
| `launchpadId`                                             | `0n`, Bankr's launchpad                                              | The launchpad                                                                                                                     |
| `quote`                                                   | WETH (USDC on Arc)                                                   | A named major or any ERC-20's address, where the launchpad takes it                                                               |
| `metadataUri`                                             | `""`                                                                 | The coin's metadata link, inside the launchpad's `metadataBytes` (at most 2,048 bytes)                                            |
| `metadataAdmin`                                           | nobody: the link is fixed                                            | Who may replace the link after launch. Part of the coin's address                                                                 |
| `fees` / `schedule`                                       | the launchpad's (0.05% each way, no opening fee)                     | Each direction's `{ startPips, steadyPips, decaySecs }`, or one schedule for both                                                 |
| `referrerBps`                                             | the launchpad's (0)                                                  | A referrer's part of each fee                                                                                                     |
| `holderShareBps`                                          | the launchpad's (1,167 bps of the creator side)                      | The holders' part of the creator's own take                                                                                       |
| `autoLpBps` or `autoLp.bps`                               | the launchpad's (3,000)                                              | Auto-liquidity's part of the creator side                                                                                         |
| `autoLp.floor`, `autoLp.cap`                              | the quote's row                                                      | The compound's floor and cap in the quote's base units, both together, where the launchpad's `launchCompoundAmounts` switch is on |
| `autoLp.intervalSeconds`, `.shareBps`, `.deviationTicks`  | the launchpad's (300 s, 2,500 bps, 488 ticks)                        | The compound's cadence and price gate. One left out keeps the launchpad's                                                         |
| `autoLp.band`                                             | the launchpad's (6,800 and 2,000 ticks)                              | `{ halfWidthTicks, gridTicks }`, on the 200 grid                                                                                  |
| `buybackBps` or `buyback.bps`                             | the launchpad's (0)                                                  | The buyback's part of the creator side                                                                                            |
| `buyback.intervalSeconds`, `.retrySeconds`                | the launchpad's (300 s, 60 s)                                        | The buyback's cadence                                                                                                             |
| `holderStream`                                            | the launchpad's (86,400 s, 1,000 bps)                                | `{ seconds, restartBps }`: how holder rewards stream                                                                              |
| `supply`                                                  | the launchpad's (100 billion)                                        | The total supply in base units (18 decimals)                                                                                      |
| `walletCap`                                               | the launchpad's (2% of supply for 1 day)                             | `{ bps, seconds }`, or `false` for no cap                                                                                         |
| `capExclusions`                                           | the chain's settlers, on a capped launch                             | Wallets exempt from the wallet cap, where the launchpad's `capExclusions` switch is on                                            |
| `vesting`                                                 | the launchpad's (15% of supply, a 30-day cliff, unlocked by day 365) | `{ bps, recipient, cliffSeconds, durationSeconds }`; a cliff and a length of 0 unlock at the trading start                        |
| `vestToHolders`                                           | none                                                                 | `{ bps, cliffSeconds, durationSeconds }`: supply vested to the coin's holders                                                     |
| `allocations`                                             | none                                                                 | `[{ recipient, amount, cliffSeconds, durationSeconds }]`; each unlocks at the trading start unless it names a schedule            |
| `feeRecipient` / `feeRecipients`                          | the launcher                                                         | Who claims the creator's take: one account, or up to the launchpad's `feeRecipients` (10) with shares summing to 10,000           |
| `allowContractFeeRecipient`, `allowOpenCodeFeeRecipients` | `false`                                                              | Waivers for a contract recipient ([Fee recipients](#fee-recipients-a-metadata-admin-and-a-scheduled-start))                       |
| `claimOperator`                                           | none                                                                 | The claim operator of a contract fee recipient with restricted claims, on a coin that can be taken over                           |
| `devBuy`                                                  | none                                                                 | `{ amount, slippageBps }` in the quote's base units; `slippageBps` defaults to 200                                                |
| `startTime`                                               | at launch                                                            | When trading opens, inside the launchpad's `startDelaySecs` (up to 7 days ahead)                                                  |
| `curve`                                                   | `"runner_v1"`                                                        | A built-in curve or your own bands, where the launchpad allows them                                                               |
| `startFdv`                                                | the launchpad's start ($10,000 for the whole supply)                 | The whole supply's value at the start, in the quote's base units. Required on a quote Bankr does not list                         |
| `extension`                                               | none                                                                 | A preset, a raw preset or custom code ([Extensions](#extensions))                                                                 |
| `feeCeilingPips`                                          | the launchpad's (100,000)                                            | With an extension: the most the two fees reach together                                                                           |
| `pin`                                                     | `true`                                                               | Pin the launch to the planned terms and coin address                                                                              |
| `salt`                                                    | mined by the SDK                                                     | A single-use bytes32 of your own                                                                                                  |
| `deadlineSeconds`                                         | 1,200                                                                | Raise it for a Safe or an ERC-4337 launcher                                                                                       |

A term left out of a group takes the launchpad's default: `vesting: { bps, durationSeconds }` keeps its cliff.

Auto-liquidity places its fees inside a swap once they reach `autoLp.floor`. Under the floor anyone can place them
by calling the hook's `compound(poolId)` and paying the gas; the cap, the interval and the price gate apply to that
call as they do in a swap.

### A launchpad's knobs

`launchpads.configure(id, { knobs })` or `launchpads.setKnobs(id, knobs)`. Each knob is `{ min, max, default }`,
and any of the three may be left out. "A new launchpad" is the template Bankr holds, which `register` copies;
`settings.template()` reads it live and `settings.limits()` Bankr's limits. Bankr can change both for launchpads
registered later; the figures below are the ones the suite deploys with.

| Knob                     | What it sets                                                                    | A new launchpad's range | Default         | The owner's limit              | A launch names it with          |
| ------------------------ | ------------------------------------------------------------------------------- | ----------------------- | --------------- | ------------------------------ | ------------------------------- |
| `steadyPips`             | The trading fee, each direction, once any opening fee has decayed (pips)        | 500 to 100,000          | 500             | 500 to 999,999                 | `fees`, `schedule`              |
| `startPips`              | The fee a launch may open at before it decays (pips)                            | 0 to 800,000            | 0               | 0 to 999,999                   | `fees`, `schedule`              |
| `decaySecs`              | How long the opening fee takes to fall to the steady fee (seconds)              | 0 to 120                | 0               | 0 to 120                       | `fees`, `schedule`              |
| `referrerBps`            | A referrer's part of each fee (bps of the fee)                                  | fixed at 0              | 0               | 0 to 10,000                    | `referrerBps`                   |
| `holdersBps`             | The coin's holders' part of the creator side (bps)                              | 0 to 10,000             | 1,167           | 0 to 10,000                    | `holderShareBps`                |
| `autoLpBps`              | Auto-liquidity's part of the creator side (bps)                                 | 0 to 10,000             | 3,000           | 0 to 10,000                    | `autoLpBps`, `autoLp.bps`       |
| `buybackBps`             | The buyback's part of the creator side (bps)                                    | 0 to 10,000             | 0               | 0 to 10,000                    | `buybackBps`, `buyback.bps`     |
| `vestBps`                | The creator's vested slice of supply; the top also counts allocations (bps)     | 0 to 5,000              | 1,500           | 0 to 9,999                     | `vesting.bps`, `allocations`    |
| `vestToHoldersBps`       | The most of supply a launch may vest to its holders (bps)                       | 0 to 5,000              | 0               | 0 to 9,999                     | `vestToHolders.bps`             |
| `vestedTotalBps`         | The most of supply vested in all: creator, allocations and holders (bps)        | 0 to 5,000              |                 | 0 to 9,999                     | a ceiling                       |
| `vestToHoldersSecs`      | How long a vest to holders runs (seconds)                                       | 86,400 to 31,536,000    | 31,536,000      | 0 to 2^32 - 1                  | `vestToHolders.durationSeconds` |
| `vestCliffSecs`          | The creator's cliff (seconds)                                                   | fixed at 2,592,000      | 2,592,000       | 0 to 2^32 - 1                  | `vesting.cliffSeconds`          |
| `vestSecs`               | The creator's vest, start to fully unlocked (seconds)                           | fixed at 31,536,000     | 31,536,000      | 0 to 2^32 - 1                  | `vesting.durationSeconds`       |
| `supply`                 | The total supply (whole tokens)                                                 | 1 to 100,000,000,000    | 100,000,000,000 | 1 to 1,000,000,000,000,000,000 | `supply`                        |
| `capBps`                 | The wallet cap's size (bps of supply)                                           | fixed at 200            | 200             | 0 to 10,000                    | `walletCap.bps`                 |
| `capSecs`                | The wallet cap's length; a top of 0 means no cap (seconds)                      | fixed at 86,400         | 86,400          | 0 to 2^32 - 1                  | `walletCap.seconds`             |
| `devBuyMaxBps`           | The most of supply a dev buy may take (bps)                                     | 0 to 200                |                 | 0 to 10,000                    | a ceiling on `devBuy`           |
| `startDelaySecs`         | How far ahead a scheduled start may be (seconds)                                | 0 to 604,800            |                 | 0 to 604,800                   | a ceiling on `startTime`        |
| `startFdvUsd`            | The starting market cap on a priced quote (whole USD)                           | 2,000 to 125,000,000    | 10,000          | 0 to 2^64 - 1                  | `curve.startFdvUsd`             |
| `metadataBytes`          | The longest metadata link (bytes)                                               | 0 to 2,048              |                 | 0 to 2,048                     | a ceiling on `metadataUri`      |
| `feeRecipients`          | How many fee recipients a launch may name                                       | 1 to 10                 |                 | 1 to 10                        | a ceiling on `feeRecipients`    |
| `compoundIntervalSecs`   | The least time between two auto-liquidity compounds (seconds)                   | fixed at 300            | 300             | 1 to 31,536,000                | `autoLp.intervalSeconds`        |
| `compoundShareBps`       | The most of the backlog one compound places; 0 is no share cap (bps)            | fixed at 2,500          | 2,500           | 0 to 10,000                    | `autoLp.shareBps`               |
| `compoundDeviationTicks` | How far the price may sit from its average for a compound to run (ticks)        | fixed at 488            | 488             | 1 to 1,800                     | `autoLp.deviationTicks`         |
| `bandHalfWidth`          | The compound band's half width (spacings of 200 ticks)                          | fixed at 34             | 34              | 1 to 8,872                     | `autoLp.band.halfWidthTicks`    |
| `bandGrid`               | The grid the compound band snaps to (spacings of 200 ticks)                     | fixed at 10             | 10              | 1 to 8,872                     | `autoLp.band.gridTicks`         |
| `buybackIntervalSecs`    | The least time between two buyback fills (seconds)                              | fixed at 300            | 300             | 300 to 31,536,000              | `buyback.intervalSeconds`       |
| `buybackRetrySecs`       | The wait after a fill that could not run (seconds)                              | fixed at 60             | 60              | 60 to 31,536,000               | `buyback.retrySeconds`          |
| `rewardStreamSecs`       | How long a deposit of holder rewards streams (seconds)                          | fixed at 86,400         | 86,400          | 86,400 to 2,592,000            | `holderStream.seconds`          |
| `feeCeilingPips`         | The most the fee and an extension's fee reach together (pips)                   | fixed at 100,000        | 100,000         | 0 to 999,999                   | `feeCeilingPips`                |
| `extMaxPips`             | The most custom extension code may declare it adds (pips)                       | 0 to 100,000            |                 | 0 to 16,777,214                | a ceiling on `extension`        |
| `curveMinDepthDiv`       | Own bands: a band holds at least 1 / this of a flat curve's depth               | fixed at 10             | 10              | 1 to 2^32 - 1                  | a rule for `curve`              |
| `curveMaxDensity`        | Own bands: a band holds at most this many times the flat depth left             | fixed at 2              | 2               | 1 to 2^32 - 1                  | a rule for `curve`              |
| `curvePlaceTicks`        | Own bands: the reach, from the start, that must hold most of the sale (ticks)   | fixed at 120,000        | 120,000         | 0 to 1,774,400                 | a rule for `curve`              |
| `curvePlaceBps`          | Own bands: the part of the sale placed inside that reach (bps)                  | fixed at 9,000          | 9,000           | 0 to 10,000                    | a rule for `curve`              |
| `curveDustPpm`           | Own bands: the most of the sale rounding may leave unplaced (parts per million) | fixed at 2              | 2               | 0 to 1,000,000                 | a rule for `curve`              |
| `padShareBps`            | The most a launchpad's payees take of the remainder together (bps)              | 0 to 10,000             |                 | 0 to 10,000                    | a ceiling on a pad's payees     |
| `rewardRestartBps`       | The part of the stream left that a top-up must reach to restart it (bps)        | fixed at 1,000          | 1,000           | 1 to 10,000                    | `holderStream.restartBps`       |

A ceiling has no default: a launch may go up to its top. Bankr's own launchpad differs from a new one in five rows:
its fee is fixed at 17,500 pips opening at 800,000 for 14 seconds, its holders' part of the creator side defaults to
0, and its auto-liquidity is fixed at 3,000 bps. Its switches differ in three: takeover is on, unlisted quotes are off
and custom extension code is on.

### A launchpad's switches

`launchpads.configure(id, { switches })` or `launchpads.setSwitches(id, switches)`. A feature launches only where
the launchpad has its switch on and Bankr allows that switch at all (`settings.allowedSwitches()`; all of them
today).

| Switch                  | A new launchpad | On, a launch may                                                                                                                                                             |
| ----------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devBuy`                | on              | Buy the coin in the launch transaction                                                                                                                                       |
| `allocations`           | on              | Give slices of the supply to other wallets                                                                                                                                   |
| `capExclusions`         | on              | Exempt wallets from the wallet cap                                                                                                                                           |
| `metadataAdmin`         | on              | Name an account that can replace the metadata link                                                                                                                           |
| `takeover`              | **off**         | Nothing: it lets Bankr's takeover authority move the creator's share of the launchpad's future coins after a public notice. Only the launchpad's own operator switches it on |
| `unlistedQuotes`        | on              | Pair with a token Bankr does not list                                                                                                                                        |
| `extPresets`            | on              | Bind one of Bankr's preset extensions                                                                                                                                        |
| `extQuoteOnly`          | off             | Bind custom extension code that only quotes a fee                                                                                                                            |
| `extCallsOut`           | off             | Bind custom extension code the hook also calls after each swap                                                                                                               |
| `extOwnerSwitch`        | on              | Bind an extension that charges; Bankr's stop for it then reaches the coin                                                                                                    |
| `launchCompoundAmounts` | off             | Name its own compound floor and cap                                                                                                                                          |

### Payees, quotes, curves and presets

| Setting                     | A new launchpad                                                                                              | Builder                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payees                      | The ones `register` named: at most 4, sharing the remainder of each fee after Bankr's slice and any referrer | `setPayees(id, payees, { decayAutoLpBps })`, or `configure`                                                                                                          |
| Decay split                 | Off                                                                                                          | Give a payee a `decayShareBps`: the surplus of an opening fee above the steady fee is then split on its own                                                          |
| Cap controller              | The template's                                                                                               | `setCapController(id, account or null)`: who may end the wallet cap early on future coins                                                                            |
| Quotes                      | Every quote                                                                                                  | `setQuoteTerms(id, quote, { allowed, ownAmounts, compoundFloor, compoundCap })`: a launchpad that lists one quote takes only the ones it lists                       |
| Curves                      | The three built-ins; no own bands                                                                            | `setCurveAllowed(id, curve, allowed)`, with `"any"` for any bands                                                                                                    |
| Preset limits               | Each preset allowed, with the windows in [Extensions](#extensions)                                           | `setPresetLimits(id, preset, { allowed, maxWindowSecs, minBrakeTicks, minAnchorTau })`, with `preset` as `"sniperTax"`, `"decayTax"`, `"pumpBrake"` or `"raffleRun"` |
| Signer, suffix, link, pause | Open, no suffix, the link `register` named, not paused                                                       | `setSigner`, `setVanity`, `setMetadataUri`, `setPaused`                                                                                                              |
| Operator                    | The account that registered                                                                                  | `transferOperator(id, next)`, then `acceptOperator(id)` from `next`                                                                                                  |

## Launchpad admin guide

`client.suite4().launchpads` builds every change a launchpad's operator can make. Each returns an unsigned
transaction and sends nothing.

- **A partial change is read-modify-write.** What a call leaves out is restated as read when it was built, and the
  contract writes the whole row. Two built from the same state undo each other: in one batch (a Safe multi-send)
  make one call per row and name every field in it, or build the next after the first lands. `configure` carries
  the switches, the cap controller and the payees whole.
- **Bankr's limits can move under you.** A knob is met inside Bankr's limit as it stands at the launch, so after
  Bankr narrows one, `settings.pad(id).knobs` (your row as stored) and `.atLaunch.knobs` (what a launch meets)
  differ. Take launch defaults from `atLaunch`.
- **A switch Bankr stops allowing is never cleared in silence.** While your launchpad holds one, `configure` and
  `setSwitches` refuse until the call names it `false`; written off, it stays off when Bankr allows it again.
- **Payee limits can stop a launchpad.** If Bankr lowers the number of payees a launchpad may name, or the share
  they may take together, a launchpad over the new limit cannot launch until its operator sets its payees again.
- **Collecting your share.** Each payee claims its own part from the fee ledger, like any fee recipient
  ([After launch](#after-launch)).

## Settings reference

`client.suite4()` returns five namespaces. Reads need no wallet; builders return unsigned transactions.

| Namespace    | What it holds                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings`   | `protocol()` (Bankr's cut, the takeover clock, the payee count), `guards()`, `limits()`, `allowedSwitches()`, `template()`, `pad(id)`, `quotes()`, `quote(address)`, `padQuote(id, quote)`, `presets()`, `extensionAllowed(key)`, `pricing()`, `suite()` (owner, pause, gate, hook, holder leg, bond), and `preview(params, { launcher })`: the chain's launch check as a read |
| `launchpads` | A launchpad operator's builders: `register`, `configure`, `setKnobs`, `setSwitches`, `setTakeover`, `setPayees`, `setCapController`, `setQuoteTerms`, `setCurveAllowed`, `setPresetLimits`, `setSigner`, `setVanity`, `setMetadataUri`, `setPaused`, `transferOperator`, `acceptOperator`                                                                                      |
| `owner`      | Bankr's own builders, from the factory's owner: `setProtocolTerms`, `setGuardTerms`, `setLimits`, `setTemplate`, `setAllowedSwitches`, `setQuote`, `removeQuote`, `setPreset`, `setExtensionAllowed`, `setHolderLeg`, `setHook`, `setTreasury`, `setPaused`, `setLaunchGated` and the rest. `setProtocolTerms` and `setLimits` return the launchpads the change would stop     |
| `coinTerms`  | A coin's frozen record: `fromReceipt`, `frozen(token)`, `fingerprint(token)`, `stored(token)`, `verify(token, record)`                                                                                                                                                                                                                                                         |
| `holderLegs` | The holders' legs: `current()`, `get(leg)`, `ofCoin(token)`, `byLeg(tokens)`, `pile(token)`, `buildPoke`, `buildConvert`                                                                                                                                                                                                                                                       |

Knobs, switches and presets are named, never numbered: `SETTINGS_KNOBS`, `PAD_FLAGS` and `EXTENSION_PRESETS` list
each with its unit and the range no setting can widen.

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
launch is mined and within the launchpad's own limit: its `startDelaySecs` knob (7 days on a new launchpad; a top of 0
means the launchpad allows none). Nobody can move it or call it off afterwards. Vesting and the opening fee count from the start.

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

In this version these namespaces are built for suite 3's coins. For a suite 4 coin, read its record with
`client.suite4().coinTerms` and its holders' leg with `client.suite4().holderLegs`, parse its launch with
`client.parseLaunchReceipt` and check it with `client.verifyTokenInvariants`; fee, holder and vesting claims for
suite 4 coins come in a later alpha.

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

Each suite has its own fee ledger, and a client reads and claims on its own suite's alone. An account with coins on
both suites of a chain claims once from a client of each (`suite: 3` and `suite: 4`); the two never count the same
fee.

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

## Suite 3: the suite live today

Suite 3 is the suite live on Base today. A client is on it unless it asks for suite 4, and a chain's suite 4
record shipping does not change that. Its coins stay on it for good: launch on it, and read and claim its coins,
with a suite 3 client. Its figures are compiled into its contracts where suite 4 reads a launchpad's: a supply of 100
billion, a 2% wallet cap for 24 hours, vesting of at most 50% with a 30-day cliff, and Bankr's slice of each fee.
The suite 4 options of [A launch](#a-launch) (`supply`, `walletCap`, `allocations`, `autoLp`, `buyback`,
`holderStream`, `capExclusions`, `feeCeilingPips`, `pin`, `claimOperator`) are refused there, never ignored, and
`client.suite4()` throws: a suite 3 launchpad is run through `client.launchpads`, whose builders in turn refuse on
a suite 4 client and name `client.suite4().launchpads`.

### Launch on Bankr's launchpad

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

### Launch from your app

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

### Run a suite 3 launchpad

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

#### Extensions on suite 3

A suite 3 launch takes the same `extension` option as [Extensions](#extensions) shows. What differs is who holds
the rules: suite 3's contracts hold them, and no launchpad setting moves them.

| Preset     | Suite 3's bounds                                                                            |
| ---------- | ------------------------------------------------------------------------------------------- |
| Sniper Tax | Buy 1 to 100,000 pips, sell 0 to 100,000; ends 121 to 3,600 seconds after launch            |
| Decay Tax  | Each start 0 to 100,000 pips, not both 0; falls to 0 over 121 to 604,800 seconds (7 days)   |
| Pump Brake | 1 to 100,000 pips on buys while the price is 6,932 (about 2x) to 887,272 ticks above launch |

- **Bounds are checked first.** A value outside throws `EXTENSION_OUT_OF_BOUNDS` before the chain is read, and
  `err.detail` names the bound ("Sniper Tax end (seconds) must be between 121 and 3600."). `PRESET_BOUNDS` holds
  every number.
- **The ceiling is 10%.** The extension's fee and the launch's own fee together never pass it, and no option
  moves it (`feeCeilingPips` is suite 4's). While the launch's own fee is at 10% or more, the extension charges
  nothing. Bankr takes 2/7 of an extension's fee.
- **Who allows it.** Bankr's allowlist holds a key per extension, and the launchpad's policy says which kinds
  launch on it. A new launchpad allows the presets and no custom code. Its operator changes that with
  `client.launchpads.setPolicy(launchpadId, { allowedExtensions, maxExtensionPips })`: bit 0 of
  `allowedExtensions` is the presets, bit 1 custom code that only quotes a fee, bit 2 custom code the hook also
  calls after each swap, and `maxExtensionPips` (at most 100,000) is the most such code may declare.
- **Pure mode only.** Bankr's prepare endpoint takes no extension, so a client with a `preparer`, and Bankr's own
  launchpad, refuse the option (`INVALID_PARAMS`).

#### Pair with any token

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

| Kind        | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`    | `PROVIDER_NOT_DEPLOYED`, `UNSUPPORTED_CHAIN`, `RPC_REQUIRED`, `WALLET_REQUIRED`, `API_KEY_IN_BROWSER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `refused`   | `PAUSED`, `LAUNCHPAD_GATED`, `UNKNOWN_LAUNCHPAD`, `LAUNCHPAD_PAUSED`, `AUTHORIZATION_REQUIRED`, `PRICE_ATTESTATION_REQUIRED`, `QUOTE_NOT_ALLOWED`, `CURVE_NOT_ALLOWED`, `EXTENSION_NOT_ALLOWED`, `EXTENSION_OUT_OF_BOUNDS`, `DEV_BUY_UNAVAILABLE`, `INVALID_PARAMS`, `INVALID_PERCENT`, `FEE_OUT_OF_BOUNDS`, `SPLIT_OUT_OF_BOUNDS`, `VESTING_OUT_OF_BOUNDS`, `BUILDER_LANE_NOT_ALLOWED`, `OUTSIDE_LAUNCHPAD_RANGE`, `NOT_ALLOWED_BY_LAUNCHPAD`, `HARD_BOUND`, `OPTION_FOR_FEATURE_OFF`, `CLAIM_OPERATOR_REQUIRED`, `LAUNCH_REFUSED`, `CREATOR_CAP_EXCEEDED`, `LAUNCHER_IS_FORWARDER`, `LAUNCHER_MISMATCH`, `FEE_RECIPIENT_CANNOT_CLAIM`, `NOT_A_LAUNCH`, `NOT_A_BENEFICIARY`, `CLAIM_NOT_ALLOWED`, `NO_VESTING`, `NOT_METADATA_ADMIN`, `INVALID_LAUNCHPAD_CONFIG`, `INVALID_SETTINGS` |
| `execution` | `SIMULATION_REVERTED`, `POOL_ALREADY_INITIALIZED`, `START_TICK_CHANGED`, `PREDICTION_MISMATCH`, `VANITY_UNAVAILABLE`, `AUTHORIZATION_INVALID`, `LAUNCHPAD_TERMS_CHANGED`, `TERMS_CHANGED`, `STALE_POLICY`, `RECEIPT_MISSING_LAUNCH`, `RECEIPT_MISSING_LAUNCHPAD`, `TRANSACTION_REVERTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `api`       | `API_KEY_OVERPRIVILEGED`, `API_ERROR`, `RATE_LIMITED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

[Errors](https://docs.bankr.bot/token-launching/launch-sdk/errors) explains each code and Bankr's API codes.

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
