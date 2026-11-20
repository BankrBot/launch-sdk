/**
 * `app/api/pad/authorize/route.ts` for a third-party launchpad with a signer: your users launch on your pad from
 * their own wallets (`createLaunchClient({ authorizer: remoteAuthorizer("/api/pad/authorize") })` in the browser),
 * and this route checks each launch against your pad's admission policy before your pad signer's key signs its exact
 * terms. The key stays on this server; an open pad (no signer) needs no route at all.
 *
 * Env: PAD_SIGNER_KEY (the key whose address is your pad's `signer`), LAUNCHPAD_ID. Use a KMS- or HSM-backed viem
 * account in production. In your app, import from "@bankr/launch-sdk/server".
 */
import { parseUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, createAuthorizeHandler } from "../src/server.js";

// This pad's dev-buy cap per quote, each in the quote's own units. Decimals differ by token and by chain (USDC has
// 6 here and 18 on BNB Chain), so one number is never a cap for every quote.
const { WETH, USDC } = CHAINS.base.quotes;
const MAX_DEV_BUY: Readonly<Record<string, bigint>> = {
  [WETH.address]: parseUnits("0.1", WETH.decimals),
  [USDC.address]: parseUnits("250", USDC.decimals),
};

/** Whether a launch's dev buy is inside this pad's cap for its quote. A quote with no cap here takes no dev buy. */
export function devBuyWithinCap(launch: {
  nativeDevBuy: bigint;
  params: { quote: Address; devBuyAmountIn: bigint };
}): boolean {
  // A native dev buy is paid in the wrapped native quote's own units.
  const amount = launch.nativeDevBuy + launch.params.devBuyAmountIn;
  if (amount === 0n) return true;
  const cap = MAX_DEV_BUY[launch.params.quote.toLowerCase()];
  return cap !== undefined && amount <= cap;
}

export const POST = createAuthorizeHandler({
  account: privateKeyToAccount(process.env.PAD_SIGNER_KEY as `0x${string}`),
  chain: "base",
  launchpadId: BigInt(process.env.LAUNCHPAD_ID ?? "1"),
  // Your users and your pad's rules, before anything is signed. Throw to refuse (a thrown Response is returned as is).
  authorize(req, launch) {
    if (!req.headers.get("cookie")?.includes("session=")) {
      throw new Response(JSON.stringify({ error: "Sign in to launch." }), {
        status: 401,
      });
    }
    if (!devBuyWithinCap(launch)) {
      throw new Response(
        JSON.stringify({ error: "Dev buys on this pad are capped." }),
        { status: 403 },
      );
    }
  },
  onError: (err) => console.error("pad authorization failed", err),
});
