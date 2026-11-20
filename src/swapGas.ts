import type { Address, Hex } from "viem";
import { readContract } from "viem/actions";
import { bankrHookLensAbi } from "./abis/generated.js";
import {
  EXT_AFTER_GAS,
  EXT_AFTER_GAS_MAX,
  EXT_QUOTE_GAS,
  EXT_QUOTE_GAS_MAX,
  SWAP_GAS_HEADROOM,
} from "./economics.js";
import { LaunchRefusedError } from "./errors.js";
import {
  HOOKDATA_MAX_KEEP_GAS,
  HOOKDATA_MAX_ROUTE_CURRENCIES,
  type HoldersWakeRequest,
} from "./hookData.js";
import { HOOK_LENS_FRAGMENT } from "./lens.js";
import type { ReadClient } from "./providers/types.js";

// Gas for a router or wallet that builds its own swaps through Bankr pools, vendored from core's bankr-v4 gas.ts and
// holdersWake.ts (src/__internal__ holds each equal). A pool's extension is asked from its first swap, so every swap
// of an extension pool carries the lens figure.

/** The terms of `BankrHookLens.extSwapGasHeadroom` beside a binding's two budgets (the contracts' LaunchConstants): the
 *  side-effect tail, the route, settle and room reserves, and the guard frame with each pinned route currency. */
export const SIDE_EFFECT_GAS_TAIL = 20_000n;
export const EXT_ROUTE_RESERVE = 80_000n;
export const EXT_SETTLE_GAS = 75_000n;
export const EXT_ROOM_RESERVE = 6_000n;
export const EXT_FRAME_GAS = 40_000n;
export const EXT_PIN_GAS = 1_000n;
/** What the extension path spends before its last gas check and no budget counts: the hook data's parse and the
 *  frame's calldata, then each pinned currency's copies (a binding with a post-swap call only). */
export const EXT_PATH_GAS = 10_000n;
export const EXT_PATH_PIN_GAS = 1_200n;
/** What a route keeps for a later hop beside that pool's own headroom: a plain swap through a Bankr pool, or a swap
 *  through any other venue's pool (an estimate, not measured). */
export const ROUTE_HOP_GAS = 250_000n;
export const ROUTE_OTHER_HOP_GAS = 300_000n;
/** What a sender adds over a swap's estimate so the route's first asking pool, keeping nothing, runs its holders'
 *  wake: the ledger's gate (4,971,748) through six call frames, rounded up. */
export const HOLDERS_WAKE_SWAP_GAS = 5_470_000n;

/** An extension binding's gas budgets as the hook holds them (its `ExtensionGasBudgets` event, or what
 *  `extensionGasBudgets` returns for a launch): `afterGas` is 0 exactly when the binding is quote-only. */
export interface ExtensionGas {
  quoteGas: number;
  afterGas: number;
}

/** One Bankr pool on a route: its lens figure, `extSwapGasHeadroom(poolId, pins)`, 0n without an extension. */
export interface RoutePool {
  extHeadroom: bigint;
}

/** A route's hops in order: a Bankr pool, or null for any other venue's pool. */
export type RouteHop = RoutePool | null;

const invalid = (detail: string): never => {
  throw new LaunchRefusedError("INVALID_PARAMS", { detail });
};

/** Six call frames each hold back 1/64 (EIP-150): the ratio the hook's lens scales its own sum by. */
const SIX_FRAMES = { num: 64n ** 6n, den: 63n ** 6n };

const within = (v: number, lo: number, hi: number): boolean =>
  Number.isInteger(v) && v >= lo && v <= hi;

/**
 * `BankrHookLens.extSwapGasHeadroom` from a binding's budgets, to the unit: 499,879 at the floors, 1,687,316 at both
 * ceilings. A pinned route currency adds about 2,435 to a binding with a post-swap call, nothing to a quote-only
 * one. A binding never changes, so neither does its figure; `readExtSwapGasHeadroom` reads it from the chain.
 */
export function extSwapGasHeadroom(b: ExtensionGas, pins = 0): bigint {
  if (!within(pins, 0, HOOKDATA_MAX_ROUTE_CURRENCIES))
    invalid("pins is the number of pinned route currencies: 0 to 16.");
  const bound =
    within(b.quoteGas, EXT_QUOTE_GAS, EXT_QUOTE_GAS_MAX) &&
    (b.afterGas === 0 || within(b.afterGas, EXT_AFTER_GAS, EXT_AFTER_GAS_MAX));
  if (!bound)
    invalid(
      "These are not a binding's gas budgets: quoteGas is 50,000 to 250,000, and afterGas 150,000 to 1,000,000, or 0 for a quote-only extension.",
    );
  let h =
    (BigInt(b.quoteGas) * 64n) / 63n +
    2n * SIDE_EFFECT_GAS_TAIL +
    EXT_ROUTE_RESERVE +
    EXT_SETTLE_GAS +
    EXT_ROOM_RESERVE +
    EXT_PATH_GAS;
  if (b.afterGas !== 0) {
    const a = BigInt(b.afterGas);
    const frame =
      a +
      (a - BigInt(EXT_AFTER_GAS)) / 63n +
      EXT_FRAME_GAS +
      BigInt(pins) * EXT_PIN_GAS;
    h += (frame * 64n) / 63n + BigInt(pins) * EXT_PATH_PIN_GAS;
  }
  return (h * SIX_FRAMES.num) / SIX_FRAMES.den + 1n;
}

