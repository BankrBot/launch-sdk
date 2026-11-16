import { isAddressEqual, type Address } from "viem";
import { readContract } from "viem/actions";
import { PAD_TREASURY_MARKER } from "../launchpad.js";
import {
  RESTRICT_CONTRACT_FIRST,
  isSentinel,
  namedPayeeOk,
} from "../recipient.js";
import type { SettingsKit } from "./context.js";
import {
  KNOB_NAMES,
  PRESET_NAMES,
  SWITCH_NAMES,
  chainRange,
  knobId,
  presetId,
  switchMask,
  switchWord,
  type KnobLimits,
  type KnobName,
  type KnobRange,
  type PadKnobs,
  type PadSwitches,
  type PresetName,
} from "./names.js";
import {
  WAD,
  WAD_PER_BPS,
  clearedSwitchesProblem,
  presetLimitsProblem,
  rangeProblem,
  switchesProblem,
  type ChainPadTerms,
  type PresetLimits,
} from "./rules.js";

// A partial change laid over what the chain holds, then checked whole: the shape every pad and template builder
// shares. `fail` refuses a broken rule (the pad's or the owner's code); `kit.invalid` a value that is no value.

export type KnobValue = bigint | number;

/** Any of a knob's three numbers; the ones left out stay as the pad holds them. */
export interface KnobChange {
  min?: KnobValue;
  max?: KnobValue;
  default?: KnobValue;
}

export type KnobChanges = Partial<Record<KnobName, KnobChange>>;

/** A payee for a pad: its share in bps, or in WAD for a finer one. Any decay share turns the decay split on. */
export interface PadPayeeInput {
  address: Address;
  shareBps?: number;
  shareWad?: bigint;
  decayShareBps?: number;
  decayShareWad?: bigint;
}

type Fail = (detail: string) => never;

const UINT64 = 2n ** 64n - 1n;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Each named knob merged over the pad's own and held to the owner's limit: the ids and ranges a call sends. */
export function mergeKnobs(
  kit: SettingsKit,
  current: PadKnobs,
  changes: unknown,
  limits: KnobLimits,
  fail: Fail,
): {
  ids: number[];
  ranges: ReturnType<typeof chainRange>[];
  merged: PadKnobs;
} {
  if (changes === undefined) return { ids: [], ranges: [], merged: current };
  if (!isRecord(changes))
    kit.invalid(
      "knobs is an object of knob names, each with min, max or default.",
    );
  const merged = { ...current };
  const ids: number[] = [];
  const ranges: ReturnType<typeof chainRange>[] = [];
  for (const [name, change] of Object.entries(changes)) {
    const id = knobId(name);
    if (id === undefined)
      kit.invalid(`${name} is not a knob: ${KNOB_NAMES.join(", ")}.`);
    if (!isRecord(change))
      kit.invalid(`${name} takes { min, max, default }, any of them.`);
    const knob = name as KnobName;
    const pick = (key: keyof KnobRange) =>
      change[key] === undefined
        ? current[knob][key]
        : kit.uint(change[key], UINT64, `${name}.${key}`);
    const next = {
      min: pick("min"),
      max: pick("max"),
      default: pick("default"),
    };
    const problem = rangeProblem(knob, next, limits[knob]);
    if (problem) fail(problem);
    merged[knob] = next;
    ids.push(id);
    ranges.push(chainRange(next));
  }
  return { ids, ranges, merged };
}

/**
 * Named switches over a flags word, inside what the owner allows. The contract writes the word whole and refuses a
 * switch the owner stopped allowing, so a stored one cannot be restated: the call says so until it is named off.
 */
export function mergeSwitches(
  kit: SettingsKit,
  current: bigint,
  changes: unknown,
  allowed: bigint,
  fail: Fail,
  { template = false, via = "switches" } = {},
): bigint {
  if (changes !== undefined && !isRecord(changes))
    kit.invalid("switches is an object of switch names, each true or false.");
  const named: Partial<PadSwitches> = {};
  let namedMask = 0n;
  for (const [name, on] of Object.entries(changes ?? {})) {
    const mask = switchMask(name);
    if (mask === undefined)
      kit.invalid(`${name} is not a switch: ${SWITCH_NAMES.join(", ")}.`);
    named[name as keyof PadSwitches] = kit.flag(on, name);
    namedMask |= mask;
  }
  const word = switchWord(named, current & allowed);
  const problem = switchesProblem(word, allowed, template);
  if (problem) fail(problem);
  // Never cleared in silence: once written off, a switch stays off when the owner allows it again.
  const cleared = current & ~allowed & ~namedMask;
  if (cleared !== 0n) fail(clearedSwitchesProblem(cleared, via));
  return word;
}

