import { EXTENSION_PRESETS, PAD_FLAGS, SETTINGS_KNOBS } from "../abis/knobs.js";

// The settings contract numbers its knobs, flags and presets; the SDK names them. Ids stay inside this module.

/** A launchpad setting with a range: `steadyPips`, `vestBps`, `capSecs`, ... (`SETTINGS_KNOBS` lists each with its unit). */
export type KnobName = (typeof SETTINGS_KNOBS)[number]["name"];

/** A feature a launchpad switches on or off for its launches: `devBuy`, `takeover`, `extPresets`, ... */
export type SwitchName = (typeof PAD_FLAGS)[number]["name"];

/** One of Bankr's reviewed extension presets. */
export type PresetName = (typeof EXTENSION_PRESETS)[number]["name"];

/**
 * A range for one knob: a launch names a value inside `[min, max]`, or takes `default`. A pad's stored row is met
 * at launch inside the owner's limit as it stands then ({@link rangeAtLaunch}), which may have moved since.
 */
export interface KnobRange {
  min: bigint;
  max: bigint;
  default: bigint;
}

/** The owner's outer range of one knob: a pad's own range sits inside it. */
export interface KnobLimit {
  min: bigint;
  max: bigint;
}

export type PadKnobs = Record<KnobName, KnobRange>;

export type KnobLimits = Record<KnobName, KnobLimit>;

export type PadSwitches = Record<SwitchName, boolean>;

export const KNOB_NAMES: readonly KnobName[] = Object.freeze(
  SETTINGS_KNOBS.map((k) => k.name),
);
export const SWITCH_NAMES: readonly SwitchName[] = Object.freeze(
  PAD_FLAGS.map((f) => f.name),
);
export const PRESET_NAMES: readonly PresetName[] = Object.freeze(
  EXTENSION_PRESETS.map((p) => p.name),
);

const KNOB_ID = new Map<string, number>(
  SETTINGS_KNOBS.map((k) => [k.name, k.id]),
);
const SWITCH_BIT = new Map<string, bigint>(
  PAD_FLAGS.map((f) => [f.name, 1n << BigInt(f.bit)]),
);
const PRESET_ID = new Map<string, number>(
  EXTENSION_PRESETS.map((p) => [p.name, p.id]),
);

/** Every switch at once: the widest word the owner may allow. */
export const ALL_SWITCHES = PAD_FLAGS.reduce(
  (word, f) => word | (1n << BigInt(f.bit)),
  0n,
);

/** A knob's id on chain; undefined for a name that is no knob. */
export const knobId = (name: string): number | undefined => KNOB_ID.get(name);
/** A switch's mask in a flags word. */
export const switchMask = (name: string): bigint | undefined =>
  SWITCH_BIT.get(name);
export const presetId = (name: string): number | undefined =>
  PRESET_ID.get(name);

/** The knob at `id`, as the chain numbers it. */
export function knobAt(id: number): (typeof SETTINGS_KNOBS)[number] {
  const knob = SETTINGS_KNOBS[id];
  if (!knob || knob.id !== id) throw new RangeError(`no knob ${id}`);
  return knob;
}

type ChainRange = { min: bigint; max: bigint; dflt: bigint };

/** `Range[]` in knob order (what `padConfig` and `template` answer) by name. */
export function knobsByName(ranges: readonly ChainRange[]): PadKnobs {
  if (ranges.length !== SETTINGS_KNOBS.length)
    throw new RangeError(
      `the chain answered ${ranges.length} knobs and this SDK version names ${SETTINGS_KNOBS.length}`,
    );
  return Object.fromEntries(
    SETTINGS_KNOBS.map((k) => {
      const r = ranges[k.id]!;
      return [k.name, { min: r.min, max: r.max, default: r.dflt }];
    }),
  ) as PadKnobs;
}

/** `Limit[]` in knob order by name. */
export function limitsByName(limits: readonly KnobLimit[]): KnobLimits {
  if (limits.length !== SETTINGS_KNOBS.length)
    throw new RangeError(
      `the chain answered ${limits.length} limits and this SDK version names ${SETTINGS_KNOBS.length}`,
    );
  return Object.fromEntries(
    SETTINGS_KNOBS.map((k) => {
      const l = limits[k.id]!;
      return [k.name, { min: l.min, max: l.max }];
    }),
  ) as KnobLimits;
}

/** `SettingsStore.range`: a stored row as a launch meets it, clamped into the owner's limit, the default inside. */
export function rangeAtLaunch(row: KnobRange, limit: KnobLimit): KnobRange {
  let { min, max, default: dflt } = row;
  if (min < limit.min) min = limit.min;
  if (min > limit.max) min = limit.max;
  if (max > limit.max) max = limit.max;
  if (max < limit.min) max = limit.min;
  if (dflt < min) dflt = min;
  if (dflt > max) dflt = max;
  return { min, max, default: dflt };
}

/** Every knob of a pad as a launch meets it now. */
export const knobsAtLaunch = (knobs: PadKnobs, limits: KnobLimits): PadKnobs =>
  Object.fromEntries(
    KNOB_NAMES.map((k) => [k, rangeAtLaunch(knobs[k], limits[k])]),
  ) as PadKnobs;

/** A flags word as named switches. A bit this SDK version does not name is ignored. */
export function switchesOf(word: bigint): PadSwitches {
  return Object.fromEntries(
    PAD_FLAGS.map((f) => [f.name, (word & (1n << BigInt(f.bit))) !== 0n]),
  ) as PadSwitches;
}

/** Named switches as a flags word, over `base` (bits the names do not cover stay as they are). */
export function switchWord(
  changes: Partial<Record<SwitchName, boolean>>,
  base = 0n,
): bigint {
  let word = base;
  for (const [name, on] of Object.entries(changes)) {
    const mask = SWITCH_BIT.get(name);
    if (mask === undefined || on === undefined) continue;
    word = on ? word | mask : word & ~mask;
  }
  return word;
}

/** The names of the bits set in `word`, for a sentence. */
export const switchNames = (word: bigint): SwitchName[] =>
  PAD_FLAGS.filter((f) => (word & (1n << BigInt(f.bit))) !== 0n).map(
    (f) => f.name,
  );

/** A chain `Range` from a named one. */
export const chainRange = (r: KnobRange): ChainRange => ({
  min: r.min,
  max: r.max,
  dflt: r.default,
});
