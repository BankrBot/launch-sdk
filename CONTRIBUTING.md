# Contributing

`@bankr/launch-sdk` is developed in Bankr's private monorepo and exported here one way. Each export is a single commit, `export of BankrBot/bankr@<sha>`, that replaces this repo's tree. So:

- **Issues** are welcome: bugs, docs gaps and feature requests.
- **Pull requests** are welcome too, but they are not merged here. A maintainer re-applies an accepted change in the monorepo, credits you, and it arrives with the next export. Small, focused PRs are the easiest to take.
- **Security reports** follow [SECURITY.md](SECURITY.md), never an issue or a PR.

## Development

You need Bun (the version in `.bun-version`) and Node 22 or later.

```sh
bun install --frozen-lockfile
bun test
bun run build
bun pm pack --destination /tmp/launch-sdk-pack
node scripts/smoke-node-import.mjs /tmp/launch-sdk-pack/*.tgz
```

## Rules CI enforces

- **No runtime dependencies.** `viem` is the only peer. Shipped `src/` imports only relative `.js` paths and `viem`, so it runs on Node and in browsers.
- **A 48-hour floor on new package versions.** `bunfig.toml` refuses versions published in the last 48 hours, and CI installs under [Aikido safe-chain](https://github.com/AikidoSec/safe-chain). Don't lower either.
- **Pinned actions.** Every action is pinned to a full commit SHA with its release in a comment (`scripts/check-workflow-pins.ts`).
- **Generated ABIs.** `src/abis/` is generated from Bankr's contracts in the monorepo. Don't hand-edit it.
