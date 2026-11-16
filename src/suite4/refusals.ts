import type { LaunchSdkErrorCode } from "../errors.js";
import { KNOB, PAD_FLAG, type KnobName, type PadFlagName } from "./settings.js";

// What suite 4's launch check says when it refuses a launch, in words, vendored from core's bankr-v4
// launchRefusal.ts (src/__internal__ holds every sentence equal). The settings contract reverts with the knob, flag
// or bound and the numbers in force: the sentence is built from those arguments, never from a figure typed here.

type Unit =
  | "pips"
  | "bps"
  | "secs"
  | "tokens"
  | "usd"
  | "bytes"
  | "count"
  | "ticks"
  | "spacings"
  | "plain";

/** Each knob as a launcher meets it: what the number is, its unit, and the SDK code a value outside it carries. */
const KNOBS: Record<KnobName, [string, Unit, LaunchSdkErrorCode]> = {
  steadyPips: ["The trading fee", "pips", "FEE_OUT_OF_BOUNDS"],
  startPips: ["The opening fee", "pips", "FEE_OUT_OF_BOUNDS"],
  decaySecs: ["The opening fee's decay", "secs", "FEE_OUT_OF_BOUNDS"],
  referrerBps: ["The referrer share of the fee", "bps", "SPLIT_OUT_OF_BOUNDS"],
  holdersBps: [
    "Fees to holders, of the creator side,",
    "bps",
    "SPLIT_OUT_OF_BOUNDS",
  ],
  autoLpBps: [
    "Auto-liquidity, of the creator side,",
    "bps",
    "SPLIT_OUT_OF_BOUNDS",
  ],
  buybackBps: [
    "The buyback share of the creator side",
    "bps",
    "SPLIT_OUT_OF_BOUNDS",
  ],
  vestBps: [
    "The creator's vest, with any builder allocations,",
    "bps",
    "VESTING_OUT_OF_BOUNDS",
  ],
  vestToHoldersBps: ["The holders' vest", "bps", "VESTING_OUT_OF_BOUNDS"],
  vestedTotalBps: [
    "Everything vested together",
    "bps",
    "VESTING_OUT_OF_BOUNDS",
  ],
  vestToHoldersSecs: [
    "The holders' vest's length",
    "secs",
    "VESTING_OUT_OF_BOUNDS",
  ],
  vestCliffSecs: [
    "The creator's vesting cliff",
    "secs",
    "VESTING_OUT_OF_BOUNDS",
  ],
  vestSecs: ["The creator's vesting length", "secs", "VESTING_OUT_OF_BOUNDS"],
  supply: ["Total supply", "tokens", "OUTSIDE_LAUNCHPAD_RANGE"],
  capBps: ["The wallet cap, of supply,", "bps", "OUTSIDE_LAUNCHPAD_RANGE"],
  capSecs: ["The wallet cap's length", "secs", "OUTSIDE_LAUNCHPAD_RANGE"],
  devBuyMaxBps: ["The dev buy, of supply,", "bps", "CREATOR_CAP_EXCEEDED"],
  startDelaySecs: [
    "The wait before trading starts",
    "secs",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  startFdvUsd: ["The start market cap", "usd", "OUTSIDE_LAUNCHPAD_RANGE"],
  metadataBytes: ["The metadata link", "bytes", "OUTSIDE_LAUNCHPAD_RANGE"],
  feeRecipients: [
    "The number of fee recipients",
    "count",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  compoundIntervalSecs: [
    "The time between compounds",
    "secs",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  compoundShareBps: [
    "The share of the backlog a compound takes",
    "bps",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  compoundDeviationTicks: [
    "The compound's price gate",
    "ticks",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  bandHalfWidth: [
    "The compound band's half width",
    "spacings",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  bandGrid: ["The compound band's grid", "spacings", "OUTSIDE_LAUNCHPAD_RANGE"],
  buybackIntervalSecs: [
    "The time between buyback fills",
    "secs",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  buybackRetrySecs: [
    "The buyback's retry time",
    "secs",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  rewardStreamSecs: [
    "The holders' reward stream",
    "secs",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  feeCeilingPips: [
    "The fee ceiling with an extension",
    "pips",
    "EXTENSION_OUT_OF_BOUNDS",
  ],
  extMaxPips: [
    "The fee an extension may charge",
    "pips",
    "EXTENSION_OUT_OF_BOUNDS",
  ],
  curveMinDepthDiv: [
    "The curve's depth rule",
    "plain",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  curveMaxDensity: [
    "The curve's density rule",
    "plain",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  curvePlaceTicks: [
    "The curve's placement distance",
    "ticks",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  curvePlaceBps: [
    "The curve's placement share",
    "bps",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  curveDustPpm: [
    "The curve's unplaced share, in parts per million,",
    "plain",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  padShareBps: ["The launchpad's own share", "bps", "OUTSIDE_LAUNCHPAD_RANGE"],
  rewardRestartBps: [
    "The reward stream's restart share",
    "bps",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
};

const KNOB_NAMES = Object.keys(KNOB) as KnobName[];

const count = (v: bigint) => v.toLocaleString("en-US");
const percent = (v: bigint, per: bigint) => {
  const text = (Number(v) / Number(per)).toFixed(4);
  return `${text.replace(/\.?0+$/u, "")}%`;
};

function seconds(v: bigint): string {
  const n = (x: bigint, unit: string) =>
    `${count(x)} ${unit}${x === 1n ? "" : "s"}`;
  if (v !== 0n && v % 86_400n === 0n) return n(v / 86_400n, "day");
  if (v !== 0n && v % 3_600n === 0n) return n(v / 3_600n, "hour");
  return n(v, "second");
}

const SHOW: Record<Unit, (v: bigint) => string> = {
  pips: (v) => percent(v, 10_000n),
  bps: (v) => percent(v, 100n),
  secs: seconds,
  tokens: (v) => `${count(v)} token${v === 1n ? "" : "s"}`,
  usd: (v) => `$${count(v)}`,
  bytes: (v) => `${count(v)} bytes`,
  count,
  ticks: (v) => `${count(v)} ticks`,
  spacings: (v) => `${count(v * 200n)} ticks`,
  plain: count,
};

const GENERAL_RANGE = "A launch term is outside this launchpad's range.";

/** `OutsideLaunchpadRange(knob, min, max)`: the range is the pad's, inside the owner's limit, as the chain holds it. */
export function knobRefusal(knob: number, min: bigint, max: bigint): string {
  const name = KNOB_NAMES[knob];
  if (!name) return GENERAL_RANGE;
  const [what, unit] = KNOBS[name];
  const show = SHOW[unit];
  if (max === 0n) return `${what} is switched off on this launchpad.`;
  // A launch names its supply in raw units, the range is in whole tokens: the sentence carries both.
  const raw = (v: bigint) => (v * 10n ** 18n).toString();
  const units = min === max ? raw(max) : `${raw(min)} to ${raw(max)}`;
  const note = unit === "tokens" ? ` (${units} in raw units)` : "";
  if (min === max)
    return `${what} is fixed at ${show(max)} on this launchpad${note}.`;
  return min === 0n
    ? `${what} can be at most ${show(max)} on this launchpad${note}.`
    : `${what} must be between ${show(min)} and ${show(max)} on this launchpad${note}.`;
}

const FLAGS: Record<PadFlagName, string> = {
  devBuy: "a dev buy",
  allocations: "builder allocations",
  capExclusions: "extra wallet-cap exemptions",
  metadataAdmin: "a metadata admin",
  takeover: "takeover",
  unlistedQuotes: "a quote token Bankr does not list",
  extPresets: "Bankr's extension presets",
  extQuoteOnly: "a launcher's own quote-only extension",
  extCallsOut: "a launcher's own extension the pool calls after a swap",
  extOwnerSwitch:
    "an extension that charges a fee (it has not granted Bankr's off switch for it)",
  launchCompoundAmounts: "a launch's own compound floor and cap",
};

/** `NotAllowedByLaunchpad(flag)`. */
export function flagRefusal(flag: bigint): string {
  const name = (Object.keys(PAD_FLAG) as PadFlagName[]).find(
    (f) => PAD_FLAG[f] === flag,
  );
  return name
    ? `This launchpad does not allow ${FLAGS[name]}.`
    : "This launchpad does not allow one of this launch's features.";
}

/** The bounds a launch's own numbers can meet in `resolve`; any other reads as the general sentence. */
const BOUNDS: Record<number, string> = {
  1: "A launch with a buyback share needs a buy fee, and a fee ceiling with an extension, of at most 99.9899%.",
  5: "The launch's start, holders' vest and wallet cap run past the latest time the pool can keep.",
  6: "This quote token's own supply is too large for a launch's holder rewards.",
  11: "A wallet cap needs both a size and a length, and a size of at least one unit of the token; name neither for no cap.",
  12: "With auto-liquidity the compound's price gate must fit inside its band, and the buy and sell fees the launchpad and a referrer leave must add up to at least 0.02%. Where the launchpad's opening-fee split pays auto-liquidity and a fee decays, the launch needs an auto-liquidity share of its own.",
  13: "The extension must be deployed code at the hash the launch names, with a payee and gas budgets inside Bankr's limits.",
  16: "Buybacks are switched off by Bankr's price guard right now.",
  18: "This launch names more fee recipients than one transaction can settle; a coin that can be taken over holds at most 64 payees in all.",
};

const GENERAL_BOUND =
  "One of the launch's numbers is outside what a pool can run on.";

const R = "INVALID_PARAMS" satisfies LaunchSdkErrorCode;

/** Every other refusal: its sentence and the SDK code it carries. */
const PLAIN: Record<string, [string, LaunchSdkErrorCode]> = {
  UnknownLaunchpad: ["This launchpad does not exist.", "UNKNOWN_LAUNCHPAD"],
  InvalidOptions: [
    "The launch names an option for a feature it leaves off, or its options are not well formed.",
    "OPTION_FOR_FEATURE_OFF",
  ],
  QuoteNotAllowed: [
    "This quote token is not available for Bankr v4 launches.",
    "QUOTE_NOT_ALLOWED",
  ],
  QuoteNotAllowedByLaunchpad: [
    "This launchpad does not take this quote token.",
    "QUOTE_NOT_ALLOWED",
  ],
  QuoteHasNoRoute: [
    "Launches against this quote token are not open yet: its holder rewards have no route.",
    "QUOTE_NOT_ALLOWED",
  ],
  InvalidVestToHolders: [
    "A holders' vest needs a share, a length and a cliff within it; with no share, name neither.",
    "VESTING_OUT_OF_BOUNDS",
  ],
  VestBpsTooHigh: [
    "A launch cannot vest its whole supply.",
    "CREATOR_CAP_EXCEEDED",
  ],
  InvalidFeeSchedule: [
    "Each trading fee must open at or above its steady rate, and decay exactly when the two differ.",
    "FEE_OUT_OF_BOUNDS",
  ],
  BankrCutDoesNotFit: [
    "The trading fee is too low to carry Bankr's share beside the referrer's.",
    "FEE_OUT_OF_BOUNDS",
  ],
  InvalidSplits: [
    "Holders, auto-liquidity and buyback shares can total at most 100% of the creator side.",
    "SPLIT_OUT_OF_BOUNDS",
  ],
  InvalidPayees: [
    "This launchpad's own payees are outside Bankr's limits right now; its operator has to set them again.",
    "LAUNCH_REFUSED",
  ],
  OperatorPayeesMismatch: [
    "This launchpad changed its payees after the launch was prepared. Prepare the launch again.",
    "LAUNCHPAD_TERMS_CHANGED",
  ],
  OperatorShareAboveLauncherBound: [
    "This launchpad's payees take more than the launch allows them.",
    "LAUNCHPAD_TERMS_CHANGED",
  ],
  AutoLpNeedsCompoundTerms: [
    "Auto-liquidity needs a compound floor above zero and a cap at or above it for this quote token.",
    "SPLIT_OUT_OF_BOUNDS",
  ],
  BuybackFeeTooLow: [
    "A buyback share needs buy and sell fees that add up to more than the launchpad and a referrer take back.",
    "FEE_OUT_OF_BOUNDS",
  ],
  ExtensionNotAllowlisted: [
    "This extension is not on Bankr's allowlist.",
    "EXTENSION_NOT_ALLOWED",
  ],
  PresetOff: [
    "This extension preset is switched off.",
    "EXTENSION_NOT_ALLOWED",
  ],
  PresetCodeChanged: [
    "This extension preset's code changed after the launch was prepared. Prepare the launch again.",
    "TERMS_CHANGED",
  ],
  AmbiguousExtension: [
    "The extension is named two ways: a preset takes only its id and parameters, and a gas budget is named only above its floor.",
    R,
  ],
  ExtensionPayeeUnnamed: [
    "Name the extension's payee when a launch has several fee recipients.",
    R,
  ],
  InvalidCurve: [
    "The launch's liquidity bands are not a table a launch can use.",
    R,
  ],
  CurveNotAllowedByLaunchpad: [
    "This launchpad does not allow this liquidity curve.",
    "CURVE_NOT_ALLOWED",
  ],
  StartPassed: ["The trading start must be in the future.", R],
  StartTooFar: [
    "The trading start is further out than this launchpad allows.",
    R,
  ],
  StartPriceUnavailable: [
    "The launch price for this quote token is unavailable right now. Try again shortly.",
    "START_TICK_CHANGED",
  ],
  InvalidPriceAttestation: [
    "The signed launch price is missing or out of date; fetch a fresh one.",
    "PRICE_ATTESTATION_REQUIRED",
  ],
  StartTickOutOfBounds: [
    "The start market cap is outside this launchpad's range for this quote token right now.",
    "START_TICK_CHANGED",
  ],
  QuoteAmountsOutOfRange: [
    "The compound amounts are worth more than Bankr's limit, or the compound cap is worth less than $1, at this quote token's price.",
    "OUTSIDE_LAUNCHPAD_RANGE",
  ],
  TermsChanged: [
    "The launch's terms changed after it was prepared. Prepare the launch again.",
    "TERMS_CHANGED",
  ],
  // The factory's own checks, behind `resolve`: the payees, the dev buy, the pins.
  SentinelPayee: [
    "That address is reserved and cannot receive fees.",
    "FEE_RECIPIENT_CANNOT_CLAIM",
  ],
  InvalidFeeRecipient: [
    "That fee recipient cannot receive fees: it is a Bankr launch contract, or this launch's own token, escrow or holder-rewards distributor.",
    "FEE_RECIPIENT_CANNOT_CLAIM",
  ],
  InvalidFeeRecipients: [
    "Fee recipients must be different addresses, each with a share above 0%, and their shares must add up to 100%.",
    R,
  ],
  OpenContractFeeRecipient: [
    "A fee recipient is a contract that has not restricted its fee claims on Bankr's ledger. Use a wallet address, or have the contract restrict its claims first.",
    "FEE_RECIPIENT_CANNOT_CLAIM",
  ],
  InvalidExtensionPayee: [
    "That extension payee cannot receive fees: it is a Bankr launch contract, or this launch's own token, escrow or holder-rewards distributor.",
    R,
  ],
  InvalidVestingRecipient: [
    "Vested tokens cannot go to that address: a Bankr launch contract, this launch's own token, escrow or holder-rewards distributor, or a contract the launch has not allowed as a vesting recipient.",
    R,
  ],
  LaunchpadPayeeRejected: [
    "One of this launchpad's own payees cannot be paid by this launch (it is the launch's token, escrow or extension, or a Bankr launch contract). Its operator has to change its payees.",
    "LAUNCH_REFUSED",
  ],
  InvalidBeneficiary: [
    "A fee recipient, or this launchpad's own payee, is the launch's quote token: a token contract could never collect its share. Use a wallet address, or launch against another quote token.",
    "FEE_RECIPIENT_CANNOT_CLAIM",
  ],
  TooManyEntries: [
    "This launch pays more addresses than one fee bucket can hold. Name fewer fee recipients.",
    R,
  ],
  AmbiguousDevBuy: [
    "Name the dev buy once: as native value sent with the launch or as a quote amount, not both.",
    "DEV_BUY_UNAVAILABLE",
  ],
  DevBuyNativeOnlyForWeth: [
    "A dev buy can be paid in the chain's native token only on a launch against wrapped native. Name a quote amount instead.",
    "DEV_BUY_UNAVAILABLE",
  ],
  DevBuyTooLarge: [
    "The dev buy is larger than this launchpad allows, or than the token's wallet cap.",
    "CREATOR_CAP_EXCEEDED",
  ],
  DevBuyTooLittle: [
    "The dev buy would receive fewer tokens than the minimum it names.",
    "SIMULATION_REVERTED",
  ],
  DevBuyerExcluded: [
    "On a scheduled launch the dev buy cannot come from a wallet that is exempt from the token's wallet cap.",
    "DEV_BUY_UNAVAILABLE",
  ],
  Expired: [
    "The launch's deadline passed before it landed. Prepare the launch again.",
    "SIMULATION_REVERTED",
  ],
  LaunchGated: [
    "Only Bankr's own launchpad can launch on this chain right now.",
    "LAUNCHPAD_GATED",
  ],
  Paused: ["Launches are paused on this chain right now.", "PAUSED"],
  InvalidTick: [
    "The start tick must be a multiple of the pool's tick spacing.",
    R,
  ],
  UnknownCurve: ["That liquidity curve does not exist.", R],
  TokenSaltTaken: [
    "A token already exists at this launch's address. Prepare the launch again.",
    "POOL_ALREADY_INITIALIZED",
  ],
  TokenAddressChanged: [
    "The token's address is not the one the launch was pinned to. Prepare the launch again.",
    "TERMS_CHANGED",
  ],
  TermsMismatch: [
    "The launchpad's fee terms changed while the launch was being prepared. Prepare the launch again.",
    "LAUNCHPAD_TERMS_CHANGED",
  ],
  MalformedLaunch: [
    "The launch's calldata is not in the form the factory takes.",
    R,
  ],
  CompoundStartTooDeep: [
    "The start price is too low for this launch's auto-liquidity: its first compound band would hold no token. Start higher, or launch without auto-liquidity.",
    R,
  ],
  // The hook's admission of a launcher's own extension, and a preset's constructor.
  ExtensionRejected: [
    "That address cannot be an extension (no contract code, a delegated account, EOF or Stylus code).",
    R,
  ],
  ExtensionCodehashMismatch: [
    "The extension's code is not the code the launch names.",
    R,
  ],
  ExtensionCapTooHigh: [
    "The extension declares a higher fee than this launch allows it.",
    "EXTENSION_OUT_OF_BOUNDS",
  ],
  ExtensionPayeeInvalid: ["An extension needs a payee.", R],
  ExtensionGasBudget: [
    "The extension's gas budgets are outside Bankr's limits; a quote-only extension names no post-swap budget.",
    R,
  ],
  PresetParamsMalformed: [
    "The extension preset's parameters are not in the form it takes.",
    "EXTENSION_OUT_OF_BOUNDS",
  ],
  PresetFeeOutOfBounds: [
    "The extension preset's fee is outside what this launchpad allows.",
    "EXTENSION_OUT_OF_BOUNDS",
  ],
  PresetTimeOutOfBounds: [
    "The extension preset's window or anchor is outside what this launchpad allows; a window must outlast the launch's own fee decay.",
    "EXTENSION_OUT_OF_BOUNDS",
  ],
  PresetThresholdOutOfBounds: [
    "The extension preset's threshold or buyback minimum is outside what this launchpad allows.",
    "EXTENSION_OUT_OF_BOUNDS",
  ],
  // The pad registry's record of the launch, and the token's deployer.
  LaunchpadPaused: ["This launchpad is paused right now.", "LAUNCHPAD_PAUSED"],
  BankrSignerUnset: [
    "Bankr's launchpad is not signing launches right now.",
    "AUTHORIZATION_INVALID",
  ],
  InvalidAuthorization: [
    "The launchpad's authorization does not match this launch. Prepare the launch again.",
    "AUTHORIZATION_INVALID",
  ],
  AuthorizationExpired: [
    "The launchpad's authorization expired before the launch landed. Prepare the launch again.",
    "AUTHORIZATION_INVALID",
  ],
  NonceUsed: [
    "That launch authorization was already used. Prepare the launch again.",
    "AUTHORIZATION_INVALID",
  ],
  VanityMismatch: [
    "The token's address no longer fits the launchpad's vanity rule. Prepare the launch again.",
    "PREDICTION_MISMATCH",
  ],
  MetadataTooLong: [
    "The metadata link is longer than this launchpad allows.",
    R,
  ],
};

/** Every error a suite 4 launch can be refused with that has a sentence. */
export const SUITE4_LAUNCH_REFUSALS: readonly string[] = [
  "OutsideLaunchpadRange",
  "NotAllowedByLaunchpad",
  "HardBound",
  "InvalidPoolInit",
  ...Object.keys(PLAIN),
];

export interface LaunchRefusal {
  code: LaunchSdkErrorCode;
  /** Hand-written and safe to show: built from the revert's own arguments. */
  detail: string;
}

/**
 * The SDK code and sentence for a refused suite 4 launch, from the error's name and arguments (`resolve`'s, the
 * factory's, the hook's or the pad registry's); null for an error that is no launch refusal. Without its arguments an
 * error that carries numbers reads as its general sentence.
 */
export function suite4LaunchRefusal(
  errorName: string,
  args: readonly unknown[] = [],
): LaunchRefusal | null {
  if (errorName === "OutsideLaunchpadRange") {
    if (args.length < 3)
      return { code: "OUTSIDE_LAUNCHPAD_RANGE", detail: GENERAL_RANGE };
    const [knob, min, max] = args as [number, bigint, bigint];
    const name = KNOB_NAMES[Number(knob)];
    return {
      code: name ? KNOBS[name][2] : "OUTSIDE_LAUNCHPAD_RANGE",
      detail: knobRefusal(Number(knob), BigInt(min), BigInt(max)),
    };
  }
  if (errorName === "NotAllowedByLaunchpad")
    return {
      code: "NOT_ALLOWED_BY_LAUNCHPAD",
      detail: flagRefusal(args.length === 0 ? 0n : BigInt(args[0] as bigint)),
    };
  // The hook holds a hard bound a second time where it registers the pool: the same bound, the same sentence.
  if (errorName === "HardBound" || errorName === "InvalidPoolInit")
    return {
      code: "HARD_BOUND",
      detail:
        (args.length === 0 ? undefined : BOUNDS[Number(args[0])]) ??
        GENERAL_BOUND,
    };
  const plain = PLAIN[errorName];
  return plain ? { code: plain[1], detail: plain[0] } : null;
}
