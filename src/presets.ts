import { encodeAbiParameters, isHex, size, type Hex } from "viem";
import type { LaunchChain } from "./chains/index.js";
import { MAX_DECAY_SECS } from "./economics.js";
import { LaunchRefusedError } from "./errors.js";
import { EXT_CEILING_PIPS } from "./launchpadRules.js";

// The suite's extension presets, vendored from core's bankr-v4 extensions.ts (src/__internal__ holds each equal): their
// ids, the bounds their constructors hold their parameters to (src/extensions/*.sol), and their encoding. Pure.

/** The suite's presets by id (BankrPreset.sol's `Presets`). Raffle Run is a reference extension, not a Bankr product. */
export const EXTENSION_PRESETS = Object.freeze({
  sniper_tax: { id: 1, name: "Sniper Tax", reference: false },
  decay_tax: { id: 2, name: "Decay Tax", reference: false },
  pump_brake: { id: 3, name: "Pump Brake", reference: false },
  raffle_run: { id: 4, name: "Raffle Run", reference: true },
} as const);

export type PresetKey = keyof typeof EXTENSION_PRESETS;

/** Bankr's own presets, the ones the `extension` option takes by name. */
export type PresetName = Exclude<PresetKey, "raffle_run">;

const window = (max: number) => [MAX_DECAY_SECS + 1, max] as const;
/** An extension fee's bounds, in pips: up to the hook's 10 % ceiling. */
export const EXTENSION_FEE_BOUNDS = [0, EXT_CEILING_PIPS] as const;
const FEE = EXTENSION_FEE_BOUNDS;
const FEE_ABOVE_0 = [1, EXT_CEILING_PIPS] as const;

/**
 * Each preset parameter's lowest and highest value, as its constructor checks them: fees in pips of the swap (at most
 * the hook's 10 %), seconds after launch (longer than the longest fee decay, 120 s), ticks above the launch price.
 */
export const PRESET_BOUNDS = Object.freeze({
  sniper_tax: { buyPips: FEE_ABOVE_0, sellPips: FEE, endSecs: window(3_600) },
  decay_tax: {
    startBuyPips: FEE,
    startSellPips: FEE,
    decaySecs: window(7 * 86_400),
  },
  pump_brake: { brakePips: FEE_ABOVE_0, thresholdTicks: [6_932, 887_272] },
  raffle_run: { buyPips: FEE, sellPips: FEE, runSecs: window(30 * 86_400) },
} as const);

/** A preset's constructor arguments, in its `abi.encode` order. */
export type PresetParams =
  | { preset: "sniper_tax"; buyPips: number; sellPips: number; endSecs: number }
  | {
      preset: "decay_tax";
      startBuyPips: number;
      startSellPips: number;
      decaySecs: number;
    }
  | { preset: "pump_brake"; brakePips: number; thresholdTicks: number }
  | {
      preset: "raffle_run";
      buyPips: number;
      sellPips: number;
      runSecs: number;
      minTicketQuote: bigint;
    };

/** What the hook binds: the extension's declared maxima, its quote-only flag and its sunset. */
export interface ExtensionTerms {
  maxBuyPips: number;
  maxSellPips: number;
  quoteOnly: boolean;
  /** Seconds after launch from which the extension is never asked again; 0 = never. */
  sunsetSecs: number;
}

const KEYS = Object.keys(EXTENSION_PRESETS) as PresetKey[];
/** The preset with this id, if the suite deploys one. */
export const presetKeyOf = (id: unknown): PresetKey | undefined =>
  KEYS.find((k) => EXTENSION_PRESETS[k].id === id);
const B = PRESET_BOUNDS;

export function refuseExtension(
  code: "INVALID_PARAMS" | "EXTENSION_OUT_OF_BOUNDS",
  detail: string,
  chain?: LaunchChain,
): never {
  throw new LaunchRefusedError(code, { chain, detail });
}

export function intIn(
  v: unknown,
  [lo, hi]: readonly [number, number],
  what: string,
  chain?: LaunchChain,
): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    refuseExtension(
      "EXTENSION_OUT_OF_BOUNDS",
      `${what} must be between ${lo} and ${hi}.`,
      chain,
    );
}

/** Each constructor's bounds, in its order, so the launch cannot revert on them (`PresetFeeOutOfBounds`,
 *  `PresetTimeOutOfBounds`, `PresetThresholdOutOfBounds`). */
export function validatePresetParams(
  p: PresetParams,
  chain?: LaunchChain,
): void {
  const at = (v: unknown, bounds: readonly [number, number], what: string) =>
    intIn(v, bounds, what, chain);
  switch (p.preset) {
    case "sniper_tax":
      at(p.buyPips, B.sniper_tax.buyPips, "Sniper Tax buy fee (pips)");
      at(p.sellPips, B.sniper_tax.sellPips, "Sniper Tax sell fee (pips)");
      at(p.endSecs, B.sniper_tax.endSecs, "Sniper Tax end (seconds)");
      return;
    case "decay_tax":
      at(
        p.startBuyPips,
        B.decay_tax.startBuyPips,
        "Decay Tax start buy fee (pips)",
      );
      at(
        p.startSellPips,
        B.decay_tax.startSellPips,
        "Decay Tax start sell fee (pips)",
      );
      if (p.startBuyPips === 0 && p.startSellPips === 0)
        refuseExtension(
          "EXTENSION_OUT_OF_BOUNDS",
          "Decay Tax needs a buy or a sell fee.",
          chain,
        );
      at(p.decaySecs, B.decay_tax.decaySecs, "Decay Tax duration (seconds)");
      return;
    case "pump_brake":
      at(p.brakePips, B.pump_brake.brakePips, "Pump Brake fee (pips)");
      at(
        p.thresholdTicks,
        B.pump_brake.thresholdTicks,
        "Pump Brake threshold (ticks above launch)",
      );
      return;
    case "raffle_run":
      at(p.buyPips, B.raffle_run.buyPips, "Raffle Run buy fee (pips)");
      at(p.sellPips, B.raffle_run.sellPips, "Raffle Run sell fee (pips)");
      at(p.runSecs, B.raffle_run.runSecs, "Raffle Run length (seconds)");
      if (
        typeof p.minTicketQuote !== "bigint" ||
        p.minTicketQuote < 0n ||
        p.minTicketQuote >= 1n << 256n
      )
        refuseExtension(
          "EXTENSION_OUT_OF_BOUNDS",
          "Raffle Run ticket minimum is out of range.",
          chain,
        );
  }
}

