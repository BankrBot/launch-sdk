import {
  decodeAbiParameters,
  encodeAbiParameters,
  size,
  zeroAddress,
  zeroHash,
  type AbiParameterToPrimitiveType,
  type Address,
  type Hex,
} from "viem";

// The contracts' `LaunchParams.options`, vendored from core's bankr-v4 launchOptions.ts (src/__internal__ holds them
// equal, and both to forge's option blobs): empty, or abi.encode(LaunchOptions). A set bit names its fields, a clear
// bit takes the pad's default and leaves them zero; the two pins ride in the same struct.

const LAUNCH_OPTIONS = {
  type: "tuple",
  components: [
    { name: "set", type: "uint32" },
    { name: "capBps", type: "uint16" },
    { name: "capSecs", type: "uint32" },
    { name: "vestCliffSecs", type: "uint32" },
    { name: "vestSecs", type: "uint32" },
    { name: "compoundFloor", type: "uint128" },
    { name: "compoundCap", type: "uint128" },
    { name: "compoundInterval", type: "uint32" },
    { name: "compoundShareBps", type: "uint16" },
    { name: "compoundDeviationTicks", type: "uint16" },
    { name: "bandHalfWidth", type: "uint16" },
    { name: "bandGrid", type: "uint16" },
    { name: "buybackInterval", type: "uint32" },
    { name: "buybackRetry", type: "uint32" },
    { name: "rewardStreamSecs", type: "uint32" },
    { name: "rewardRestartBps", type: "uint16" },
    { name: "feeCeilingPips", type: "uint24" },
    { name: "expectedTermsHash", type: "bytes32" },
    { name: "expectedToken", type: "address" },
  ],
} as const;

/** `LaunchOptions` as viem encodes it. */
export type LaunchOptions = AbiParameterToPrimitiveType<typeof LAUNCH_OPTIONS>;

/** The `set` bits (Knobs.sol's OPT_*): which group of fields a launch names. */
export const LAUNCH_OPTION = Object.freeze({
  walletCap: 1,
  vestClock: 2,
  compoundAmounts: 4,
  compoundCadence: 8,
  compoundBand: 16,
  buybackCadence: 32,
  rewardStream: 64,
  feeCeiling: 128,
} as const);

export type LaunchOptionName = keyof typeof LAUNCH_OPTION;

const ALL = Object.values(LAUNCH_OPTION).reduce((a, b) => a | b, 0);

export const NO_LAUNCH_OPTIONS: LaunchOptions = Object.freeze({
  set: 0,
  capBps: 0,
  capSecs: 0,
  vestCliffSecs: 0,
  vestSecs: 0,
  compoundFloor: 0n,
  compoundCap: 0n,
  compoundInterval: 0,
  compoundShareBps: 0,
  compoundDeviationTicks: 0,
  bandHalfWidth: 0,
  bandGrid: 0,
  buybackInterval: 0,
  buybackRetry: 0,
  rewardStreamSecs: 0,
  rewardRestartBps: 0,
  feeCeilingPips: 0,
  expectedTermsHash: zeroHash,
  expectedToken: zeroAddress,
});

/** What a launch names on top of its pad's defaults, one entry per `set` bit; an entry left out takes the default. */
export interface LaunchOptionsInput {
  /** The wallet cap's size and length; `false` launches with none. */
  walletCap?: { bps: number; seconds: number } | false;
  /** The creator's own vest; a cliff and length of 0 unlock at the trading start. */
  vestClock?: { cliffSeconds: number; durationSeconds: number };
  /** The pool's own compound floor and cap in the quote's base units; the pad must allow it. */
  compoundAmounts?: { floor: bigint; cap: bigint };
  compoundCadence?: {
    intervalSeconds: number;
    /** Of the backlog; 0: no share cap. */
    shareBps: number;
    deviationTicks: number;
  };
  /** In 200-tick spacings. */
  compoundBand?: { halfWidthSpacings: number; gridSpacings: number };
  buybackCadence?: { intervalSeconds: number; retrySeconds: number };
  rewardStream?: { seconds: number; restartBps: number };
  /** Base fee plus extension fee, on a launch with an extension. */
  feeCeilingPips?: number;
}

/** The pins, always both: the terms `resolve` showed for this launch, and the token address mined for it. */
export interface LaunchPins {
  expectedTermsHash: Hex;
  expectedToken: Address;
}

