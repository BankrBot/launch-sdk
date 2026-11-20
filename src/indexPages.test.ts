import { describe, expect, test } from "bun:test";
import type { IndexedLaunch, LaunchPage, LaunchQuery } from "./api.js";
import { isLaunchSdkError } from "./errors.js";
import { iterateLaunches } from "./indexPages.js";

const row = (n: number) =>
  ({ tokenAddress: `0x${n}` }) as unknown as IndexedLaunch;

/** An index of `pages` pages; each query is recorded, each cursor names the next page. */
function fakeIndex(
  pages: IndexedLaunch[][],
  cursorOf = (i: number) => `c${i}`,
) {
  const queries: LaunchQuery[] = [];
  const api = {
    async launches(query: LaunchQuery): Promise<LaunchPage> {
      queries.push(query);
      const i = query.cursor === undefined ? 0 : Number(query.cursor.slice(1));
      return {
        launches: pages[i] ?? [],
        nextCursor: i + 1 < pages.length ? cursorOf(i + 1) : null,
      };
    },
  };
  return { api, queries };
}

async function collect(
  it: AsyncIterable<IndexedLaunch>,
): Promise<IndexedLaunch[]> {
  const out: IndexedLaunch[] = [];
  for await (const l of it) out.push(l);
  return out;
}

describe("iterateLaunches", () => {
  test("walks every page until nextCursor is null, 100 a page unless the query names a limit", async () => {
    const { api, queries } = fakeIndex([[row(1), row(2)], [row(3)], [row(4)]]);
    expect(
      await collect(iterateLaunches(api, { chain: "base", q: "dog" })),
    ).toEqual([row(1), row(2), row(3), row(4)]);
    expect(queries).toEqual([
      { chain: "base", q: "dog", limit: 100, cursor: undefined },
      { chain: "base", q: "dog", limit: 100, cursor: "c1" },
      { chain: "base", q: "dog", limit: 100, cursor: "c2" },
    ]);
    const limited = fakeIndex([[row(1)]]);
    await collect(iterateLaunches(limited.api, { limit: 5 }));
    expect(limited.queries[0]!.limit).toBe(5);
  });

  test("starts from the query's cursor", async () => {
    const { api, queries } = fakeIndex([[row(1)], [row(2)], [row(3)]]);
    expect(await collect(iterateLaunches(api, { cursor: "c1" }))).toEqual([
      row(2),
      row(3),
    ]);
    expect(queries.map((q) => q.cursor)).toEqual(["c1", "c2"]);
  });

  test("max stops after that many launches with no extra page fetched", async () => {
    const { api, queries } = fakeIndex([[row(1), row(2)], [row(3)]]);
    expect(await collect(iterateLaunches(api, {}, { max: 2 }))).toEqual([
      row(1),
      row(2),
    ]);
    expect(queries).toHaveLength(1);
    expect(await collect(iterateLaunches(api, {}, { max: 0 }))).toEqual([]);
    expect(queries).toHaveLength(1);
    for (const max of [-1, 1.5, Number.NaN]) {
      const err = await collect(iterateLaunches(api, {}, { max })).catch(
        (e) => e,
      );
      expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(true);
    }
  });

  test("an abort throws its reason, before the next page or the next launch", async () => {
    const { api, queries } = fakeIndex([[row(1), row(2)], [row(3)]]);
    const controller = new AbortController();
    const reason = new Error("stop");
    const seen: IndexedLaunch[] = [];
    const err = await (async () => {
      for await (const l of iterateLaunches(
        api,
        {},
        { signal: controller.signal },
      )) {
        seen.push(l);
        controller.abort(reason);
      }
    })().catch((e) => e);
    expect(err).toBe(reason);
    expect(seen).toEqual([row(1)]);
    expect(queries).toHaveLength(1);

    const before = fakeIndex([[row(1)]]);
    const aborted = AbortSignal.abort(reason);
    expect(
      await collect(iterateLaunches(before.api, {}, { signal: aborted })).catch(
        (e) => e,
      ),
    ).toBe(reason);
    expect(before.queries).toHaveLength(0);
  });

  test("a page's error propagates unchanged, with no retry", async () => {
    const failure = new Error("429");
    let calls = 0;
    const api = {
      async launches(): Promise<LaunchPage> {
        calls += 1;
        if (calls === 2) throw failure;
        return { launches: [row(1)], nextCursor: "c1" };
      },
    };
    const seen: IndexedLaunch[] = [];
    const err = await (async () => {
      for await (const l of iterateLaunches(api)) seen.push(l);
    })().catch((e) => e);
    expect(err).toBe(failure);
    expect(seen).toEqual([row(1)]);
    expect(calls).toBe(2);
  });

  test("a cursor the API already sent is API_ERROR, never a loop", async () => {
    // Page 2 points back at page 1's cursor.
    const { api, queries } = fakeIndex([[row(1)], [row(2)], [row(3)]], (i) =>
      i === 2 ? "c1" : `c${i}`,
    );
    const err = await collect(iterateLaunches(api, { chain: "base" })).catch(
      (e) => e,
    );
    expect(isLaunchSdkError(err, "API_ERROR")).toBe(true);
    expect(queries).toHaveLength(2);
  });
});
