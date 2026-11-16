/**
 * Register a launchpad of your own on Bankr's configurable suite (suite 4), set its parameters, and launch a coin
 * on it, in pure mode: no key and no call to Bankr. The operator's wallet sends three transactions: the
 * registration (it pays the registry's bond), one `configure`, and the launch.
 *
 *   OPERATOR_KEYSTORE=~/.foundry/keystores/operator KEYSTORE_PASSWORD=… bun examples/own-launchpad.ts
 *
 * Until this SDK ships a chain's suite 4 record, point it at a suite you deployed: SUITE_RECORD is that deploy's
 * deployments/<chain>.json and BASE_RPC_URL its node (an anvil fork). In your app, import from "@bankr/launch-sdk".
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  createLaunchClient,
  isLaunchSdkError,
  percentToBps,
  percentToPips,
  pipsToPercent,
  type ProviderAddresses,
  type UnsignedTx,
} from "../src/index.js";
import { decryptKeystore } from "./node-launch.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

async function main(): Promise<void> {
  const keystore = readFileSync(requireEnv("OPERATOR_KEYSTORE"), "utf8");
  const operator = privateKeyToAccount(
    decryptKeystore(keystore, requireEnv("KEYSTORE_PASSWORD")),
  );
  const transport = http(process.env.BASE_RPC_URL);
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({
    account: operator,
    chain: base,
    transport,
  });
  const record = process.env.SUITE_RECORD;
  const client = createLaunchClient({
    chain: "base",
    suite: 4,
    publicClient,
    walletClient,
    ...(record
      ? {
          addresses: JSON.parse(
            readFileSync(record, "utf8"),
          ) as Partial<ProviderAddresses>,
          fork: true,
        }
      : {}),
  });
  const { launchpads, settings } = client.suite4();

  async function send(tx: UnsignedTx) {
    const hash = await walletClient.sendTransaction(tx);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error(`Transaction ${hash} reverted`);
    return receipt;
  }

  // What a new launchpad starts as, and what registering one costs.
  const [template, suite] = await Promise.all([
    settings.template(),
    settings.suite(),
  ]);
  console.log(
    `A new launchpad's fee: ${pipsToPercent(Number(template.knobs.steadyPips.default))}%.`,
    `Bond: ${suite.registrationBondWei} wei.`,
  );

  // An open launchpad: anyone may launch on it. Its payee takes half of each fee's remainder.
  const registered = await send(
    await launchpads.register({
      operator: operator.address,
      payees: [{ address: operator.address, shareBps: percentToBps("50") }],
    }),
  );
  const launchpadId = launchpads.launchpadIdFromReceipt(registered);

  // The launchpad's own parameters, in one transaction. What is left out stays as the template has it.
  await send(
    await launchpads.configure(launchpadId, {
      knobs: {
        steadyPips: {
          min: percentToPips("1"),
          max: percentToPips("2"),
          default: percentToPips("1"),
        },
        supply: {
          min: 1_000_000_000,
          max: 1_000_000_000,
          default: 1_000_000_000,
        },
        capSecs: { min: 0, max: 0, default: 0 }, // no wallet cap
        buybackBps: { min: 0, max: 5_000, default: 2_000 },
      },
      switches: { allocations: false },
    }),
  );
  const pad = await settings.pad(launchpadId);
  console.log(`Launchpad ${launchpadId}:`, pad.atLaunch.knobs.steadyPips);

  // A coin with nothing set takes the launchpad's defaults; the plan shows the terms it will freeze.
  const input = {
    name: "Acme Coin",
    symbol: "ACME",
    metadataUri: "ipfs://bafy…",
    launcher: operator.address,
    launchpadId,
  };
  const plan = await client.plan(input);
  const terms = plan.suite4?.terms;
  console.log(
    `${plan.predictedToken} would freeze a ${pipsToPercent(terms?.pool.buy.steadyPips ?? 0)}% fee,`,
    `a supply of ${terms?.totalSupply} and a buyback of ${terms?.buybackBps} bps of the creator side.`,
  );
  const launch = await client.launch(input);
  console.log("Token:", launch.token, "Tx:", launch.txHash);
}

if (import.meta.main) {
  await main().catch((err: unknown) => {
    if (!isLaunchSdkError(err)) throw err;
    const detail = err.detail ? ` ${err.detail}` : "";
    console.error(`${err.code}: ${err.message}${detail}`);
    process.exitCode = 1;
  });
}
