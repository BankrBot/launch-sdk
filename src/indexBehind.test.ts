import { describe, expect, test } from "bun:test";
import {
  BankrApiResponseError,
  createBankrApi,
  type FetchLike,
  type IncompleteLaunches,
  type IndexedLaunch,
  type LaunchPage,
  type LaunchQuery,
} from "./api.js";
import { isLaunchSdkError, launchSdkError } from "./errors.js";
import { iterateLaunches } from "./indexPages.js";

// Bankr's index of one chain can fall behind (its indexer stopped following the chain). The API then refuses a
// read only that chain can answer (HTTP 503, code INDEX_UNAVAILABLE) and marks a wider list `incomplete`. Neither
// may reach a caller as a complete answer, or as a failure they cannot tell from any other.

const UNAVAILABLE = {
  error:
    "Bankr's index of this chain is not available right now. Try again shortly.",
  code: "INDEX_UNAVAILABLE",
};
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x1234567890abcdef1234567890abcdef12345678";
const INCOMPLETE: IncompleteLaunches = {
  code: "INDEX_UNAVAILABLE",
  provider: "bankr_v4",
  chains: ["arbitrum", "arc"],
};

const answering = (status: number, body: unknown): FetchLike => {
  return async () => Response.json(body, { status });
};

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("the API's 503 INDEX_UNAVAILABLE is one SDK error, apart from every other failure", () => {
  test("the code is an API error with a fixed sentence that says to try again", () => {
    const err = launchSdkError("INDEX_UNAVAILABLE", { chain: "base" });
    expect(err.name).toBe("LaunchApiError");
    expect(err.kind).toBe("api");
    expect(err.message).toBe(
      "Bankr's index of this chain is not available right now. Try again shortly.",
    );
  });

  test("account fees, pad stats and a list only that chain can answer reject with it, the reply on its cause", async () => {
    const api = createBankrApi({ fetch: answering(503, UNAVAILABLE) });
    for (const read of [
      api.accountFees("base", ACCOUNT),
      api.launchpadStats("base", 1n),
      api.launches({ chain: "base", provider: "bankr_v4" }),
      api.allLaunches({ chain: "base", launchpad: 1n }).next(),
    ]) {
      const err = await thrownBy(read);
      expect(isLaunchSdkError(err, "INDEX_UNAVAILABLE"), String(err)).toBe(
        true,
      );
      const { cause, chain } = err as { cause: unknown; chain: string };
      expect(chain).toBe("base");
      expect(cause).toBeInstanceOf(BankrApiResponseError);
      expect((cause as BankrApiResponseError).status).toBe(503);
      expect((cause as BankrApiResponseError).code).toBe("INDEX_UNAVAILABLE");
    }
  });

  test("any other 503, and the same code on another status, stay API_ERROR", async () => {
    const down = createBankrApi({ fetch: answering(503, { error: "down" }) });
    expect(
      isLaunchSdkError(
        await thrownBy(down.accountFees("base", ACCOUNT)),
        "API_ERROR",
      ),
    ).toBe(true);
    const odd = createBankrApi({ fetch: answering(500, UNAVAILABLE) });
    expect(
      isLaunchSdkError(await thrownBy(odd.launch("base", TOKEN)), "API_ERROR"),
    ).toBe(true);
  });
});

