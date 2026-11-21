# Changelog

Versions of `@bankr/launch-sdk`, newest first. A heading carries the date its version went live on npm.

Stable versions are on the `latest` dist-tag, which `npm install @bankr/launch-sdk viem` installs. A prerelease is on a dist-tag of its own.

## 1.0.0

The first stable version.

- Launch tokens and run your own launchpad on Bankr's Uniswap v4 hook contracts, from your own wallet, on Base, Robinhood Chain, Arbitrum, Arc, Ethereum and BNB Chain.
- Register a launchpad and set its fee range, payees, snipe protection, supply, wallet cap, vesting and extensions.
- Plan, simulate and send a launch, read a coin back from the chain, and build every fee, holder-reward and vesting claim as an unsigned transaction.
- Read Bankr's launch index and register a launch with it on every chain, with no key.
- Since `1.0.0-alpha.0`: the launch index covers Ethereum and BNB Chain, so `ChainCapabilities.indexed` and the `INDEX_NOT_COVERED` error code are removed.
