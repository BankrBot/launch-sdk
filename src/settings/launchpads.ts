import type { Address, TransactionReceipt } from "viem";
import type { CurveKeyInput } from "../curveInput.js";
import type { UnsignedTx } from "../providers/types.js";
import type { Vanity } from "../salt.js";
import type { PadChanges } from "./configure.js";
import {
  settingsKit,
  type SettingsContext,
  type SettingsKit,
} from "./context.js";
import type { PadSwitches, PresetName } from "./names.js";
import type { KnobChanges, PadPayeeInput } from "./padChanges.js";
import { padRegistryBuilders } from "./padRegistry.js";
import { padSettingsBuilders } from "./padSettings.js";
import { settingsReaders } from "./readers.js";
import type { PadQuoteTerms, PresetLimits } from "./rules.js";

/** {@link LaunchpadAdmin.register}. */
export interface RegisterPadInput {
  /** The account that sends the registration and becomes the pad's operator: an EOA or a Safe. */
  operator: Address;
  /** Signs every launch on the pad. Omitted: an open pad, launched without an authorization. */
  signer?: Address;
  /** The pad's payees, inside the owner's payee count and share limits. A new pad has no decay split. */
  payees: readonly PadPayeeInput[];
  /** The pad's branding link, inside the registry's byte limit. Default empty. */
  metadataUri?: string;
}

/**
 * A launchpad's operator transactions, unsigned: the operator's wallet or Safe sends each one; the SDK sends
 * nothing. Each is built from what the chain holds now and checked against the owner's limits and the contracts'
 * own rules first (`INVALID_LAUNCHPAD_CONFIG` with a `detail`, or `UNKNOWN_LAUNCHPAD`). It comes from the account
 * the contract requires: the pad's live operator, and for Bankr's pad (id 0) the owner. Changes reach future
 * launches only: a coin keeps the terms of its launch.
 *
 * A partial change is read-modify-write: what a call leaves out is restated as read when it was built, and the
 * contract writes the whole row (a knob's range, the switches word, a quote's or a preset's terms; `configure`
 * also the cap controller and the payees). Two built from the same state undo each other, so in one batch (a
 * Safe multi-send) make one call per row and name every field in it, or build the next after the first lands.
 */
export interface LaunchpadAdmin {
  /** A new pad. Its value is the registry's live bond, paid to Bankr's treasury and never refunded. The pad starts
   *  as the owner's template with takeover off; read its id with `launchpadIdFromReceipt`. */
  register(input: RegisterPadInput): Promise<UnsignedTx>;
  /** The id in a mined `register` receipt from this chain's registry; `RECEIPT_MISSING_LAUNCHPAD` otherwise. */
  launchpadIdFromReceipt(receipt: TransactionReceipt): bigint;
  /** Knobs, switches, cap controller, payees and preset limits in one call, checked together. */
  configure(id: bigint, changes: PadChanges): Promise<UnsignedTx>;
  /** Each named knob's range and default. Bankr's pad's fee knobs move only through `configure`, with its payees. */
  setKnobs(id: bigint, knobs: KnobChanges): Promise<UnsignedTx>;
  /** Features on or off; the ones not named stay as they are. Only a switch the owner allows can be on, and the
   *  call writes them all: while the pad holds one on that the owner has stopped allowing, it is refused until
   *  that switch is named `false` (it then stays off when the owner allows it again). */
  setSwitches(id: bigint, switches: Partial<PadSwitches>): Promise<UnsignedTx>;
  /** Whether Bankr's takeover authority may move the creator share of this pad's future coins. Off on every pad
   *  but Bankr's until its own operator turns it on; the owner cannot. It is `setSwitches` with one name. */
  setTakeover(id: bigint, on: boolean): Promise<UnsignedTx>;
  /** Replaces the payees and the decay split together. Not on Bankr's pad: `configure` moves them with its fee. */
  setPayees(
    id: bigint,
    payees: readonly PadPayeeInput[],
    options?: { decayAutoLpBps?: number },
  ): Promise<UnsignedTx>;
  /** Who may end the wallet cap early on the pad's future coins; null: nobody. */
  setCapController(id: bigint, controller: Address | null): Promise<UnsignedTx>;
  /** The pad's own word on a quote, over what it holds: `allowed` lists it (a pad that lists none takes every
   *  quote); `ownAmounts` gives its coins on that quote the pad's compound floor and cap. */
  setQuoteTerms(
    id: bigint,
    quote: Address,
    terms: Partial<PadQuoteTerms>,
  ): Promise<UnsignedTx>;
  /** Allows or refuses one curve: a built-in (on until refused), a launcher's own bands, or `"any"` bands. */
  setCurveAllowed(
    id: bigint,
    curve: CurveKeyInput,
    allowed: boolean,
  ): Promise<UnsignedTx>;
  /** Whether a launch with `curve` passes the pad's list now. */
  isCurveAllowed(id: bigint, curve: CurveKeyInput): Promise<boolean>;
  setPresetLimits(
    id: bigint,
    preset: PresetName,
    limits: Partial<PresetLimits>,
  ): Promise<UnsignedTx>;
  /** The pad's launch signer; null makes the pad open. On Bankr's pad it is Bankr's signer, and null stops it. */
  setSigner(id: bigint, signer: Address | null): Promise<UnsignedTx>;
  /** The suffix every token on the pad ends in: 4 to 6 hex digits, or `nibbles: 0` for none. */
  setVanity(id: bigint, vanity: Vanity): Promise<UnsignedTx>;
  setMetadataUri(id: bigint, uri: string): Promise<UnsignedTx>;
  /** Pauses or resumes new launches on the pad. */
  setPaused(id: bigint, paused: boolean): Promise<UnsignedTx>;
  /** Starts a two-step handover to `next`, who sends `acceptOperator`. Bankr's pad moves with the registry. */
  transferOperator(id: bigint, next: Address): Promise<UnsignedTx>;
  /** From the pending operator a `transferOperator` named. */
  acceptOperator(id: bigint): Promise<UnsignedTx>;
}

/** The launchpad admin namespace for one chain's contracts: no wallet needed. */
export function createLaunchpadAdmin(ctx: SettingsContext): LaunchpadAdmin {
  const kit: SettingsKit = settingsKit(ctx);
  const r = settingsReaders(kit);
  return { ...padRegistryBuilders(kit, r), ...padSettingsBuilders(kit, r) };
}
