import { getAddress, type Address } from "viem";
import type { LaunchInput } from "../providers/types.js";

// What a suite 4 launch names beyond suite 3's fields, with only the checks of shape: every range is its pad's, and
// the chain's launch check (`resolve`) judges it. featureOptions.ts builds the option groups from these.

/** The fields a suite 3 launch cannot carry: naming one there is refused, never ignored. */
export const SUITE4_ONLY_FIELDS = [
  "supply",
  "walletCap",
  "allocations",
  "autoLp",
  "buyback",
  "holderStream",
  "capExclusions",
  "feeCeilingPips",
  "pin",
  "claimOperator",
] as const satisfies readonly (keyof LaunchInput)[];

export interface NormalizedAllocation {
  recipient: Address;
  amount: bigint;
  cliff: bigint;
  duration: bigint;
}

/** A launch's suite 4 choices with their shapes checked; undefined where the pad's default applies. */
export interface Suite4Choices {
  supply: bigint | undefined;
  walletCap: { bps: number; seconds: number } | false | undefined;
  vestClock: { cliffSeconds?: number; durationSeconds?: number } | undefined;
  allocations: readonly NormalizedAllocation[];
  compoundAmounts: { floor: bigint; cap: bigint } | undefined;
  compoundCadence:
    | { intervalSeconds?: number; shareBps?: number; deviationTicks?: number }
    | undefined;
  compoundBand: { halfWidthSpacings: number; gridSpacings: number } | undefined;
  buybackCadence:
    { intervalSeconds?: number; retrySeconds?: number } | undefined;
  rewardStream: { seconds: number; restartBps: number } | undefined;
  /** The launch's own exemptions; undefined: the chain's settlers, where the launch has a cap and the pad allows them. */
  capExclusions: readonly Address[] | undefined;
  feeCeilingPips: number | undefined;
  pin: boolean;
  claimOperator: Address | undefined;
}

const U16 = 0xffff;
const U32 = 0xffff_ffff;
const U128 = (1n << 128n) - 1n;
const SPACING = 200;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const isUint = (v: unknown, max: bigint): v is bigint =>
  typeof v === "bigint" && v >= 0n && v <= max;

/**
 * The suite 4 fields of a launch input, held to their shapes alone (types, widths, one spelling per term). `bps`
 * of auto-liquidity and of the buyback come back merged with the top-level `autoLpBps` and `buybackBps`.
 */
