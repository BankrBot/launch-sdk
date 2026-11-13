/**
 * `@bankr/launch-sdk/server`: the entry for a builder's backend. Server-only helpers (API-mode prepare handling with a
 * scoped key, and a launchpad signer's authorizations) belong here, never in the root entry that browsers bundle.
 * It re-exports the root API so an error thrown through either entry is the same class.
 */
import {
  BankrApiResponseError,
  httpPreparer,
  normalizeApiUrl,
  pickPrepareRequest,
  refuseInBrowser,
  type FetchLike,
  type PrepareRequest,
  type Preparer,
} from "./api.js";
import { LaunchRefusedError, isLaunchSdkError } from "./errors.js";
import { MAX_BODY_BYTES, isJsonRequest, json, readBody } from "./serverHttp.js";

export * from "./index.js";
export {
  createAuthorizeHandler,
  padAuthorizer,
  signLaunchAuthorization,
  type AuthorizeHandlerOptions,
  type PadAuthorizerOptions,
  type PadSigner,
  type SignLaunchAuthorizationInput,
} from "./padSigner.js";

export interface BankrPreparerOptions {
  /** A prepare-scoped key: wallet and agent APIs disabled, or Bankr refuses it (`API_KEY_OVERPRIVILEGED`). */
  apiKey: string;
  /** Default `https://api.bankr.bot`. */
  url?: string;
  fetch?: FetchLike;
}

function requireKey(apiKey: unknown): void {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError("A Bankr API key is required");
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The key travels only over https, or plain http to a local API. */
function keyApiUrl(url: string | undefined): string {
  const base = normalizeApiUrl(url);
  const { protocol, hostname } = new URL(base);
  if (protocol !== "https:" && !LOCAL_HOSTS.has(hostname)) {
    throw new LaunchRefusedError("INVALID_PARAMS");
  }
  return base;
}

/**
 * API mode on your server: prepares launches through Bankr's `POST /bankr-v4/launches/prepare` with your
 * prepare-scoped key, so Bankr signs Bankr's own pad (id 0), prices a SIGNED quote, pins `metadata` and records the
 * prepare for `prepared` attribution. Pass it as `createLaunchClient({ api: { preparer } })`.
 * Throws `API_KEY_IN_BROWSER` in a browser, and `INVALID_PARAMS` for a `url` that is not https (or a local API).
 */
export function bankrPreparer(o: BankrPreparerOptions): Preparer {
  refuseInBrowser();
  requireKey(o.apiKey);
  return httpPreparer(
    `${keyApiUrl(o.url)}/bankr-v4/launches/prepare`,
    // fetch drops Authorization on a cross-origin redirect but keeps a custom header: never follow one with the key.
    { headers: { "x-api-key": o.apiKey }, redirect: "error" },
    o.fetch,
  );
}

export interface PrepareHandlerOptions extends BankrPreparerOptions {
  /**
   * Required, with no default allow: authenticate the end user and rate-limit them before your key is used.
   * Throw to refuse: a thrown `Response` (e.g. a 401 or 429) is returned as is, anything else becomes a 403. It
   * may read the request body; the handler forwards its own copy.
   */
  authorize: (req: Request) => void | Promise<void>;
  /** Sees every failed prepare (Bankr's refusal or an outage) for your logs; the response never carries details. */
  onError?: (error: unknown) => void;
}

// Bankr's own user-facing refusals of the request (validation, admission, simulation); passed on to the browser.
const FORWARDED_STATUSES = new Set([400, 404, 409, 422]);
const PREPARE_FAILED = "Could not prepare the launch right now.";

/** The browser's view of a failed prepare: SDK codes and fixed text, plus Bankr's own message on a 4xx refusal. */
function failure(err: unknown): Response {
  if (!isLaunchSdkError(err)) return json(500, { error: PREPARE_FAILED });
  const cause = err.cause instanceof BankrApiResponseError ? err.cause : null;
  if (err.code === "RATE_LIMITED") {
    const retry = cause?.retryAfterSeconds;
    return json(
      429,
      { error: err.message, code: err.code },
      retry == null ? undefined : { "retry-after": String(retry) },
    );
  }
  if (
    err.code === "API_ERROR" &&
    cause !== null &&
    FORWARDED_STATUSES.has(cause.status)
  ) {
    return json(cause.status, {
      error: cause.message,
      code: err.code,
      ...(cause.code === null ? {} : { apiCode: cause.code }),
    });
  }
  // An over-privileged key or a Bankr outage is the server's problem, not the user's request.
  return json(502, { error: err.message, code: err.code });
}

/**
 * A `(Request) => Promise<Response>` route (Next.js App Router, Hono, Bun, Deno, Workers) that prepares launches for
 * your users with your prepare-scoped key, which never leaves the server. Browsers reach it with `remotePreparer`.
 * `authorize` is required: without per-user auth and limits the route is an open proxy into your key's quota and
 * your builder's `prepared` attribution. Accepts POST only, an `application/json` body of at most 16 KiB (read
 * before `authorize` runs), and forwards only the prepare request's fields. Throws `API_KEY_IN_BROWSER` in a browser.
 */
export function createPrepareHandler(
  o: PrepareHandlerOptions,
): (req: Request) => Promise<Response> {
  refuseInBrowser();
  if (typeof o?.authorize !== "function") {
    throw new TypeError(
      "createPrepareHandler needs an authorize function: there is no default allow",
    );
  }
  const preparer = bankrPreparer(o);

  return async function prepareHandler(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return json(405, { error: "Use POST." }, { allow: "POST" });
    }
    if (!isJsonRequest(req)) {
      return json(415, { error: "Send the launch request as JSON." });
    }
    const tooLarge = () =>
      json(413, { error: "The request body is too large." });
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return tooLarge();
    }
    // Read, and bounded, before authorize runs: it gets the request with its body still unread.
    const text = await readBody(req.clone(), MAX_BODY_BYTES);
    if (text === null) return tooLarge();
    try {
      await o.authorize(req);
    } catch (denied) {
      if (denied instanceof Response) return denied;
      return json(403, { error: "Not authorized." });
    }

    let request: PrepareRequest | null;
    try {
      request = pickPrepareRequest(JSON.parse(text));
    } catch {
      request = null;
    }
    if (request === null) {
      return json(400, { error: "The body must be a JSON launch request." });
    }

    try {
      return json(200, await preparer(request));
    } catch (err) {
      o.onError?.(err);
      return failure(err);
    }
  };
}
