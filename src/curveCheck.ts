import {
  bandLiquidity,
  builtInCurveId,
  decodeCurve,
  placeCurve,
  type PlacedCurveBand,
} from "./curve.js";
import { MAX_USABLE_TICK } from "./economics.js";
import { sqrtPriceX96AtTick } from "./tickMath.js";

// The rules a launch's own bands are held to, in the order a launch meets them, vendored from core's bankr-v4
// curveCheck.ts (the contracts' CurveTable and LaunchPool): exact integer math, so the verdict, the error and its
// row are the chain's own. src/__internal__ holds it equal to core, which is held to forge.

/** Half of v4's per-tick liquidity cap at a 200 spacing; the other half is left to the pool's compounds. */
export const CURVE_MAX_TICK_LIQUIDITY = (2n ** 128n - 1n) / 8_874n / 2n;

/** The contracts' errors for a launch's own bands, as their ABI names them. */
export type CurveRevertName =
  | "InvalidCurve"
  | "CurveTooThin"
  | "CurveLiquidity"
  | "CurveTooDense"
  | "CurveStep"
  | "CurvePlacement"
  | "CurveDust";

/** The revert a launch of the bands would carry. */
export interface CurveRevert {
  name: CurveRevertName;
  /** The band the error names, counted from 0 as the contract counts (the four per-band errors); else null. */
  row: number | null;
  /** `CurveDust`'s argument, the unplaced base units; else null. */
  unplaced: bigint | null;
}

export type CurveVerdict =
  | { ok: true; bands: PlacedCurveBand[]; unplaced: bigint }
  | { ok: false; revert: CurveRevert };

export interface CheckCurveInput {
  /** `LaunchParams.curveId`. */
  curve: bigint;
  /** `LaunchParams.expectedStartTick`: quote per token, on the 200 grid. */
  startTick: number;
  /** Whether the token sorts below its quote; known only once the salt is mined, so check both orders before. */
  tokenIsCurrency0: boolean;
  /** What the launch sells into its bands: the supply less everything vested and every builder allocation. */
  sale: bigint;
  /** Whether the pool will ever buy its own token (a buyback share, auto-liquidity, or an extension the hook calls
   *  after a swap), which switches the step rule on. */
  ownBuys: boolean;
  /** The coin's own rules: `plan.resolved.terms.curve`, or a launchpad's from `settings.pad(id)`. */
  rules: CurveRules;
}

/** The numbers a launch's own bands are held to: a launchpad sets them, and `resolve` freezes them per coin. */
export interface CurveRules {
  minDepthDiv: number;
  maxDensity: number;
  placeTicks: number;
  placeBps: number;
  nearTicks: number;
  nearStep: number;
  dustPpm: number;
}

const Q96 = 1n << 96n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

const refused = (
  name: CurveRevertName,
  row: number | null = null,
  unplaced: bigint | null = null,
): CurveVerdict => ({ ok: false, revert: { name, row, unplaced } });

/** The form alone, which the factory checks before it deploys anything: well-formed bands whose last finite edge
 *  sits inside the pool's range from `startTick`. */
export function checkCurveFormat(curve: bigint, startTick: number): boolean {
  const rows = decodeCurve(curve);
  if (!rows) return false;
  return rows.reduce((t, r) => t + r.widthTicks, startTick) < MAX_USABLE_TICK;
}

/** What the mints leave of the sale: v4 takes each band's amount rounded up. */
function unplacedOf(
  bands: readonly PlacedCurveBand[],
  tokenIsCurrency0: boolean,
  sale: bigint,
): bigint {
  let used = 0n;
  for (const b of bands) {
    const [lo, hi] = [sqrtPriceX96AtTick(b.lower), sqrtPriceX96AtTick(b.upper)];
    used += tokenIsCurrency0
      ? ceilDiv(ceilDiv((b.liquidity << 96n) * (hi - lo), hi), lo)
      : ceilDiv(b.liquidity * (hi - lo), Q96);
  }
  return sale - used;
}

/** The TOKEN a band has sold once the price reaches tick `mark`. */
function soldBy(
  tokenIsCurrency0: boolean,
  near: number,
  next: number,
  mark: number,
  amount: bigint,
): bigint {
  const dir = tokenIsCurrency0 ? 1 : -1;
  if (dir * near >= dir * mark) return 0n;
  if (dir * next <= dir * mark) return amount;
  const [a, c, m] = [near, next, mark].map(sqrtPriceX96AtTick) as [
    bigint,
    bigint,
    bigint,
  ];
  return tokenIsCurrency0
    ? (amount * (((m - a) * c) / m)) / (c - a)
    : (amount * (a - m)) / (a - c);
}

/**
 * A launch's verdict on its curve for one token order: the bands and the base units rounding leaves unplaced, or
 * the revert the chain would raise, by name and band. A built-in curve meets no rule. `startTick` must be one the
 * factory's window admits; the plan's simulation stays the final word.
 */
export function checkCurve(i: CheckCurveInput): CurveVerdict {
  const t0 = i.tokenIsCurrency0;
  if (builtInCurveId(i.curve) !== null) {
    const bands = placeCurve(i);
    return { ok: true, bands, unplaced: unplacedOf(bands, t0, i.sale) };
  }
  if (!checkCurveFormat(i.curve, i.startTick)) return refused("InvalidCurve");
  const { rules } = i;
  const dir = t0 ? 1 : -1;
  const [start, far] = [dir * i.startTick, dir * MAX_USABLE_TICK];
  const reach = start + dir * rules.placeTicks;
  const mark = dir * reach > dir * far ? far : reach;
  const flat = bandLiquidity(t0, start, far, i.sale);
  const bands = placeCurve(i);
  let under = 0n;
  let thin: bigint | null = null;
  let placed = 0n;
  for (const [row, b] of bands.entries()) {
    const [near, next] = t0 ? [b.lower, b.upper] : [b.upper, b.lower];
    const liq = b.liquidity;
    if (liq === 0n || liq * BigInt(rules.minDepthDiv) < flat) {
      return refused("CurveTooThin", row);
    }
    if (under + liq > CURVE_MAX_TICK_LIQUIDITY) {
      return refused("CurveLiquidity", row);
    }
    if (liq > BigInt(rules.maxDensity) * bandLiquidity(t0, near, far, i.sale)) {
      return refused("CurveTooDense", row);
    }
    if (i.ownBuys && thin !== null) {
      const off = dir * (near - start);
      const most =
        off <= rules.nearTicks ? thin * BigInt(rules.nearStep) : under;
      if (liq > most) return refused("CurveStep", row);
    }
    if (thin === null || liq < thin) thin = liq;
    placed += soldBy(t0, near, next, mark, b.amount);
    under = liq;
  }
  if (placed * 10_000n < i.sale * BigInt(rules.placeBps)) {
    return refused("CurvePlacement");
  }
  const unplaced = unplacedOf(bands, t0, i.sale);
  if (unplaced * 1_000_000n > i.sale * BigInt(rules.dustPpm)) {
    return refused("CurveDust", null, unplaced);
  }
  return { ok: true, bands, unplaced };
}

/**
 * The verdict a launch needs before its salt is mined, when the token's side of the pool is not known yet: the
 * first refusal in either token order, else the currency0 order's placement.
 */
export function checkCurveBothOrders(
  i: Omit<CheckCurveInput, "tokenIsCurrency0">,
): CurveVerdict {
  const first = checkCurve({ ...i, tokenIsCurrency0: true });
  if (!first.ok) return first;
  const second = checkCurve({ ...i, tokenIsCurrency0: false });
  return second.ok ? first : second;
}
