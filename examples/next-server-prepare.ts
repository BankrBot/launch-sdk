/**
 * `app/api/launch/prepare/route.ts` in a Next.js App Router app: your users launch from their own wallets in the
 * browser (`browser-launch.ts`), and this route prepares each launch through Bankr with your prepare-scoped key,
 * which never reaches the browser. `authorize` is required: it signs the user in and rate-limits them per user, so
 * the route is not an open proxy into your key's quota or your builder's `prepared` attribution.
 *
 * Env: BANKR_PREPARE_KEY (wallet and agent APIs disabled), SESSION_SECRET (your session cookie's HMAC key).
 * In your app, import from "@bankr/launch-sdk/server".
 *
 * Not available yet: on Bankr's current contracts this SDK version refuses API mode (`PROVIDER_NOT_DEPLOYED`), so
 * the browser half runs once a later version ships it. Until then launch in pure mode (`own-launchpad.ts`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createPrepareHandler } from "../src/server.js";

const PREPARES_PER_USER_PER_MINUTE = 5;
const WINDOW_MS = 60_000;

/**
 * Your session check. Here: a `session=<userId>.<hmac>` cookie signed with SESSION_SECRET. Swap in your auth
 * provider (NextAuth, Clerk, Privy…) and return the signed-in user's id, or null.
 */
function sessionUserId(req: Request): string | null {
  const secret = process.env.SESSION_SECRET;
  const cookie = req.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith("session="))
    ?.slice("session=".length);
  if (!secret || !cookie) return null;
  const dot = cookie.lastIndexOf(".");
  const userId = cookie.slice(0, dot);
  const given = Buffer.from(cookie.slice(dot + 1), "hex");
  const expected = createHmac("sha256", secret).update(userId).digest();
  return dot > 0 &&
    given.length === expected.length &&
    timingSafeEqual(given, expected)
    ? userId
    : null;
}

// Per instance. Behind several instances use a shared store (Redis, your database) so the limit holds overall.
const recent = new Map<string, number[]>();

function takePrepare(userId: string): boolean {
  const now = Date.now();
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= PREPARES_PER_USER_PER_MINUTE) return false;
  hits.push(now);
  recent.set(userId, hits);
  return true;
}

const problem = (status: number, error: string, headers?: HeadersInit) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const POST = createPrepareHandler({
  apiKey: process.env.BANKR_PREPARE_KEY ?? "",
  authorize(req) {
    const userId = sessionUserId(req);
    // A thrown Response is returned as is; any other throw is a 403.
    if (!userId) throw problem(401, "Sign in to launch.");
    if (!takePrepare(userId)) {
      throw problem(429, "Too many launches. Try again in a minute.", {
        "retry-after": "60",
      });
    }
  },
  // Bankr's refusals and outages, for your logs; the browser only sees codes and fixed text.
  onError: (err) => console.error("launch prepare failed", err),
});
