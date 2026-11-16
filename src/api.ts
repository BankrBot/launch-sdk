import type { Address, Hex } from "viem";
import { getChain, type LaunchChain } from "./chains/index.js";
import type { CurveBand, CurveId, CurveName } from "./curve.js";
import type { FeeSchedule } from "./economics.js";
import {
  LaunchApiError,
  LaunchConfigError,
  LaunchRefusedError,
} from "./errors.js";
import type { LaunchMetadata } from "./providers/types.js";

/** Bankr's public API. */
export const DEFAULT_BANKR_API_URL = "https://api.bankr.bot";

/** `POST /launches/register` indexes a launch once its receipt has this many confirmations. */
export const REGISTER_MIN_CONFIRMATIONS = 5;

/** Any fetch-compatible function: the global `fetch`, or one with your own timeouts and retries. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * `POST /bankr-v4/launches/prepare`: one launch in the API's units (bigints as decimal strings). Each omitted economic
 * field is the pad's default; `holderShareBps` is bps of the creator's own take, as everywhere.
 */
export interface PrepareRequest {
  chain: LaunchChain;
  launcher: Address;
  /** Decimal uint64; default "0" (Bankr's pad, which needs a prepare-scoped key). */
  launchpadId?: string;
  name: string;
  symbol: string;
  /** At most 2,048 UTF-8 bytes. */
  metadataUri?: string;
  /** Bankr pins it (a prepare-scoped key only); the response's `metadataUri` is the pin. */
  metadata?: LaunchMetadata;
  /** Who may replace the token's metadata URI after launch; omitted = nobody. */
  metadataAdmin?: Address;
  quote?: Address;
  /** 1–10 distinct recipients of the creator's own take, `bps` summing to 10,000, the primary first; omitted = the
   *  launcher alone. */
  feeRecipients?: { address: Address; bps: number }[];
  /** The launch's waiver for contract recipients that let anyone claim for them; default false. */
  allowOpenCodeFeeRecipients?: boolean;
  /** Unix seconds public trading opens at; omitted or 0 = at launch. */
  startTime?: number;
  /** A built-in curve by name, or the launch's own bands with the USD FDV the first one starts at; omitted =
   *  `runner_v1`. */
  curve?: CurveName | { bands: CurveBand[]; startFdvUsd: number };
  vesting?: { bps: number; recipient?: Address };
  economics?: {
    buy?: FeeSchedule;
    sell?: FeeSchedule;
    holderShareBps?: number;
    autoLpBps?: number;
    buybackBps?: number;
    referrerBps?: number;
    vestToHolders?: {
      bps: number;
      cliffSeconds: number;
      durationSeconds: number;
    };
  };
  /** Quote base units (native on WETH); the dev-buy floor is the SDK's to set. */
  devBuy?: { amount: string };
}

/** What the prepare endpoint returns. The client verifies it against its own input and suite, and re-encodes it. */
export interface PrepareResponse {
  chain: LaunchChain;
  chainId: number;
  launchpadId: string;
  factory: Address;
  launcher: Address;
  /** `LaunchParams`, every field, bigints as decimal strings. */
  params: Record<string, unknown>;
  /** `msg.value` (a native dev buy), decimal. */
  value: string;
  /** An ERC-20 dev buy: approve the factory for this first. */
  approval: { token: Address; amount: string } | null;
  predictedToken: Address;
  poolId: Hex;
  tokenIsCurrency0: boolean;
  distributor: Address;
  escrow: Address | null;
  expectedStartTick: number;
  deadline: string;
  /** Set when the pad needs its own authorizer's signature (the client's `authorizer`). */
  padSigner: Address | null;
  authorization: { nonce: Hex; deadline: string; signature: Hex } | null;
  metadataUri: string;
  /** Bankr's mirrors of `params` in the request's units (recipients resolved, `metadataAdmin` null for nobody). The
   *  client reads and verifies `params` alone, so another preparer may leave them out. */
  feeRecipients?: { address: Address; bps: number }[];
  allowOpenCodeFeeRecipients?: boolean;
  metadataAdmin?: Address | null;
  startTime?: number;
  /** The curve as built, mirrored too: a built-in's id, or the launch's own bands and the word `params` carries. */
  curve?: {
    curveId: CurveId | null;
    curveTable: Hex | null;
    curveBands: CurveBand[];
  };
  /** Set when Bankr recorded the prepare (a prepare-scoped key): the evidence for `prepared` attribution. */
  prepareId: string | null;
}

