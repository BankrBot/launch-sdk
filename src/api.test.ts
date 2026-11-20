import { describe, expect, test } from "bun:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  BankrApiResponseError,
  DEFAULT_BANKR_API_URL,
  createBankrApi,
  type AccountFeesResponse,
  type FetchLike,
  type LaunchPage,
  type LaunchpadStats,
  type RegisterResult,
} from "./api.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import * as sdk from "./index.js";

const TOKEN: Address = "0x1234567890abcdef1234567890abcdef12345678";
const TX_HASH: Hex = `0x${"ab".repeat(32)}`;

interface Call {
  url: URL;
  init: RequestInit | undefined;
  body: unknown;
}

/** A fetch that records each call and answers with `respond`. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: Call = {
      url: new URL(input, "https://builder.example"),
      init,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

async function expectCode(
  promise: Promise<unknown>,
  code: LaunchSdkErrorCode,
): Promise<unknown> {
  const err = await rejection(promise);
  expect(isLaunchSdkError(err, code), `${code}, got ${String(err)}`).toBe(true);
  return err;
}

const PAGE: LaunchPage = {
  launches: [
    {
      chain: "arbitrum",
      tokenAddress: TOKEN,
      poolId: "0x9999999999999999999999999999999999999999",
      name: "Launch",
      symbol: "LNCH",
      imageUrl: null,
      provider: "bankr_v4",
      launchpadId: "0",
      quoteAddress: "0x4200000000000000000000000000000000000006",
      launcher: "0x1111111111111111111111111111111111111111",
      feeRecipient: null,
      builder: "mypad",
      attribution: "prepared",
      deployedAt: "2026-11-04T00:00:00.000Z",
      hidden: false,
      market: { priceUsd: null, marketCapUsd: null, volume24hUsd: 0 },
    },
  ],
  // The server's keyset cursor: opaque to the SDK, which never parses it.
  nextCursor: "eyJ0IjoxNzMwMDAwMDAwMDAwLCJpZCI6ImFiYyJ9+/=",
};

describe("createBankrApi: the launch index", () => {
  test("launches: GET /launches with only the filters given, and the opaque cursor sent back unchanged", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, PAGE));
    const api = createBankrApi({ fetch });
    expect(api.url).toBe(DEFAULT_BANKR_API_URL);

    const first = await api.launches({ chain: "arbitrum", builder: "mypad" });
    expect(first).toEqual(PAGE);
    await api.launches({
      chain: "arbitrum",
      cursor: first.nextCursor!,
      limit: 50,
    });

    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(
      "https://api.bankr.bot/launches",
    );
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      chain: "arbitrum",
      builder: "mypad",
    });
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[1]!.url.searchParams.get("cursor")).toBe(PAGE.nextCursor);
    expect(calls[1]!.url.searchParams.get("limit")).toBe("50");
  });

  test("launch and builder: one row or profile, null for a 404", async () => {
    const { fetch, calls } = fakeFetch(({ url }) =>
      url.pathname.endsWith(TOKEN)
        ? json(200, PAGE.launches[0])
        : json(404, { error: "Not found." }),
    );
    const api = createBankrApi({ url: "https://api.example/v/", fetch });
    expect(await api.launch("arbitrum", TOKEN)).toEqual(PAGE.launches[0]!);
    expect(await api.launch("arbitrum", `0x${"00".repeat(19)}01`)).toBeNull();
    expect(await api.builder("no-such-pad", { window: "24h" })).toBeNull();
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `/v/launches/arbitrum/${TOKEN}`,
      `/v/launches/arbitrum/0x${"00".repeat(19)}01`,
      "/v/builders/no-such-pad",
    ]);
    expect(calls[2]!.url.searchParams.get("window")).toBe("24h");
    expect(calls[0]!.url.search).toBe("");
  });

  test("launch: attribution all asks for a code-tier builder too", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, PAGE.launches[0]));
    const api = createBankrApi({ fetch });
    await api.launch("arbitrum", TOKEN, { attribution: "all" });
    await api.launch("arbitrum", TOKEN, {});
    expect(calls[0]!.url.pathname).toBe(`/launches/arbitrum/${TOKEN}`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      attribution: "all",
    });
    expect(calls[1]!.url.search).toBe("");
  });

  test("register: POST /launches/register with the chain and hash", async () => {
    const body: RegisterResult = {
      chain: "arbitrum",
      txHash: TX_HASH,
      confirmations: 6,
      launches: [{ tokenAddress: TOKEN, poolId: TOKEN, status: "pending" }],
    };
    const { fetch, calls } = fakeFetch(() => json(200, body));
    const api = createBankrApi({ fetch });
    expect(await api.register("arbitrum", TX_HASH)).toEqual(body);
    expect(calls[0]!.url.pathname).toBe("/launches/register");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ chain: "arbitrum", txHash: TX_HASH });

    // A caller's signal reaches the request, so a hung registration can be cancelled.
    const { signal } = new AbortController();
    await api.register("arbitrum", TX_HASH, { signal });
    expect(calls[1]!.init?.signal).toBe(signal);
  });

  test("the launch index takes the bankr_v4 provider and a launchpad filter", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, { launches: [], nextCursor: null }),
    );
    await createBankrApi({ fetch }).launches({
      provider: "bankr_v4",
      launchpad: 7n,
      chain: "base",
    });
    expect(calls[0]!.url.searchParams.get("provider")).toBe("bankr_v4");
    expect(calls[0]!.url.searchParams.get("launchpad")).toBe("7");
  });

  test("launchpadStats: GET /launchpads/:chain/:id/stats with only the options given", async () => {
    const body: LaunchpadStats = {
      chain: "base",
      launchpadId: "7",
      window: "7d",
      visibility: "all",
      stats: { launches: 3, volume24hUsd: 12.5 },
    };
    const { fetch, calls } = fakeFetch(() => json(200, body));
    const api = createBankrApi({ fetch });
    expect(await api.launchpadStats("base", 7n, { window: "7d" })).toEqual(
      body,
    );
    expect(calls[0]!.url.pathname).toBe("/launchpads/base/7/stats");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      window: "7d",
    });
    const wrong = fakeFetch(() => json(200, { ...body, stats: null }));
    await expectCode(
      createBankrApi({ fetch: wrong.fetch }).launchpadStats("base", "7"),
      "API_ERROR",
    );
  });

  test("search, quote and deploy dates: a Date goes out as ISO, a string unchanged", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, { launches: [], nextCursor: null }),
    );
    const api = createBankrApi({ fetch });
    await api.launches({
      q: "dog",
      quote: "0x4200000000000000000000000000000000000006",
      deployedAfter: new Date(Date.UTC(2026, 10, 1)),
      deployedBefore: "2026-11-02T00:00:00+00:00",
    });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      q: "dog",
      quote: "0x4200000000000000000000000000000000000006",
      deployedAfter: "2026-11-01T00:00:00.000Z",
      deployedBefore: "2026-11-02T00:00:00+00:00",
    });
    await expectCode(
      api.launches({ deployedAfter: new Date(Number.NaN) }),
      "INVALID_PARAMS",
    );
    expect(calls).toHaveLength(1);
  });

  test("accountFees: GET /bankr-v4/accounts/:account/fees with the chain's id and the ledger named; null for a 404, API_ERROR for a wrong shape", async () => {
    const LEDGER = getAddress("0x00000000000000000000000000000000000084e2");
    const body: AccountFeesResponse = {
      chainId: 8453,
      account: TOKEN,
      ledger: LEDGER,
      balances: [],
      buckets: [],
      totalByQuote: [],
      bucketCount: 0,
    };
    const { fetch, calls } = fakeFetch(() => json(200, body));
    expect(await createBankrApi({ fetch }).accountFees("base", TOKEN)).toEqual(
      body,
    );
    expect(calls[0]!.url.href).toBe(
      `https://api.bankr.bot/bankr-v4/accounts/${TOKEN}/fees?chainId=8453`,
    );
    // A suite's client names its own ledger: on a chain with two suites the answer is that ledger's alone.
    await createBankrApi({ fetch }).accountFees("base", TOKEN, LEDGER);
    expect(calls[1]!.url.href).toBe(
      `https://api.bankr.bot/bankr-v4/accounts/${TOKEN}/fees?chainId=8453&ledger=${LEDGER}`,
    );
    const missing = fakeFetch(() => json(404, { error: "Not found" }));
    expect(
      await createBankrApi({ fetch: missing.fetch }).accountFees("base", TOKEN),
    ).toBeNull();
    const wrong = fakeFetch(() => json(200, { ...body, buckets: null }));
    await expectCode(
      createBankrApi({ fetch: wrong.fetch }).accountFees("base", TOKEN),
      "API_ERROR",
    );
  });

  test("a base URL that is not http(s) is refused up front", () => {
    for (const url of ["ftp://api.bankr.bot", "not a url"]) {
      let thrown: unknown;
      try {
        createBankrApi({ url });
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    }
  });
});

describe("API errors", () => {
  test("429 is RATE_LIMITED, with the server's Retry-After on the cause", async () => {
    const { fetch } = fakeFetch(() =>
      json(429, { error: "Too many." }, { "retry-after": "42" }),
    );
    const err = await expectCode(
      createBankrApi({ fetch }).launches(),
      "RATE_LIMITED",
    );
    const cause = (err as Error).cause as BankrApiResponseError;
    expect(cause).toBeInstanceOf(BankrApiResponseError);
    expect(cause.status).toBe(429);
    expect(cause.retryAfterSeconds).toBe(42);
  });

  test("any other failure is API_ERROR with a fixed message; the server's text and code ride on the cause", async () => {
    const { fetch } = fakeFetch(() =>
      json(409, {
        error: "internal detail /srv/app.js",
        code: "NOT_CONFIRMED",
      }),
    );
    const err = (await expectCode(
      createBankrApi({ fetch }).register("arbitrum", TX_HASH),
      "API_ERROR",
    )) as Error;
    expect(err.message).toBe("The Bankr API request failed.");
    expect(JSON.stringify(err)).not.toContain("internal detail");
    const cause = err.cause as BankrApiResponseError;
    expect(cause.status).toBe(409);
    expect(cause.code).toBe("NOT_CONFIRMED");
    expect(cause.message).toBe("internal detail /srv/app.js");
  });

  test("a network failure, a body that is not JSON and a body of the wrong shape are API_ERROR", async () => {
    const down: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const err = (await expectCode(
      createBankrApi({ fetch: down }).launches(),
      "API_ERROR",
    )) as Error;
    expect((err.cause as Error).message).toBe("fetch failed");

    for (const res of [
      () => new Response("<html>bad gateway</html>", { status: 200 }),
      () => json(200, { launches: "nope" }),
    ]) {
      const { fetch } = fakeFetch(res);
      await expectCode(createBankrApi({ fetch }).launches(), "API_ERROR");
    }
  });
});

describe("the root entry", () => {
  test("exports the API client, and nothing that prepares a launch through Bankr's API", () => {
    const exported = Object.keys(sdk);
    expect(exported).toContain("createBankrApi");
    for (const gone of [
      "remotePreparer",
      "createPrepareHandler",
      "bankrPreparer",
    ])
      expect(exported, gone).not.toContain(gone);
  });
});
