import {
  isAddressEqual,
  zeroAddress,
  zeroHash,
  type Address,
  type ContractFunctionName,
  type ContractFunctionReturnType,
} from "viem";
import type { bankrLaunchSettingsAbi } from "../abis/settings.js";
import { PAD_TREASURY_MARKER } from "../launchpad.js";
import {
  switchNames,
  type KnobLimit,
  type KnobName,
  type KnobRange,
} from "./names.js";

// The settings contract's own checks on a setter (SettingsCold.sol), without the chain: each returns the rule a
// value breaks as a sentence, or null. A builder refuses with it before anyone signs. The numbers typed here are
// the contract's compiled floors, which no view answers; __internal__/settingsParity.test.ts holds them to its source.

export type SettingsView<
  N extends ContractFunctionName<typeof bankrLaunchSettingsAbi, "view">,
> = ContractFunctionReturnType<typeof bankrLaunchSettingsAbi, "view", N>;

type View<
  N extends ContractFunctionName<typeof bankrLaunchSettingsAbi, "view">,
> = SettingsView<N>;

/** Bankr's cut, the holders' part of it, the takeover clock, the activation divisors and the pad payee count. */
export type ProtocolTerms = View<"protocolTerms">;

/** The numbers the buyback's and the compound's price rule are sized with. */
export type GuardTerms = View<"guardTerms">;

/** The owner's row of a quote: how it is priced, and its compound and activation amounts. */
export type QuoteTerms = View<"quoteTerms">;

/** A pad's own word on a quote: on its list or not, and its own compound amounts. */
export type PadQuoteTerms = View<"padQuoteTerms">;

/** What a pad admits of one preset. */
export type PresetLimits = View<"presetLimitsOf">;

/** Which code a preset id deploys. */
export type PresetRecord = View<"presetOf">;

/** A pad's payees as the chain holds them. */
export type ChainPadTerms = View<"payeesOf">;

export const BPS = 10_000n;
export const WAD = 10n ** 18n;
export const WAD_PER_BPS = 10n ** 14n;

/** SettingsCold's compiled floors and tops (B4, B7, B14, B16 to B18). */
export const SETTINGS_FLOORS = Object.freeze({
  minCtoNotice: 3_600,
  minTokenActivationDivisor: 10_000,
  minBnkrActivationDivisor: 10_000_000,
  maxPadPayees: 16,
  minRefTauSecs: 1_800,
  maxCurveNearStep: 13,
  /** A pad whose coins can be taken over names at most this many fee recipients. */
  takeoverMaxFeeRecipients: 64n,
  minAnchorTau: 21_600,
  maxAnchorTau: 31_536_000,
});

/** Pricing modes of a quote row. */
export const PRICING_MODE = Object.freeze({ none: 0, chainlink: 1, signed: 2 });

export type PricingModeName = keyof typeof PRICING_MODE;

export function protocolTermsProblem(t: ProtocolTerms): string | null {
  const f = SETTINGS_FLOORS;
  if (t.bankrFeeBps > 10_000 || t.holdersShareBps > 10_000)
    return "bankrFeeBps and holdersShareBps are at most 10,000 bps.";
  if (t.extBankrDen === 0 || t.extBankrNum > t.extBankrDen)
    return "Bankr's share of an extension fee is extBankrNum / extBankrDen, a fraction of at most 1 with a denominator above 0.";
  if (t.ctoNotice < f.minCtoNotice || t.ctoGrace === 0)
    return `A takeover's notice is at least ${f.minCtoNotice} seconds and its grace above 0.`;
  if (
    t.tokenActivationDivisor < f.minTokenActivationDivisor ||
    t.bnkrActivationDivisor < f.minBnkrActivationDivisor
  )
    return `The activation divisors are at least ${f.minTokenActivationDivisor} (token) and ${f.minBnkrActivationDivisor} (BNKR).`;
  if (t.maxPadPayees > f.maxPadPayees)
    return `A pad names at most ${f.maxPadPayees} payees.`;
  return null;
}

