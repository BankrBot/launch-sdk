import { LaunchRefusedError } from "./errors.js";

// Exact conversions between a percentage and the contracts' units, pips (1,000,000 = 100 %) and bps (10,000 = 100 %).
// Decimal strings are parsed digit by digit, never through floating point.

interface Unit {
  /** Decimal places of a percentage the unit holds: a pip is 0.0001 %, a bp 0.01 %. */
  decimals: number;
  name: string;
  step: string;
}

const PIPS: Unit = { decimals: 4, name: "Pips", step: "a pip is 0.0001 %" };
const BPS: Unit = { decimals: 2, name: "Bps", step: "a bp is 0.01 %" };

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;
/** Decimal places a number of pips or bps may carry: `volumeSplit` rounds its legs to 2. */
const UNIT_DECIMALS = 2;
const SHOWN_CHARS = 32;

/** The caller's input as a `detail` repeats it, cut to 32 characters so the detail stays short enough to show. */
export const shown = (input: unknown): string => {
  const text = String(input);
  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text;
};

function refuse(detail: string): never {
  throw new LaunchRefusedError("INVALID_PERCENT", { detail });
}

/** `percent` in the unit, exactly; refuses a negative, non-numeric, over-precise or above-100 % value. */
function percentToUnits(percent: string | number, u: Unit): number {
  const tooPrecise = (text: string): never =>
    refuse(
      `${shown(text)} % has more than ${u.decimals} decimal places: ${u.step}.`,
    );
  let text: string;
  if (typeof percent === "number") {
    if (!Number.isFinite(percent) || percent < 0) {
      refuse(
        `A percentage must be a finite number of at least 0, not ${percent}.`,
      );
    }
    if (percent > 100) refuse(`${percent} % is above 100 %.`);
    // A number counts by its shortest decimal form: 1.75 passes, 0.1 + 0.2 (0.30000000000000004) does not.
    text = String(percent);
    if (text.includes("e")) tooPrecise(text);
  } else if (typeof percent === "string") {
    text = percent;
  } else {
    refuse(
      'A percentage must be a decimal string, such as "1.75", or a number.',
    );
  }
  const m = PLAIN_DECIMAL.exec(text);
  if (!m)
    refuse(
      `"${shown(text)}" is not a plain decimal percentage, such as "1.75".`,
    );
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  if (fraction.length > u.decimals) tooPrecise(text);
  const scale = 10n ** BigInt(u.decimals);
  const units =
    BigInt(m[1]!) * scale + BigInt(fraction.padEnd(u.decimals, "0"));
  if (units > 100n * scale) refuse(`${shown(text)} % is above 100 %.`);
  return Number(units);
}

/** `units` as the shortest exact percentage string; a number may carry 2 decimal places, as `volumeSplit`'s legs do. */
function unitsToPercent(units: number | bigint, u: Unit): string {
  if (typeof units !== "number" && typeof units !== "bigint") {
    refuse(`${u.name} must be a number or bigint.`);
  }
  const max = 100n * 10n ** BigInt(u.decimals);
  const inRange =
    typeof units === "bigint"
      ? units >= 0n && units <= max
      : units >= 0 && units <= Number(max);
  if (!inRange) {
    refuse(
      `${u.name} must be between 0 and ${max} (100 %), not ${shown(units)}.`,
    );
  }
  // A number counts by its shortest decimal form, as in percentToUnits; exponent form is refused as too precise.
  const m = PLAIN_DECIMAL.exec(String(units));
  const fraction = m?.[2] ?? "";
  if (!m || fraction.length > UNIT_DECIMALS) {
    refuse(
      `${u.name} carry at most ${UNIT_DECIMALS} decimal places, not ${shown(units)}.`,
    );
  }
  const hundredths =
    BigInt(m[1]!) * 10n ** BigInt(UNIT_DECIMALS) +
    BigInt(fraction.padEnd(UNIT_DECIMALS, "0"));
  const places = u.decimals + UNIT_DECIMALS;
  const scale = 10n ** BigInt(places);
  const digits = (hundredths % scale)
    .toString()
    .padStart(places, "0")
    .replace(/0+$/, "");
  const whole = (hundredths / scale).toString();
  return digits === "" ? whole : `${whole}.${digits}`;
}

/**
 * A percentage as pips (1,000,000 = 100 %): `"1.75"` → `17_500`. Exact to 4 decimal places (1 pip = 0.0001 %).
 * Prefer a string: a number is taken by its shortest decimal form. `INVALID_PERCENT` for a negative, NaN, more
 * than 4 decimal places or above 100 %.
 */
export const percentToPips = (percent: string | number): number =>
  percentToUnits(percent, PIPS);

/**
 * Pips as the shortest exact percentage: `4_750` → `"0.475"`, and a `volumeSplit` leg such as `525.15` →
 * `"0.052515"`. `INVALID_PERCENT` for a negative or above-100 % value, or a number with more than 2 decimal places.
 */
export const pipsToPercent = (pips: number | bigint): string =>
  unitsToPercent(pips, PIPS);

/**
 * A percentage as bps (10,000 = 100 %): `"50"` → `5_000`. Exact to 2 decimal places (1 bp = 0.01 %). Prefer a
 * string: a number is taken by its shortest decimal form. `INVALID_PERCENT` for a negative, NaN, more than 2
 * decimal places or above 100 %.
 */
export const percentToBps = (percent: string | number): number =>
  percentToUnits(percent, BPS);

/**
 * Bps as the shortest exact percentage: `875` → `"8.75"`, `66.5` → `"0.665"`. `INVALID_PERCENT` for a negative or
 * above-100 % value, or a number with more than 2 decimal places.
 */
export const bpsToPercent = (bps: number | bigint): string =>
  unitsToPercent(bps, BPS);
