import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  type AbiParameter,
  type Address,
  type ContractFunctionReturnType,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import { bankrLaunchpadRegistryAbi } from "./abis/suite3.js";
import type { LaunchChain } from "./chains/index.js";
import {
  BANKR_FEE_BPS,
  BANKR_MIN_PIPS,
  DEFAULT_TOTAL_SUPPLY,
  MIN_BUYBACK_ROUND_TRIP_PIPS,
  NO_VEST_TO_HOLDERS,
  holdersBpsToHolderShare,
  type FeeSchedule,
  type LaunchEconomics,
} from "./economics.js";
import { LaunchRefusedError, type CodeOfKind } from "./errors.js";
import type { ReadClient } from "./providers/types.js";

// A launchpad as the registry holds it (registry v2), vendored from core's bankr-v4 launchpad.ts and economics.ts:
// its bounds, policy, vanity, signer and payees, the launch defaults it implies, and the checks its recordLaunch
// runs, refused here with readable details.

/** Bankr's own pad: always signed by Bankr, pinned at 80 % falling to its steady rate over 14 s, vanity `…ba3`. */
export const BANKR_LAUNCHPAD_ID = 0n;
export const BANKR_PAD_START_PIPS = 800_000;
export const BANKR_PAD_DECAY_SECS = 14;
export const BANKR_PAD_VANITY = Object.freeze({ suffix: 0xba3, nibbles: 3 });
/** The treasury as a pad payee: a marker the ledger cuts into Bankr's own bucket, never an account. */
export const PAD_TREASURY_MARKER: Address =
  "0x32bf48defd4071cfd8c51aa815999b0e433e3b01";

/** `registry.getLaunchpad(id)`. */
export type Launchpad = ContractFunctionReturnType<
  typeof bankrLaunchpadRegistryAbi,
  "view",
  "getLaunchpad"
>;

/** A pad's fee bounds, one set for buy and sell: steady and start fees in pips, decay in seconds, referrer in bps. */
export type LaunchpadFeeBounds = Launchpad["feeBounds"];

/** A pad's policy: what its launches may choose (bps of the creator side, of supply for vesting) and the SDK's defaults. */
export type LaunchpadPolicy = Launchpad["policy"];

/** `registry.payeesOf(id)`: 1–4 payees, their WAD shares of the remainder, and the decay split. */
export type PadTerms = ContractFunctionReturnType<
  typeof bankrLaunchpadRegistryAbi,
  "view",
  "payeesOf"
>;

const payeesFn = bankrLaunchpadRegistryAbi.find(
  (e) => e.type === "function" && e.name === "payeesOf",
);
/** The `PadTerms` tuple, as `abi.encode(terms)` lays it out. */
const PAD_TERMS_PARAM = (
  payeesFn?.type === "function" ? payeesFn.outputs[0] : undefined
) as AbiParameter;

