import type { ContractFunctionArgs } from "viem";
import type { bankrLaunchFactoryAbi } from "./abis/generated.js";
import type { LaunchChain } from "./chains/index.js";
import { LaunchRefusedError, type CodeOfKind } from "./errors.js";

// A launch's own economics and the few figures the SDK itself works with, vendored from core's bankr-v4
// constants.ts / launchParams.ts / economics.ts (src/__internal__ holds each equal). A launchpad's ranges are never
// typed here: they are read from the settings contract. Pure: no chain reads.

/** `IBankrLaunchFactory.LaunchParams` as viem encodes it, straight from the vendored ABI. */
export type LaunchParams = ContractFunctionArgs<
  typeof bankrLaunchFactoryAbi,
  "payable",
  "launch"
>[0];

/** `LaunchParams.econ`: both fee schedules, the referrer's slice and the creator side's shares, bound for good. */
export type LaunchEconomics = LaunchParams["econ"];

/** One direction's fee: `startPips` falling linearly to `steadyPips` over `decaySecs` from the pool's first block. */
export type FeeSchedule = LaunchEconomics["buy"];

/** One fee recipient: `shareBps` is its part of the creator's own take (10,000 = all of it). */
export type FeeRecipient = LaunchParams["feeRecipients"][number];

/** 1,000,000 pips = 100 %. */
export const PIPS = 1_000_000;
/** The supply a launchpad's template defaults to, and the one `startTickForQuoteFdv` assumes when none is given. */
export const DEFAULT_TOTAL_SUPPLY = 100_000_000_000n * 10n ** 18n;
export const TICK_SPACING = 200;
/** The last tick on the 200 grid inside v4's usable range. */
export const MAX_USABLE_TICK = 887_200;
/** PoolKey.fee of every Bankr pool: the hook takes the whole fee. */
export const DYNAMIC_FEE = 0x800000;
/** Gas a swap adds to its simulated limit for each Bankr pool on its route (a compound can come due); a dev buy is
 *  such a swap. A pool with an extension adds its lens figure on top (`readExtSwapGasHeadroom`). */
export const SWAP_GAS_HEADROOM = 960_000n;
/** A custom extension's two gas budgets, bound for the pool's life: the floors (what 0 names in a launch, and every
 *  preset's) and the ceilings. Outside them the hook reverts `ExtensionGasBudget`. */
export const EXT_QUOTE_GAS = 50_000;
export const EXT_QUOTE_GAS_MAX = 250_000;
export const EXT_AFTER_GAS = 150_000;
export const EXT_AFTER_GAS_MAX = 1_000_000;
/** The start FDV per curve (0 runner_v1, 1 degen, 2 thin topside), as core's prepare places it. */
export const START_FDV_USD: Readonly<Record<0 | 1 | 2, number>> = Object.freeze(
  {
    0: 10_000,
    1: 2_500,
    2: 10_000,
  },
);

const BPS = 10_000;
const isBps = (n: number) => Number.isInteger(n) && n >= 0 && n <= BPS;

function refuse(
  code: CodeOfKind<"refused">,
  detail: string,
  chain?: LaunchChain,
): never {
  throw new LaunchRefusedError(code, { chain, detail });
}

/**
 * The public `holderShareBps` (bps of the creator's own take, i.e. what the creator would keep after auto-LP and
 * buyback; 10,000 = all of it to holders) as the contract's `econ.holdersBps` (bps of the whole creator side):
 * `floor(holderShareBps × (10,000 − autoLpBps − buybackBps) / 10,000)`. 100 % maps exactly to the creator's own take.
 * Every Bankr surface (SDK, API, agent, web, docs) takes the holder share in this meaning, through core's one
 * converter; launches carry `holdersBps`.
 */
export function holderShareToHoldersBps(
  holderShareBps: number,
  autoLpBps: number,
  buybackBps: number,
): number {
  const own = BPS - autoLpBps - buybackBps;
  if (
    !isBps(holderShareBps) ||
    !isBps(autoLpBps) ||
    !isBps(buybackBps) ||
    own < 0
  ) {
    throw new RangeError(
      "holderShareBps, autoLpBps and buybackBps must be bps that leave a creator share",
    );
  }
  return Math.floor((holderShareBps * own) / BPS);
}

/** The inverse of {@link holderShareToHoldersBps}: the least `holderShareBps` giving `holdersBps` (rounded up, so
 *  passing it back reproduces `holdersBps` exactly); 0 when the creator keeps nothing. */
export function holdersBpsToHolderShare(
  holdersBps: number,
  autoLpBps: number,
  buybackBps: number,
): number {
  const own = BPS - autoLpBps - buybackBps;
  if (own <= 0) return 0;
  return Math.min(BPS, Math.ceil((holdersBps * BPS) / own));
}

const grouped = (n: number) => n.toLocaleString("en-US");

