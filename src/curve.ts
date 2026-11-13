import type { Hex } from "viem";
import { MAX_USABLE_TICK, TICK_SPACING } from "./economics.js";
import { sqrtPriceX96AtTick } from "./tickMath.js";

// A launch's curve (`LaunchParams.curveId`, a uint256), vendored from core's bankr-v4 curve.ts: 0, 1 and 2 are the
// built-in curves; any other value is the launch's own bands, eight 32-bit rows from the word's top bits, each
// (width in 200-tick spacings << 16) | share in bps. Pure: src/__internal__ holds it equal to core.

/** The built-in curves by name, in id order. `runner_v1` (id 0) is the default when a launch names no curve. */
export const CURVE_NAMES = ["runner_v1", "degen", "thin_topside"] as const;

export type CurveName = (typeof CURVE_NAMES)[number];

export type CurveId = 0 | 1 | 2;

/**
 * One band of a curve: `widthTicks` wide (a multiple of 200) holding `shareBps` of the sale. Bands run outward from
 * the start price, each beginning where the last ended; the last has `widthTicks: 0` and runs to the pool's edge.
 */
export interface CurveBand {
  widthTicks: number;
  shareBps: number;
}

/** A launch names at most eight bands. */
export const CURVE_MAX_BANDS = 8;
/** A launchpad's key for "any bands a launcher defines" (`setCurveAllowed`). Never a curve itself. */
export const ANY_CURVE = 2n ** 256n - 1n;

const band = (widthTicks: number, shareBps: number): CurveBand =>
  Object.freeze({ widthTicks, shareBps });

/** The built-in curves' own bands: runner_v1 ($10K to $20K, to $1.2B, above), degen (from $2.5K) and thin topside. */
export const BUILT_IN_CURVES: Readonly<Record<CurveId, readonly CurveBand[]>> =
  Object.freeze({
    0: Object.freeze([band(6_800, 300), band(110_000, 9_500), band(0, 200)]),
    1: Object.freeze([band(20_600, 300), band(110_000, 9_500), band(0, 200)]),
    2: Object.freeze([
      band(6_800, 300),
      band(7_000, 3_565),
      band(3_400, 400),
      band(7_600, 3_865),
      band(13_800, 1_000),
      band(32_200, 300),
      band(46_000, 450),
      band(0, 120),
    ]),
  });

const Q96 = 1n << 96n;
const isWord = (word: unknown): word is bigint =>
  typeof word === "bigint" && word >= 0n && word >> 256n === 0n;

/** The built-in curve a word names, or null for a launcher's own bands and for anything else. */
export const builtInCurveId = (word: bigint): CurveId | null =>
  word === 0n ? 0 : word === 1n ? 1 : word === 2n ? 2 : null;

/**
 * The word a launch carries for its own bands, or null when they are not bands the factory takes: 1 to 8 of them,
 * whole shares of at least 1 bp that add up to 10,000, every width but the last 200 to 13,107,000 ticks on the 200
 * grid, and the last 0.
 */
export function encodeCurve(bands: readonly CurveBand[]): bigint | null {
  if (!Array.isArray(bands)) return null;
  if (bands.length === 0 || bands.length > CURVE_MAX_BANDS) return null;
  let word = 0n;
  let sum = 0;
  for (const [i, b] of bands.entries()) {
    if (typeof b !== "object" || b === null) return null;
    const spacings = b.widthTicks / TICK_SPACING;
    const width =
      i + 1 === bands.length
        ? spacings === 0
        : Number.isInteger(spacings) && spacings >= 1 && spacings <= 0xffff;
    if (!width || !Number.isInteger(b.shareBps) || b.shareBps < 1) return null;
    sum += b.shareBps;
    word |=
      ((BigInt(spacings) << 16n) | BigInt(b.shareBps)) << BigInt(224 - 32 * i);
  }
  return sum === 10_000 ? word : null;
}

/** A word's own bands, or null for anything else: a built-in id, {@link ANY_CURVE}, a word with a bit out of place.
 *  One set of bands has one word: a word decodes only if its bands encode back to it. */
export function decodeCurve(word: bigint): CurveBand[] | null {
  if (!isWord(word)) return null;
  const bands: CurveBand[] = [];
  for (let i = 0; i < CURVE_MAX_BANDS; i += 1) {
    const packed = (word >> BigInt(224 - 32 * i)) & 0xffff_ffffn;
    if (packed === 0n) break;
    bands.push({
      widthTicks: Number(packed >> 16n) * TICK_SPACING,
      shareBps: Number(packed & 0xffffn),
    });
  }
  return encodeCurve(bands) === word ? bands : null;
}

