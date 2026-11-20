import { encodeFunctionData, zeroAddress, type Hex } from "viem";
import { readContract } from "viem/actions";
import { ANY_CURVE } from "../curve.js";
import { padAllowsCurve } from "../curveDetail.js";
import { curveKey } from "../curveInput.js";
import type { UnsignedTx } from "../providers/types.js";
import { TAKEOVER, buildConfigure, namesBankrFeeKnob } from "./configure.js";
import { BANKR_PAD, type SettingsKit } from "./context.js";
import type { LaunchpadAdmin } from "./launchpads.js";
import { presetId, type PadSwitches } from "./names.js";
import {
  mergeKnobs,
  mergePresets,
  mergeSwitches,
  payeeTerms,
  refuseRejectedPayees,
} from "./padChanges.js";
import type { SettingsReaders } from "./readers.js";
import {
  newPayeesProblem,
  padQuoteTermsProblem,
  padRowProblem,
  type PadQuoteTerms,
} from "./rules.js";

type PadSettingsBuilders = Pick<
  LaunchpadAdmin,
  | "configure"
  | "setKnobs"
  | "setSwitches"
  | "setTakeover"
  | "setPayees"
  | "setCapController"
  | "setQuoteTerms"
  | "setCurveAllowed"
  | "isCurveAllowed"
  | "setPresetLimits"
>;