export function guardTermsProblem(g: GuardTerms): string | null {
  const f = SETTINGS_FLOORS;
  if (g.refTauSecs < f.minRefTauSecs)
    return `refTauSecs is at least ${f.minRefTauSecs} seconds.`;
  if (g.compoundSwapMaxTicks === 0 || g.maxCompoundUsd === 0)
    return "compoundSwapMaxTicks and maxCompoundUsd are above 0.";
  if (
    g.fillTravelTicks * 100 > g.minRoundTripPips ||
    (g.fillTravelCompoundingTicks + g.compoundSwapMaxTicks) * 100 >
      g.minRoundTripPips
  )
    return "The buyback's travel must fit the round-trip fee it is measured against: fillTravelTicks x 100, and (fillTravelCompoundingTicks + compoundSwapMaxTicks) x 100, are at most minRoundTripPips.";
  if (g.curveNearStep === 0 || g.curveNearStep > f.maxCurveNearStep)
    return `curveNearStep is from 1 to ${f.maxCurveNearStep}.`;
  return null;
}

/** B2: Bankr's slice beside the referrer's, and its floor inside what the referrer leaves of the fee. */
export const cutFits = (
  t: Pick<ProtocolTerms, "bankrFeeBps" | "bankrMinPips">,
  steadyPips: bigint,
  referrerBps: bigint,
): boolean =>
  BigInt(t.bankrFeeBps) + referrerBps <= BPS &&
  BigInt(t.bankrMinPips) * BPS <= steadyPips * (BPS - referrerBps);

type FeeRow = Record<"steadyPips" | "referrerBps", KnobRange>;

/** A row's lowest fee beside its highest referrer rate still carries Bankr's cut. */
export const cutFitsRow = (t: ProtocolTerms, row: FeeRow): boolean =>
  cutFits(t, row.steadyPips.min, row.referrerBps.max);

/** `_checkCut`: the cut fits somewhere inside the owner's limits, and inside the template's and Bankr's pad's rows. */
export function ownerCutProblem(i: {
  protocol: ProtocolTerms;
  limits: Record<"steadyPips" | "referrerBps", KnobLimit>;
  template: FeeRow;
  bankrPad: FeeRow;
}): string | null {
  const t = i.protocol;
  const cut = `Bankr's cut (${t.bankrFeeBps} bps of the fee, at least ${t.bankrMinPips} pips of volume)`;
  if (!cutFits(t, i.limits.steadyPips.max, i.limits.referrerBps.min))
    return `${cut} does not fit inside any fee the limits admit.`;
  if (!cutFitsRow(t, i.template))
    return `${cut} does not fit the template's lowest fee beside its highest referrer rate: move the template first.`;
  if (!cutFitsRow(t, i.bankrPad))
    return `${cut} does not fit Bankr's own pad's lowest fee beside its highest referrer rate: configure pad 0 first.`;
  return null;
}

/** `_checkPad`: what a pad's row must hold as a whole after any change to its knobs or switches. */
export function padRowProblem(i: {
  protocol: ProtocolTerms;
  knobs: Record<"steadyPips" | "referrerBps" | "feeRecipients", KnobRange>;
  takeover: boolean;
}): string | null {
  if (!cutFitsRow(i.protocol, i.knobs))
    return `The pad's lowest fee (${i.knobs.steadyPips.min} pips) beside its highest referrer rate (${i.knobs.referrerBps.max} bps) does not carry Bankr's cut (${i.protocol.bankrFeeBps} bps of the fee, at least ${i.protocol.bankrMinPips} pips of volume).`;
  const most = SETTINGS_FLOORS.takeoverMaxFeeRecipients;
  if (i.takeover && i.knobs.feeRecipients.max > most)
    return `A pad whose coins can be taken over names at most ${most} fee recipients: lower feeRecipients.max or leave takeover off.`;
  return null;
}

/** `_setLimit`: hard.min <= min <= max <= hard.max. */
export function limitProblem(
  knob: KnobName,
  l: KnobLimit,
  hard: KnobLimit,
): string | null {
  return l.min < hard.min || l.max > hard.max || l.min > l.max
    ? `${knob}: a limit runs from its min to its max inside the hard range ${hard.min} to ${hard.max}; got ${l.min} to ${l.max}.`
    : null;
}

