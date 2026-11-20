/**
 * Launch a coin with Bankr's Sniper Tax preset on your own open launchpad on Base, in pure mode: no key and no call
 * to Bankr. Buys pay 5% more and sells 2% more for the coin's first 5 minutes; the hook binds that at launch, for
 * good. The preview is what a confirm screen shows, and says before anything is signed whether the chain takes it.
 *
 *   LAUNCHER_KEYSTORE=~/.foundry/keystores/launcher KEYSTORE_PASSWORD=… LAUNCHPAD_ID=7 bun examples/preset-launch.ts
 *
 * LAUNCHPAD_ID is a launchpad without a signer (`own-launchpad.ts` registers one); one with a signer also takes
 * its `authorizer` on the client. In your app, import from "@bankr/launch-sdk".
 */
import { readFileSync } from "node:fs";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  createLaunchClient,
  isLaunchSdkError,
  percentToPips,
  pipsToPercent,
  type LaunchExtensionInput,
} from "../src/index.js";
import { decryptKeystore } from "./node-launch.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

async function main(): Promise<void> {
  const keystore = readFileSync(requireEnv("LAUNCHER_KEYSTORE"), "utf8");
  const account = privateKeyToAccount(
    decryptKeystore(keystore, requireEnv("KEYSTORE_PASSWORD")),
  );
  const launchpadId = BigInt(requireEnv("LAUNCHPAD_ID"));
  const rpcUrl = process.env.BASE_RPC_URL;
  const client = createLaunchClient({
    chain: "base",
    rpcUrl,
    walletClient: createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl),
    }),
  });

  // The coin's own fee: a flat 1%. The preset's fee comes on top, and the two together never pass 10%.
  const schedule = {
    startPips: percentToPips("1"),
    steadyPips: percentToPips("1"),
    decaySecs: 0,
  };
  const extension: LaunchExtensionInput = {
    preset: "sniper_tax",
    buyPips: percentToPips("5"),
    sellPips: percentToPips("2"),
    endSecs: 300,
  };

  try {
    const preview = await client.previewExtension(extension, {
      launchpadId,
      schedule,
    });
    console.log(`${preview.label}: ${preview.description}`);
    for (const row of preview.feeTable)
      console.log(
        `  ${row.secsSinceLaunch}s: buys ${pipsToPercent(row.buy.totalPips)}%, sells ${pipsToPercent(row.sell.totalPips)}%`,
      );
    if (preview.refusal) throw new Error(preview.refusal);

    const launch = await client.launch({
      name: "My Token",
      symbol: "MINE",
      metadataUri: "ipfs://bafy…", // your token's metadata JSON
      launcher: account.address,
      launchpadId,
      schedule,
      extension,
    });
    console.log(`Launched ${launch.token} in ${launch.txHash}`);
  } catch (err) {
    // A parameter outside its bound is EXTENSION_OUT_OF_BOUNDS; `detail` names the bound.
    if (!isLaunchSdkError(err)) throw err;
    console.error(`${err.code}: ${err.message} ${err.detail ?? ""}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