/** keccak256(abi.encode(terms)): a launch's `operatorPayeesHash`, pinning these exact terms. */
export function padTermsHash(terms: PadTerms): Hex {
  return keccak256(encodeAbiParameters([PAD_TERMS_PARAM], [terms]));
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The `maxOperatorShareBps` the pad's terms need (the registry compares Σ <= bps·1e14, steady and decay). */
export function maxOperatorShareBps(
  terms: Pick<PadTerms, "steadySharesWad" | "decay">,
): number {
  const sum = (xs: readonly bigint[]) => xs.reduce((a, x) => a + x, 0n);
  const most = [sum(terms.steadySharesWad), sum(terms.decay.sharesWad)].reduce(
    (a, x) => (x > a ? x : a),
    0n,
  );
  return Number(ceilDiv(most, 10n ** 14n));
}

/** A pad read live: its configuration, payees and branding, and the terms a launch pins. */
export interface PadState {
  id: bigint;
  pad: Launchpad;
  terms: PadTerms;
  termsHash: Hex;
  maxOperatorShareBps: number;
  metadataUri: string;
}

/** `UNKNOWN_LAUNCHPAD` for an id the registry never registered: its views answer zeroes past the count, not a revert. */
export async function requireRegisteredPad(
  client: ReadClient,
  registry: Address,
  id: bigint,
  chain?: LaunchChain,
): Promise<void> {
  const count = await readContract(client, {
    address: registry,
    abi: bankrLaunchpadRegistryAbi,
    functionName: "launchpadCount",
  });
  // Ids run 1..count, plus Bankr's 0.
  if (id < 0n || id > count) {
    throw new LaunchRefusedError("UNKNOWN_LAUNCHPAD", { chain });
  }
}

/** The pad `id` from the registry; `UNKNOWN_LAUNCHPAD` for an id it never registered. */
export async function readPad(
  client: ReadClient,
  registry: Address,
  id: bigint,
  chain?: LaunchChain,
): Promise<PadState> {
  const r = { address: registry, abi: bankrLaunchpadRegistryAbi } as const;
  await requireRegisteredPad(client, registry, id, chain);
  const [pad, terms, metadataUri] = await Promise.all([
    readContract(client, { ...r, functionName: "getLaunchpad", args: [id] }),
    readContract(client, { ...r, functionName: "payeesOf", args: [id] }),
    readContract(client, { ...r, functionName: "metadataUriOf", args: [id] }),
  ]);
  return {
    id,
    pad,
    terms,
    termsHash: padTermsHash(terms),
    maxOperatorShareBps: maxOperatorShareBps(terms),
    metadataUri,
  };
}

/** The pad's signer, or null for an open pad (no authorization needed). */
export const padSigner = (p: Pick<PadState, "pad">): Address | null =>
  BigInt(p.pad.signer) === 0n ? null : getAddress(p.pad.signer);

/** The pad's default schedule both ways: id 0's pinned 14 s decay to its steady rate, else flat at the lowest rate. */
export function padSchedule(
  id: bigint,
  b: Pick<Launchpad["feeBounds"], "minSteadyPips">,
): FeeSchedule {
  return id === BANKR_LAUNCHPAD_ID
    ? {
        startPips: BANKR_PAD_START_PIPS,
        steadyPips: b.minSteadyPips,
        decaySecs: BANKR_PAD_DECAY_SECS,
      }
    : { startPips: b.minSteadyPips, steadyPips: b.minSteadyPips, decaySecs: 0 };
}

/** What a launch picks on top of its pad, in contract units; omitted = the pad's default. */
export interface EconomicsChoice {
  schedule?: { buy: FeeSchedule; sell: FeeSchedule };
  holdersBps?: number;
  autoLpBps?: number;
  buybackBps?: number;
  referrerBps?: number;
  vestToHolders?: { bps: number; cliffSecs: number; durationSecs: number };
}

/** Q11: Bankr's pad fixes auto-LP at its policy's stored value; the registry refuses any other (BankrPadAutoLpFixed). */
function fixedAutoLpDetail(fixedBps: number): string {
  return `Bankr's launchpad fixes auto-liquidity at ${fixedBps / 100}% of the creator side.`;
}

/**
 * A launch's economics on `p`: Bankr's pad pins its schedule and its auto-LP (Q11: an explicit other value is
 * refused) and defaults the creator's holder share to 0; any other pad's defaults are its policy hints.
 */
export function padEconomics(
  p: Pick<PadState, "id" | "pad">,
  choice: EconomicsChoice = {},
  chain?: LaunchChain,
): LaunchEconomics {
  const { policy } = p.pad;
  const bankrPad = p.id === BANKR_LAUNCHPAD_ID;
  if (
    bankrPad &&
    choice.autoLpBps !== undefined &&
    choice.autoLpBps !== policy.defaultAutoLpBps
  ) {
    throw new LaunchRefusedError("SPLIT_OUT_OF_BOUNDS", {
      chain,
      detail: fixedAutoLpDetail(policy.defaultAutoLpBps),
    });
  }
  const pinned = padSchedule(p.id, p.pad.feeBounds);
  const v = choice.vestToHolders;
  return {
    buy: choice.schedule?.buy ?? pinned,
    sell: choice.schedule?.sell ?? pinned,
    referrerBps: choice.referrerBps ?? 0,
    holdersBps: choice.holdersBps ?? (bankrPad ? 0 : policy.defaultHoldersBps),
    autoLpBps: bankrPad
      ? policy.defaultAutoLpBps
      : (choice.autoLpBps ??
        Math.max(policy.defaultAutoLpBps, policy.minAutoLpBps)),
    buybackBps: choice.buybackBps ?? 0,
    ...(v && v.bps > 0
      ? {
          vestToHoldersBps: v.bps,
          vestToHoldersCliff: BigInt(v.cliffSecs),
          vestToHoldersDuration: BigInt(v.durationSecs),
        }
      : NO_VEST_TO_HOLDERS),
  };
}

/** LaunchRegistry's builder-lane test: allocations, cap exclusions (any chain with settlers), a dev buy or a custom supply. */
export function usesBuilderLane(i: {
  extraAllocations: number;
  capExclusions: number;
  devBuy: bigint;
  totalSupply: bigint;
}): boolean {
  return (
    i.extraAllocations > 0 ||
    i.capExclusions > 0 ||
    i.devBuy > 0n ||
    (i.totalSupply !== 0n && i.totalSupply !== DEFAULT_TOTAL_SUPPLY)
  );
}

/** The registry's recordLaunch checks that need nothing beyond the pad, refused with a readable detail. */
export function checkPadTerms(
  p: Pick<PadState, "id" | "pad" | "terms">,
  i: {
    economics: LaunchEconomics;
    vestBps: number;
    usesBuilderLane: boolean;
    chain?: LaunchChain;
  },
): void {
  const refuse = (code: CodeOfKind<"refused">, detail?: string): never => {
    throw new LaunchRefusedError(code, { chain: i.chain, detail });
  };
  const { pad } = p;
  if (pad.paused) refuse("LAUNCHPAD_PAUSED");
  const b = pad.feeBounds;
  for (const s of [i.economics.buy, i.economics.sell]) {
    const outside =
      s.steadyPips < b.minSteadyPips ||
      s.steadyPips > b.maxSteadyPips ||
      s.startPips > b.maxStartPips ||
      s.decaySecs > b.maxDecaySecs ||
      (p.id === BANKR_LAUNCHPAD_ID &&
        (s.startPips !== BANKR_PAD_START_PIPS ||
          s.decaySecs !== BANKR_PAD_DECAY_SECS));
    if (outside) {
      refuse(
        "FEE_OUT_OF_BOUNDS",
        `This launchpad's fee settles between ${b.minSteadyPips / 10_000}% and ${b.maxSteadyPips / 10_000}%, starts at most ${b.maxStartPips / 10_000}% and decays over at most ${b.maxDecaySecs} seconds.`,
      );
    }
  }
  if (i.economics.referrerBps > b.maxReferrerBps) {
    refuse(
      "SPLIT_OUT_OF_BOUNDS",
      `The referrer share can be at most ${b.maxReferrerBps / 100}% of the fee on this launchpad.`,
    );
  }
  const pol = pad.policy;
  if (
    i.economics.holdersBps < pol.minHoldersBps ||
    i.economics.holdersBps > pol.maxHoldersBps
  ) {
    refuse(
      "SPLIT_OUT_OF_BOUNDS",
      `Fees to holders must be ${pol.minHoldersBps / 100}–${pol.maxHoldersBps / 100}% of the creator side on this launchpad.`,
    );
  }
  if (i.economics.autoLpBps < pol.minAutoLpBps) {
    refuse(
      "SPLIT_OUT_OF_BOUNDS",
      `Auto-liquidity must be at least ${pol.minAutoLpBps / 100}% of the creator side on this launchpad.`,
    );
  }
  if (
    p.id === BANKR_LAUNCHPAD_ID &&
    i.economics.autoLpBps !== pol.defaultAutoLpBps
  ) {
    refuse("SPLIT_OUT_OF_BOUNDS", fixedAutoLpDetail(pol.defaultAutoLpBps));
  }
  if (i.vestBps < pol.minVestBps || i.vestBps > pol.maxVestBps) {
    refuse(
      "VESTING_OUT_OF_BOUNDS",
      `Vesting must be ${pol.minVestBps / 100}–${pol.maxVestBps / 100}% of supply on this launchpad.`,
    );
  }
  if (i.usesBuilderLane && !pol.allowBuilderLane)
    refuse("BUILDER_LANE_NOT_ALLOWED");
  const e = i.economics;
  if (e.vestToHoldersBps > pol.maxVestToHoldersBps) {
    refuse(
      "VESTING_OUT_OF_BOUNDS",
      pol.maxVestToHoldersBps === 0
        ? "This launchpad does not allow a holders' vest."
        : `A holders' vest can be at most ${pol.maxVestToHoldersBps / 100}% of supply on this launchpad.`,
    );
  }
  if (
    e.vestToHoldersBps > 0 &&
    e.vestToHoldersDuration < pol.minVestToHoldersSecs
  ) {
    refuse(
      "VESTING_OUT_OF_BOUNDS",
      `A holders' vest must run at least ${spell(pol.minVestToHoldersSecs)} on this launchpad.`,
    );
  }
  if (e.buybackBps > pol.maxBuybackBps) {
    refuse(
      "SPLIT_OUT_OF_BOUNDS",
      pol.maxBuybackBps === 0
        ? "This launchpad does not allow a buyback share."
        : `A buyback share can be at most ${pol.maxBuybackBps / 100}% of the creator side on this launchpad.`,
    );
  }
  if (e.buybackBps > 0) {
    const min = minBuybackRoundTripPips(p.terms, e.referrerBps);
    if (e.buy.steadyPips + e.sell.steadyPips < min) {
      refuse(
        "FEE_OUT_OF_BOUNDS",
        `A buyback share needs buy and sell fees that add up to at least ${Number((min / 10_000).toFixed(2))}% on this launchpad (1% after its payees and the referrer).`,
      );
    }
  }
}

/**
 * The registry's buyback round-trip rule: buy + sell steady, times what neither the pad's payees nor the referrer
 * take back (1 − Σ steady shares − referrerBps), must reach 1 %. The least passing round trip, in pips.
 */
export function minBuybackRoundTripPips(
  terms: Pick<PadTerms, "steadySharesWad">,
  referrerBps: number,
): number {
  const WAD = 10n ** 18n;
  const kept =
    terms.steadySharesWad.reduce((k, x) => k - x, WAD) -
    BigInt(referrerBps) * 10n ** 14n;
  if (kept <= 0n) return Number.POSITIVE_INFINITY;
  const need = BigInt(MIN_BUYBACK_ROUND_TRIP_PIPS) * WAD;
  return Number((need + kept - 1n) / kept);
}

/** A pad's minimum duration in words: whole days, else whole hours (rounded up), else seconds. */
function spell(secs: bigint): string {
  const n = (v: bigint, unit: string) => `${v} ${unit}${v === 1n ? "" : "s"}`;
  if (secs % 86_400n === 0n) return n(secs / 86_400n, "day");
  if (secs >= 3_600n) return n((secs + 3_599n) / 3_600n, "hour");
  return n(secs, "second");
}

/** Who takes what of the volume once the fee has decayed, in pips (fractions kept). */
export interface VolumeSplit {
  feePips: number;
  /** Bankr's own half of its slice plus the treasury's payee share on its pad. */
  bankrPips: number;
  /** The coin's holders' half of Bankr's slice, paid in BNKR (or the quote where BNKR is not listed). */
  holdersBnkrPips: number;
  referrerPips: number;
  /** Every other pad payee (the BNKR flywheel on Bankr's 1.75 % pad), in EIP-55 like the client's other addresses. */
  payees: { address: Address; pips: number }[];
  /** The creator side: the creator's holder share, auto-LP, buyback and the creator itself. */
  creatorHoldersPips: number;
  autoLpPips: number;
  buybackPips: number;
  creatorPips: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The steady-state legs of one launch on a pad (core's `bankrV4VolumeSplit`). */
export function volumeSplit(i: {
  steadyPips: number;
  terms: Pick<PadTerms, "payees" | "steadySharesWad">;
  economics: Pick<
    LaunchEconomics,
    "referrerBps" | "holdersBps" | "autoLpBps" | "buybackBps"
  >;
  waived?: boolean;
  /** A suite 4 coin's own Bankr terms (`CoinTerms`); omitted, the figures suite 3 compiled in. */
  bankrTerms?: {
    bankrFeeBps: number;
    bankrMinPips: number;
    holdersShareBps: number;
  };
}): VolumeSplit {
  const f = i.steadyPips;
  const t = i.bankrTerms ?? {
    bankrFeeBps: BANKR_FEE_BPS,
    bankrMinPips: BANKR_MIN_PIPS,
    holdersShareBps: 5_000,
  };
  const b = Math.max((f * t.bankrFeeBps) / 10_000, t.bankrMinPips);
  const holders = (b * t.holdersShareBps) / 10_000;
  let bankr = i.waived ? 0 : b - holders;
  const referrer = (f * i.economics.referrerBps) / 10_000;
  const m = f - holders - bankr - referrer;
  let opTotal = 0;
  const payees: { address: Address; pips: number }[] = [];
  i.terms.payees.forEach((address, n) => {
    const share = Number(i.terms.steadySharesWad[n] ?? 0n) / 1e18;
    opTotal += share;
    if (address.toLowerCase() === PAD_TREASURY_MARKER) {
      bankr += m * share;
    } else {
      // Core lowercases (its rows key on it); the SDK hands addresses out checksummed.
      payees.push({ address: getAddress(address), pips: round2(m * share) });
    }
  });
  const c = m * (1 - opTotal);
  const creatorHolders = (c * i.economics.holdersBps) / 10_000;
  const autoLp = (c * i.economics.autoLpBps) / 10_000;
  const buyback = (c * i.economics.buybackBps) / 10_000;
  return {
    feePips: f,
    bankrPips: round2(bankr),
    holdersBnkrPips: round2(holders),
    referrerPips: round2(referrer),
    payees,
    creatorHoldersPips: round2(creatorHolders),
    autoLpPips: round2(autoLp),
    buybackPips: round2(buyback),
    creatorPips: round2(c - creatorHolders - autoLp - buyback),
  };
}

/** A pad as `client.launchpad(id)` reports it: terms, bounds, policy, vanity, signer and the defaults it implies. */
export interface LaunchpadInfo {
  id: bigint;
  operator: Address;
  /** null: an open pad, launched unsigned. Id 0's is Bankr's signer. */
  signer: Address | null;
  paused: boolean;
  /** The registry owner's off-chain badge; no on-chain effect. */
  verified: boolean;
  /** 0 = every quote the factory allows. */
  allowedQuoteCount: number;
  /** The suffix every token address on this pad ends in; null for none. */
  vanity: { suffix: number; nibbles: number } | null;
  feeBounds: LaunchpadFeeBounds;
  policy: LaunchpadPolicy;
  terms: PadTerms;
  /** What a launch pins: `operatorPayeesHash` and `maxOperatorShareBps`. */
  termsHash: Hex;
  maxOperatorShareBps: number;
  metadataUri: string;
  /** A launch's economics when it sets none, and the matching public `holderShareBps`. */
  defaults: {
    economics: LaunchEconomics;
    holderShareBps: number;
    vestBps: number;
  };
  /** The steady-state legs at those defaults, in pips of volume. */
  volumeSplit: VolumeSplit;
}

export function launchpadInfo(p: PadState): LaunchpadInfo {
  const economics = padEconomics(p);
  const { vanity } = p.pad;
  return {
    id: p.id,
    operator: getAddress(p.pad.operator),
    signer: padSigner(p),
    paused: p.pad.paused,
    verified: p.pad.verified,
    allowedQuoteCount: p.pad.allowedQuoteCount,
    vanity:
      vanity.nibbles > 0
        ? { suffix: vanity.suffix, nibbles: vanity.nibbles }
        : null,
    feeBounds: p.pad.feeBounds,
    policy: p.pad.policy,
    terms: p.terms,
    termsHash: p.termsHash,
    maxOperatorShareBps: p.maxOperatorShareBps,
    metadataUri: p.metadataUri,
    defaults: {
      economics,
      holderShareBps: holdersBpsToHolderShare(
        economics.holdersBps,
        economics.autoLpBps,
        economics.buybackBps,
      ),
      vestBps: p.pad.policy.defaultVestBps,
    },
    volumeSplit: volumeSplit({
      steadyPips: economics.buy.steadyPips,
      terms: p.terms,
      economics,
    }),
  };
}
