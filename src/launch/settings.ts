import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  type AbiParameter,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrLaunchpadRegistryAbi,
} from "../abis/generated.js";
import type { ReadClient } from "../providers/types.js";

// What a launch is held to, read from the settings contract and never typed: the pad's row and the owner's
// limits (the defaults a launch takes), and `resolve`, which judges one launch and returns the terms its coin will
// freeze. Vendored from core's bankr-v4 settings.ts and launchResolverState.ts; every type is the ABI's own.

type View<
  N extends ContractFunctionName<typeof bankrLaunchSettingsAbi, "view">,
> = ContractFunctionReturnType<typeof bankrLaunchSettingsAbi, "view", N>;

/** A pad's whole row: every knob's range, its flags, cap controller, payees and preset limits. */
export type PadConfig = View<"padConfig">;

/** The owner's limit on one knob: a pad's range is met inside it. */
export type KnobLimit = View<"limitOf">;

/** A pad's range for one knob: a launch names a value inside it, or takes the default. */
export type KnobRange = View<"knobOf">;

/** A pad's payees, their shares and its decay split. */
export type PadTerms = View<"payeesOf">;

/** The owner's row for a quote; `allowed` false for one that is not listed. */
export type QuoteTerms = View<"quoteTerms">;

/** A coin's whole record: what `resolve` returns for a launch, and what the coin stores, hashes and logs once. */
export type CoinTerms = View<"resolve">[0];

/** `LaunchParams` as the contracts take it: the launch's own fields and its encoded `options`. */
export type ContractLaunchParams = ContractFunctionArgs<
  typeof bankrLaunchSettingsAbi,
  "view",
  "resolve"
>[2];

/** Knob ids (Knobs.sol; core's BANKR_V4_KNOB): `padConfig(id).ranges` and `limits()` list every knob in this order. */
export const KNOB = Object.freeze({
  steadyPips: 0,
  startPips: 1,
  decaySecs: 2,
  referrerBps: 3,
  holdersBps: 4,
  autoLpBps: 5,
  buybackBps: 6,
  vestBps: 7,
  vestToHoldersBps: 8,
  vestedTotalBps: 9,
  vestToHoldersSecs: 10,
  vestCliffSecs: 11,
  vestSecs: 12,
  supply: 13,
  capBps: 14,
  capSecs: 15,
  devBuyMaxBps: 16,
  startDelaySecs: 17,
  startFdvUsd: 18,
  metadataBytes: 19,
  feeRecipients: 20,
  compoundIntervalSecs: 21,
  compoundShareBps: 22,
  compoundDeviationTicks: 23,
  bandHalfWidth: 24,
  bandGrid: 25,
  buybackIntervalSecs: 26,
  buybackRetrySecs: 27,
  rewardStreamSecs: 28,
  feeCeilingPips: 29,
  extMaxPips: 30,
  curveMinDepthDiv: 31,
  curveMaxDensity: 32,
  curvePlaceTicks: 33,
  curvePlaceBps: 34,
  curveDustPpm: 35,
  padShareBps: 36,
  rewardRestartBps: 37,
} as const);

export type KnobName = keyof typeof KNOB;

/** Pad switches (Knobs.sol's F_*; core's BANKR_V4_FLAG): a feature launches only where the pad and the owner allow it. */
export const PAD_FLAG = Object.freeze({
  devBuy: 1n,
  allocations: 2n,
  capExclusions: 4n,
  metadataAdmin: 8n,
  takeover: 16n,
  unlistedQuotes: 32n,
  extPresets: 64n,
  extQuoteOnly: 128n,
  extCallsOut: 256n,
  extOwnerSwitch: 512n,
  launchCompoundAmounts: 1_024n,
} as const);

export type PadFlagName = keyof typeof PAD_FLAG;

/**
 * A pad's knob as a launch meets it (SettingsRead.range): the overlap of the pad's row and the owner's limit, or the
 * nearest edge of the limit where the owner has since moved it past the row, with the default clamped inside.
 */
export function knobInForce(
  s: {
    pad: Pick<PadConfig, "ranges">;
    limits: readonly KnobLimit[];
  },
  knob: KnobName,
): KnobRange {
  const row = s.pad.ranges[KNOB[knob]];
  const l = s.limits[KNOB[knob]];
  if (!row || !l) throw new RangeError(`the pad's row has no ${knob} knob`);
  const r = { ...row };
  if (r.min < l.min) r.min = l.min;
  if (r.min > l.max) r.min = l.max;
  if (r.max > l.max) r.max = l.max;
  if (r.max < l.min) r.max = l.min;
  if (r.dflt < r.min) r.dflt = r.min;
  if (r.dflt > r.max) r.dflt = r.max;
  return r;
}

const payeesFn = bankrLaunchSettingsAbi.find(
  (e) => e.type === "function" && e.name === "payeesOf",
);
const PAD_TERMS_PARAM = (
  payeesFn?.type === "function" ? payeesFn.outputs[0] : undefined
) as AbiParameter;

/** keccak256(abi.encode(terms)): a launch's `operatorPayeesHash` and a coin's `padTermsHash`. */
export function padTermsHash(terms: PadTerms): Hex {
  return keccak256(encodeAbiParameters([PAD_TERMS_PARAM], [terms]));
}