/** A curve word as it is stored and compared: `0x` and 64 lower-case hex digits. Throws a RangeError past 256 bits. */
export function curveWordHex(word: bigint): Hex {
  if (!isWord(word)) throw new RangeError("a curve word is a uint256");
  return `0x${word.toString(16).padStart(64, "0")}`;
}

/** The bands of any curve word, a built-in's or the launcher's own; null for a word that is no curve. */
export function curveBandsOf(word: bigint): CurveBand[] | null {
  const id = isWord(word) ? builtInCurveId(word) : null;
  return id === null
    ? decodeCurve(word)
    : BUILT_IN_CURVES[id].map((b) => ({ ...b }));
}

/** One band as the pool holds it: real pool ticks, TOKEN, and the liquidity it is floored to. */
export interface PlacedCurveBand {
  lower: number;
  upper: number;
  amount: bigint;
  liquidity: bigint;
}

/** TOKEN-only liquidity of `amount` from tick `near` outward to `far`, floored as the pool floors it: above spot
 *  for a currency0 token, below it for a currency1 one. */
export function bandLiquidity(
  tokenIsCurrency0: boolean,
  near: number,
  far: number,
  amount: bigint,
): bigint {
  const [a, c] = [sqrtPriceX96AtTick(near), sqrtPriceX96AtTick(far)];
  return tokenIsCurrency0
    ? (amount * ((a * c) / Q96)) / (c - a)
    : (amount * Q96) / (a - c);
}

/**
 * The bands a curve places from `startTick` (the launch's `expectedStartTick`, quote per token; a currency1 token's
 * are mirrored below it): each takes ⌊sale × bps / 10,000⌋, the last the rest, out to the usable edge. No rule runs.
 * Throws a RangeError for a word that is no curve, or bands past the pool's range.
 */
export function placeCurve(i: {
  curve: bigint;
  startTick: number;
  tokenIsCurrency0: boolean;
  sale: bigint;
}): PlacedCurveBand[] {
  const rows = curveBandsOf(i.curve);
  if (!rows) throw new RangeError("not a launch curve");
  const dir = i.tokenIsCurrency0 ? 1 : -1;
  let edge = dir * i.startTick;
  let left = i.sale;
  return rows.map((r, n) => {
    const last = n + 1 === rows.length;
    const amount = last ? left : (i.sale * BigInt(r.shareBps)) / 10_000n;
    left -= amount;
    const next = last ? dir * MAX_USABLE_TICK : edge + dir * r.widthTicks;
    if (!last && Math.abs(next) >= MAX_USABLE_TICK) {
      throw new RangeError("the curve's bands run past the usable tick range");
    }
    const liquidity = bandLiquidity(i.tokenIsCurrency0, edge, next, amount);
    const placed = i.tokenIsCurrency0
      ? { lower: edge, upper: next, amount, liquidity }
      : { lower: next, upper: edge, amount, liquidity };
    edge = next;
    return placed;
  });
}

/** One band of a launched curve: its width and share, and where it sits in the pool. */
export interface LaunchCurveBand extends CurveBand {
  /** The band's range in the pool's own ticks. A currency1 token's bands sit below its start, mirrored. */
  tickLower: number;
  tickUpper: number;
}

/** A launch's curve as a receipt or the chain reports it. */
export interface LaunchCurve {
  /** A built-in curve's id; null on a launcher's own bands. */
  curveId: CurveId | null;
  /** The built-in curve's name; null on a launcher's own bands. */
  name: CurveName | null;
  /** The launcher's own bands as the word the launch carried, `0x` and 64 hex digits; null on a built-in curve. */
  curveTable: Hex | null;
  /** The tick the first band starts at, as quote per token: a currency1 token's pool tick is its negative. */
  startTick: number;
  /** The bands from the start price outward; the last runs to the pool's edge. */
  bands: LaunchCurveBand[];
}

/** {@link LaunchCurve} for a curve word at a launch's start tick (quote per token); null for a word that is no curve. */
export function launchCurveAt(
  word: bigint,
  startTick: number,
  tokenIsCurrency0: boolean,
): LaunchCurve | null {
  const rows = curveBandsOf(word);
  if (!rows) return null;
  const curveId = builtInCurveId(word);
  const dir = tokenIsCurrency0 ? 1 : -1;
  let edge = dir * startTick;
  const bands = rows.map((r, n) => {
    const next =
      n + 1 === rows.length ? dir * MAX_USABLE_TICK : edge + dir * r.widthTicks;
    const [tickLower, tickUpper] = tokenIsCurrency0
      ? [edge, next]
      : [next, edge];
    edge = next;
    return { ...r, tickLower, tickUpper };
  });
  return {
    curveId,
    name: curveId === null ? null : CURVE_NAMES[curveId],
    curveTable: curveId === null ? curveWordHex(word) : null,
    startTick,
    bands,
  };
}
