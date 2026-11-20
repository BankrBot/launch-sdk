import type { Address, Hex } from "viem";
import type { UnsignedTx } from "../providers/types.js";
import { buildConfigure, type PadChanges } from "./configure.js";
import {
  BANKR_PAD,
  settingsKit,
  type SettingsContext,
  type SettingsKit,
} from "./context.js";
import type { KnobName, PadSwitches, PresetName } from "./names.js";
import { ownerListBuilders } from "./ownerLists.js";
import { ownerTermsBuilders } from "./ownerTerms.js";
import type { KnobChanges, KnobValue } from "./padChanges.js";
import { settingsReaders } from "./readers.js";
import type { QuoteRow } from "./settingsTypes.js";
import type {
  GuardTerms,
  PresetLimits,
  PresetRecord,
  ProtocolTerms,
} from "./rules.js";
import type { SettingsChange } from "./stoppedPads.js";

/** A quote row's fields to change; the ones left out stay as the row holds them (a new row starts empty). */
export type QuoteChange = Partial<Omit<QuoteRow, "quote" | "listed">>;

/** What `setTemplate` moves of what a new launchpad starts with. */
export interface TemplateChanges {
  knobs?: KnobChanges;
  /** Takeover is never part of the template: only a pad switches it on, for itself. A switch the template holds
   *  on that is no longer allowed must be named `false`, as on a pad. */
  switches?: Partial<PadSwitches>;
  capController?: Address | null;
}

/**
 * The protocol owner's settings changes, unsigned: the owner's wallet sends each one; the SDK sends nothing. Each
 * is built from what the chain holds now and checked against the hard bounds and the contract's own rules first
 * (`INVALID_SETTINGS` with a `detail`). Every change is instant and reaches future launches only.
 *
 * A partial change is read-modify-write: the fields a call leaves out are restated as read when it was built, and
 * the contract writes the whole struct (the protocol terms, the guard terms, a quote's row, a knob's limit, the
 * template's switches and cap controller, the allowed switches, pad 0's `configure`). Two built from the same
 * state undo each other: in one batch make one call per struct and name every field in it.
 */
export interface OwnerSettingsAdmin {
  /** Bankr's cut, the takeover clock, the activation divisors and the pad payee count, over the terms in force.
   *  Lists the pads a lower payee count would stop from launching. */
  setProtocolTerms(changes: Partial<ProtocolTerms>): Promise<SettingsChange>;
  setGuardTerms(changes: Partial<GuardTerms>): Promise<UnsignedTx>;
  /** The outer range of each named knob, inside its hard range. A pad's own range is met inside it at launch, never
   *  rewritten. Lists the pads a lower pad-share limit would stop from launching. */
  setLimits(
    limits: Partial<Record<KnobName, { min?: KnobValue; max?: KnobValue }>>,
  ): Promise<SettingsChange>;
  /** What a pad registered from now on starts with; pads that exist keep their rows. */
  setTemplate(changes: TemplateChanges): Promise<UnsignedTx>;
  setTemplatePresetLimits(
    preset: PresetName,
    limits: Partial<PresetLimits>,
  ): Promise<UnsignedTx>;
  /** Which switches a launchpad may use at all; off here is off for every pad's next launch. */
  setAllowedSwitches(switches: Partial<PadSwitches>): Promise<UnsignedTx>;
  /** Lists, updates or re-prices a quote in one call. The contract also prices a feed row when it is set and holds
   *  its amounts to the owner's dollar ceiling: a row it refuses there reverts on chain. */
  setQuote(quote: Address, changes: QuoteChange): Promise<UnsignedTx>;
  removeQuote(quote: Address): Promise<UnsignedTx>;
  setPriceSigner(signer: Address | null): Promise<UnsignedTx>;
  /** null: no sequencer gate. */
  setSequencerUptimeFeed(
    feed: Address | null,
    graceSecs: number,
  ): Promise<UnsignedTx>;
  /** Which code a preset deploys; null clears it. */
  setPreset(
    preset: PresetName,
    record: PresetRecord | null,
  ): Promise<UnsignedTx>;
  setExtensionAllowed(key: Hex, allowed: boolean): Promise<UnsignedTx>;
  /** Whether a BNKR-paired coin on `pad` keeps Bankr's own half; `"template"` sets what a new pad starts with. */
  setBnkrPairWaiver(
    pad: bigint | "template",
    waived: boolean,
  ): Promise<UnsignedTx>;
  /** Bankr's own pad (id 0) in one `configure`: its fee knobs and its payees move together or not at all. */
  configureBankrPad(changes: PadChanges): Promise<UnsignedTx>;
}

/** The settings contract's owner setters for one chain's suite. */
export function createOwnerSettingsAdmin(
  ctx: SettingsContext,
): OwnerSettingsAdmin {
  const kit: SettingsKit = settingsKit(ctx);
  const r = settingsReaders(kit);
  return {
    ...ownerTermsBuilders(kit, r),
    ...ownerListBuilders(kit, r),
    configureBankrPad: (changes) => buildConfigure(kit, r, BANKR_PAD, changes),
  };
}
