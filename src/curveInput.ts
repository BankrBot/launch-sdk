import {
  ANY_CURVE,
  CURVE_MAX_BANDS,
  CURVE_NAMES,
  curveBandsOf,
  encodeCurve,
  type CurveBand,
  type CurveId,
  type CurveName,
} from "./curve.js";
import {
  curveFromMarketCaps,
  type CurveMarketCapRange,
} from "./curveMarketCaps.js";
import { TICK_SPACING } from "./economics.js";
import { isLaunchSdkError } from "./errors.js";

// A launch's `curve` option resolved to the word the launch carries, with a detail naming the band for bands that
// are not a table. The coin's rules on a well-formed table need the start tick and the sale: curveCheck.ts.

/**
 * A launch's curve: a built-in by name or id, or the launcher's own bands, as raw bands or as market-cap ranges.
 * Own bands launch only on a launchpad whose operator listed them or opened it to launcher-defined bands.
 */
export type LaunchCurveInput =
  | CurveName
  | CurveId
  | {
      /** Outward from the start price; the last band has `widthTicks: 0`. */
      bands: readonly CurveBand[];
      /** Where the first band starts: the whole supply's value in USD, on a quote the factory prices. Required
       *  unless the launch sets `startFdv`, which places the start instead. */
      startFdvUsd?: number;
    }
  | {
      /** Contiguous from the launch's start market cap, the last ending at `"max"`: `curveFromMarketCaps`. In USD
       *  on a quote the factory prices; in the quote's base units, starting at `startFdv`, when the launch sets it.
       *  `plan()` places each band's end on the grid line at or under its market cap, from the launch's start tick. */
      marketCaps: readonly CurveMarketCapRange[];
    };

/** A launch's curve with its static refusals passed. */
export interface NormalizedCurve {
  /** `LaunchParams.curveId`. */
  word: bigint;
  /** The built-in curve's id; null on the launcher's own bands. */
  builtIn: CurveId | null;
  /** The curve's bands: the launcher's own, or the built-in's. */
  bands: CurveBand[];
  /** The start the curve itself names: `startFdvUsd`, or the first market-cap range's start. */
  startMarketCap: number | undefined;
  /** The market-cap ranges the bands came from (USD on a priced quote, the quote's base units beside `startFdv`),
   *  as converted from a start on the grid: {@link curveAtStart} places them from the launch's own. Else null. */
  marketCaps: readonly CurveMarketCapRange[] | null;
}

export const DEFAULT_CURVE: NormalizedCurve = Object.freeze({
  word: 0n,
  builtIn: 0,
  bands: curveBandsOf(0n)!,
  startMarketCap: undefined,
  marketCaps: null,
});

const builtIn = (id: CurveId): NormalizedCurve => ({
  word: BigInt(id),
  builtIn: id,
  bands: curveBandsOf(BigInt(id))!,
  startMarketCap: undefined,
  marketCaps: null,
});

/** Why `bands` are not a table a launch can carry, naming the band; null when they are. */
export function bandsFormDetail(bands: unknown): string | null {
  if (!Array.isArray(bands) || bands.length === 0)
    return "Name 1 to 8 liquidity bands, each { widthTicks, shareBps }.";
  if (bands.length > CURVE_MAX_BANDS)
    return `A launch can name at most ${CURVE_MAX_BANDS} liquidity bands: merge neighbouring bands.`;
  let sum = 0;
  for (const [i, b] of (bands as readonly unknown[]).entries()) {
    const at = `Liquidity band ${i + 1}`;
    if (typeof b !== "object" || b === null)
      return `${at} must be { widthTicks, shareBps }.`;
    const { widthTicks, shareBps } = b as Partial<CurveBand>;
    const last = i + 1 === bands.length;
    if (last && widthTicks !== 0)
      return `${at} is the last, so its widthTicks must be 0: the last band is open-ended and runs to the top of the pool's range.`;
    const spacings = (widthTicks as number) / TICK_SPACING;
    if (!last && !(Number.isInteger(spacings) && spacings >= 1))
      return `${at}: widthTicks must be a multiple of 200 ticks, at least 200. Only the last band has width 0.`;
    if (!last && spacings > 0xffff)
      return `${at} is wider than a band can be: make it narrower.`;
    if (!Number.isInteger(shareBps) || (shareBps as number) < 1)
      return `${at}: shareBps must be a whole number of basis points, at least 1.`;
    sum += shareBps as number;
  }
  return sum === 10_000
    ? null
    : `The bands' shares add up to ${sum} basis points: change them to add up to exactly 10,000 (100% of the sale).`;
}