export function normalizeSuite4Choices(
  input: LaunchInput,
  address: (v: unknown, what: string) => Address,
  invalid: (detail: string) => never,
): Suite4Choices & {
  autoLpBps: number | undefined;
  buybackBps: number | undefined;
} {
  const secs = (v: unknown, what: string): number => {
    if (!isInt(v, 0, U32)) invalid(`${what} must be whole seconds, 0 or more.`);
    return v as number;
  };
  const bps = (v: unknown, what: string): number => {
    if (!isInt(v, 0, 10_000))
      invalid(`${what} must be an integer number of bps from 0 to 10,000.`);
    return v as number;
  };
  const once = (a: unknown, b: unknown, what: string): number | undefined => {
    if (a !== undefined && b !== undefined)
      invalid(`Set ${what} once: ${what}Bps or ${what}.bps, not both.`);
    const v = a ?? b;
    return v === undefined ? undefined : bps(v, `${what}Bps`);
  };

  if (input.supply !== undefined && !isUint(input.supply, (1n << 256n) - 1n))
    invalid("supply must be a bigint in the token's base units.");

  const cap = input.walletCap;
  if (cap !== undefined && cap !== false) {
    if (
      typeof cap !== "object" ||
      cap === null ||
      !isInt(cap.bps, 0, 10_000) ||
      !isInt(cap.seconds, 0, U32)
    )
      invalid(
        "walletCap is { bps, seconds }, or false for a launch with no wallet cap.",
      );
    // The token stores no cap for a length of 0, so a size alone (or a length alone) names nothing.
    if ((cap.bps === 0) !== (cap.seconds === 0))
      invalid(
        "A wallet cap needs both a size and a length: name both, or pass walletCap: false for none.",
      );
  }

  const v = input.vesting;
  const vestClock =
    v?.cliffSeconds === undefined && v?.durationSeconds === undefined
      ? undefined
      : {
          cliffSeconds:
            v.cliffSeconds === undefined
              ? undefined
              : secs(v.cliffSeconds, "vesting.cliffSeconds"),
          durationSeconds:
            v.durationSeconds === undefined
              ? undefined
              : secs(v.durationSeconds, "vesting.durationSeconds"),
        };

  const raw: unknown = input.allocations ?? [];
  if (!Array.isArray(raw)) invalid("allocations is a list.");
  const allocations = (raw as readonly unknown[]).map((entry, i) => {
    const a = (typeof entry === "object" && entry !== null ? entry : {}) as {
      recipient?: unknown;
      amount?: unknown;
      cliffSeconds?: unknown;
      durationSeconds?: unknown;
    };
    const at = `allocations[${i}]`;
    if (!isUint(a.amount, (1n << 256n) - 1n) || a.amount === 0n)
      invalid(`${at}.amount must be above 0, in the token's base units.`);
    const cliff = secs(a.cliffSeconds ?? 0, `${at}.cliffSeconds`);
    const duration = secs(a.durationSeconds ?? 0, `${at}.durationSeconds`);
    return {
      recipient: address(a.recipient, `${at}.recipient`),
      amount: a.amount as bigint,
      cliff: BigInt(cliff),
      duration: BigInt(duration),
    };
  });

  const lp = input.autoLp;
  if ((lp?.floor === undefined) !== (lp?.cap === undefined))
    invalid(
      "Name the compound's floor and cap together: autoLp.floor and autoLp.cap.",
    );
  if (
    lp?.floor !== undefined &&
    (!isUint(lp.floor, U128) || !isUint(lp.cap, U128))
  )
    invalid(
      "autoLp.floor and autoLp.cap are bigints in the quote's base units.",
    );
  const cadence =
    lp?.intervalSeconds === undefined &&
    lp?.shareBps === undefined &&
    lp?.deviationTicks === undefined
      ? undefined
      : {
          intervalSeconds:
            lp.intervalSeconds === undefined
              ? undefined
              : secs(lp.intervalSeconds, "autoLp.intervalSeconds"),
          shareBps:
            lp.shareBps === undefined
              ? undefined
              : bps(lp.shareBps, "autoLp.shareBps"),
          deviationTicks: lp.deviationTicks,
        };
  if (
    cadence?.deviationTicks !== undefined &&
    !isInt(cadence.deviationTicks, 0, U16)
  )
    invalid(
      "autoLp.deviationTicks must be a whole number of ticks, 0 to 65,535.",
    );
  const band = lp?.band;
  if (band !== undefined) {
    for (const [ticks, what] of [
      [band.halfWidthTicks, "autoLp.band.halfWidthTicks"],
      [band.gridTicks, "autoLp.band.gridTicks"],
    ] as const) {
      if (!isInt(ticks, 0, U16 * SPACING) || ticks % SPACING !== 0)
        invalid(`${what} must be a multiple of the pool's 200-tick spacing.`);
    }
  }

  const bb = input.buyback;
  const buybackCadence =
    bb?.intervalSeconds === undefined && bb?.retrySeconds === undefined
      ? undefined
      : {
          intervalSeconds:
            bb.intervalSeconds === undefined
              ? undefined
              : secs(bb.intervalSeconds, "buyback.intervalSeconds"),
          retrySeconds:
            bb.retrySeconds === undefined
              ? undefined
              : secs(bb.retrySeconds, "buyback.retrySeconds"),
        };

  const stream = input.holderStream;
  if (
    stream !== undefined &&
    (typeof stream !== "object" ||
      stream === null ||
      !isInt(stream.seconds, 0, U32) ||
      !isInt(stream.restartBps, 0, 10_000))
  )
    invalid("holderStream is { seconds, restartBps }.");

  const exclusions: unknown = input.capExclusions;
  if (exclusions !== undefined && !Array.isArray(exclusions))
    invalid("capExclusions is a list of addresses.");
  if (
    input.feeCeilingPips !== undefined &&
    !isInt(input.feeCeilingPips, 0, 999_999)
  )
    invalid("feeCeilingPips must be whole pips, under 100%.");
  if (input.pin !== undefined && typeof input.pin !== "boolean")
    invalid("pin must be true or false.");

  return {
    supply: input.supply,
    walletCap: cap,
    vestClock,
    allocations,
    compoundAmounts:
      lp?.floor === undefined ? undefined : { floor: lp.floor, cap: lp.cap! },
    compoundCadence: cadence,
    compoundBand:
      band === undefined
        ? undefined
        : {
            halfWidthSpacings: band.halfWidthTicks / SPACING,
            gridSpacings: band.gridTicks / SPACING,
          },
    buybackCadence,
    rewardStream: stream,
    capExclusions:
      exclusions === undefined
        ? undefined
        : (exclusions as readonly unknown[]).map((a, i) =>
            getAddress(address(a, `capExclusions[${i}]`)),
          ),
    feeCeilingPips: input.feeCeilingPips,
    pin: input.pin !== false,
    claimOperator:
      input.claimOperator === undefined
        ? undefined
        : address(input.claimOperator, "claimOperator"),
    autoLpBps: once(input.autoLpBps, lp?.bps, "autoLp"),
    buybackBps: once(input.buybackBps, bb?.bps, "buyback"),
  };
}