/**
 * Prepares a launch through Bankr (API mode). In a browser use {@link remotePreparer} (your server holds the key);
 * on a server, `bankrPreparer` from `@bankr/launch-sdk/server`.
 */
export type Preparer = (request: PrepareRequest) => Promise<PrepareResponse>;

// Every PrepareRequest field: a prepare endpoint forwards these and drops anything else.
const PREPARE_FIELDS = Object.keys({
  chain: true,
  launcher: true,
  launchpadId: true,
  name: true,
  symbol: true,
  metadataUri: true,
  metadata: true,
  metadataAdmin: true,
  quote: true,
  feeRecipients: true,
  allowOpenCodeFeeRecipients: true,
  startTime: true,
  curve: true,
  vesting: true,
  economics: true,
  devBuy: true,
} satisfies Record<keyof PrepareRequest, true>);

/** Who is credited for a launch, strongest first; `code` is a claim anyone can append. */
export type LaunchAttribution = "api_key" | "prepared" | "wallet" | "code";

/** A row of Bankr's launch index (`GET /launches`). */
export interface IndexedLaunch {
  chain: LaunchChain;
  tokenAddress: Address;
  /** The v4 pool id (bankr_v4, Doppler), or a Launch v3 pool address. */
  poolId: Hex;
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  provider: "bankr_v4" | "bankr_v3" | "doppler";
  /** The launch's pad (decimal uint64) on bankr_v4; null on other providers. */
  launchpadId: string | null;
  launcher: Address;
  feeRecipient: Address | null;
  /** Builder slug; null when unattributed, or for a code claim under `attribution: "verified"`. */
  builder: string | null;
  attribution: LaunchAttribution | null;
  deployedAt: string;
  /** Moderated off Discover and the default listing; still indexed and tradable. */
  hidden: boolean;
  /** Best effort for SDK launches: priced after a trade on a quote Bankr prices, within per-chain caps. Null when
   *  moderation hides it, on other quotes, or when untraded for a while; docs.bankr.bot "Market data" has the rules. */
  market: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    volume24hUsd: number;
  };
}

/** A page of launches, newest first. */
export interface LaunchPage {
  launches: IndexedLaunch[];
  /** Opaque: pass it back as `cursor` unchanged. Null on the last page. */
  nextCursor: string | null;
}

export interface LaunchQuery {
  chain?: LaunchChain;
  builder?: string;
  launcher?: Address;
  /** An ERC-8021 builder code. */
  code?: string;
  provider?: IndexedLaunch["provider"];
  /** bankr_v4 launches on one pad (a decimal id). */
  launchpad?: bigint | string;
  /** Default `"verified"`: code claims are not shown as attribution. */
  attribution?: "verified" | "all";
  /** Default `"listed"`: launches hidden by moderation are left out. */
  visibility?: "listed" | "all";
  /** A page's `nextCursor`, unchanged. Its format is the API's and may change. */
  cursor?: string;
  /** 1–100, default 20. */
  limit?: number;
}

/** `GET /launches/:chain/:token`. */
export interface LaunchDetailQuery {
  /** Default `"verified"`: a code claim leaves `builder` and `attribution` null. `"all"` shows it. */
  attribution?: "verified" | "all";
}

export interface BuilderStats {
  launches: number;
  verifiedLaunches: number;
  volume24hUsd: number;
}

/** `GET /builders/:slug`: the public profile and its stats over `window`. */
export interface BuilderProfile {
  slug: string;
  name: string;
  description: string | null;
  websiteUrl: string | null;
  /** Proven launcher wallets (the `wallet` attribution tier). */
  wallets: { chain: LaunchChain; address: Address }[];
  /** Claimed ERC-8021 codes (never verified). */
  codes: string[];
  createdAt: string;
  window: "24h" | "7d" | "30d";
  attribution: "verified" | "all";
  stats: BuilderStats;
  byChain: Partial<Record<LaunchChain, BuilderStats>>;
}

