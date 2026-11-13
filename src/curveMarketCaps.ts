import { CURVE_MAX_BANDS, encodeCurve, type CurveBand } from "./curve.js";
import { TICK_SPACING } from "./economics.js";
import { LaunchRefusedError } from "./errors.js";

// A curve as market-cap ranges, the shape Doppler's multicurve takes, and back again for a chart. Market caps are
// in any one unit (USD, or the quote's): only their ratio to the launch's start market cap places a band.

/** One range of a curve by market cap, as Doppler's multicurve takes it. */
export interface CurveMarketCapRange {
  /** The whole supply's value where the range starts and ends. The last range ends at `"max"`: it is open-ended. */
  marketCap: { start: number; end: number | "max" };
  /** The range's share of the sale as a WAD fraction (10^18 = all of it), in whole basis points (10^14). */
  shares: bigint;
  /** Doppler's field. A range is one band here, with level liquidity across it, so 1 or omitted. */
  numPositions?: number;
}

/** {@link curveFromMarketCaps}'s result. */
export interface CurveFromMarketCaps {
  /** The word a launch carries (`LaunchParams.curveId`). */
  curve: bigint;
  /** The same curve as bands, for `LaunchInput.curve`. */
  bands: CurveBand[];
  /** The market cap the first band starts at: the launch's start FDV, in the ranges' unit. */
  startMarketCap: number;
}

/** One band of a curve as a market-cap range: what {@link curveMarketCaps} returns, and a {@link CurveMarketCapRange}. */
export interface CurveMarketCapBand extends CurveMarketCapRange {
  shareBps: number;
  widthTicks: number;
}

const WAD = 10n ** 18n;
const WAD_PER_BPS = 10n ** 14n;
const LN_TICK = Math.log(1.0001);

function invalid(detail: string): never {
  throw new LaunchRefusedError("INVALID_PARAMS", { detail });
}

/**
 * How far above the launch's start tick a market cap sits, on the 200-tick grid, for a start market cap `offset`
 * ticks above that tick: `200 × floor((offset + log_1.0001(ratio)) / 200)`, the built-in curves' rule at offset 0.
 * A billionth of a spacing under a grid line counts as on it, so a boundary computed from ticks converts back.
 */
const gridTicksAbove = (ratio: number, offset: number): number =>
  Math.floor((offset + Math.log(ratio) / LN_TICK) / TICK_SPACING + 1e-9) *
  TICK_SPACING;

const isCap = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Market-cap ranges as a launch's bands: contiguous from the start market cap, the last ending at `"max"`, shares
 * adding up to 10^18 in whole basis points (one that is not is refused, never rounded). Rounding: a launch starts on
 * the 200-tick grid and each range's end is floored to it, so a band ends at or under the market cap asked for.
 */
export function curveFromMarketCaps(i: {
  ranges: readonly CurveMarketCapRange[];
  /** The launch's start market cap, in the ranges' unit. Default: where the first range starts. */
  startMarketCap?: number;
  /** How many ticks the start market cap sits above the launch's start tick: 0 up to 200, and what `plan()` passes
   *  for `curve: { marketCaps }`. Given, a band ends less than one spacing (about 2%) under its market cap. Left out,
   *  the start counts as on the grid: on a launch that starts below it a band ends less than two (about 4%) under. */
  startOffsetTicks?: number;
}): CurveFromMarketCaps {
  const ranges: unknown = i?.ranges;
  if (!Array.isArray(ranges) || ranges.length === 0)
    invalid("Name at least one market-cap range.");
  const list = ranges as readonly CurveMarketCapRange[];
  if (list.length > CURVE_MAX_BANDS)
    invalid(`A launch can name at most ${CURVE_MAX_BANDS} market-cap ranges.`);
  const start = i.startMarketCap ?? list[0]?.marketCap?.start;
  if (!isCap(start)) invalid("The start market cap must be a number above 0.");
  const from = i.startOffsetTicks ?? 0;
  if (!(typeof from === "number" && from >= 0 && from < TICK_SPACING))
    invalid(
      "startOffsetTicks is how far the start market cap sits above the launch's start tick: a number from 0 up to, not including, 200.",
    );
  const bands: CurveBand[] = [];
  let edge = start;
  let offset = 0;
  let total = 0n;
  list.forEach((r, n) => {
    const at = `Market-cap range ${n + 1}`;
    const last = n + 1 === list.length;
    const cap = r?.marketCap;
    if (typeof cap !== "object" || cap === null)
      invalid(`${at} must be { marketCap: { start, end }, shares }.`);
    if (cap.start !== edge)
      invalid(
        n === 0
          ? `${at} must start at the launch's start market cap (${edge}).`
          : `${at} must start where range ${n} ends (${edge}): ranges are contiguous.`,
      );
    if (last ? cap.end !== "max" : !isCap(cap.end) || cap.end <= cap.start)
      invalid(
        last
          ? `${at} is the last, so it must end at "max": the last band is open-ended.`
          : `${at} must end at a market cap above its start; only the last range ends at "max".`,
      );
    if (r.numPositions !== undefined && r.numPositions !== 1)
      invalid(
        `${at}: numPositions must be 1 or left out. A range is one band with level liquidity across it; split it into ranges to shape it.`,
      );
    if (
      typeof r.shares !== "bigint" ||
      r.shares <= 0n ||
      r.shares % WAD_PER_BPS !== 0n
    )
      invalid(
        `${at}: shares must be a bigint above 0 in whole basis points of the sale (10^18 is all of it, 10^14 one basis point).`,
      );
    total += r.shares;
    const shareBps = Number(r.shares / WAD_PER_BPS);
    if (last) {
      bands.push({ widthTicks: 0, shareBps });
      return;
    }
    const next = gridTicksAbove((cap.end as number) / start, from);
    const widthTicks = next - offset;
    if (widthTicks < TICK_SPACING)
      invalid(
        `${at} is narrower than one tick spacing (about 2%) once its end is rounded down to the 200-tick grid. Widen it, or merge it into the next range.`,
      );
    bands.push({ widthTicks, shareBps });
    [edge, offset] = [cap.end as number, next];
  });
  if (total !== WAD)
    invalid("The ranges' shares must add up to 100% of the sale (10^18).");
  const curve = encodeCurve(bands);
  if (curve === null) invalid("The ranges are not bands a launch can carry.");
  return { curve, bands, startMarketCap: start };
}

/**
 * A curve's bands as market-cap ranges, for a chart; the last ends at `"max"`. `startMarketCap` is the launch's
 * start FDV in the chart's unit: `1.0001 ** startTick × totalSupply` in the quote's base units. Boundaries are
 * exact to the tick, so {@link curveFromMarketCaps} turns the result back into the same bands.
 */
export function curveMarketCaps(i: {
  bands: readonly CurveBand[];
  startMarketCap: number;
}): CurveMarketCapBand[] {
  if (!isCap(i?.startMarketCap))
    invalid("The start market cap must be a number above 0.");
  if (encodeCurve(i.bands) === null) invalid("These are not a curve's bands.");
  let offset = 0;
  let start = i.startMarketCap;
  return i.bands.map((b, n) => {
    const last = n + 1 === i.bands.length;
    offset += b.widthTicks;
    const end = last ? "max" : i.startMarketCap * Math.pow(1.0001, offset);
    const range: CurveMarketCapBand = {
      marketCap: { start, end },
      shares: BigInt(b.shareBps) * WAD_PER_BPS,
      shareBps: b.shareBps,
      widthTicks: b.widthTicks,
    };
    if (end !== "max") start = end;
    return range;
  });
}