/** The word for a launcher's own bands, or `invalid` with {@link bandsFormDetail}. */
function bandsWord(bands: unknown, invalid: (detail: string) => never): bigint {
  const detail = bandsFormDetail(bands);
  if (detail !== null) invalid(detail);
  return encodeCurve(bands as readonly CurveBand[]) as bigint;
}

/** Market-cap ranges as a launch's curve, from a start `startOffsetTicks` above its tick; the refusal is the launch's. */
function rangesCurve(
  ranges: readonly CurveMarketCapRange[],
  startOffsetTicks: number,
  invalid: (detail: string) => never,
): NormalizedCurve {
  try {
    const made = curveFromMarketCaps({ ranges, startOffsetTicks });
    return {
      word: made.curve,
      builtIn: null,
      bands: made.bands,
      startMarketCap: made.startMarketCap,
      marketCaps: ranges,
    };
  } catch (err) {
    // The helper names the range; the launch's refusal carries the chain too.
    if (isLaunchSdkError(err, "INVALID_PARAMS") && err.detail)
      invalid(err.detail);
    throw err;
  }
}

/**
 * A curve from market-cap ranges, converted again once the launch's start tick is known: `startOffsetTicks` is how
 * far the start market cap sits above that tick, so each band ends on the grid line at or under its own market cap.
 * Bands given as bands, and a built-in, come back as they are.
 */
export function curveAtStart(
  curve: NormalizedCurve,
  startOffsetTicks: number,
  invalid: (detail: string) => never,
): NormalizedCurve {
  if (curve.marketCaps === null) return curve;
  return rangesCurve(curve.marketCaps, startOffsetTicks, invalid);
}

/**
 * `LaunchInput.curve` with the refusals that need no chain state: an unknown name or id, bands that are not a
 * table, market-cap ranges that do not convert. Omitted, the default curve (`runner_v1`, id 0).
 */
export function normalizeCurve(
  input: unknown,
  invalid: (detail: string) => never,
): NormalizedCurve {
  if (input === undefined) return DEFAULT_CURVE;
  if (typeof input === "string" || typeof input === "number") {
    const id =
      typeof input === "string"
        ? CURVE_NAMES.indexOf(input as CurveName)
        : input;
    if (id !== 0 && id !== 1 && id !== 2)
      invalid(
        `curve must be one of ${CURVE_NAMES.join(", ")} (or its id, 0 to 2), { bands } or { marketCaps }.`,
      );
    return builtIn(id as CurveId);
  }
  const custom =
    typeof input === "object" && input !== null
      ? (input as {
          bands?: unknown;
          startFdvUsd?: unknown;
          marketCaps?: unknown;
        })
      : invalid("curve must be a curve name, { bands } or { marketCaps }.");
  if ((custom.bands === undefined) === (custom.marketCaps === undefined))
    invalid("A custom curve is { bands } or { marketCaps }: set exactly one.");
  if (custom.marketCaps !== undefined) {
    if (custom.startFdvUsd !== undefined)
      invalid(
        "With marketCaps the first range's start is the launch's start market cap: omit curve.startFdvUsd.",
      );
    return rangesCurve(
      custom.marketCaps as readonly CurveMarketCapRange[],
      0,
      invalid,
    );
  }
  const word = bandsWord(custom.bands, invalid);
  const usd = custom.startFdvUsd;
  if (
    usd !== undefined &&
    !(typeof usd === "number" && Number.isFinite(usd) && usd > 0)
  )
    invalid("curve.startFdvUsd must be a number of US dollars above 0.");
  return {
    word,
    builtIn: null,
    bands: (custom.bands as readonly CurveBand[]).map((b) => ({
      widthTicks: b.widthTicks,
      shareBps: b.shareBps,
    })),
    startMarketCap: usd as number | undefined,
    marketCaps: null,
  };
}

/** A curve a launchpad's operator allows or refuses: a built-in, the launcher's own bands (or their word), or
 *  `"any"` for every set of bands a launcher defines. */
export type CurveKeyInput =
  CurveName | CurveId | "any" | bigint | { bands: readonly CurveBand[] };

/** The registry's key for `curve`: a built-in's id, the bands' word, or `ANY_CURVE`. `invalid` for anything else. */
export function curveKey(
  curve: unknown,
  invalid: (detail: string) => never,
): bigint {
  if (curve === "any") return ANY_CURVE;
  if (typeof curve === "bigint") {
    if (curve !== ANY_CURVE && curveBandsOf(curve) === null)
      invalid(
        "This word is not a curve: pass a built-in curve's id (0 to 2), a set of bands' word, or \"any\".",
      );
    return curve;
  }
  if (typeof curve === "object" && curve !== null && "marketCaps" in curve)
    invalid(
      "A launchpad lists a curve by its bands: convert market-cap ranges with curveFromMarketCaps first.",
    );
  return normalizeCurve(curve, invalid).word;
}