/** The struct for what a launch names and pins. Without `pins` it is the base a draft pins before it is sent. */
export function launchOptions(
  i: LaunchOptionsInput = {},
  pins?: LaunchPins,
): LaunchOptions {
  const o = { ...NO_LAUNCH_OPTIONS };
  const name = (bit: number) => (o.set |= bit);
  if (i.walletCap !== undefined) {
    name(LAUNCH_OPTION.walletCap);
    if (i.walletCap) {
      [o.capBps, o.capSecs] = [i.walletCap.bps, i.walletCap.seconds];
    }
  }
  if (i.vestClock) {
    name(LAUNCH_OPTION.vestClock);
    o.vestCliffSecs = i.vestClock.cliffSeconds;
    o.vestSecs = i.vestClock.durationSeconds;
  }
  if (i.compoundAmounts) {
    name(LAUNCH_OPTION.compoundAmounts);
    o.compoundFloor = i.compoundAmounts.floor;
    o.compoundCap = i.compoundAmounts.cap;
  }
  if (i.compoundCadence) {
    name(LAUNCH_OPTION.compoundCadence);
    o.compoundInterval = i.compoundCadence.intervalSeconds;
    o.compoundShareBps = i.compoundCadence.shareBps;
    o.compoundDeviationTicks = i.compoundCadence.deviationTicks;
  }
  if (i.compoundBand) {
    name(LAUNCH_OPTION.compoundBand);
    o.bandHalfWidth = i.compoundBand.halfWidthSpacings;
    o.bandGrid = i.compoundBand.gridSpacings;
  }
  if (i.buybackCadence) {
    name(LAUNCH_OPTION.buybackCadence);
    o.buybackInterval = i.buybackCadence.intervalSeconds;
    o.buybackRetry = i.buybackCadence.retrySeconds;
  }
  if (i.rewardStream) {
    name(LAUNCH_OPTION.rewardStream);
    o.rewardStreamSecs = i.rewardStream.seconds;
    o.rewardRestartBps = i.rewardStream.restartBps;
  }
  if (i.feeCeilingPips !== undefined) {
    name(LAUNCH_OPTION.feeCeiling);
    o.feeCeilingPips = i.feeCeilingPips;
  }
  o.expectedTermsHash = pins?.expectedTermsHash ?? zeroHash;
  o.expectedToken = pins?.expectedToken ?? zeroAddress;
  return o;
}

const isEmpty = (o: LaunchOptions): boolean =>
  o.set === 0 &&
  BigInt(o.expectedTermsHash) === 0n &&
  BigInt(o.expectedToken) === 0n;

/** Whether a struct is one a launch may carry (LaunchResolver._options): a bit or a pin set, and a clear bit's
 *  fields zero. Nothing set and no pin is the empty `options`, never a struct. */
export function isLaunchOptions(o: LaunchOptions): boolean {
  const clear = (bit: number) => (o.set & bit) === 0;
  const O = LAUNCH_OPTION;
  const stray =
    (clear(O.walletCap) && (o.capBps | o.capSecs) !== 0) ||
    (clear(O.vestClock) && (o.vestCliffSecs | o.vestSecs) !== 0) ||
    (clear(O.compoundAmounts) && (o.compoundFloor | o.compoundCap) !== 0n) ||
    (clear(O.compoundCadence) &&
      (o.compoundInterval | o.compoundShareBps | o.compoundDeviationTicks) !==
        0) ||
    (clear(O.compoundBand) && (o.bandHalfWidth | o.bandGrid) !== 0) ||
    (clear(O.buybackCadence) && (o.buybackInterval | o.buybackRetry) !== 0) ||
    (clear(O.rewardStream) &&
      (o.rewardStreamSecs | o.rewardRestartBps) !== 0) ||
    (clear(O.feeCeiling) && o.feeCeilingPips !== 0);
  return (o.set & ~ALL) === 0 && !isEmpty(o) && !stray;
}

/** `LaunchParams.options`: empty when the launch names nothing and pins nothing, else the struct. */
export function encodeLaunchOptions(o: LaunchOptions): Hex {
  return isEmpty(o) ? "0x" : encodeAbiParameters([LAUNCH_OPTIONS], [o]);
}

/** The struct `options` carries; null for bytes the launch check refuses (`InvalidOptions`). */
export function decodeLaunchOptions(options: Hex): LaunchOptions | null {
  if (size(options) === 0) return { ...NO_LAUNCH_OPTIONS };
  if (size(options) !== LAUNCH_OPTIONS.components.length * 32) return null;
  try {
    const [o] = decodeAbiParameters([LAUNCH_OPTIONS], options);
    return isLaunchOptions(o) ? o : null;
  } catch {
    return null;
  }
}

/** `options` with both pins set: the terms hash `resolve` returned and the mined token. */
export function pinLaunchOptions(options: Hex, pins: LaunchPins): Hex {
  const o = decodeLaunchOptions(options);
  if (!o) throw new TypeError("not a launch's options");
  return encodeLaunchOptions({ ...o, ...pins });
}

/** The pins a launch's `options` carry; null for each one it does not set (and for bytes that are no options). */
export function launchPinsOf(options: Hex): {
  expectedTermsHash: Hex | null;
  expectedToken: Address | null;
} {
  const o = decodeLaunchOptions(options);
  return {
    expectedTermsHash:
      o && BigInt(o.expectedTermsHash) !== 0n ? o.expectedTermsHash : null,
    expectedToken: o && BigInt(o.expectedToken) !== 0n ? o.expectedToken : null,
  };
}
