/**
 * `app/api/pad/authorize/route.ts` for a third-party launchpad with a signer: your users launch on your pad from
 * their own wallets (`createLaunchClient({ authorizer: remoteAuthorizer("/api/pad/authorize") })` in the browser),
 * and this route checks each launch against your pad's admission policy before your pad signer's key signs its exact
 * terms. The key stays on this server; an open pad (no signer) needs no route at all.
 *
 * Env: PAD_SIGNER_KEY (the key whose address is your pad's `signer`), LAUNCHPAD_ID. Use a KMS- or HSM-backed viem
 * account in production. In your app, import from "@bankr/launch-sdk/server".
 */
import { privateKeyToAccount } from "viem/accounts";
import { createAuthorizeHandler } from "../src/server.js";

const MAX_DEV_BUY_WEI = 10n ** 17n;

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
    if (launch.nativeDevBuy + launch.params.devBuyAmountIn > MAX_DEV_BUY_WEI) {
      throw new Response(
        JSON.stringify({ error: "Dev buys on this pad are capped." }),
        { status: 403 },
      );
    }
  },
  onError: (err) => console.error("pad authorization failed", err),
});
