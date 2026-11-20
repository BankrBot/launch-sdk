# @bankr/launch-sdk

Launch tokens and run your own launchpad on Bankr's Uniswap v4 hook contracts. One transaction from your own wallet
creates an ERC-20 and its pool with the liquidity locked, and a launchpad you register sets the rules for every coin
launched on it and pays you a share of every trade.

**Docs: [docs.bankr.bot/token-launching/launch-sdk/overview](https://docs.bankr.bot/token-launching/launch-sdk/overview)**

## Install

```sh
npm install @bankr/launch-sdk@alpha viem
```

ESM only. Node 22 or later, Bun, or any modern browser. `viem` 2.57.8 or later is the only peer dependency.

## Quick start

Register a launchpad and launch a coin on it. This spends real ETH on Base: a one-time 0.01 ETH bond, and gas.

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { waitForTransactionReceipt } from "viem/actions";
import { base } from "viem/chains";
import { createLaunchClient } from "@bankr/launch-sdk";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const wallet = createWalletClient({ account, chain: base, transport: http() });
const client = createLaunchClient({ chain: "base", walletClient: wallet });
const { launchpads } = client.contracts();

// A launchpad launches where the chain reports paused: false, gated: false.
const { paused, gated } = await client.status();
if (paused || gated) throw new Error("A launchpad cannot launch here.");

// Register your launchpad: one transaction, which pays the bond.
// Its payee, you, takes 20% of each trading fee after Bankr's cut.
const payees = [{ address: account.address, shareBps: 2_000 }];
const pad = { operator: account.address, payees };
const { to, data, value } = await launchpads.register(pad);
const hash = await wallet.sendTransaction({ to, data, value });
const receipt = await waitForTransactionReceipt(client.publicClient, { hash });
const launchpadId = launchpads.launchpadIdFromReceipt(receipt);

// Launch a coin on it: an ERC-20 and its Uniswap v4 pool, liquidity locked.
const coin = { name: "My Coin", symbol: "MINE", launcher: account.address };
const { token } = await client.launch({ ...coin, launchpadId });
console.log(`launchpad ${launchpadId}, token ${token}`);
```

Save it as `quickstart.ts` and run it once with `PRIVATE_KEY=0x… bun quickstart.ts`. Each run registers a new launchpad
and pays the bond again.

The SDK never holds your keys. `client.launch` sends from the wallet you give it, and every other call returns an
unsigned transaction for you to send.

[Getting started](https://docs.bankr.bot/token-launching/launch-sdk/quickstart) walks through it step by step:
register, configure, launch, read the coin back and claim your fees.

## What you can build

- **Your own launchpad.** Set the fee range, your share of every trade, snipe protection, the supply, the wallet cap
  and vesting. You write no contracts.
  [Set up a launchpad](https://docs.bankr.bot/token-launching/launch-sdk/your-own-launchpad)
- **Token launches inside your app.** Your users launch from their own wallets, or your server launches for them.
  [Launch for your users](https://docs.bankr.bot/token-launching/launch-sdk/launch-from-your-app)
- **A coin of your own.** One script, with the options you want.
  [Launch a token yourself](https://docs.bankr.bot/token-launching/launch-sdk/launch-a-token)
- **Coins with their own trading rules.** A sniper tax, a tax that fades, a brake on pumps, a raffle on every buy, or
  your own rule in Solidity. [Extensions](https://docs.bankr.bot/token-launching/launch-sdk/extensions)
- **Coins that pay their holders.** Part of every trading fee goes to the wallets that hold the coin, with nothing to
  stake. [Fees and rewards](https://docs.bankr.bot/token-launching/launch-sdk/fees)
- **Dashboards with no indexer.** Bankr indexes every launch on every launchpad. Read it from the SDK or over HTTP,
  with no key. [Reading launches](https://docs.bankr.bot/token-launching/launch-sdk/launch-index)

## Supported chains

| Chain           | `chain`       |
| --------------- | ------------- |
| Base            | `"base"`      |
| Robinhood Chain | `"robinhood"` |
| Arbitrum        | `"arbitrum"`  |
| Arc             | `"arc"`       |

[Chains and addresses](https://docs.bankr.bot/token-launching/launch-sdk/chains) has every contract address. Before
you register a launchpad on a chain, read `client.status()`: a launchpad launches where it reports `gated: false`.

## Documentation

| Page                                                                               | What it covers                                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Overview](https://docs.bankr.bot/token-launching/launch-sdk/overview)             | What the SDK does, and where to start.                                 |
| [Getting started](https://docs.bankr.bot/token-launching/launch-sdk/quickstart)    | Your own launchpad and your first coin, step by step.                  |
| [Configuration](https://docs.bankr.bot/token-launching/launch-sdk/configuration)   | Every launchpad setting and launch option, with its range and default. |
| [Extensions](https://docs.bankr.bot/token-launching/launch-sdk/extensions)         | The built-in extensions, what you can build with them, and your own.   |
| [Fees and rewards](https://docs.bankr.bot/token-launching/launch-sdk/fees)         | How a fee splits, and how each party claims.                           |
| [SDK reference](https://docs.bankr.bot/token-launching/launch-sdk/options)         | Every method, helper and constant.                                     |
| [Launch API](https://docs.bankr.bot/token-launching/launch-sdk/builder-api)        | The HTTP API behind the SDK's reads.                                   |
| [Errors](https://docs.bankr.bot/token-launching/launch-sdk/errors)                 | Every error code, its cause and what to do.                            |
| [What is fixed at launch](https://docs.bankr.bot/token-launching/launch-sdk/trust) | What can and cannot change after a coin launches.                      |

## License

MIT