/** A pad's rows in the settings contract, each change from its settings operator (Bankr's pad: the owner). */
export function padSettingsBuilders(
  kit: SettingsKit,
  r: SettingsReaders,
): PadSettingsBuilders {
  const { client, addresses: a, padRule } = kit;
  const settingsAbi = r.s.abi;
  const toSettings = async (id: bigint, data: Hex) =>
    kit.call(await kit.settingsOperator(id), a.settings, data);

  async function setFlags(
    id: bigint,
    switches: Partial<PadSwitches>,
  ): Promise<UnsignedTx> {
    const [row, protocol, allowed] = await Promise.all([
      r.padRow(id),
      r.protocol(),
      r.allowedFlags(),
    ]);
    // setFlags writes every switch: one the owner paused is named off here, setTakeover's caller included.
    const flags = mergeSwitches(
      kit,
      row.config.flags,
      switches,
      allowed,
      padRule,
      { via: "setSwitches" },
    );
    const whole = padRowProblem({
      protocol,
      knobs: row.knobs,
      takeover: (flags & TAKEOVER) !== 0n,
    });
    if (whole) padRule(whole);
    return toSettings(
      id,
      encodeFunctionData({
        abi: settingsAbi,
        functionName: "setFlags",
        args: [id, flags],
      }),
    );
  }

  return {
    configure: async (id, changes) =>
      buildConfigure(kit, r, kit.requireId(id), changes),

    async setKnobs(id, knobs) {
      const n = kit.requireId(id);
      if (typeof knobs !== "object" || knobs === null)
        kit.invalid("setKnobs takes an object of knob names.");
      if (namesBankrFeeKnob(n, knobs))
        padRule(
          "Bankr's launchpad (id 0) moves its fee knobs (steadyPips, startPips, decaySecs, referrerBps) only together with its payees: use configure.",
        );
      const [row, limits, protocol] = await Promise.all([
        r.padRow(n),
        r.limits(),
        r.protocol(),
      ]);
      const merged = mergeKnobs(kit, row.knobs, knobs, limits, padRule);
      if (merged.ids.length === 0) kit.invalid("setKnobs names no knob.");
      const whole = padRowProblem({
        protocol,
        knobs: merged.merged,
        takeover: row.switches.takeover,
      });
      if (whole) padRule(whole);
      return toSettings(
        n,
        encodeFunctionData({
          abi: settingsAbi,
          functionName: "setKnobs",
          args: [n, merged.ids, merged.ranges],
        }),
      );
    },

    setSwitches: async (id, switches) => {
      if (typeof switches !== "object" || switches === null)
        kit.invalid("setSwitches takes an object of switch names.");
      return setFlags(kit.requireId(id), switches);
    },

    setTakeover: async (id, on) =>
      setFlags(kit.requireId(id), { takeover: kit.flag(on, "on") }),

    async setPayees(id, payees, options = {}) {
      const n = kit.requireId(id);
      if (n === BANKR_PAD)
        padRule(
          "Bankr's launchpad (id 0) moves its payees only together with its fee knobs: use configure.",
        );
      const terms = payeeTerms(kit, payees, options.decayAutoLpBps);
      const [row, protocol, limits] = await Promise.all([
        r.padRow(n),
        r.protocol(),
        r.limits(),
      ]);
      const problem = newPayeesProblem(
        terms,
        protocol.maxPadPayees,
        limits.padShareBps.max,
      );
      if (problem) padRule(problem);
      await refuseRejectedPayees(
        kit,
        terms.payees,
        padRule,
        row.config.terms.payees,
      );
      return toSettings(
        n,
        encodeFunctionData({
          abi: settingsAbi,
          functionName: "setPayees",
          args: [n, terms],
        }),
      );
    },

    async setCapController(id, controller) {
      const n = kit.requireId(id);
      const who =
        controller === null
          ? zeroAddress
          : kit.address(controller, "The cap controller", true);
      return toSettings(
        n,
        encodeFunctionData({
          abi: settingsAbi,
          functionName: "setCapController",
          args: [n, who],
        }),
      );
    },

    async setQuoteTerms(id, quote, terms) {
      const n = kit.requireId(id);
      const q = kit.address(quote, "The quote");
      if (typeof terms !== "object" || terms === null)
        kit.invalid(
          "setQuoteTerms takes { allowed, ownAmounts, compoundFloor, compoundCap }, any of them.",
        );
      const [, was] = await Promise.all([
        kit.requireRegistered(n),
        readContract(client, {
          ...r.s,
          functionName: "padQuoteTerms",
          args: [n, q],
        }),
      ]);
      const amount = (key: "compoundFloor" | "compoundCap") =>
        terms[key] === undefined
          ? was[key]
          : kit.uint(terms[key], 2n ** 128n - 1n, key);
      const next: PadQuoteTerms = {
        allowed:
          terms.allowed === undefined
            ? was.allowed
            : kit.flag(terms.allowed, "allowed"),
        ownAmounts:
          terms.ownAmounts === undefined
            ? was.ownAmounts
            : kit.flag(terms.ownAmounts, "ownAmounts"),
        compoundFloor: amount("compoundFloor"),
        compoundCap: amount("compoundCap"),
      };
      const problem = padQuoteTermsProblem(next);
      if (problem) padRule(problem);
      return toSettings(
        n,
        encodeFunctionData({
          abi: settingsAbi,
          functionName: "setQuoteTerms",
          args: [n, q, next],
        }),
      );
    },

    async setCurveAllowed(id, curve, allowed) {
      const n = kit.requireId(id);
      const key = curveKey(curve, kit.invalid);
      const on = kit.flag(allowed, "allowed");
      return toSettings(
        n,
        encodeFunctionData({
          abi: settingsAbi,
          functionName: "setCurveAllowed",
          args: [n, key, on],
        }),
      );
    },

    async isCurveAllowed(id, curve) {
      const n = kit.requireId(id);
      const key = curveKey(curve, kit.invalid);
      const read = (k: bigint) =>
        readContract(client, {
          ...r.s,
          functionName: "isCurveAllowed",
          args: [n, k],
        });
      const [, listed, anyBands] = await Promise.all([
        kit.requireRegistered(n),
        read(key),
        key === ANY_CURVE ? false : read(ANY_CURVE),
      ]);
      return padAllowsCurve(key, { listed, anyBands });
    },

    async setPresetLimits(id, preset, limits) {
      const n = kit.requireId(id);
      if (presetId(preset) === undefined)
        kit.invalid(`${String(preset)} is not a preset.`);
      const row = await r.padRow(n);
      const merged = mergePresets(
        kit,
        row.presets,
        { [preset]: limits },
        padRule,
      );
      return toSettings(
        n,
        encodeFunctionData({
          abi: settingsAbi,
          functionName: "setPresetLimits",
          args: [n, merged.ids[0]!, merged.limits[0]!],
        }),
      );
    },
  };
}
