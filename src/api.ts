import type { Address, Hex } from "viem";
import {
  LAUNCH_CHAINS,
  getChain,
  isLaunchChain,
  type LaunchChain,
} from "./chains/index.js";
import {
  LaunchApiError,
  LaunchConfigError,
  LaunchRefusedError,
} from "./errors.js";
import { isRecord } from "./isRecord.js";
import { iterateLaunches, type LaunchIterationOptions } from "./indexPages.js";

/** Bankr's public API. */
export const DEFAULT_BANKR_API_URL = "https://api.bankr.bot";

/** `POST /launches/register` indexes a launch once its receipt has this many confirmations. */
export const REGISTER_MIN_CONFIRMATIONS = 5;

/** Any fetch-compatible function: the global `fetch`, or one with your own timeouts and retries. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

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
  /** The token the bankr_v4 pool quotes (lowercase); null on other providers. */
  quoteAddress: Address | null;
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

/** What a list left out: the bankr_v4 launches of `chains`, whose index is behind right now. */
export interface IncompleteLaunches {
  code: "INDEX_UNAVAILABLE";
  provider: "bankr_v4";
  chains: LaunchChain[];
}

/** A page of launches, newest first. */
export interface LaunchPage {
  launches: IndexedLaunch[];
  /** Opaque: pass it back as `cursor` unchanged. Null on the last page. */
  nextCursor: string | null;
  /** Only when rows were left out: the page is not the whole answer, and a later read can be. */
  incomplete?: IncompleteLaunches;
}