/** The lens's largest answer (1,726,284): both budgets at their ceilings and 16 pinned route currencies. */
export const MAX_EXT_SWAP_GAS_HEADROOM = extSwapGasHeadroom(
  { quoteGas: EXT_QUOTE_GAS_MAX, afterGas: EXT_AFTER_GAS_MAX },
  HOOKDATA_MAX_ROUTE_CURRENCIES,
);
/** The most one Bankr pool adds to a swap's gas limit (2,686,284): 960,000 plus the lens's largest answer. */
export const MAX_POOL_GAS_HEADROOM =
  SWAP_GAS_HEADROOM + MAX_EXT_SWAP_GAS_HEADROOM;

/** What one Bankr pool adds to a swap's simulated gas limit: 960,000 plus its lens figure. Gas used is unchanged. */
export function swapGasHeadroom(pool: RoutePool): bigint {
  const ext = pool.extHeadroom;
  if (typeof ext !== "bigint" || ext < 0n || ext > MAX_EXT_SWAP_GAS_HEADROOM)
    invalid(
      "extHeadroom is the pool's lens figure: a bigint from 0 to 1,726,284.",
    );
  return SWAP_GAS_HEADROOM + ext;
}

/**
 * The wake request hop `index` of a route carries in its hookData (`encodeHookData`'s `holdersWake`); null for a hop
 * that is not a Bankr pool. Every Bankr pool asks, because the hook reads the request per pool, and keeps what the
 * hops after it need: 250,000 and its own headroom for a Bankr pool, 300,000 for any other. The last hop keeps 0.
 */
export function holdersWakeRequest(
  route: readonly RouteHop[],
  index: number,
): HoldersWakeRequest | null {
  if (!Number.isInteger(index) || index < 0 || index >= route.length)
    invalid("The route has no hop at this index.");
  if (!route[index]) return null;
  const keep = route
    .slice(index + 1)
    .reduce(
      (sum, hop) =>
        sum +
        (hop ? ROUTE_HOP_GAS + swapGasHeadroom(hop) : ROUTE_OTHER_HOP_GAS),
      0n,
    );
  // Three bytes hold under 16.8M, Base's own transaction ceiling: a route needing more after one hop cannot land.
  if (keep > BigInt(HOOKDATA_MAX_KEEP_GAS))
    invalid("The route after this pool needs more gas than a request holds.");
  return { keepGas: Number(keep) };
}

/**
 * What a sender adds over a swap's estimate so the route's FIRST asking pool, keeping `keepGas`, runs its holders'
 * wake. A later pool's wake also needs what each Bankr pool before it takes under the larger limit: the buyback fill
 * a bare estimate skips (about 480,000 at its 460,000 stipend). Nothing here adds that; short, the wake is skipped.
 */
export function holdersWakeSwapGas(keepGas: number): bigint {
  if (!within(keepGas, 0, HOOKDATA_MAX_KEEP_GAS))
    invalid("The kept gas must be a whole number from 0 to 16,777,215.");
  const kept =
    (BigInt(keepGas) * SIX_FRAMES.num + SIX_FRAMES.den - 1n) / SIX_FRAMES.den;
  return HOLDERS_WAKE_SWAP_GAS + kept;
}

/**
 * `BankrHookLens.extSwapGasHeadroom(poolId, pins)`: what the pool's extension adds to a swap's simulated gas limit,
 * 0n without one. `pins` is the number of route currencies the swap's hookData pins for this pool (default 0). A
 * binding is set once at launch, so a pool's answer never changes; `launchInfo` gives a token's `hook` and `poolId`.
 */
export async function readExtSwapGasHeadroom(
  client: ReadClient,
  i: { hook: Address; poolId: Hex; pins?: number },
): Promise<bigint> {
  const pins = i.pins ?? 0;
  if (!within(pins, 0, HOOKDATA_MAX_ROUTE_CURRENCIES))
    invalid("pins is the number of pinned route currencies: 0 to 16.");
  const lens = await readContract(client, {
    address: i.hook,
    abi: HOOK_LENS_FRAGMENT,
    functionName: "hookLens",
  });
  return readContract(client, {
    address: lens,
    abi: bankrHookLensAbi,
    functionName: "extSwapGasHeadroom",
    args: [i.poolId, BigInt(pins)],
  });
}