/** The smallest `maxOperatorShareBps` the pad's payees pass: the larger of its two share lists, rounded up. */
export function maxOperatorShareBps(
  terms: Pick<PadTerms, "steadySharesWad" | "decay">,
): number {
  const sum = (shares: readonly bigint[]) => shares.reduce((a, s) => a + s, 0n);
  const steady = sum(terms.steadySharesWad);
  const decay = terms.decay.on ? sum(terms.decay.sharesWad) : 0n;
  const most = steady > decay ? steady : decay;
  return Number((most + 10n ** 14n - 1n) / 10n ** 14n);
}

const resolveFn = bankrLaunchSettingsAbi.find(
  (e) => e.type === "function" && e.name === "resolve",
);
const COIN_TERMS_PARAM = (
  resolveFn?.type === "function" ? resolveFn.outputs[0] : undefined
) as AbiParameter;

/** `abi.encode(CoinTerms)`: the words a coin's record is, and what its hashes are taken over. */
export function encodeCoinTerms(terms: CoinTerms): Hex {
  return encodeAbiParameters([COIN_TERMS_PARAM], [terms]);
}

/** The `terms` bytes of the factory's `CoinTermsFrozen`, as the struct. */
export function decodeCoinTerms(terms: Hex): CoinTerms {
  return decodeAbiParameters([COIN_TERMS_PARAM], terms)[0] as CoinTerms;
}

/** The settings contract's and the pad registry's answers a plan needs, read in one round. */
export interface LaunchState {
  paused: boolean;
  gated: boolean;
  weth: Address;
  /** The pad as the registry holds it: operator, signer, pause, vanity. */
  registryPad: ContractFunctionReturnType<
    typeof bankrLaunchpadRegistryAbi,
    "view",
    "getLaunchpad"
  >;
  /** The number of pads registered: an id at or past it is no pad. */
  padCount: bigint;
  pad: PadConfig;
  limits: readonly KnobLimit[];
  /** The owner's allowed set: a pad's flag counts only where this has it too. */
  allowedFlags: bigint;
  quote: QuoteTerms;
  padTakesQuote: boolean;
}

export async function readLaunchState(
  client: ReadClient,
  a: { factory: Address; launchpadRegistry: Address; settings: Address },
  i: { padId: bigint; quote: Address },
): Promise<LaunchState> {
  const f = { address: a.factory, abi: bankrLaunchFactoryAbi } as const;
  const r = {
    address: a.launchpadRegistry,
    abi: bankrLaunchpadRegistryAbi,
  } as const;
  const s = { address: a.settings, abi: bankrLaunchSettingsAbi } as const;
  const [
    paused,
    gated,
    weth,
    registryPad,
    padCount,
    pad,
    limits,
    allowedFlags,
    quote,
    padTakesQuote,
  ] = await Promise.all([
    readContract(client, { ...f, functionName: "paused" }),
    readContract(client, { ...f, functionName: "launchGated" }),
    readContract(client, { ...f, functionName: "weth" }),
    readContract(client, {
      ...r,
      functionName: "getLaunchpad",
      args: [i.padId],
    }),
    readContract(client, { ...r, functionName: "launchpadCount" }),
    readContract(client, { ...s, functionName: "padConfig", args: [i.padId] }),
    readContract(client, { ...s, functionName: "limits" }),
    readContract(client, { ...s, functionName: "allowedFlags" }),
    readContract(client, {
      ...s,
      functionName: "quoteTerms",
      args: [i.quote],
    }),
    readContract(client, {
      ...s,
      functionName: "isQuoteAllowed",
      args: [i.padId, i.quote],
    }),
  ]);
  return {
    paused,
    gated,
    weth,
    registryPad,
    padCount,
    pad,
    limits,
    allowedFlags,
    quote,
    padTakesQuote,
  };
}

/** Whether pad and owner both leave `flag` on for a launch landing now. */
export const flagInForce = (
  s: Pick<LaunchState, "pad" | "allowedFlags">,
  flag: PadFlagName,
): boolean => (s.pad.flags & s.allowedFlags & PAD_FLAG[flag]) !== 0n;

export interface ResolvedTerms {
  terms: CoinTerms;
  /** What `LaunchOptions.expectedTermsHash` pins: the hash of `terms` as resolved, before the factory's fill. */
  resolvedHash: Hex;
  /** The pad's payees the launch would be signed against. */
  padTerms: PadTerms;
}

/**
 * `settings.resolve(launcher, nativeDevBuy, params)` as an `eth_call`: the terms this launch would freeze now. A
 * launch the chain would refuse rejects with the contract's own error (refusals.ts words it).
 */
export async function resolveLaunchTerms(
  client: ReadClient,
  settings: Address,
  i: {
    launcher: Address;
    nativeDevBuy: bigint;
    params: ContractLaunchParams;
    blockNumber?: bigint;
  },
): Promise<ResolvedTerms> {
  const [terms, resolvedHash, , padTerms] = await readContract(client, {
    address: settings,
    abi: bankrLaunchSettingsAbi,
    functionName: "resolve",
    args: [i.launcher, i.nativeDevBuy, i.params],
    blockNumber: i.blockNumber,
  });
  return { terms, resolvedHash, padTerms };
}
