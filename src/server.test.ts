import { describe, expect, test } from "bun:test";
import { remotePreparer, type FetchLike, type PrepareRequest } from "./api.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import {
  bankrPreparer,
  createPrepareHandler,
  type PrepareHandlerOptions,
} from "./server.js";

const KEY = "bk_usr_test_key";

const REQUEST: PrepareRequest = {
  chain: "base",
  launcher: "0x1111111111111111111111111111111111111111",
  launchpadId: "0",
  name: "Launch",
  symbol: "LNCH",
  vesting: { bps: 1_000 },
};

// Shape only: the launch client, not the handler, verifies a prepare against its own input and suite.
const PREPARED = {
  chain: "base",
  chainId: 8453,
  launchpadId: "0",
  factory: "0x00",
  launcher: "0x00",
  params: {},
  value: "0",
  approval: null,
  predictedToken: "0x00",
  poolId: "0x00",
  tokenIsCurrency0: true,
  distributor: "0x00",
  escrow: null,
  expectedStartTick: 0,
  deadline: "0",
  padSigner: null,
  authorization: null,
  metadataUri: "ipfs://x",
  prepareId: "abc",
};

interface Upstream {
  fetch: FetchLike;
  calls: { url: string; headers: Headers; body: unknown }[];
}

/** Bankr's API as the handler's upstream: records each call and answers with `respond`. */
function upstream(
  respond: () => Response = () => json(200, PREPARED),
): Upstream {
  const calls: Upstream["calls"] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({
        url: input,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return respond();
    },
  };
}