export interface BuilderQuery {
  window?: BuilderProfile["window"];
  visibility?: "listed" | "all";
  attribution?: "verified" | "all";
}

/** `POST /launches/register`: each launch in the transaction, `pending` until the indexer confirms it. */
export interface RegisterResult {
  chain: LaunchChain;
  txHash: Hex;
  confirmations: number;
  launches: {
    tokenAddress: Address;
    poolId: Hex;
    status: "pending" | "indexed";
  }[];
}

/** One bucket share in Bankr's account index; amounts are decimal strings. */
export interface AccountFeeBucket {
  bucketId: Hex;
  poolId: Hex;
  token: Address;
  quote: Address;
  kind: "creator" | "decay";
  claimableQuote: string;
  claimableToken: string;
  /** The account's checkpoint on a credited side is still 0. */
  firstTouch: boolean;
  /** The bucket was ever credited on both sides. */
  bothSides: boolean;
}

/**
 * `GET /bankr-v4/accounts/:account/fees?chainId=&ledger=`: what an account is owed on one fee ledger, from Bankr's
 * bucket-share index (claimable read on-chain). Amounts are decimal strings.
 */
export interface AccountFeesResponse {
  chainId: number;
  account: Address;
  /**
   * The ledger answered for: the one asked, else the chain's oldest suite's. Each suite has its own, never summed.
   * Absent from an API that predates the field, which serves the chain's suite 3 record alone.
   */
  ledger?: Address;
  /** Pull balances: referral slices and settled shares. */
  balances: { quote: Address; amount: string }[];
  buckets: AccountFeeBucket[];
  totalByQuote: { quote: Address; amount: string }[];
  bucketCount: number;
}

/**
 * A response that was not a success, from Bankr's API or a prepare endpoint: the `cause` of an `api` error. Its
 * text is the server's, so it never reaches the SDK error's `message`.
 */
