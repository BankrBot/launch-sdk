import { createCoinTermsReads, type CoinTermsReads } from "./coinTerms.js";
import type { SettingsContext } from "./context.js";
import { createHolderLegs, type HolderLegs } from "./holderLegs.js";
import { createLaunchpadAdmin, type LaunchpadAdmin } from "./launchpads.js";
import { createOwnerSettingsAdmin, type OwnerSettingsAdmin } from "./owner.js";
import { createOwnerLeversAdmin, type OwnerLeversAdmin } from "./ownerSuite.js";
import { createSettingsReads, type SettingsReads } from "./reads.js";

/** Every owner change: the settings contract's setters, and the factory's and the launchpad registry's levers. */
export type OwnerAdmin = OwnerSettingsAdmin & OwnerLeversAdmin;

/** The owner's builders for one chain's suite. Unsigned: nothing here sends. */
export const createOwnerAdmin = (ctx: SettingsContext): OwnerAdmin => ({
  ...createOwnerSettingsAdmin(ctx),
  ...createOwnerLeversAdmin(ctx),
});

/** One suite's settings: the reads, and the pad's and the owner's changes as unsigned transactions. */
export interface LaunchContracts {
  /** What the owner and each pad hold a launch to, read live. */
  settings: SettingsReads;
  /** A launchpad operator's changes. */
  launchpads: LaunchpadAdmin;
  /** The protocol owner's changes. */
  owner: OwnerAdmin;
  /** A coin's frozen terms and their fingerprint check. */
  coinTerms: CoinTermsReads;
  /** Holder legs per generation, and each coin's pile at its own leg. */
  holderLegs: HolderLegs;
}

/** The settings reads and admin builders of one chain's suite. No wallet needed: every builder returns a
 *  transaction for the account the contract requires, and sends nothing. */
export function createLaunchContracts(ctx: SettingsContext): LaunchContracts {
  return {
    settings: createSettingsReads(ctx),
    launchpads: createLaunchpadAdmin(ctx),
    owner: createOwnerAdmin(ctx),
    coinTerms: createCoinTermsReads(ctx),
    holderLegs: createHolderLegs(ctx),
  };
}

export {
  EXTENSION_PRESETS,
  LAUNCH_OPTION_BITS,
  PAD_FLAGS,
  SETTINGS_KNOBS,
} from "../abis/knobs.js";
export { bankrLaunchSettingsAbi, bankrTermsLensAbi } from "../abis/settings.js";
export {
  createCoinTermsReads,
  decodeCoinTerms,
  type CoinTermsCheck,
  type CoinTermsReads,
  type FrozenCoinTerms,
} from "./coinTerms.js";
export type { PadChanges } from "./configure.js";
export {
  readSettingsAddresses,
  type SettingsAddresses,
  type SettingsContext,
} from "./context.js";
export {
  createHolderLegs,
  type HolderLegInfo,
  type HolderLegRoute,
  type HolderLegs,
} from "./holderLegs.js";
export {
  holderPileDue,
  type CoinHolderLeg,
  type HolderPile,
  type HolderPileDue,
  type HolderPileReads,
} from "./holderPile.js";
export {
  createLaunchpadAdmin,
  type LaunchpadAdmin,
  type RegisterPadInput,
} from "./launchpads.js";
export {
  KNOB_NAMES,
  PRESET_NAMES,
  SWITCH_NAMES,
  type KnobLimit,
  type KnobLimits,
  type KnobName,
  type KnobRange,
  type PadKnobs,
  type PadSwitches,
  type PresetName,
  type SwitchName,
} from "./names.js";
export {
  createOwnerSettingsAdmin,
  type OwnerSettingsAdmin,
  type QuoteChange,
  type TemplateChanges,
} from "./owner.js";
export { createOwnerLeversAdmin, type OwnerLeversAdmin } from "./ownerSuite.js";
export type {
  KnobChange,
  KnobChanges,
  KnobValue,
  PadPayeeInput,
} from "./padChanges.js";
export { createSettingsReads, type SettingsReads } from "./reads.js";
export type {
  GuardTerms,
  PadQuoteTerms,
  PresetLimits,
  PresetRecord,
  PricingModeName,
  ProtocolTerms,
} from "./rules.js";
export type {
  CoinTerms,
  LaunchPreview,
  PadPayeeShare,
  PadPayees,
  PadSettings,
  QuoteRow,
  ResolveParams,
  ProtocolLevers,
  TemplateSettings,
} from "./settingsTypes.js";
export type { SettingsChange, StoppedPad } from "./stoppedPads.js";