const json = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const post = (body: unknown, headers?: HeadersInit) =>
  new Request("https://builder.example/api/launch/prepare", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function handler(
  up: Upstream,
  overrides: Partial<PrepareHandlerOptions> = {},
): (req: Request) => Promise<Response> {
  return createPrepareHandler({
    apiKey: KEY,
    authorize: () => {},
    fetch: up.fetch,
    ...overrides,
  });
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function inBrowser<T>(fn: () => T): T {
  Object.assign(globalThis, { window: {}, document: {} });
  try {
    return fn();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
}

describe("createPrepareHandler: construction", () => {
  test("authorize is required: there is no default allow", () => {
    const missing = { apiKey: KEY } as unknown as PrepareHandlerOptions;
    expect(thrownBy(() => createPrepareHandler(missing))).toBeInstanceOf(
      TypeError,
    );
    const blank = { apiKey: "", authorize: () => {} };
    expect(thrownBy(() => createPrepareHandler(blank))).toBeInstanceOf(
      TypeError,
    );
  });

  test("API_KEY_IN_BROWSER: the handler and bankrPreparer refuse to run in a browser", () => {
    const makers: (() => unknown)[] = [
      () => createPrepareHandler({ apiKey: KEY, authorize: () => {} }),
      () => bankrPreparer({ apiKey: KEY }),
    ];
    for (const make of makers) {
      const err = thrownBy(() => inBrowser(make));
      expect(isLaunchSdkError(err, "API_KEY_IN_BROWSER")).toBe(true);
      expect(thrownBy(make)).toBeUndefined();
    }
  });
});

describe("createPrepareHandler: requests", () => {
  test("forwards an authorized prepare to Bankr with the key, and returns Bankr's prepare", async () => {
    const up = upstream();
    const seen: Request[] = [];
    const res = await handler(up, {
      url: "https://api.example",
      authorize: (req) => void seen.push(req),
    })(post({ ...REQUEST, apiKey: "smuggled", builderId: "other" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PREPARED);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(seen).toHaveLength(1);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toBe(
      "https://api.example/bankr-v4/launches/prepare",
    );
    expect(up.calls[0]!.headers.get("x-api-key")).toBe(KEY);
    // Only the prepare request's own fields reach Bankr.
    expect(up.calls[0]!.body).toEqual(REQUEST);
  });

  test("a launch's curve reaches Bankr: a built-in by name, or own bands with their USD start", async () => {
    const up = upstream();
    for (const curve of [
      "degen",
      {
        bands: [
          { widthTicks: 6_800, shareBps: 304 },
          { widthTicks: 0, shareBps: 9_696 },
        ],
        startFdvUsd: 25_000,
      },
    ] as const) {
      const res = await handler(up)(post({ ...REQUEST, curve }));
      expect(res.status).toBe(200);
      expect(up.calls.at(-1)!.body).toEqual({ ...REQUEST, curve });
    }
  });

  test("authorize can read the body; the handler forwards its own copy", async () => {
    const up = upstream();
    let launcher: unknown;
    const res = await handler(up, {
      authorize: async (req) => {
        launcher = ((await req.json()) as PrepareRequest).launcher;
      },
    })(post(REQUEST));
    expect(res.status).toBe(200);
    expect(launcher).toBe(REQUEST.launcher);
    expect(up.calls[0]!.body).toEqual(REQUEST);
  });

  test("a refused authorize: a thrown Response is returned as is; anything else is a 403; Bankr is never called", async () => {
    const up = upstream();
    const limited = await handler(up, {
      authorize: () => {
        throw new Response("slow down", { status: 429 });
      },
    })(post(REQUEST));
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("slow down");

    const denied = await handler(up, {
      authorize: async () => {
        throw new Error("no session for /srv/secret");
      },
    })(post(REQUEST));
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("secret");
    expect(up.calls).toEqual([]);
  });

  test("only POST, a JSON object body, and at most 16 KiB", async () => {
    const up = upstream();
    const h = handler(up);
    const get = await h(new Request("https://builder.example/p"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await h(post("{not json"))).status).toBe(400);
    expect((await h(post("[1,2]"))).status).toBe(400);
    const big = { ...REQUEST, name: "x".repeat(17 * 1024) };
    expect((await h(post(big))).status).toBe(413);
    // The limit counts bytes: 6,000 three-byte characters are about 18 KB.
    const wide = { ...REQUEST, name: "\u20ac".repeat(6_000) };
    expect((await h(post(wide))).status).toBe(413);
    expect(up.calls).toEqual([]);
  });

  test("only application/json: a text/plain or form body (a CORS-simple request, no preflight) is a 415", async () => {
    const up = upstream();
    const h = handler(up);
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
    ]) {
      const res = await h(post(REQUEST, { "content-type": type }));
      expect(res.status, type).toBe(415);
    }
    expect(up.calls).toEqual([]);
    const charset = await h(
      post(REQUEST, { "content-type": "Application/JSON; charset=utf-8" }),
    );
    expect(charset.status).toBe(200);
  });

  test("a streamed body with no Content-Length is cut off past 16 KiB, before authorize runs", async () => {
    const up = upstream();
    let pulled = 0;
    let authorized = 0;
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 10 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request("https://builder.example/api/launch/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();

    const res = await handler(up, {
      authorize: () => void authorized++,
    })(req);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(64 * 1024);
    expect(authorized).toBe(0);
    expect(up.calls).toEqual([]);
  });

  test("Bankr's refusals: 429 stays 429, a 4xx keeps Bankr's own message and code, the rest is a fixed 502", async () => {
    const cases: [Response, number, Record<string, unknown>][] = [
      [
        json(429, { error: "Too many." }, { "retry-after": "30" }),
        429,
        { code: "RATE_LIMITED" },
      ],
      [
        json(422, {
          error: "The launch would revert as prepared.",
          code: "LAUNCH_V3_SIMULATION",
        }),
        422,
        {
          error: "The launch would revert as prepared.",
          code: "API_ERROR",
          apiCode: "LAUNCH_V3_SIMULATION",
        },
      ],
      [
        json(403, { error: "Key too broad.", code: "API_KEY_OVERPRIVILEGED" }),
        502,
        { code: "API_KEY_OVERPRIVILEGED" },
      ],
      [
        json(500, { error: "mongo at 10.0.0.1 timed out" }),
        502,
        { code: "API_ERROR", error: "The Bankr API request failed." },
      ],
    ];
    for (const [answer, status, body] of cases) {
      const errors: unknown[] = [];
      const res = await handler(
        upstream(() => answer.clone()),
        {
          onError: (err) => void errors.push(err),
        },
      )(post(REQUEST));
      expect(res.status).toBe(status);
      const got = (await res.json()) as Record<string, unknown>;
      expect(got).toMatchObject(body);
      expect(JSON.stringify(got)).not.toContain("10.0.0.1");
      expect(errors).toHaveLength(1);
      if (status === 429) expect(res.headers.get("retry-after")).toBe("30");
    }
  });

  test("a browser's remotePreparer reads the handler's errors back as the same codes", async () => {
    const cases: [Response, LaunchSdkErrorCode][] = [
      [json(429, { error: "Too many." }), "RATE_LIMITED"],
      [
        json(403, { error: "Key too broad.", code: "API_KEY_OVERPRIVILEGED" }),
        "API_KEY_OVERPRIVILEGED",
      ],
      [json(400, { error: "Bad.", code: "INVALID_LAUNCH" }), "API_ERROR"],
    ];
    for (const [answer, code] of cases) {
      const h = handler(upstream(() => answer.clone()));
      const prepare = remotePreparer(
        "https://builder.example/api/launch/prepare",
        {},
        { fetch: (input, init) => h(new Request(input, init)) },
      );
      let thrown: unknown;
      try {
        await prepare(REQUEST);
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, code), `${code}`).toBe(true);
    }
  });
});

describe("bankrPreparer", () => {
  test("sends the key only over https or to a local API, and never follows a redirect with it", async () => {
    for (const url of ["http://api.bankr.bot", "http://api.example:8080"]) {
      const err = thrownBy(() => bankrPreparer({ apiKey: KEY, url }));
      expect(isLaunchSdkError(err, "INVALID_PARAMS"), url).toBe(true);
      const make = () =>
        createPrepareHandler({ apiKey: KEY, url, authorize: () => {} });
      expect(isLaunchSdkError(thrownBy(make), "INVALID_PARAMS")).toBe(true);
    }
    for (const url of [
      "https://api.example",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      const inits: (RequestInit | undefined)[] = [];
      const prepare = bankrPreparer({
        apiKey: KEY,
        url,
        fetch: async (_input, init) => {
          inits.push(init);
          return json(200, PREPARED);
        },
      });
      await prepare(REQUEST);
      expect(inits[0]?.redirect, url).toBe("error");
      expect(new Headers(inits[0]?.headers).get("x-api-key")).toBe(KEY);
    }
  });
});