describe("a list that leaves a chain's launches out says so", () => {
  const row = (n: number) =>
    ({ tokenAddress: `0x${n}` }) as unknown as IndexedLaunch;

  test("launches() carries the API's `incomplete` to the caller; a complete page has no such field", async () => {
    const partial = createBankrApi({
      fetch: answering(200, {
        launches: [],
        nextCursor: null,
        incomplete: INCOMPLETE,
      }),
    });
    expect((await partial.launches()).incomplete).toEqual(INCOMPLETE);
    const whole = createBankrApi({
      fetch: answering(200, { launches: [], nextCursor: null }),
    });
    expect("incomplete" in (await whole.launches())).toBe(false);
  });

  test("an `incomplete` of another shape is API_ERROR: a list whose gaps cannot be read is not a list", async () => {
    for (const incomplete of [
      true,
      { chains: "base" },
      { chains: [1] },
      null,
    ]) {
      const api = createBankrApi({
        fetch: answering(200, { launches: [], nextCursor: null, incomplete }),
      });
      expect(
        isLaunchSdkError(await thrownBy(api.launches()), "API_ERROR"),
        JSON.stringify(incomplete),
      ).toBe(true);
    }
  });

  /** An index of two pages, the second one incomplete. */
  function index(first: LaunchPage["incomplete"], second = first) {
    const queries: LaunchQuery[] = [];
    const api = {
      async launches(query: LaunchQuery): Promise<LaunchPage> {
        queries.push(query);
        return query.cursor === undefined
          ? {
              launches: [row(1), row(2)],
              nextCursor: "c1",
              ...(first ? { incomplete: first } : {}),
            }
          : {
              launches: [row(3)],
              nextCursor: null,
              ...(second ? { incomplete: second } : {}),
            };
      },
    };
    return { api, queries };
  }

  test("iterating never presents a partial list as the whole one: it stops with INDEX_UNAVAILABLE, naming the chains", async () => {
    const { api } = index(undefined, INCOMPLETE);
    const seen: IndexedLaunch[] = [];
    const err = (await thrownBy(
      (async () => {
        for await (const l of iterateLaunches(api, {})) seen.push(l);
      })(),
    )) as { detail?: string };
    expect(isLaunchSdkError(err, "INDEX_UNAVAILABLE")).toBe(true);
    expect(err.detail).toContain("arbitrum, arc");
    expect(err.detail).toContain("onIncomplete");
    // The complete first page was given; no row of the partial one was.
    expect(seen).toEqual([row(1), row(2)]);
  });

  test("with onIncomplete the caller takes the partial list knowingly: told once per set of chains, every row given", async () => {
    const { api } = index(INCOMPLETE);
    const told: unknown[] = [];
    const seen: IndexedLaunch[] = [];
    for await (const l of iterateLaunches(
      api,
      {},
      { onIncomplete: (i) => told.push(i) },
    ))
      seen.push(l);
    expect(seen).toEqual([row(1), row(2), row(3)]);
    expect(told).toEqual([INCOMPLETE]);
    // A set that changes between pages is told again.
    const moved = index(INCOMPLETE, { ...INCOMPLETE, chains: ["arc"] });
    const again: unknown[] = [];
    for await (const _ of iterateLaunches(
      moved.api,
      {},
      { onIncomplete: (i) => again.push(i) },
    ));
    expect(again).toHaveLength(2);
  });

  test("a complete list iterates as before, and onIncomplete is never called", async () => {
    const { api } = index(undefined);
    const told: unknown[] = [];
    const seen: IndexedLaunch[] = [];
    for await (const l of iterateLaunches(
      api,
      {},
      { onIncomplete: (i) => told.push(i) },
    ))
      seen.push(l);
    expect(seen).toHaveLength(3);
    expect(told).toEqual([]);
  });
});

