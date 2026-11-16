import type { Address, ContractFunctionArgs, Hex } from "viem";
import type { bankrLaunchSettingsAbi } from "../abis/settings.js";
import type { Vanity } from "../salt.js";
import type { PadKnobs, PadSwitches, PresetName } from "./names.js";
import type {
  ChainPadTerms,
  PresetLimits,
  PricingModeName,
  SettingsView,
} from "./rules.js";

// The settings as the SDK names them: what the reads return and the builders merge a change over.

/** A pad payee and its share of each fee's remainder, in WAD (1e18 = all of it). */
export interface PadPayeeShare {
  address: Address;
  steadyShareWad: bigint;
  /** Its share of the decay window's surplus; 0 while the pad's decay split is off. */
  decayShareWad: bigint;
}

/** A pad's payees with its decay split. */
export interface PadPayees {
  payees: PadPayeeShare[];
  decay: { on: boolean; autoLpBps: number };
}

/** What a new launchpad starts with: the owner's template, as stored. A pad copies it without takeover and with
 *  only the switches allowed then; its launches meet each knob inside the owner's limits (`PadSettings.atLaunch`). */
export interface TemplateSettings {
  knobs: PadKnobs;
  switches: PadSwitches;
  /** Who may end the wallet cap early on a pad's future coins; null: nobody. */
  capController: Address | null;
  presets: Record<PresetName, PresetLimits>;
  /** A BNKR-paired coin keeps Bankr's own half in the remainder. */
  bnkrPairWaived: boolean;
}

/** One launchpad: who runs it in the registry, and every row it holds in the settings contract. */
export interface PadSettings extends TemplateSettings, PadPayees {
  id: bigint;
  /** What a launch on the pad meets now, where `knobs` and `switches` are the rows as stored: each knob inside
   *  the owner's limit as it stands, and only the switches the owner still allows. Take launch defaults from here. */
  atLaunch: { knobs: PadKnobs; switches: PadSwitches };
  /** Sends the pad's registry calls (signer, link, pause, vanity). Bankr's pad: the registry's owner. */
  operator: Address;
  /** Sends the pad's settings changes: `operator`, and for Bankr's pad the factory's owner. */
  settingsOperator: Address;
  pendingOperator: Address | null;
  /** Signs every launch on the pad; null: an open pad. */
  signer: Address | null;
  paused: boolean;
  verified: boolean;
  vanity: Vanity | null;
  metadataUri: string;
}

/** The owner's row of a quote. */
export interface QuoteRow {
  quote: Address;
  listed: boolean;
  pricing: PricingModeName;
  decimals: number;
  maxPriceAge: number;
  feed: Address | null;
  compoundFloor: bigint;
  compoundCap: bigint;
  quoteActivation: bigint;
  /** The quote's coins pay holders in the quote, on purpose. */
  quotePaid: boolean;
}

/** The factory's and the registry's own levers, read live. */
export interface SuiteLevers {
  owner: Address;
  pendingOwner: Address | null;
  paused: boolean;
  /** On: only Bankr's own pad launches. */
  launchGated: boolean;
  treasury: Address;
  hook: Address;
  hookGenerations: readonly Address[];
  holderLeg: Address;
  registryOwner: Address;
  registrationBondWei: bigint;
  maxPadUriBytes: number;
  bankrSigner: Address | null;
}

/** Suite 4's `LaunchParams`, as the settings contract's `resolve` takes it. */
export type ResolveParams = ContractFunctionArgs<
  typeof bankrLaunchSettingsAbi,
  "view",
  "resolve"
>[2];

/** A coin's whole record: what `resolve` returns for a launch and what the coin stores, hashes and logs once. */
export type CoinTerms = SettingsView<"resolve">[0];

export interface LaunchPreview {
  /** The terms this launch would freeze now. */
  terms: CoinTerms;
  /** What a launch pins as `expectedTermsHash`. */
  resolvedHash: Hex;
  expectedToken: Address;
  /** The pad's payees the launch would be signed against. */
  padTerms: ChainPadTerms;
}