/** `_setKnob`: limit.min <= min <= default <= max <= limit.max. */
export function rangeProblem(
  knob: KnobName,
  r: KnobRange,
  limit: KnobLimit,
): string | null {
  if (r.min > r.default || r.default > r.max)
    return `${knob}: min <= default <= max; got ${r.min}, ${r.default}, ${r.max}.`;
  if (r.min < limit.min || r.max > limit.max)
    return `${knob}: ${r.min} to ${r.max} is outside the owner's limit, ${limit.min} to ${limit.max}.`;
  return null;
}

/** `_setFlags` / `_setTemplateFlags`: only what the owner allows, and never takeover in the template. */
export function switchesProblem(
  word: bigint,
  allowed: bigint,
  template = false,
): string | null {
  const refused = word & ~allowed;
  if (refused !== 0n)
    return `The owner does not allow ${switchNames(refused).join(", ") || "a switch this SDK version does not name"} on a launchpad.`;
  return template && switchNames(word).includes("takeover")
    ? "Takeover is never part of the template: only a pad's own operator switches it on."
    : null;
}

/** Stored switches the owner stopped allowing: a call that writes the flags word would clear them for good. */
export function clearedSwitchesProblem(
  cleared: bigint,
  via = "switches",
): string {
  const names = switchNames(cleared);
  const which = names.join(", ") || "a switch this SDK version does not name";
  const it = names.length > 1 ? "them" : "it";
  const stay = names.length > 1 ? "they stay" : "it stays";
  const off = names.map((n) => `${n}: false`).join(", ");
  return `The owner has stopped allowing ${which}, held on here. The contract writes the switches whole and refuses one that is not allowed, so this call would switch ${it} off, and off ${stay} when the owner allows ${it} again. Name ${it} off to go on${off ? ` (${via}: { ${off} })` : ""}, or wait until the owner allows ${it} again.`;
}

const sumWad = (shares: readonly bigint[]): bigint | null =>
  shares.some((s) => s < 0n || s > WAD)
    ? null
    : shares.reduce((a, s) => a + s, 0n);

/** How a pad's stored payees stand against the owner's two payee limits: the launch's own check (and `_setPayees`'). */
export function payeeLimitBreach(
  t: ChainPadTerms,
  maxPadPayees: number,
  padShareMaxBps: bigint,
): "payeeCount" | "payeeShare" | null {
  if (t.payees.length > maxPadPayees) return "payeeCount";
  const steady = sumWad(t.steadySharesWad);
  const decay = t.decay.on ? sumWad(t.decay.sharesWad) : 0n;
  const most = padShareMaxBps * WAD_PER_BPS;
  return steady === null || decay === null || steady > most || decay > most
    ? "payeeShare"
    : null;
}

/** `_setPayees`: distinct non-zero payees, a share each, both sums inside the owner's limit, one encoding of "off". */
export function payeesProblem(
  t: ChainPadTerms,
  maxPadPayees: number,
  padShareMaxBps: bigint,
): string | null {
  const n = t.payees.length;
  if (n > maxPadPayees)
    return `A launchpad names at most ${maxPadPayees} payees; got ${n}.`;
  if (t.steadySharesWad.length !== n) return "Each payee has one steady share.";
  if (
    t.decay.on
      ? t.decay.sharesWad.length !== n || t.decay.autoLpBps > 10_000
      : t.decay.sharesWad.length !== 0 || t.decay.autoLpBps !== 0
  )
    return "A decay split has one share per payee and an auto-LP part of at most 10,000 bps; switched off it has neither.";
  if (payeeLimitBreach(t, maxPadPayees, padShareMaxBps) !== null)
    return `The payees' shares, steady and decay alike, come to at most ${padShareMaxBps} bps of the remainder together.`;
  const seen: Address[] = [];
  for (const p of t.payees) {
    if (isAddressEqual(p, zeroAddress))
      return "A payee is not the zero address.";
    if (seen.some((s) => isAddressEqual(s, p))) return `${p} is named twice.`;
    seen.push(p);
  }
  return null;
}

