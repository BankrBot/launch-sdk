import { encodeFunctionData, getAbiItem, zeroAddress, type Hex } from "viem";
import { readContract } from "viem/actions";
import { bankrLaunchSettingsAbi } from "../abis/settings.js";
import type { UnsignedTx } from "../providers/types.js";
import { BANKR_PAD, MAX_UINT64, type SettingsKit } from "./context.js";
import {
  ALL_SWITCHES,
  KNOB_NAMES,
  knobId,
  presetId,
  type KnobName,
} from "./names.js";
import type { OwnerSettingsAdmin } from "./owner.js";
import { mergeKnobs, mergePresets, mergeSwitches } from "./padChanges.js";
import type { SettingsReaders } from "./readers.js";
import {
  guardTermsProblem,
  limitProblem,
  ownerCutProblem,
  padRowProblem,
  protocolTermsProblem,
} from "./rules.js";
import { padsStoppedBy } from "./stoppedPads.js";

type OwnerTermsBuilders = Pick<
  OwnerSettingsAdmin,
  | "setProtocolTerms"
  | "setGuardTerms"
  | "setLimits"
  | "setTemplate"
  | "setTemplatePresetLimits"
  | "setAllowedSwitches"
>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type StructFields = readonly { name: string; type: string }[];

const PROTOCOL_FIELDS: StructFields = getAbiItem({
  abi: bankrLaunchSettingsAbi,
  name: "setProtocolTerms",
}).inputs[0].components;
const GUARD_FIELDS: StructFields = getAbiItem({
  abi: bankrLaunchSettingsAbi,
  name: "setGuardTerms",
}).inputs[0].components;

/** `changes` over `current`, field by field, each inside its Solidity width; an unknown field is refused. */
function mergeStruct<T extends Record<string, number>>(
  kit: SettingsKit,
  current: T,
  changes: unknown,
  fields: StructFields,
): T {
  const names = fields.map((f) => f.name).join(", ");
  if (!isRecord(changes)) kit.invalid(`The change is an object of: ${names}.`);
  const next: Record<string, number> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    const field = fields.find((f) => f.name === key);
    if (!field) kit.invalid(`${key} is not one of: ${names}.`);
    if (value === undefined) continue;
    // Every field is a uintN: its top is the width's.
    const top = 2n ** BigInt(field.type.slice("uint".length)) - 1n;
    next[key] = Number(kit.uint(value, top, key));
  }
  return next as T;
}