const U24 = { type: "uint24" } as const;
const U32 = { type: "uint32" } as const;

/** `params` exactly as the preset's constructor decodes it: the bytes a launch authorization commits to. */
export function encodePresetParams(p: PresetParams, chain?: LaunchChain): Hex {
  validatePresetParams(p, chain);
  switch (p.preset) {
    case "sniper_tax":
      return encodeAbiParameters(
        [U24, U24, U32],
        [p.buyPips, p.sellPips, p.endSecs],
      );
    case "decay_tax":
      return encodeAbiParameters(
        [U24, U24, U32],
        [p.startBuyPips, p.startSellPips, p.decaySecs],
      );
    case "pump_brake":
      return encodeAbiParameters(
        [U24, { type: "int24" }],
        [p.brakePips, p.thresholdTicks],
      );
    case "raffle_run":
      return encodeAbiParameters(
        [U24, U24, U32, { type: "uint256" }],
        [p.buyPips, p.sellPips, p.runSecs, p.minTicketQuote],
      );
  }
}

/** How many ABI words each preset's constructor decodes. */
export const PRESET_WORDS: Readonly<Record<PresetKey, number>> = {
  sniper_tax: 3,
  decay_tax: 3,
  pump_brake: 2,
  raffle_run: 4,
};

/** A launch's preset id and params back to values; null for an unknown id, another length, or a word wider than its
 *  parameter (the constructor's `PresetParamsMalformed`, and `abi.decode`'s own revert). */
export function decodePresetParams(
  id: number,
  params: Hex,
): PresetParams | null {
  const preset = presetKeyOf(id);
  if (!preset || !isHex(params, { strict: true })) return null;
  if (size(params) !== PRESET_WORDS[preset] * 32) return null;
  const word = (i: number) =>
    BigInt(`0x${params.slice(2 + i * 64, 66 + i * 64)}`);
  const uint = (i: number, bits: number) =>
    word(i) < 1n << BigInt(bits) ? Number(word(i)) : null;
  // An int24 is sign-extended to the whole word.
  const int24 = (i: number) => {
    const v = BigInt.asIntN(256, word(i));
    return v >= -(1n << 23n) && v < 1n << 23n ? Number(v) : null;
  };
  const [a, b] = [
    uint(0, 24),
    preset === "pump_brake" ? int24(1) : uint(1, 24),
  ];
  if (a === null || b === null) return null;
  if (preset === "pump_brake")
    return { preset, brakePips: a, thresholdTicks: b };
  const secs = uint(2, 32);
  if (secs === null) return null;
  if (preset === "sniper_tax")
    return { preset, buyPips: a, sellPips: b, endSecs: secs };
  if (preset === "decay_tax")
    return { preset, startBuyPips: a, startSellPips: b, decaySecs: secs };
  return {
    preset,
    buyPips: a,
    sellPips: b,
    runSecs: secs,
    minTicketQuote: word(3),
  };
}

/** What `BankrPresetDeployer.deploy` hands the hook: the instance's maxima, `quoteOnly()` and `sunsetSecs()`. */
export function presetTerms(p: PresetParams): ExtensionTerms {
  switch (p.preset) {
    case "sniper_tax":
      return {
        maxBuyPips: p.buyPips,
        maxSellPips: p.sellPips,
        quoteOnly: true,
        sunsetSecs: p.endSecs,
      };
    case "decay_tax":
      return {
        maxBuyPips: p.startBuyPips,
        maxSellPips: p.startSellPips,
        quoteOnly: true,
        sunsetSecs: p.decaySecs,
      };
    case "pump_brake":
      return {
        maxBuyPips: p.brakePips,
        maxSellPips: 0,
        quoteOnly: true,
        sunsetSecs: 0,
      };
    case "raffle_run":
      return {
        maxBuyPips: p.buyPips,
        maxSellPips: p.sellPips,
        quoteOnly: false,
        sunsetSecs: 0,
      };
  }
}

const pct = (pips: number) => `${pips / 10_000}%`;

/** One line for a confirm screen, from Bankr's own reading of the parameters (never the launcher's words). */
export function describePreset(p: PresetParams): string {
  switch (p.preset) {
    case "sniper_tax":
      return `Sniper Tax: buys +${pct(p.buyPips)}, sells +${pct(p.sellPips)} until ${p.endSecs}s after launch, then 0`;
    case "decay_tax":
      return `Decay Tax: buys +${pct(p.startBuyPips)}, sells +${pct(p.startSellPips)} falling to 0 over ${p.decaySecs}s`;
    case "pump_brake":
      return `Pump Brake: buys +${pct(p.brakePips)} while the price is over ${p.thresholdTicks} ticks above launch`;
    case "raffle_run":
      return `Raffle Run: buys +${pct(p.buyPips)}, sells +${pct(p.sellPips)} for ${p.runSecs}s; tickets on buys, buybacks on sells`;
  }
}