/** `LaunchResolver._split` on one share list: the treasury marker's cut first, the rest rescaled over what it
 *  leaves and rounded up. False where every launch on the pad would revert `InvalidPayees`. */
export function splitFits(
  payees: readonly Address[],
  sharesWad: readonly bigint[],
): boolean {
  const isMarker = (i: number) =>
    isAddressEqual(payees[i]!, PAD_TREASURY_MARKER);
  const cut = sharesWad.reduce((c, share, i) => (isMarker(i) ? share : c), 0n);
  if (cut >= WAD) return false;
  let rest = WAD;
  for (const [i, share] of sharesWad.entries()) {
    if (isMarker(i)) continue;
    const part = (share * WAD + (WAD - cut) - 1n) / (WAD - cut);
    if (part > rest) return false;
    rest -= part;
  }
  return true;
}

/** Payees a call names: `_setPayees`' checks, then the launch's own split, which the setter does not run. */
export function newPayeesProblem(
  t: ChainPadTerms,
  maxPadPayees: number,
  padShareMaxBps: bigint,
): string | null {
  const stored = payeesProblem(t, maxPadPayees, padShareMaxBps);
  if (stored) return stored;
  const lists = t.decay.on
    ? [t.steadySharesWad, t.decay.sharesWad]
    : [t.steadySharesWad];
  return lists.every((shares) => splitFits(t.payees, shares))
    ? null
    : "No launch on the pad would go through with these payees: the treasury marker's share must be under the whole, and the other shares, rescaled over what the marker leaves and rounded up, must fit the remainder.";
}

/** `_setPresetLimits`' own bound (B14): an allowed preset's anchor floor sits inside Raffle Run's range. */
export function presetLimitsProblem(l: PresetLimits): string | null {
  const f = SETTINGS_FLOORS;
  return l.allowed &&
    (l.minAnchorTau < f.minAnchorTau || l.minAnchorTau > f.maxAnchorTau)
    ? `An allowed preset's minAnchorTau is from ${f.minAnchorTau} to ${f.maxAnchorTau} seconds.`
    : null;
}

/** `setQuote`'s checks that need no feed: a listed row, its amounts in order, a priced row with an age. */
export function quoteTermsProblem(t: QuoteTerms): string | null {
  if (!t.allowed) return "A quote row is a listed quote: removeQuote unlists.";
  if (
    t.quoteActivation >= 1n << 112n ||
    (t.compoundFloor !== 0n &&
      (t.quoteActivation > t.compoundFloor || t.compoundFloor > t.compoundCap))
  )
    return "A quote's amounts run quoteActivation <= compoundFloor <= compoundCap, with quoteActivation under 2^112.";
  if (t.mode === PRICING_MODE.none) return null;
  if (t.maxPriceAge === 0) return "A priced quote has a maxPriceAge above 0.";
  const feed = !isAddressEqual(t.feed, zeroAddress);
  if (t.mode === PRICING_MODE.signed && feed)
    return "A quote priced by signed attestation names no feed.";
  if (t.mode === PRICING_MODE.chainlink && !feed)
    return "A quote priced by a feed names it.";
  return null;
}

/** `setQuoteTerms`' amounts: its own floor and cap in order, or none at all. */
export function padQuoteTermsProblem(t: PadQuoteTerms): string | null {
  if (
    t.ownAmounts
      ? t.compoundFloor > t.compoundCap
      : (t.compoundFloor | t.compoundCap) !== 0n
  )
    return "A pad's own compound amounts run compoundFloor <= compoundCap; without ownAmounts both are 0.";
  return null;
}

/** `_setPreset`'s shape: an all-zero record clears the id; any other names a deployer and both code hashes. */
export function presetRecordProblem(r: PresetRecord): string | null {
  const hashes =
    r.deployerCodeHash !== zeroHash || r.creationCodeHash !== zeroHash;
  if (isAddressEqual(r.deployer, zeroAddress))
    return r.active || r.selfPayee || hashes
      ? "A record with no deployer clears the preset: every other field is empty."
      : null;
  return r.deployerCodeHash === zeroHash || r.creationCodeHash === zeroHash
    ? "A preset record names its deployer's code hash and the preset's creation-code hash."
    : null;
}
