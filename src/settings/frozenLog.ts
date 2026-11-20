import { getAbiItem, type Address, type Hex } from "viem";
import { getBlock, getLogs, readContract } from "viem/actions";
import { bankrLaunchTokenAbi } from "../abis/generated.js";
import { bankrLaunchFactoryAbi } from "../abis/settings.js";
import type { ReadClient } from "../providers/types.js";

// A coin's frozen record is one log of its launch transaction, and no contract stores that block. The token does
// hold its trading start: the launch's own second, or a later one the launch scheduled. So the log is in a window
// at the first block of that second, or for a scheduled coin a walk back from it no longer than the coin's own
// delay. Nothing here grows with the chain's age, where a scan from the contracts' deploy block did.

const SCAN_CONCURRENCY = 4;
/** A search for one coin's log reads at most this many windows of the chain's `maxLogRange`. */
export const MAX_SCAN_WINDOWS = 2_000;

/** `CoinTermsFrozen`'s arguments, as the factory logged them. */
export interface FrozenLogArgs {
  token: Address;
  poolId: Hex;
  termsHash: Hex;
  resolvedHash: Hex;
  terms: Hex;
}

/** One coin's log, or why there is none: `walked` says the walk reached the deploy block rather than its cap. */
export type FrozenLogSearch =
  { found: FrozenLogArgs } | { found: null; walked: boolean };

export type LogWindow = readonly [fromBlock: bigint, toBlock: bigint];

type Head = { number: bigint; timestamp: bigint };

/** The windows of `span` blocks that cover `[from, to]`, in order; none when `to` is before `from`. */
export function logWindows(
  from: bigint,
  to: bigint,
  span: bigint,
): LogWindow[] {
  const windows: LogWindow[] = [];
  for (let s = from; s <= to; s += span)
    windows.push([s, s + span - 1n < to ? s + span - 1n : to]);
  return windows;
}

/**
 * The coin's `CoinTermsFrozen` log in `windows`, read in their order: the first `alone` one request at a time, the
 * rest four a round. Null when none of them holds it. The one reader of this log.
 */
export async function scanFrozenLog(
  client: ReadClient,
  o: { factory: Address; token: Address },
  windows: readonly LogWindow[],
  alone = 0,
): Promise<FrozenLogArgs | null> {
  const read = async ([fromBlock, toBlock]: LogWindow) => {
    const logs = await getLogs(client, {
      address: o.factory,
      event: getAbiItem({
        abi: bankrLaunchFactoryAbi,
        name: "CoinTermsFrozen",
      }),
      args: { token: o.token },
      fromBlock,
      toBlock,
      strict: true,
    });
    return logs.find((log) => !log.removed)?.args ?? null;
  };
  for (let i = 0; i < windows.length;) {
    const n = i < alone ? 1 : SCAN_CONCURRENCY;
    const hits = await Promise.all(windows.slice(i, i + n).map(read));
    const found = hits.find((hit) => hit !== null);
    if (found) return found;
    i += n;
  }
  return null;
}

/**
 * A block of `[from, head]` to start a log window at for `target` (unix seconds; `head` is at or after it): every
 * block before it is before `target`, and the first block at `target` is within `slack` blocks of it. The window
 * needs no more precision, so the search stops there.
 */
async function windowStart(
  client: ReadClient,
  target: bigint,
  from: bigint,
  head: Head,
  slack: bigint,
): Promise<bigint> {
  const time = async (n: bigint) =>
    (await getBlock(client, { blockNumber: n })).timestamp;
  let [lo, hi] = [from, head.number];
  if (hi - lo <= slack) return lo;
  let [tLo, tHi] = [await time(lo), head.timestamp];
  if (tLo >= target) return lo;
  // time(lo) < target <= time(hi) from here on. A guess by the blocks' average pace and a halving, in turn: the
  // pace lands a steady chain in a few reads, the halving bounds a chain of any pace.
  for (let halve = false; hi - lo > slack; halve = !halve) {
    const guess = halve
      ? (lo + hi) / 2n
      : lo + ((hi - lo) * (target - tLo)) / (tHi - tLo);
    const mid = guess <= lo ? lo + 1n : guess >= hi ? hi - 1n : guess;
    const t = await time(mid);
    if (t >= target) [hi, tHi] = [mid, t];
    else [lo, tLo] = [mid, t];
  }
  return lo + 1n;
}

/**
 * A launched coin's `CoinTermsFrozen` log, found from the token's trading start: one log request for a coin that
 * traded from launch, and a walk back in the chain's log windows for one whose start was scheduled. `deployBlock`
 * is where the walk stops (default the chain's first block).
 */
export async function findFrozenLog(
  client: ReadClient,
  o: {
    factory: Address;
    token: Address;
    maxLogRange: number;
    deployBlock?: number;
  },
): Promise<FrozenLogSearch> {
  const [start, head] = await Promise.all([
    readContract(client, {
      address: o.token,
      abi: bankrLaunchTokenAbi,
      functionName: "tradingStart",
    }),
    getBlock(client, { blockTag: "latest" }),
  ]);
  const floor = BigInt(o.deployBlock ?? 0);
  const span = BigInt(o.maxLogRange);
  const last =
    head.number - span + 1n > floor ? head.number - span + 1n : floor;
  // A start still ahead of the chain's clock: the coin launched at or before the head, so the chain's last window.
  // Else a window with the start's first block in its first half: a chain with several blocks a second has the
  // launch a few blocks on.
  const at =
    start > head.timestamp
      ? last
      : await windowStart(client, start, floor, head, span / 2n);
  const end = at + span - 1n < head.number ? at + span - 1n : head.number;
  // Then back from it, newest first: a scheduled coin launched before its start, most of them within a window.
  const back: LogWindow[] = [];
  for (
    let to = at - 1n;
    to >= floor && back.length < MAX_SCAN_WINDOWS - 1;
    to -= span
  )
    back.push([to - span + 1n > floor ? to - span + 1n : floor, to]);
  const found = await scanFrozenLog(client, o, [[at, end], ...back], 2);
  if (found) return { found };
  return { found: null, walked: (back.at(-1)?.[0] ?? at) <= floor };
}
