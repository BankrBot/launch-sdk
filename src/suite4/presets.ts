import { encodeAbiParameters, isHex, size, type Hex } from "viem";
import type { LaunchChain } from "../chains/index.js";
import {
  EXTENSION_PRESETS,
  presetKeyOf,
  refuseExtension,
  type PresetKey,
  type PresetParams,
} from "../presets.js";
import type { LaunchExtension } from "../terms.js";

// Suite 4's presets, vendored from core's bankr-v4 presetParamsSuite4.ts and extensionsSuite4.ts (src/__internal__
// holds each equal). A preset is held to the limits its constructor is handed, the coin's `presetSite` word: the
// pad's own limits, its extension ceiling, the launch's fee decay and the quote's compound floor. None is typed here.

type Raffle = Extract<PresetParams, { preset: "raffle_run" }>;

/** Each preset's constructor arguments on suite 4: suite 3's, and Raffle Run's dust floor and anchor. */
export type Suite4PresetParams =
  | Exclude<PresetParams, Raffle>
  | (Raffle & {
      /** The least quote a buyback spends: at least 2, at most the site's dust ceiling. */
      minBuyback: bigint;
      /** How slowly the buyback's price ceiling follows the market, in seconds: six hours to a year. */
      anchorTauSecs: number;
    });

/** How many ABI words each preset's constructor decodes on suite 4. */
export const SUITE4_PRESET_WORDS: Readonly<Record<PresetKey, number>> = {
  sniper_tax: 3,
  decay_tax: 3,
  pump_brake: 2,
  raffle_run: 6,
};

/** B14's three compiled figures: Raffle Run's anchor is six hours to a year, its buyback minimum at least 2 units. */
export const PRESET_MIN_ANCHOR_TAU_SECS = 21_600;
export const PRESET_MAX_ANCHOR_TAU_SECS = 31_536_000;
export const PRESET_MIN_DUST_FLOOR = 2n;

const count = (v: number | bigint) => v.toLocaleString("en-US");

/** A value the ABI can carry at all: what the encoding holds before any pad is read. */
export function checkSuite4PresetShape(
  p: Suite4PresetParams,
  chain?: LaunchChain,
): void {
  const refuse = (detail: string): never =>
    refuseExtension("EXTENSION_OUT_OF_BOUNDS", detail, chain);
  const intIn = (v: unknown, lo: number, hi: number, what: string) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
      refuse(`${what} must be between ${count(lo)} and ${count(hi)}.`);
  };
  const u24 = (v: unknown, what: string) => intIn(v, 0, 2 ** 24 - 1, what);
  const u32 = (v: unknown, what: string) => intIn(v, 0, 2 ** 32 - 1, what);
  const u256 = (v: unknown, what: string) => {
    if (typeof v !== "bigint" || v < 0n || v >= 1n << 256n)
      refuse(`${what} is out of range.`);
  };
  switch (p.preset) {
    case "sniper_tax":
      u24(p.buyPips, "Sniper Tax buy fee (pips)");
      u24(p.sellPips, "Sniper Tax sell fee (pips)");
      return u32(p.endSecs, "Sniper Tax end (seconds)");
    case "decay_tax":
      u24(p.startBuyPips, "Decay Tax start buy fee (pips)");
      u24(p.startSellPips, "Decay Tax start sell fee (pips)");
      return u32(p.decaySecs, "Decay Tax duration (seconds)");
    case "pump_brake":
      u24(p.brakePips, "Pump Brake fee (pips)");
      return intIn(
        p.thresholdTicks,
        -(2 ** 23),
        2 ** 23 - 1,
        "Pump Brake threshold (ticks above launch)",
      );
    case "raffle_run":
      u24(p.buyPips, "Raffle Run buy fee (pips)");
      u24(p.sellPips, "Raffle Run sell fee (pips)");
      u32(p.runSecs, "Raffle Run length (seconds)");
      u256(p.minTicketQuote, "Raffle Run ticket minimum");
      u256(p.minBuyback, "Raffle Run buyback minimum");
      return u32(p.anchorTauSecs, "Raffle Run anchor (seconds)");
  }
}

const U24 = { type: "uint24" } as const;
const U32 = { type: "uint32" } as const;
const U256 = { type: "uint256" } as const;

/** `params` exactly as the preset's constructor decodes it: an exact word count, the bytes a signature commits to. */
export function encodeSuite4PresetParams(
  p: Suite4PresetParams,
  chain?: LaunchChain,
): Hex {
  checkSuite4PresetShape(p, chain);
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
        [U24, U24, U32, U256, U256, U32],
        [
          p.buyPips,
          p.sellPips,
          p.runSecs,
          p.minTicketQuote,
          p.minBuyback,
          p.anchorTauSecs,
        ],
      );
  }
}

/** A suite 4 launch's preset id and params back to values; null for an unknown id, another length, or a word wider
 *  than its parameter. */
export function decodeSuite4PresetParams(
  id: number,
  params: Hex,
): Suite4PresetParams | null {
  const preset = presetKeyOf(id);
  if (!preset || !isHex(params, { strict: true })) return null;
  if (size(params) !== SUITE4_PRESET_WORDS[preset] * 32) return null;
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
  const anchorTauSecs = uint(5, 32);
  if (anchorTauSecs === null) return null;
  return {
    preset,
    buyPips: a,
    sellPips: b,
    runSecs: secs,
    minTicketQuote: word(3),
    minBuyback: word(4),
    anchorTauSecs,
  };
}