export interface LaunchQuery {
  chain?: LaunchChain;
  builder?: string;
  launcher?: Address;
  /** An ERC-8021 builder code. */
  code?: string;
  provider?: IndexedLaunch["provider"];
  /** bankr_v4 launches on one pad (a decimal id), on the chain's current contracts. */
  launchpad?: bigint | string;
  /** bankr_v4 launches whose pool quotes this token. */
  quote?: Address;
  /** 1–64 characters: a case-insensitive part of the name or symbol, or a whole token address. */
  q?: string;
  /** Deployed at or after this instant (a `Date`, or an ISO 8601 date-time). */
  deployedAfter?: Date | string;
  /** Deployed at or before this instant. */
  deployedBefore?: Date | string;
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

/** `GET /launchpads/:chain/:id/stats`: one pad's totals on the chain's current contracts. An unknown pad reads zeros. */
export interface LaunchpadStats {
  chain: LaunchChain;
  launchpadId: string;
  window: "all" | "24h" | "7d" | "30d";
  visibility: "listed" | "all";
  stats: {
    /** Launches deployed inside `window`. */
    launches: number;
    /** Their current rolling 24h volume in USD, SDK launches included (best effort, as `market`). */
    volume24hUsd: number;
  };
}

export interface LaunchpadStatsQuery {
  /** Default `"all"`: every launch on the pad. */
  window?: LaunchpadStats["window"];
  /** Default `"all"`, unlike the launch list: SDK launches stay hidden until Bankr lists them. */
  visibility?: "listed" | "all";
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
  /** The ledger answered for: the one asked, else the chain's current one. Ledgers are never summed. */
  ledger: Address;
  /** Pull balances: referral slices and settled shares. */
  balances: { quote: Address; amount: string }[];
  buckets: AccountFeeBucket[];
  totalByQuote: { quote: Address; amount: string }[];
  bucketCount: number;
}

/**
 * A response that was not a success, from Bankr's API or a launchpad's signing route: the `cause` of an `api`
 * error. Its text is the server's, so it never reaches the SDK error's `message`.
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

const MAX_ERROR_TEXT = 500;

interface ApiReply {
  status: number;
  ok: boolean;
  body: unknown;
  retryAfter: string | null;
}

/** `incomplete` as the API defines it, field for field: its code, its provider, and at least one chain the SDK
 *  knows, each named once. Anything else is a malformed reply. */
const isIncomplete = (v: unknown): boolean =>
  isRecord(v) &&
  v.code === "INDEX_UNAVAILABLE" &&
  v.provider === "bankr_v4" &&
  Array.isArray(v.chains) &&
  v.chains.length > 0 &&
  v.chains.length <= LAUNCH_CHAINS.length &&
  v.chains.every((c) => isLaunchChain(c)) &&
  new Set(v.chains).size === v.chains.length;

/** The SDK error for a failed reply: 429 is RATE_LIMITED, a 503 for a chain's index INDEX_UNAVAILABLE, the rest
 *  API_ERROR. */
function apiError(reply: ApiReply, chain?: LaunchChain): LaunchApiError {
  const body = isRecord(reply.body) ? reply.body : {};
  const code = typeof body.code === "string" ? body.code : null;
  const retry = Number(reply.retryAfter);
  const cause = new BankrApiResponseError({
    status: reply.status,
    code,
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
      : reply.status === 503 && code === "INDEX_UNAVAILABLE"
        ? "INDEX_UNAVAILABLE"
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
  /** One page. `incomplete` is set when a chain's index is behind and its launches were left out. */
  launches(query?: LaunchQuery): Promise<LaunchPage>;
  /** Every launch matching `query`, newest first, fetched a page (default 100) at a time; `iterateLaunches` has the stop rules. */
  allLaunches(
    query?: LaunchQuery,
    options?: LaunchIterationOptions,
  ): AsyncIterableIterator<IndexedLaunch>;
  /** `GET /launches/:chain/:token`, hidden launches included; null when Bankr has not indexed it. */
  launch(
    chain: LaunchChain,
    token: Address,
    query?: LaunchDetailQuery,
  ): Promise<IndexedLaunch | null>;
  /** `GET /builders/:slug`; null for an unknown builder. */
  builder(slug: string, query?: BuilderQuery): Promise<BuilderProfile | null>;
  /** `GET /launchpads/:chain/:id/stats`: the pad on the chain's current contracts; zeros for an unknown pad. */
  launchpadStats(
    chain: LaunchChain,
    id: bigint | string,
    query?: LaunchpadStatsQuery,
  ): Promise<LaunchpadStats>;
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
   * `GET /bankr-v4/accounts/:account/fees`: the account's owed fees on one `ledger`, unnamed the chain's
   * current one; null for a 404 (no such ledger there, or not indexed).
   */
  accountFees(
    chain: LaunchChain,
    account: Address,
    ledger?: Address,
  ): Promise<AccountFeesResponse | null>;
}

type Query = Record<string, string | number | bigint | undefined>;

/** A date filter as the API reads it; `INVALID_PARAMS` for an invalid `Date`. */
function isoDate(
  d: Date | string | undefined,
  chain: LaunchChain | undefined,
): string | undefined {
  if (!(d instanceof Date)) return d;
  if (Number.isNaN(d.getTime())) {
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail: "deployedAfter and deployedBefore must be valid dates.",
    });
  }
  return d.toISOString();
}

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

  const api: BankrApi = {
    url: base,
    async launches(query = {}) {
      const reply = await get("/launches", {
        ...query,
        deployedAfter: isoDate(query.deployedAfter, query.chain),
        deployedBefore: isoDate(query.deployedBefore, query.chain),
      });
      return expectBody<LaunchPage>(
        reply,
        (b) =>
          isRecord(b) &&
          Array.isArray(b.launches) &&
          (b.nextCursor === null || typeof b.nextCursor === "string") &&
          (!("incomplete" in b) || isIncomplete(b.incomplete)),
        query.chain,
      );
    },
    allLaunches: (query, options) => iterateLaunches(api, query, options),
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
    async launchpadStats(chain, id, query = {}) {
      const reply = await get(
        `/launchpads/${segment(chain)}/${segment(String(id))}/stats`,
        { ...query },
        chain,
      );
      return expectBody<LaunchpadStats>(
        reply,
        (b) =>
          isRecord(b) &&
          typeof b.launchpadId === "string" &&
          isRecord(b.stats) &&
          typeof b.stats.launches === "number" &&
          typeof b.stats.volume24hUsd === "number",
        chain,
      );
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
  return api;
}