function budgetIn(
  v: number,
  [floor, max]: readonly [number, number],
  what: string,
  chain?: LaunchChain,
): number {
  if (v === 0) return floor;
  if (!Number.isInteger(v) || v < floor || v > max)
    refuse(
      "INVALID_PARAMS",
      `${what} must be between ${grouped(floor)} and ${grouped(max)}, or 0 for ${grouped(floor)}.`,
      chain,
    );
  return v;
}

/**
 * The gas budgets the hook binds for a launch's custom extension (its `ExtensionGasBudget` bounds): omitted or 0
 * names the floor, and a quote-only extension has no post-swap budget. Held equal to core's `bankrV4ExtensionGas`.
 */
export function extensionGasBudgets(
  e: { quoteOnly: boolean; quoteGas?: number; afterGas?: number },
  chain?: LaunchChain,
): { quoteGas: number; afterGas: number } {
  const quoteGas = budgetIn(
    e.quoteGas ?? 0,
    [EXT_QUOTE_GAS, EXT_QUOTE_GAS_MAX],
    "The extension's quote gas budget",
    chain,
  );
  if (e.quoteOnly) {
    if ((e.afterGas ?? 0) !== 0)
      refuse(
        "INVALID_PARAMS",
        "A quote-only extension makes no post-swap call, so it cannot name a post-swap gas budget.",
        chain,
      );
    return { quoteGas, afterGas: 0 };
  }
  const afterGas = budgetIn(
    e.afterGas ?? 0,
    [EXT_AFTER_GAS, EXT_AFTER_GAS_MAX],
    "The extension's post-swap gas budget",
    chain,
  );
  return { quoteGas, afterGas };
}

/**
 * A launch's extension terms held to the budget rules before anything is sent. A preset names no budget and custom
 * code writes a floor as 0 (the factory's `AmbiguousExtension`); stray fields of a launch naming none are ignored.
 */
export function checkExtensionBudgets(
  e: LaunchParams["extension"],
  chain?: LaunchChain,
): void {
  const custom = e.id === 0 && BigInt(e.ext) !== 0n;
  if (e.id !== 0 && (e.quoteGas !== 0 || e.afterGas !== 0))
    refuse(
      "INVALID_PARAMS",
      "A preset extension runs on the floor gas budgets: leave quoteGas and afterGas at 0.",
      chain,
    );
  if (!custom) return;
  extensionGasBudgets(e, chain);
  if (e.quoteGas === EXT_QUOTE_GAS || e.afterGas === EXT_AFTER_GAS)
    refuse(
      "INVALID_PARAMS",
      "An extension's gas budget at its floor is written as 0, not spelled out.",
      chain,
    );
}

/**
 * The grid tick at `targetFdvUsd` from the chain's live bounds: `highest` prices `maxStartFdvUsd` at the quote's
 * current price and FDV scales as 1.0001^tick, so the target is a log step below it (`lowest` can be raised to the
 * pool's own floor, so it is no anchor). Clamped inside the bounds; null when no grid tick fits.
 */
export function startTickForFdv(i: {
  lowest: number;
  highest: number;
  maxStartFdvUsd: number;
  targetFdvUsd: number;
}): number | null {
  const s = TICK_SPACING;
  const exact =
    i.highest - Math.log(i.maxStartFdvUsd / i.targetFdvUsd) / Math.log(1.0001);
  const low = Math.ceil(i.lowest / s) * s;
  const high = Math.floor(i.highest / s) * s;
  if (low > high || !(i.targetFdvUsd > 0) || !(i.maxStartFdvUsd > 0))
    return null;
  return Math.min(Math.max(Math.floor(exact / s) * s, low), high);
}

/** `startFdv`'s own tick, before any grid: `ln(startFdv / totalSupply) / ln(1.0001)`, both in base units. */
export function quoteFdvTick(
  startFdv: bigint,
  totalSupply: bigint = DEFAULT_TOTAL_SUPPLY,
): number {
  const ln = (v: bigint) => {
    const digits = v.toString();
    const head = Math.min(digits.length, 17);
    return (
      Math.log(Number(digits.slice(0, head))) +
      (digits.length - head) * Math.LN10
    );
  };
  return (ln(startFdv) - ln(totalSupply)) / Math.log(1.0001);
}

/**
 * The start tick for `startFdv` (the whole supply's value in the quote's base units): LaunchEconomics._fdvTick at a
 * price of 1 per quote, `floor(ln(startFdv / totalSupply) / ln(1.0001))`, floored to the 200 spacing. What a launch on
 * a quote Bankr does not list passes as `expectedStartTick`.
 */
export function startTickForQuoteFdv(
  startFdv: bigint,
  totalSupply: bigint = DEFAULT_TOTAL_SUPPLY,
): number {
  const exact = quoteFdvTick(startFdv, totalSupply);
  return Math.floor(exact / TICK_SPACING) * TICK_SPACING;
}
