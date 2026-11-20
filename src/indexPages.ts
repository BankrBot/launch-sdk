import type { IndexedLaunch, LaunchPage, LaunchQuery } from "./api.js";
import { LaunchApiError, LaunchRefusedError } from "./errors.js";

/** The page size `all` asks for when the query names none (the API's maximum). */
export const LAUNCH_INDEX_ITERATION_LIMIT = 100;

export interface LaunchIterationOptions {
  /** Stop after this many launches, without fetching another page. */
  max?: number;
  /** Aborting it throws its reason from the iterator. */
  signal?: AbortSignal;
}

/**
 * Every launch matching `query`, newest first, a page at a time from `query.cursor` (or the start). A page's error
 * propagates unchanged (a 429 included: no retry here); an API that sends back a cursor it already sent is
 * `API_ERROR`, never an endless loop.
 */
export async function* iterateLaunches(
  api: { launches(query: LaunchQuery): Promise<LaunchPage> },
  query: LaunchQuery = {},
  options: LaunchIterationOptions = {},
): AsyncIterableIterator<IndexedLaunch> {
  const { max = Number.POSITIVE_INFINITY, signal } = options;
  if (!(
    max === Number.POSITIVE_INFINITY ||
    (Number.isSafeInteger(max) && max >= 0)
  )) {
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain: query.chain,
      detail: "max must be a whole number of launches, 0 or more.",
    });
  }
  const sent = new Set<string>();
  let cursor = query.cursor;
  let yielded = 0;
  while (yielded < max) {
    signal?.throwIfAborted();
    if (cursor !== undefined) sent.add(cursor);
    const page = await api.launches({
      ...query,
      limit: query.limit ?? LAUNCH_INDEX_ITERATION_LIMIT,
      cursor,
    });
    for (const launch of page.launches) {
      signal?.throwIfAborted();
      yield launch;
      if (++yielded >= max) return;
    }
    if (page.nextCursor === null) return;
    if (sent.has(page.nextCursor)) {
      throw new LaunchApiError("API_ERROR", {
        chain: query.chain,
        cause: new Error(
          "The launch index sent back a cursor it already sent.",
        ),
      });
    }
    cursor = page.nextCursor;
  }
}
