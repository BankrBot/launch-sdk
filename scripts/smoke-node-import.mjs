#!/usr/bin/env node
// Usage: node scripts/smoke-node-import.mjs <tarball from `bun pm pack`>
// Unpacks the tarball into a scratch node_modules and imports both entries through the package `exports` map on
// plain Node ESM, so a broken exports field, a missing .js extension or a stray runtime dependency fails here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node scripts/smoke-node-import.mjs <launch-sdk tarball>");
  process.exit(2);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
assert.ok(nodeMajor >= 22, `Node ${process.versions.node} is below engines.node >=22`);

const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const forbidden = listing.filter((f) => /\.test\.|__internal__|\.map$|^package\/(src|scripts)\//.test(f));
assert.deepEqual(forbidden, [], "the tarball ships tests, sources, scripts or source maps");
for (const file of ["package.json", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/server.js", "dist/server.d.ts"]) {
  assert.ok(listing.includes(`package/${file}`), `the tarball is missing ${file}`);
}

const scratch = mkdtempSync(join(tmpdir(), "launch-sdk-smoke-"));
try {
  const pkgDir = join(scratch, "node_modules/@bankr/launch-sdk");
  mkdirSync(pkgDir, { recursive: true });
  execFileSync("tar", ["-xzf", resolve(tarball), "-C", pkgDir, "--strip-components=1"]);
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined, "the packed manifest declares runtime dependencies");

  // viem is the only peer: link the monorepo's copy rather than installing from the network.
  const viemDir = dirname(createRequire(import.meta.url).resolve("viem/package.json"));
  symlinkSync(viemDir, join(scratch, "node_modules/viem"), "dir");

  const entry = join(scratch, "smoke.mjs");
  writeFileSync(
    entry,
    `import assert from "node:assert/strict";
const sdk = await import("@bankr/launch-sdk");
const server = await import("@bankr/launch-sdk/server");
assert.deepEqual([...sdk.LAUNCH_CHAINS], ["base", "robinhood", "arbitrum", "arc", "ethereum", "bnb"]);
// Bankr's index covers the first four; BNB Chain's dollars have 18 decimals.
assert.deepEqual(sdk.LAUNCH_CHAINS.filter((c) => !sdk.CHAINS[c].indexed), ["ethereum", "bnb"]);
assert.equal(sdk.CHAINS.bnb.quotes.USDT.decimals, 18);
await assert.rejects(sdk.createBankrApi({}).launches({ chain: "bnb" }), (e) => sdk.isLaunchSdkError(e, "INDEX_NOT_COVERED"));
// Every chain ships its contracts' record: that row is what makes the chain live, and a default client reads it.
for (const chain of sdk.LAUNCH_CHAINS) {
  assert.equal(sdk.BANKR_V4_LAUNCH_ADDRESSES[chain].chainId, sdk.CHAINS[chain].chainId, chain);
  assert.deepEqual(sdk.createLaunchClient({ chain, rpcUrl: "http://127.0.0.1:1" }).provider.addresses, sdk.BANKR_V4_LAUNCH_ADDRESSES[chain]);
}
// The public holderShareBps meaning: bps of the creator's own take, converted to the contract's creator-side bps.
assert.equal(sdk.holderShareToHoldersBps(10_000, 3_000, 0), 7_000);
assert.equal(sdk.encodeBuilderCodeSuffix([sdk.BANKR_BUILDER_CODE]).slice(-32), "80218021802180218021802180218021");
assert.equal(server.LaunchSdkError, sdk.LaunchSdkError, "both entries must share one error class");
assert.equal(server.CHAINS, sdk.CHAINS);
// Pad signers: the key helpers ship only in ./server; the browser-safe half in both.
for (const name of ["createAuthorizeHandler", "padAuthorizer", "signLaunchAuthorization"]) {
  assert.equal(typeof server[name], "function", name + " is missing from ./server");
  assert.equal(sdk[name], undefined, name + " must not ship in the root entry");
}
assert.equal(server.remoteAuthorizer, sdk.remoteAuthorizer);
assert.equal(typeof sdk.createBankrApi({}).launches, "function");
const handler = server.createAuthorizeHandler({ account: { address: "0x00000000000000000000000000000000000000a1" }, chain: "base", launchpadId: 1n, authorize: () => {} });
assert.equal((await handler(new Request("http://localhost/authorize"))).status, 405);
console.log("@bankr/launch-sdk " + ${JSON.stringify(manifest.version)} + ": ESM import OK on Node " + process.versions.node);
`,
  );
  execFileSync(process.execPath, [entry], { stdio: "inherit" });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