/** The limits a preset is built under: `CoinTerms.presetSite`, the one word its constructor is handed. */
export interface PresetSite {
  maxPips: number;
  minWindowSecs: number;
  maxWindowSecs: number;
  minBrakeTicks: number;
  minAnchorTau: number;
  maxDustFloor: bigint;
}

export function decodePresetSite(word: bigint): PresetSite {
  const at = (shift: number, bits: number) =>
    Number(BigInt.asUintN(bits, word >> BigInt(shift)));
  return {
    maxPips: at(0, 24),
    minWindowSecs: at(24, 32),
    maxWindowSecs: at(56, 32),
    minBrakeTicks: Number(BigInt.asIntN(24, word >> 88n)),
    minAnchorTau: at(112, 32),
    maxDustFloor: word >> 144n,
  };
}

/** Each preset constructor's own checks against its site, said before a launch can revert on them. */
export function validateSuite4PresetParams(
  p: Suite4PresetParams,
  site: PresetSite,
  chain?: LaunchChain,
): void {
  checkSuite4PresetShape(p, chain);
  const refuse = (detail: string): never =>
    refuseExtension("EXTENSION_OUT_OF_BOUNDS", detail, chain);
  const fee = (pips: number, what: string) => {
    if (pips > site.maxPips)
      refuse(
        site.maxPips === 0
          ? "This launchpad lets an extension charge no fee."
          : `${what} can be at most ${count(site.maxPips)} pips on this launchpad.`,
      );
  };
  // BankrPreset._checkEnd: past the launch's own fee decay, up to the pad's limit.
  const window = (secs: number, what: string) => {
    if (secs <= site.minWindowSecs || secs > site.maxWindowSecs)
      refuse(
        `${what} must be longer than ${count(site.minWindowSecs)} seconds (this launch's fee decay) and at most ${count(site.maxWindowSecs)} on this launchpad.`,
      );
  };
  switch (p.preset) {
    case "sniper_tax":
      fee(p.buyPips, "Sniper Tax buy fee");
      fee(p.sellPips, "Sniper Tax sell fee");
      if (p.buyPips === 0) refuse("Sniper Tax needs a buy fee.");
      return window(p.endSecs, "Sniper Tax end");
    case "decay_tax":
      fee(p.startBuyPips, "Decay Tax start buy fee");
      fee(p.startSellPips, "Decay Tax start sell fee");
      if (p.startBuyPips === 0 && p.startSellPips === 0)
        refuse("Decay Tax needs a buy or a sell fee.");
      return window(p.decaySecs, "Decay Tax duration");
    case "pump_brake":
      fee(p.brakePips, "Pump Brake fee");
      if (p.brakePips === 0) refuse("Pump Brake needs a fee.");
      if (p.thresholdTicks < site.minBrakeTicks)
        refuse(
          `Pump Brake threshold must be at least ${count(site.minBrakeTicks)} ticks above launch on this launchpad.`,
        );
      return;
    case "raffle_run": {
      fee(p.buyPips, "Raffle Run buy fee");
      fee(p.sellPips, "Raffle Run sell fee");
      window(p.runSecs, "Raffle Run length");
      const least = Math.max(PRESET_MIN_ANCHOR_TAU_SECS, site.minAnchorTau);
      if (
        p.anchorTauSecs < least ||
        p.anchorTauSecs > PRESET_MAX_ANCHOR_TAU_SECS
      )
        refuse(
          `Raffle Run anchor must be between ${count(least)} and ${count(PRESET_MAX_ANCHOR_TAU_SECS)} seconds.`,
        );
      if (
        p.minBuyback < PRESET_MIN_DUST_FLOOR ||
        p.minBuyback > site.maxDustFloor
      )
        refuse(
          `Raffle Run buyback minimum must be between ${count(PRESET_MIN_DUST_FLOOR)} and ${count(site.maxDustFloor)} units of the quote token.`,
        );
    }
  }
}

/**
 * A launch's preset against the site its coin will freeze (`CoinTerms.presetSite`): `resolve` runs no preset
 * constructor, so a launch it passes can still revert when the preset is built. Nothing to hold without a preset.
 */
export function checkSuite4LaunchPreset(
  e: Pick<LaunchExtension, "id" | "params">,
  presetSite: bigint,
  chain?: LaunchChain,
): void {
  if (e.id === 0) return;
  const p = decodeSuite4PresetParams(e.id, e.params);
  if (!p)
    return refuseExtension(
      "EXTENSION_OUT_OF_BOUNDS",
      "The extension preset's parameters are not in the form it takes.",
      chain,
    );
  validateSuite4PresetParams(p, decodePresetSite(presetSite), chain);
}

/** Whether a preset binds quote-only (BankrPreset.quoteOnly): every one but Raffle Run. Null for no preset's id. */
export function presetIsQuoteOnly(id: number): boolean | null {
  const key = presetKeyOf(id);
  return key ? key !== "raffle_run" : null;
}

/** The preset's display name, for a sentence. */
export const presetNameOf = (id: number): string | null => {
  const key = presetKeyOf(id);
  return key ? EXTENSION_PRESETS[key].name : null;
};
