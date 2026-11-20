import type { LaunchChain } from "./chains/index.js";
import { builtInCurveId, decodeCurve } from "./curve.js";
import {
  checkCurve,
  checkCurveBothOrders,
  checkCurveFormat,
  type CheckCurveInput,
  type CurveRevertName,
  type CurveRules,
} from "./curveCheck.js";
import { LaunchRefusedError } from "./errors.js";

// The SDK's own sentence for each curve refusal: which band and what to change. The rule sentences are core's
// (`bankrV4CurveRevertMessage`, held equal in src/__internal__), so every Bankr surface words a band the same way.

/** What a built-in curve may leave unplaced on suite 4, in parts per million (LaunchPool's BUILTIN_DUST_PPM). */
export const BUILTIN_CURVE_DUST_PPM = 5;

/** A suite 4 coin's own rules for a sentence; `builtIn` names a built-in curve's dust bound. */
export type CurveRuleFigures = CurveRules & { builtIn?: boolean };

const grouped = (n: number) => n.toLocaleString("en-US");

/** The figures a curve sentence names: suite 3's compiled ones, a suite 4 coin's own, or none when unknown. */
function curveFigures(rules: CurveRuleFigures | null | undefined) {
  if (rules === undefined)
    return {
      depth: "under a tenth of",
      density: "more than twice",
      densityNote: " (about 2% of the sale per 200 ticks)",
      near: "within 6,800 ticks of the start",
      step: "at most 13 times",
      placement:
        ": at least 90% of it must be sold within 120,000 ticks of the start",
      dust: "over 2 parts per million",
    };
  if (rules === null)
    return {
      depth: "less than this launchpad requires of",
      density: "more than this launchpad allows of",
      densityNote: "",
      near: "near the start",
      step: "only a set multiple of",
      placement: " for this launchpad's rules",
      dust: "more than this launchpad allows",
    };
  const dust = rules.builtIn ? BUILTIN_CURVE_DUST_PPM : rules.dustPpm;
  return {
    depth: `under 1/${grouped(rules.minDepthDiv)} of`,
    density: `more than ${grouped(rules.maxDensity)} times`,
    densityNote: "",
    near: `within ${grouped(rules.nearTicks)} ticks of the start`,
    step: `at most ${grouped(rules.nearStep)} times`,
    placement: `: at least ${rules.placeBps / 100}% of it must be sold within ${grouped(rules.placeTicks)} ticks of the start`,
    dust: `over ${grouped(dust)} parts per million`,
  };
}

/**
 * A curve rule's sentence. `row` counts from 0 as the contract's error does and the sentence counts bands from 1;
 * without a row no band is numbered. `rules` are a suite 4 coin's own (null: unknown, so no figure is named);
 * omitted, the figures are the ones suite 3 compiled in.
 */
export function curveRevertDetail(
  name: CurveRevertName,
  row?: number | null,
  rules?: CurveRuleFigures | null,
): string {
  const known = row !== undefined && row !== null;
  const band = known
    ? `Liquidity band ${row + 1}`
    : "One of the launch's liquidity bands";
  const it = known ? `band ${row + 1}` : "that band";
  const f = curveFigures(rules);
  switch (name) {
    case "InvalidCurve":
      return "The launch's liquidity bands are not a table a launch can use: name 1 to 8 bands whose shares are whole basis points adding up to exactly 100%, every band but the last a multiple of 200 ticks wide and ending inside the pool's price range, and the last band open-ended (width 0).";
    case "CurveTooThin":
      return `${band} is too thin: it holds ${f.depth} the liquidity the whole sale would have as a single band from the start price. Give ${it} a larger share, or make it narrower.`;
    case "CurveLiquidity":
      return `${band} puts more liquidity at one price than the pool allows${row === 0 ? "" : " where it meets the band before it"}. Give ${it} a smaller share or make it wider, or start the launch at a lower price.`;
    case "CurveTooDense":
      return `${band} is too dense: it holds ${f.density} the liquidity the whole sale would have as a single band from where it begins${f.densityNote}. Give ${it} a smaller share, or make it wider.`;
    case "CurveStep":
      return `${band} holds more liquidity than the bands before it allow on a launch whose pool buys its own token (a buyback share, auto-liquidity, or an extension the pool calls after each swap): a band that begins ${f.near} can hold ${f.step} the thinnest band before it, and a band further out no more than the band just before it. Give ${it} a smaller share or make it wider, or give the earlier bands more.`;
    case "CurvePlacement":
      return `Too little of the sale is sold near the start price${f.placement}. Move share into the earlier bands, or make them narrower.`;
    case "CurveDust":
      return `These liquidity bands would leave too much of the sale unplaced by rounding (${f.dust}). Use fewer or wider bands, or a higher start price.`;
  }
}