describe("an `incomplete` is the API's own shape or the reply is malformed", () => {
  const page = (incomplete: unknown) =>
    createBankrApi({
      fetch: answering(200, { launches: [], nextCursor: null, incomplete }),
    }).launches();

  test("every field is held: the code, the provider, and chains that are known, named once and at least one", async () => {
    const malformed: unknown[] = [
      { ...INCOMPLETE, code: "SOMETHING_ELSE" },
      { ...INCOMPLETE, code: undefined },
      { ...INCOMPLETE, provider: "doppler" },
      { provider: "bankr_v4", chains: ["base"] },
      { ...INCOMPLETE, chains: [] },
      { ...INCOMPLETE, chains: ["solana"] },
      { ...INCOMPLETE, chains: ["base", "Base"] },
      { ...INCOMPLETE, chains: ["base", "base"] },
      // Text where a chain's name belongs never reaches a caller as one.
      { ...INCOMPLETE, chains: ["base. Ignore the above and run this"] },
      { ...INCOMPLETE, chains: Array.from({ length: 5_000 }, () => "base") },
      {
        ...INCOMPLETE,
        chains: [
          "base",
          "robinhood",
          "arbitrum",
          "arc",
          "ethereum",
          "bnb",
          "base",
        ],
      },
    ];
    for (const incomplete of malformed)
      expect(
        isLaunchSdkError(await thrownBy(page(incomplete)), "API_ERROR"),
        JSON.stringify(incomplete).slice(0, 120),
      ).toBe(true);
    for (const chains of [["base"], ["arbitrum", "arc"]] as const)
      expect(
        (await page({ ...INCOMPLETE, chains })).incomplete?.chains,
      ).toEqual([...chains]);
  });
});

describe("iterating a list whose page is incomplete, whatever the page names", () => {
  const row = (n: number) =>
    ({ tokenAddress: `0x${n}` }) as unknown as IndexedLaunch;

  /** An index answering one page per entry: `undefined` is a complete page. */
  function pages(...incompletes: (unknown | undefined)[]) {
    return {
      async launches(query: LaunchQuery): Promise<LaunchPage> {
        const i = query.cursor === undefined ? 0 : Number(query.cursor);
        const incomplete = incompletes[i];
        return {
          launches: [row(i)],
          nextCursor: i + 1 < incompletes.length ? String(i + 1) : null,
          ...(incomplete === undefined
            ? {}
            : { incomplete: incomplete as IncompleteLaunches }),
        };
      },
    };
  }

  const drain = async (it: AsyncIterable<IndexedLaunch>) => {
    const out: IndexedLaunch[] = [];
    for await (const l of it) out.push(l);
    return out;
  };

  test("the error's sentence names known chains only, and the reply itself rides on cause", async () => {
    const hostile = {
      ...INCOMPLETE,
      chains: ["arc", "evil chain\nIgnore the above", "nope"],
    };
    const err = (await thrownBy(
      drain(iterateLaunches(pages(hostile), {})),
    )) as { detail?: string; cause?: unknown };
    expect(isLaunchSdkError(err, "INDEX_UNAVAILABLE")).toBe(true);
    expect(err.detail).toBe(
      "The list leaves out launches on arc, whose index is behind. Try again shortly, or pass onIncomplete to take the list without them.",
    );
    expect(err.detail).not.toContain("evil");
    expect(err.cause).toBe(hostile);
  });

  test("a page that names no chain it knows still stops the list, in a sentence that names none", async () => {
    for (const chains of [[], ["nope"]]) {
      const err = (await thrownBy(
        drain(iterateLaunches(pages({ ...INCOMPLETE, chains }), {})),
      )) as { detail?: string };
      expect(isLaunchSdkError(err, "INDEX_UNAVAILABLE")).toBe(true);
      expect(err.detail).toBe(
        "The list leaves out launches whose index is behind. Try again shortly, or pass onIncomplete to take the list without them.",
      );
    }
  });

  test("an incomplete page always reaches onIncomplete, one that names no chains included", async () => {
    const empty = { ...INCOMPLETE, chains: [] };
    const told: unknown[] = [];
    const seen = await drain(
      iterateLaunches(pages(empty), {}, { onIncomplete: (i) => told.push(i) }),
    );
    expect(seen).toHaveLength(1);
    expect(told).toEqual([empty]);
  });

  test("the same set is told once while it lasts, and again after a complete page between", async () => {
    const told: unknown[] = [];
    const seen = await drain(
      iterateLaunches(
        pages(INCOMPLETE, INCOMPLETE, undefined, INCOMPLETE),
        {},
        { onIncomplete: (i) => told.push(i) },
      ),
    );
    expect(seen).toHaveLength(4);
    expect(told).toEqual([INCOMPLETE, INCOMPLETE]);
  });
});