/** The owner's terms, guards, limits, template and allowed switches: what every pad and launch is held to. */
export function ownerTermsBuilders(
  kit: SettingsKit,
  r: SettingsReaders,
): OwnerTermsBuilders {
  const { client, ownerRule } = kit;
  const abi = r.s.abi;
  const send = async (data: Hex): Promise<UnsignedTx> =>
    kit.call(await kit.owner(), kit.addresses.settings, data);

  /** The rows `_checkCut` reads: the template's and Bankr's pad's fee knobs. */
  const cutRows = async () => {
    const [template, bankrPad] = await Promise.all([
      r.template(),
      r.padRow(BANKR_PAD),
    ]);
    return { template: template.knobs, bankrPad: bankrPad.knobs };
  };

  return {
    async setProtocolTerms(changes) {
      const [now, limits, rows] = await Promise.all([
        r.protocol(),
        r.limits(),
        cutRows(),
      ]);
      const next = mergeStruct(kit, now, changes, PROTOCOL_FIELDS);
      const problem =
        protocolTermsProblem(next) ??
        ownerCutProblem({ protocol: next, limits, ...rows });
      if (problem) ownerRule(problem);
      const share = limits.padShareBps.max;
      const [tx, stoppedPads] = await Promise.all([
        send(
          encodeFunctionData({
            abi,
            functionName: "setProtocolTerms",
            args: [next],
          }),
        ),
        padsStoppedBy(
          kit,
          r,
          { maxPadPayees: next.maxPadPayees, padShareMaxBps: share },
          { maxPadPayees: now.maxPadPayees, padShareMaxBps: share },
        ),
      ]);
      return { tx, stoppedPads };
    },

    async setGuardTerms(changes) {
      const next = mergeStruct(kit, await r.guards(), changes, GUARD_FIELDS);
      const problem = guardTermsProblem(next);
      if (problem) ownerRule(problem);
      return send(
        encodeFunctionData({
          abi,
          functionName: "setGuardTerms",
          args: [next],
        }),
      );
    },

    async setLimits(changes) {
      if (!isRecord(changes))
        kit.invalid(
          "setLimits takes an object of knob names, each with min or max.",
        );
      const names = Object.keys(changes);
      if (names.length === 0) kit.invalid("setLimits names no knob.");
      const ids = names.map(
        (name) =>
          knobId(name) ??
          kit.invalid(`${name} is not a knob: ${KNOB_NAMES.join(", ")}.`),
      );
      const [now, protocol, rows, hard] = await Promise.all([
        r.limits(),
        r.protocol(),
        cutRows(),
        Promise.all(
          ids.map((id) =>
            readContract(client, {
              ...r.s,
              functionName: "hardBounds",
              args: [id],
            }),
          ),
        ),
      ]);
      const next = { ...now };
      names.forEach((name, i) => {
        const knob = name as KnobName;
        const change = (changes as Record<string, unknown>)[name];
        if (!isRecord(change))
          kit.invalid(`${name} takes { min, max }, either.`);
        const pick = (key: "min" | "max") =>
          change[key] === undefined
            ? now[knob][key]
            : kit.uint(change[key], MAX_UINT64, `${name}.${key}`);
        next[knob] = { min: pick("min"), max: pick("max") };
        const [min, max] = hard[i]!;
        const problem = limitProblem(knob, next[knob], { min, max });
        if (problem) ownerRule(problem);
      });
      const cut = ownerCutProblem({ protocol, limits: next, ...rows });
      if (cut) ownerRule(cut);
      const payees = protocol.maxPadPayees;
      const [tx, stoppedPads] = await Promise.all([
        send(
          encodeFunctionData({
            abi,
            functionName: "setLimits",
            args: [ids, names.map((name) => next[name as KnobName])],
          }),
        ),
        padsStoppedBy(
          kit,
          r,
          { maxPadPayees: payees, padShareMaxBps: next.padShareBps.max },
          { maxPadPayees: payees, padShareMaxBps: now.padShareBps.max },
        ),
      ]);
      return { tx, stoppedPads };
    },

    async setTemplate(changes) {
      if (!isRecord(changes))
        kit.invalid(
          "setTemplate takes { knobs, switches, capController }, any of them.",
        );
      const [now, limits, protocol, allowed] = await Promise.all([
        r.template(),
        r.limits(),
        r.protocol(),
        r.allowedFlags(),
      ]);
      const knobs = mergeKnobs(
        kit,
        now.knobs,
        changes.knobs,
        limits,
        ownerRule,
      );
      const flags = mergeSwitches(
        kit,
        now.flags,
        changes.switches,
        allowed,
        ownerRule,
        { template: true },
      );
      const whole = padRowProblem({
        protocol,
        knobs: knobs.merged,
        takeover: false,
      });
      if (whole) ownerRule(whole);
      const capController =
        changes.capController === undefined
          ? now.controller
          : changes.capController === null
            ? zeroAddress
            : kit.address(changes.capController, "The cap controller", true);
      return send(
        encodeFunctionData({
          abi,
          functionName: "setTemplate",
          args: [knobs.ids, knobs.ranges, flags, capController],
        }),
      );
    },

    async setTemplatePresetLimits(preset, limits) {
      if (presetId(preset) === undefined)
        kit.invalid(`${String(preset)} is not a preset.`);
      const now = await r.template();
      const merged = mergePresets(
        kit,
        now.presets,
        { [preset]: limits },
        ownerRule,
      );
      return send(
        encodeFunctionData({
          abi,
          functionName: "setTemplatePresetLimits",
          args: [merged.ids[0]!, merged.limits[0]!],
        }),
      );
    },

    async setAllowedSwitches(switches) {
      // Every bit is allowed to the owner, so the merge can refuse only a name that is no switch.
      const flags = mergeSwitches(
        kit,
        await r.allowedFlags(),
        switches ?? {},
        ALL_SWITCHES,
        ownerRule,
      );
      return send(
        encodeFunctionData({
          abi,
          functionName: "setAllowedFlags",
          args: [flags],
        }),
      );
    },
  };
}