/** Each named preset's limits merged over the pad's own. */
export function mergePresets(
  kit: SettingsKit,
  current: Record<PresetName, PresetLimits>,
  changes: unknown,
  fail: Fail,
): { ids: number[]; limits: PresetLimits[] } {
  if (changes === undefined) return { ids: [], limits: [] };
  if (!isRecord(changes))
    kit.invalid("presets is an object of preset names, each with its limits.");
  const ids: number[] = [];
  const limits: PresetLimits[] = [];
  for (const [name, change] of Object.entries(changes)) {
    const id = presetId(name);
    if (id === undefined)
      kit.invalid(`${name} is not a preset: ${PRESET_NAMES.join(", ")}.`);
    if (!isRecord(change))
      kit.invalid(
        `${name} takes { allowed, maxWindowSecs, minBrakeTicks, minAnchorTau }, any of them.`,
      );
    const was = current[name as PresetName];
    const u32 = (key: "maxWindowSecs" | "minAnchorTau") =>
      change[key] === undefined
        ? was[key]
        : Number(kit.uint(change[key], 0xffff_ffffn, `${name}.${key}`));
    const brake = change.minBrakeTicks ?? was.minBrakeTicks;
    if (
      typeof brake !== "number" ||
      !Number.isInteger(brake) ||
      Math.abs(brake) > 0x7f_ffff
    )
      kit.invalid(`${name}.minBrakeTicks is a whole number of ticks (int24).`);
    const next: PresetLimits = {
      allowed:
        change.allowed === undefined
          ? was.allowed
          : kit.flag(change.allowed, `${name}.allowed`),
      maxWindowSecs: u32("maxWindowSecs"),
      minBrakeTicks: brake,
      minAnchorTau: u32("minAnchorTau"),
    };
    const problem = presetLimitsProblem(next);
    if (problem) fail(`${name}: ${problem}`);
    ids.push(id);
    limits.push(next);
  }
  return { ids, limits };
}

/** Payees as the settings contract takes them. Any decay share, or `decayAutoLpBps`, turns the decay split on. */
export function payeeTerms(
  kit: SettingsKit,
  payees: unknown,
  decayAutoLpBps: unknown,
  decayAllowed = true,
): ChainPadTerms {
  if (!Array.isArray(payees))
    kit.invalid("payees is a list of { address, shareBps }.");
  const rows = payees as readonly PadPayeeInput[];
  const share = (
    bps: unknown,
    wad: unknown,
    what: string,
  ): bigint | undefined => {
    if (bps !== undefined && wad !== undefined)
      kit.invalid(`${what}: set its share in bps or in WAD, not both.`);
    if (wad !== undefined) return kit.uint(wad, WAD, `${what} in WAD`);
    return bps === undefined
      ? undefined
      : kit.uint(bps, 10_000n, `${what} in bps`) * WAD_PER_BPS;
  };
  const parsed = rows.map((p, i) => {
    if (!isRecord(p)) kit.invalid("A payee is { address, shareBps }.");
    const what = `Payee ${i + 1}`;
    const steady = share(p.shareBps, p.shareWad, `${what}'s share`);
    if (steady === undefined)
      kit.invalid(`${what} needs shareBps or shareWad.`);
    return {
      address: kit.address(p.address, what),
      steady,
      decay: share(p.decayShareBps, p.decayShareWad, `${what}'s decay share`),
    };
  });
  const on =
    decayAutoLpBps !== undefined || parsed.some((p) => p.decay !== undefined);
  if (on && !decayAllowed)
    kit.invalid(
      "A new launchpad has no decay split: set it afterwards with setPayees.",
    );
  return {
    payees: parsed.map((p) => p.address),
    steadySharesWad: parsed.map((p) => p.steady),
    decay: {
      on,
      autoLpBps: on
        ? Number(kit.uint(decayAutoLpBps ?? 0, 10_000n, "decayAutoLpBps"))
        : 0,
      sharesWad: on ? parsed.map((p) => p.decay ?? 0n) : [],
    },
  };
}

/**
 * The factory refuses a suite contract, a launched token or a routing marker as a pad payee at every launch, so
 * such a pad could never launch; the treasury marker alone is a marker a pad may name. A contract payee that lets
 * anyone claim for it can lose its share to a stranger's settle.
 */
export async function refuseRejectedPayees(
  kit: SettingsKit,
  payees: readonly Address[],
  fail: Fail,
  stored: readonly Address[] = [],
): Promise<void> {
  // A payee the pad already holds is not held again: a change of its share names nobody new.
  const real = payees.filter(
    (p) =>
      !isAddressEqual(p, PAD_TREASURY_MARKER) &&
      !stored.some((s) => isAddressEqual(s, p)),
  );
  const [suite, named] = await Promise.all([
    Promise.all(
      real.map(
        async (p) =>
          isSentinel(p) ||
          (await readContract(kit.client, {
            ...kit.factory,
            functionName: "isSuite",
            args: [p],
          })),
      ),
    ),
    Promise.all(
      real.map((p) => namedPayeeOk(kit.client, kit.addresses.ledger, p)),
    ),
  ]);
  const bad = real.find((_, i) => suite[i]);
  if (bad)
    fail(
      `${bad} cannot be a payee: the factory refuses a Bankr suite contract, a launched token or a routing marker, so no launch on the pad would go through.`,
    );
  const open = real.find((_, i) => !named[i]!.ok);
  if (open) fail(`Payee ${open}: ${RESTRICT_CONTRACT_FIRST}`);
}