export class BankrApiResponseError extends Error {
  override readonly name = "BankrApiResponseError";
  readonly status: number;
  /** The server's own code (e.g. `NOT_CONFIRMED`, `INVALID_LAUNCH`), when it sent one. */
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(i: {
    status: number;
    code: string | null;
    message: string;
    retryAfterSeconds: number | null;
  }) {
    super(i.message);
    this.status = i.status;
    this.code = i.code;
    this.retryAfterSeconds = i.retryAfterSeconds;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_ERROR_TEXT = 500;

interface ApiReply {
  status: number;
  ok: boolean;
  body: unknown;
  retryAfter: string | null;
}

/** The SDK error for a failed reply: 429 is RATE_LIMITED, an over-privileged key keeps its code, the rest API_ERROR. */
function apiError(reply: ApiReply, chain?: LaunchChain): LaunchApiError {
  const body = isRecord(reply.body) ? reply.body : {};
  const code = typeof body.code === "string" ? body.code : null;
  // A prepare handler answers with the SDK's code and Bankr's own as `apiCode`.
  const apiCode = typeof body.apiCode === "string" ? body.apiCode : code;
  const retry = Number(reply.retryAfter);
  const cause = new BankrApiResponseError({
    status: reply.status,
    code: apiCode,
    message:
      typeof body.error === "string"
        ? body.error.slice(0, MAX_ERROR_TEXT)
        : `HTTP ${reply.status}`,
    retryAfterSeconds:
      reply.retryAfter !== null && Number.isFinite(retry) ? retry : null,
  });
  const sdkCode =
    reply.status === 429 || code === "RATE_LIMITED"
      ? "RATE_LIMITED"
      : code === "API_KEY_OVERPRIVILEGED"
        ? "API_KEY_OVERPRIVILEGED"
        : "API_ERROR";
  return new LaunchApiError(sdkCode, { cause, chain });
}

async function send(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  chain?: LaunchChain,
): Promise<ApiReply> {
  try {
    const res = await fetchFn(url, init);
    const text = await res.text();
    let body: unknown;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return {
      status: res.status,
      ok: res.ok,
      body,
      retryAfter: res.headers.get("retry-after"),
    };
  } catch (err) {
    throw new LaunchApiError("API_ERROR", { cause: err, chain });
  }
}

/** The reply's body when it succeeded with the expected shape; the matching SDK error otherwise. */
function expectBody<T>(
  reply: ApiReply,
  isShape: (body: unknown) => boolean,
  chain?: LaunchChain,
): T {
  if (!reply.ok) throw apiError(reply, chain);
  if (!isShape(reply.body)) {
    throw new LaunchApiError("API_ERROR", {
      chain,
      cause: new TypeError(`Unexpected response shape (HTTP ${reply.status})`),
    });
  }
  return reply.body as T;
}

// Looked up per call, and called on globalThis: some browsers refuse a detached `fetch` ("Illegal invocation").
const resolveFetch =
  (f: FetchLike | undefined): FetchLike =>
  (input, init) =>
    f ? f(input, init) : globalThis.fetch(input, init);

/** An http(s) base URL without trailing slashes; `INVALID_PARAMS` for anything else. */
export function normalizeApiUrl(url: string = DEFAULT_BANKR_API_URL): string {
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new LaunchRefusedError("INVALID_PARAMS");
  }
  return url.replace(/\/+$/, "");
}

/** A browser bundle (a page or a test DOM), where an API key would ship to every visitor. */
export function isBrowserRuntime(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return (
    typeof g.window === "object" &&
    g.window !== null &&
    typeof g.document === "object" &&
    g.document !== null
  );
}

/** `API_KEY_IN_BROWSER` when this runs in a browser. */
export function refuseInBrowser(chain?: LaunchChain): void {
  if (isBrowserRuntime()) {
    throw new LaunchConfigError("API_KEY_IN_BROWSER", { chain });
  }
}

const KEY_HEADER = "x-api-key";
// Bankr reads a key from Authorization bare or after an exact `Bearer ` prefix. This also matches other casing and
// spacing, so a browser refuses any key-shaped header, even one Bankr would not accept.
const AUTHORIZATION_KEY = /^(bearer\s+)?bk_/i;

const isPrepareResponse = (b: unknown): boolean =>
  isRecord(b) &&
  typeof b.chain === "string" &&
  typeof b.chainId === "number" &&
  typeof b.launchpadId === "string" &&
  typeof b.factory === "string" &&
  typeof b.launcher === "string" &&
  isRecord(b.params) &&
  typeof b.value === "string" &&
  (b.approval === null || isRecord(b.approval)) &&
  typeof b.predictedToken === "string" &&
  typeof b.poolId === "string" &&
  typeof b.distributor === "string" &&
  (b.padSigner === null || typeof b.padSigner === "string") &&
  (b.authorization === null || isRecord(b.authorization)) &&
  typeof b.metadataUri === "string" &&
  (b.prepareId === null || typeof b.prepareId === "string");

/** A preparer that POSTs each request as JSON to `url`, with `init` (headers, credentials) applied. */
export function httpPreparer(
  url: string,
  init: RequestInit,
  fetchFn?: FetchLike,
): Preparer {
  const doFetch = resolveFetch(fetchFn);
  return async (request) => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    const reply = await send(
      doFetch,
      url,
      { ...init, method: "POST", headers, body: JSON.stringify(request) },
      request.chain,
    );
    return expectBody<PrepareResponse>(reply, isPrepareResponse, request.chain);
  };
}

/**
 * A preparer for the browser: POSTs each prepare to your own endpoint (`createPrepareHandler` from
 * `@bankr/launch-sdk/server`), which adds your key server-side. `init` carries your session auth or CSRF header.
 * Throws `API_KEY_IN_BROWSER` if a Bankr API key rides in its headers in a browser.
 */
export function remotePreparer(
  url: string,
  init: RequestInit = {},
  options: { fetch?: FetchLike } = {},
): Preparer {
  const headers = new Headers(init.headers);
  if (
    headers.has(KEY_HEADER) ||
    AUTHORIZATION_KEY.test(headers.get("authorization") ?? "")
  ) {
    refuseInBrowser();
  }
  return httpPreparer(url, init, options.fetch);
}

