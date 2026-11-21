# Security

Please don't report a vulnerability in a public issue, discussion or pull request.

## Reporting a vulnerability

File a report at the [Bankr Help Center](https://help.bankr.bot/inbox/new) with Request Type **Bug Bounty / Vulnerability**. Include what the issue is, a step-by-step reproduction, ideally a working proof of concept, and the accounts and wallet addresses you tested from, with dates. We only accept reports filed there.

For **Critical** issues only, you can also email [security@bankr.bot](mailto:security@bankr.bot) a short alert with your ticket link. Don't send the report itself by email: reports sent only by email are not reviewed and earn no reward.

Scope, rewards and safe harbor follow Bankr's [Bug Bounty & Vulnerability Policy](https://docs.bankr.bot/security/bug-bounty).

## What we most want to hear about in this SDK

- A transaction that differs from what its inputs describe, or that sends funds or fees to an address the caller did not pass.
- A wrong token or pool address prediction, or a launch the SDK reports as verified when its on-chain invariants do not hold.
- An API key that can reach a browser bundle, or a request that gets past `createPrepareHandler`'s required `authorize` check.

Test against a local fork. Never test against other people's tokens, pools or funds.

## Supported versions

Fixes ship in a new version on the `latest` dist-tag. A version that a fix supersedes is deprecated on npm with an upgrade message.
