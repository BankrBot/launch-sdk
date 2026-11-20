/**
 * The browser half of `next-server-prepare.ts`: the user's injected wallet (EIP-1193, e.g. MetaMask or Rabby) is the
 * launcher and pays the gas; your route prepares through Bankr with the key it keeps. No API key in this bundle:
 * `remotePreparer` throws API_KEY_IN_BROWSER if one rides in its headers. In your app, import from
 * "@bankr/launch-sdk".
 *
 * Not available yet: on Bankr's current contracts this SDK version refuses API mode (`PROVIDER_NOT_DEPLOYED`), so
 * this example runs once a later version ships it. Until then launch in pure mode (`own-launchpad.ts`).
 */
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { base } from "viem/chains";
import {
  createLaunchClient,
  isLaunchSdkError,
  remotePreparer,
  type LaunchResult,
} from "../src/index.js";

export async function launchFromBrowser(token: {
  name: string;
  symbol: string;
  image: string;
  description?: string;
}): Promise<LaunchResult<"base"> | null> {
  const ethereum = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!ethereum) throw new Error("Install a browser wallet to launch.");
  const [launcher] = await ethereum.request({ method: "eth_requestAccounts" });
  if (!launcher) return null;
  const walletClient = createWalletClient({
    account: launcher,
    chain: base,
    transport: custom(ethereum),
  });
  await walletClient.switchChain({ id: base.id });

  const client = createLaunchClient({
    chain: "base",
    walletClient,
    api: {
      // Your route; the session cookie authorizes and rate-limits the user there.
      preparer: remotePreparer("/api/launch/prepare", {
        credentials: "same-origin",
      }),
    },
  });
  try {
    return await client.launch({
      name: token.name,
      symbol: token.symbol,
      launcher,
      metadata: { image: token.image, description: token.description },
    });
  } catch (err) {
    if (isLaunchSdkError(err, "RATE_LIMITED")) {
      alert("Too many launches. Try again in a minute.");
      return null;
    }
    throw err;
  }
}