/** Only the PrepareRequest fields of a JSON body, or null when it is not an object. */
export function pickPrepareRequest(body: unknown): PrepareRequest | null {
  if (!isRecord(body)) return null;
  const picked: Record<string, unknown> = {};
  for (const field of PREPARE_FIELDS) {
    if (body[field] !== undefined) picked[field] = body[field];
  }
  return picked as unknown as PrepareRequest;
}

export interface BankrApiOptions {
  /** Default `https://api.bankr.bot`. */
  url?: string;
  /** Default the global `fetch`. */
  fetch?: FetchLike;
}

/** Bankr's public launch API: the launch index and registration. No key needed. */
export interface BankrApi {
  readonly url: string;
  /** `GET /launches`, newest first. Page with `nextCursor`. */
  launches(query?: LaunchQuery): Promise<LaunchPage>;
  /** `GET /launches/:chain/:token`, hidden launches included; null when Bankr has not indexed it. */
  launch(
    chain: LaunchChain,
    token: Address,
    query?: LaunchDetailQuery,
  ): Promise<IndexedLaunch | null>;
  /** `GET /builders/:slug`; null for an unknown builder. */
  builder(slug: string, query?: BuilderQuery): Promise<BuilderProfile | null>;
  /**
   * `POST /launches/register`: index a launch at 5 confirmations instead of the indexer's full depth. Idempotent.
   * `signal` cancels the request.
   */
  register(
    chain: LaunchChain,
    txHash: Hex,
    options?: { signal?: AbortSignal },
  ): Promise<RegisterResult>;
  /**
   * `GET /bankr-v4/accounts/:account/fees`: the account's owed fees on one suite's `ledger`, unnamed the chain's
   * oldest suite's; null for a 404 (no such ledger there, or not indexed).
   */
  accountFees(
    chain: LaunchChain,
    account: Address,
    ledger?: Address,
  ): Promise<AccountFeesResponse | null>;
}

type Query = Record<string, string | number | bigint | undefined>;

/** A client for Bankr's public launch API. `INVALID_PARAMS` for a `url` that is not http(s). */
export function createBankrApi(o: BankrApiOptions = {}): BankrApi {
  const base = normalizeApiUrl(o.url);
  const doFetch = resolveFetch(o.fetch);

  const get = (path: string, query: Query, chain?: LaunchChain) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    return send(
      doFetch,
      `${base}${path}${qs ? `?${qs}` : ""}`,
      { method: "GET", headers: { accept: "application/json" } },
      chain,
    );
  };
  const found = <T>(
    reply: ApiReply,
    isShape: (b: unknown) => boolean,
    chain?: LaunchChain,
  ): T | null =>
    reply.status === 404 ? null : expectBody<T>(reply, isShape, chain);
  const segment = encodeURIComponent;

  return {
    url: base,
    async launches(query = {}) {
      const reply = await get("/launches", { ...query });
      return expectBody<LaunchPage>(
        reply,
        (b) =>
          isRecord(b) &&
          Array.isArray(b.launches) &&
          (b.nextCursor === null || typeof b.nextCursor === "string"),
        query.chain,
      );
    },
    async launch(chain, token, query = {}) {
      const reply = await get(
        `/launches/${segment(chain)}/${segment(token)}`,
        { ...query },
        chain,
      );
      return found(
        reply,
        (b) => isRecord(b) && typeof b.tokenAddress === "string",
        chain,
      );
    },
    async builder(slug, query = {}) {
      const reply = await get(`/builders/${segment(slug)}`, { ...query });
      return found(reply, (b) => isRecord(b) && typeof b.slug === "string");
    },
    async register(chain, txHash, options = {}) {
      const reply = await send(
        doFetch,
        `${base}/launches/register`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ chain, txHash }),
          signal: options.signal,
        },
        chain,
      );
      return expectBody<RegisterResult>(
        reply,
        (b) => isRecord(b) && Array.isArray(b.launches),
        chain,
      );
    },
    async accountFees(chain, account, ledger) {
      const reply = await get(
        `/bankr-v4/accounts/${segment(account)}/fees`,
        { chainId: getChain(chain).chainId, ledger },
        chain,
      );
      return found(
        reply,
        (b) =>
          isRecord(b) &&
          typeof b.chainId === "number" &&
          Array.isArray(b.balances) &&
          Array.isArray(b.buckets),
        chain,
      );
    },
  };
}
