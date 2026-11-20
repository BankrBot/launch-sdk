import type {
  IncompleteLaunches,
  IndexedLaunch,
  LaunchPage,
  LaunchQuery,
} from "./api.js";
import { isLaunchChain } from "./chains/index.js";
import { LaunchApiError, LaunchRefusedError } from "./errors.js";

/** The page size `all` asks for when the query names none (the API's maximum). */
export const LAUNCH_INDEX_ITERATION_LIMIT = 100;

export interface LaunchIterationOptions {
  /** Stop after this many launches, without fetching another page. */
  max?: number;
  /** Aborting it throws its reason from the iterator. */
  signal?: AbortSignal;
  /**
   * Take a list that leaves a chain's launches out (its index is behind) instead of stopping: called with what is
   * missing, once per set of chains. Without it such a page throws `INDEX_UNAVAILABLE`.
   */
  onIncomplete?: (incomplete: IncompleteLaunches) => void;
}

/**
 * Every launch matching `query`, newest first, a page at a time from `query.cursor` (or the start). A page's error
 * propagates unchanged (a 429 included: no retry here); an API that sends back a cursor it already sent is
 * `API_ERROR`, never an endless loop. A page that leaves a chain's launches out is never given as the whole list:
 * it throws `INDEX_UNAVAILABLE` before any of its rows, unless `onIncomplete` takes it.
 */
export async function* iterateLaunches(
  api: { launches(query: LaunchQuery): Promise<LaunchPage> },
  query: LaunchQuery = {},
  options: LaunchIterationOptions = {},
): AsyncIterableIterator<IndexedLaunch> {
  const { max = Number.POSITIVE_INFINITY, signal, onIncomplete } = options;
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
  // The set of chains the caller was last told of; null while the list is whole.
  let told: string | null = null;
  while (yielded < max) {
    signal?.throwIfAborted();
    if (cursor !== undefined) sent.add(cursor);
    const page = await api.launches({
      ...query,
      limit: query.limit ?? LAUNCH_INDEX_ITERATION_LIMIT,
      cursor,
    });
    if (page.incomplete) {
      const named: readonly unknown[] = Array.isArray(page.incomplete.chains)
        ? page.incomplete.chains
        : [];
      // The sentence names chains from the SDK's own list only: what the page sent rides on `cause`.
      const known = named.filter(isLaunchChain).join(", ");
      if (!onIncomplete)
        throw new LaunchApiError("INDEX_UNAVAILABLE", {
          chain: query.chain,
          cause: page.incomplete,
          detail: `The list leaves out launches ${known ? `on ${known}, ` : ""}whose index is behind. Try again shortly, or pass onIncomplete to take the list without them.`,
        });
      const set = named.map(String).join(",");
      if (set !== told) onIncomplete(page.incomplete);
      told = set;
    } else {
      told = null;
    }
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
