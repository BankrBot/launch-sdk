import { encodeFunctionData, zeroAddress, type Address } from "viem";
import type { UnsignedTx } from "../providers/types.js";
import { BANKR_PAD, type SettingsKit } from "./context.js";
import { switchWord, type PadSwitches, type PresetName } from "./names.js";
import {
  mergeKnobs,
  mergePresets,
  mergeSwitches,
  payeeTerms,
  refuseRejectedPayees,
  type KnobChanges,
  type PadPayeeInput,
} from "./padChanges.js";
import type { SettingsReaders } from "./readers.js";
import {
  newPayeesProblem,
  padRowProblem,
  payeesProblem,
  type PresetLimits,
} from "./rules.js";

/** The takeover switch's bit: a pad that has it on names at most 64 fee recipients. */
export const TAKEOVER = switchWord({ takeover: true });

/**
 * What one `configure` moves on a launchpad. Everything left out stays as the pad holds it, with one exception the
 * call refuses rather than makes: a switch the owner has stopped allowing cannot be restated, so name it off.
 */
export interface PadChanges {
  /** Each named knob's min, max or default. */
  knobs?: KnobChanges;
  /** Features switched on or off: `{ takeover: true, devBuy: false }`. A switch the pad holds on that the owner
   *  no longer allows must be named `false` here: written off, it stays off when the owner allows it again. */
  switches?: Partial<PadSwitches>;
  /** Who may end the wallet cap early on the pad's future coins; null: nobody. */
  capController?: Address | null;
  /** Replaces the payees and the decay split together. */
  payees?: readonly PadPayeeInput[];
  /** Auto-LP's bps of the decay surplus the payees leave. Setting it turns the decay split on. */
  decayAutoLpBps?: number;
  presets?: Partial<Record<PresetName, Partial<PresetLimits>>>;
}

/**
 * `settings.configure(id, config)` from the pad's settings operator. The contract moves only the knobs and preset
 * limits a call names, and writes the flags, the cap controller and the payees as sent, so the call is built from
 * the pad's live row and carries those three whole: a second one built before this lands undoes it.
 */
export async function buildConfigure(
  kit: SettingsKit,
  r: SettingsReaders,
  id: bigint,
  changes: PadChanges,
): Promise<UnsignedTx> {
  if (typeof changes !== "object" || changes === null)
    kit.invalid(
      "A configure takes { knobs, switches, capController, payees, presets }, any of them.",
    );
  const fail = kit.padRule;
  const [row, limits, protocol, allowed, from] = await Promise.all([
    r.padRow(id),
    r.limits(),
    r.protocol(),
    r.allowedFlags(),
    kit.settingsOperator(id),
  ]);
  const knobs = mergeKnobs(kit, row.knobs, changes.knobs, limits, fail);
  const flags = mergeSwitches(
    kit,
    row.config.flags,
    changes.switches,
    allowed,
    fail,
  );
  const newPayees =
    changes.payees !== undefined || changes.decayAutoLpBps !== undefined;
  if (newPayees && changes.payees === undefined)
    kit.invalid("decayAutoLpBps is set with the payees it applies to.");
  const terms = newPayees
    ? payeeTerms(kit, changes.payees, changes.decayAutoLpBps)
    : row.config.terms;
  // configure checks the payees it is sent against the owner's limits as they stand, changed or not; only a
  // list this call names is also held to the launch's split.
  const payees = (newPayees ? newPayeesProblem : payeesProblem)(
    terms,
    protocol.maxPadPayees,
    limits.padShareBps.max,
  );
  if (payees)
    fail(
      newPayees
        ? payees
        : `The pad's stored payees are over the owner's limits now, so every configure must set them again: ${payees}`,
    );
  if (newPayees)
    await refuseRejectedPayees(
      kit,
      terms.payees,
      fail,
      row.config.terms.payees,
    );
  const presets = mergePresets(kit, row.presets, changes.presets, fail);
  const takeover = (flags & TAKEOVER) !== 0n;
  const whole = padRowProblem({ protocol, knobs: knobs.merged, takeover });
  if (whole) fail(whole);
  const capController =
    changes.capController === undefined
      ? row.config.capController
      : changes.capController === null
        ? zeroAddress
        : kit.address(changes.capController, "The cap controller", true);
  return kit.call(
    from,
    kit.addresses.settings,
    encodeFunctionData({
      abi: r.s.abi,
      functionName: "configure",
      args: [
        id,
        {
          knobs: knobs.ids,
          ranges: knobs.ranges,
          flags,
          capController,
          terms,
          presetIds: presets.ids,
          presetLimits: presets.limits,
        },
      ],
    }),
  );
}

/** Bankr's pad's fee knobs: its payee shares are sized for its fee, so the two move in one `configure`. */
export const BANKR_PAD_FEE_KNOBS = Object.freeze([
  "steadyPips",
  "startPips",
  "decaySecs",
  "referrerBps",
] as const);

/** Whether `id` is Bankr's pad and `knobs` names one of its fee knobs: `setKnobs` reverts `BankrPadIsPreset` there. */
export const namesBankrFeeKnob = (id: bigint, knobs: object): boolean =>
  id === BANKR_PAD && BANKR_PAD_FEE_KNOBS.some((k) => Object.hasOwn(knobs, k));