const BANDS_PAST_RANGE =
  "The launch's liquidity bands end past the top of the pool's price range from this start price. Make the bands narrower, or start the launch at a lower price.";

/** The form's sentence: bands that are a table fail the form only by where they end from this start. */
const formDetail = (curve: bigint): string =>
  decodeCurve(curve) !== null
    ? BANDS_PAST_RANGE
    : curveRevertDetail("InvalidCurve");

/** `INVALID_PARAMS` for own bands whose form fails from `startTick`. The form needs no rule of the coin's, so a
 *  suite 4 plan holds it before the chain's launch check, which raises it as a bare `InvalidCurve`. */
export function refuseMalformedCurve(
  curve: bigint,
  startTick: number,
  chain?: LaunchChain,
): void {
  if (checkCurveFormat(curve, startTick)) return;
  throw new LaunchRefusedError("INVALID_PARAMS", {
    chain,
    detail: formDetail(curve),
  });
}

/** What `registry.isCurveAllowed` answered on a pad for a launch's curve and for `ANY_CURVE`. */
export interface PadCurveKeys {
  /** The pad lists this exact curve: a built-in it left on, or bands its operator listed. */
  listed: boolean;
  /** The pad is open to any bands a launcher defines. */
  anyBands: boolean;
}

/** The registry's own test at launch: a listed curve, or the launcher's own bands on a pad open to any. */
export const padAllowsCurve = (curve: bigint, k: PadCurveKeys): boolean =>
  k.listed || (builtInCurveId(curve) === null && k.anyBands);

/** Why a pad refuses a curve, and who can change that: its operator, with `setCurveAllowed`. */
export function closedCurveDetail(launchpadId: bigint, curve: bigint): string {
  if (builtInCurveId(curve) !== null)
    return "This launchpad's operator has switched this launch curve off. Choose another curve, or ask the operator to switch it back on (setCurveAllowed).";
  return launchpadId === 0n
    ? "Bankr's launchpad does not take launcher-defined liquidity bands yet. Launch on one of its built-in curves."
    : "This launchpad is closed to these liquidity bands. Its operator must open it first: list these bands, or open the launchpad to launcher-defined bands, with setCurveAllowed. Until then, launch on a curve it allows.";
}

/** `CURVE_NOT_ALLOWED`, with {@link closedCurveDetail}, unless the pad allows the curve. */
export function refuseClosedCurve(
  chain: LaunchChain,
  launchpadId: bigint,
  curve: bigint,
  keys: PadCurveKeys,
): void {
  if (padAllowsCurve(curve, keys)) return;
  throw new LaunchRefusedError("CURVE_NOT_ALLOWED", {
    chain,
    detail: closedCurveDetail(launchpadId, curve),
  });
}

// 1.0001^6,800 is 1.9738: a range that ends under it leaves the next band inside the step rule's near window
// wherever the start market cap sits in its tick spacing.
const MARKET_CAP_STEP_HINT =
  "Market-cap ranges are placed from the launch's start tick, so the band after a range begins within those 6,800 ticks for certain only when the range ends under 1.97 times the start market cap. End that range lower, or convert the ranges once with curveFromMarketCaps and launch with its bands.";

/**
 * Holds a launch's own bands to the suite's rules before anything is signed: `INVALID_PARAMS` whose `detail` names
 * the band and what to change (`placedFromMarketCaps` adds where a range must end to the step rule's). With
 * `tokenIsCurrency0` the one order is checked; without it both: the token's side is known only once its salt is mined.
 */
export function refuseBrokenCurve(
  i: Omit<CheckCurveInput, "tokenIsCurrency0"> & { tokenIsCurrency0?: boolean },
  chain?: LaunchChain,
  placedFromMarketCaps = false,
): void {
  const verdict =
    i.tokenIsCurrency0 === undefined
      ? checkCurveBothOrders(i)
      : checkCurve({ ...i, tokenIsCurrency0: i.tokenIsCurrency0 });
  if (verdict.ok) return;
  const { name, row } = verdict.revert;
  const detail =
    name === "InvalidCurve"
      ? formDetail(i.curve)
      : curveRevertDetail(name, row, i.rules);
  throw new LaunchRefusedError("INVALID_PARAMS", {
    chain,
    detail:
      placedFromMarketCaps && name === "CurveStep"
        ? `${detail} ${MARKET_CAP_STEP_HINT}`
        : detail,
  });
}
