import {
  isAddress,
  isAddressEqual,
  stringToBytes,
  zeroAddress,
  type Address,
} from "viem";
import type { LaunchChain } from "./chains/index.js";
import {
  MAX_DECAY_SECS,
  MAX_METADATA_URI_BYTES,
  MAX_REFERRER_BPS,
  MAX_START_DELAY_SECS,
  MAX_START_FEE_PIPS,
  MAX_STEADY_FEE_PIPS,
  MAX_VEST_BPS,
  MIN_STEADY_FEE_PIPS,
  VEST_TO_HOLDERS_MAX_DURATION_SECS,
} from "./economics.js";
import { LaunchRefusedError, type CodeOfKind } from "./errors.js";
import {
  BANKR_LAUNCHPAD_ID,
  type LaunchpadFeeBounds,
  type LaunchpadPolicy,
} from "./launchpad.js";
import type { LaunchpadPayeeWithDecay } from "./launchpads.js";
import { requireAddress } from "./recipient.js";
import type { Vanity } from "./salt.js";
import { bpsToPercent, pipsToPercent, shown } from "./units.js";

// BankrLaunchpadRegistry's checks on an operator's call, without the chain: the SDK refuses what the registry would
// revert before anyone signs, as INVALID_LAUNCHPAD_CONFIG with a detail naming the rule.

/** BankrLaunchpadRegistry.MAX_PAYEES. */
export const MAX_PAD_PAYEES = 4;
/** LaunchConstants.MAX_OPERATOR_SHARE_WAD (0.95e18) in bps: the payees' total, steady and decay alike. */
export const MAX_OPERATOR_SHARE_BPS = 9_500;
/** LaunchConstants.EXT_CEILING_PIPS: a pad's `maxExtensionPips` ceiling. */
export const EXT_CEILING_PIPS = 100_000;
const MIN_VANITY_NIBBLES = 4;
const MAX_VANITY_NIBBLES = 6;
const EXTENSION_MASK_ALL = 0x07;
const BPS = 10_000;
const WAD_PER_BPS = 10n ** 14n;

type PolicyField = keyof LaunchpadPolicy;

/** The policy's integer fields and their Solidity widths; `allowBuilderLane` and `minVestToHoldersSecs` aside. */
const POLICY_UINTS: Readonly<
  Record<
    Exclude<PolicyField, "allowBuilderLane" | "minVestToHoldersSecs">,
    number
  >
> = {
  minHoldersBps: 0xffff,
  maxHoldersBps: 0xffff,
  minAutoLpBps: 0xffff,
  minVestBps: 0xffff,
  maxVestBps: 0xffff,
  allowedExtensions: 0xff,
  maxExtensionPips: 0xffffff,
  defaultHoldersBps: 0xffff,
  defaultAutoLpBps: 0xffff,
  defaultVestBps: 0xffff,
  maxVestToHoldersBps: 0xffff,
  maxBuybackBps: 0xffff,
  maxStartDelay: 0xffffffff,
};
const POLICY_FIELDS: readonly PolicyField[] = [
  ...(Object.keys(POLICY_UINTS) as PolicyField[]),
  "allowBuilderLane",
  "minVestToHoldersSecs",
];

const isUint = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0);
const pct = (pips: number) => `${pipsToPercent(pips)} %`;
const bpsPct = (bps: number) => `${bpsToPercent(bps)} %`;

function refuse(
  chain: LaunchChain,
  code: CodeOfKind<"refused">,
  detail: string,
): never {
  throw new LaunchRefusedError(code, { chain, detail });
}

function invalid(chain: LaunchChain, detail: string): never {
  refuse(chain, "INVALID_LAUNCHPAD_CONFIG", detail);
}

/** The low `nibbles` hex digits. */
export const vanityMask = (nibbles: number): number => 16 ** nibbles - 1;

/** A suffix as `0x…`, padded to its nibbles. */
export const vanityHex = (v: Vanity): string =>
  `0x${v.suffix.toString(16).padStart(v.nibbles, "0")}`;

/** `value` as a boolean; `INVALID_PARAMS` otherwise. */
export function requireFlag(
  value: unknown,
  what: string,
  chain: LaunchChain,
): boolean {
  return typeof value === "boolean"
    ? value
    : refuse(chain, "INVALID_PARAMS", `${what} is true or false.`);
}

/**
 * `value` as a payee or new operator. The registry reverts the zero address (`InvalidPayees`, `ZeroAddress`), so that
 * is `INVALID_LAUNCHPAD_CONFIG`; a value that is no address at all is `INVALID_PARAMS`. Both name `what`.
 */
export function requirePadAddress(
  value: unknown,
  what: string,
  chain: LaunchChain,
): Address {
  if (
    typeof value === "string" &&
    isAddress(value, { strict: false }) &&
    isAddressEqual(value, zeroAddress)
  ) {
    invalid(chain, `${what} is the zero address, which the registry refuses.`);
  }
  return requireAddress(value, chain, what);
}

/** A metadata URI within the registry's byte cap. */
export function checkPadMetadataUri(uri: unknown, chain: LaunchChain): string {
  if (typeof uri !== "string") {
    refuse(chain, "INVALID_PARAMS", "A metadata URI is a string.");
  }
  if (stringToBytes(uri).length > MAX_METADATA_URI_BYTES) {
    invalid(
      chain,
      `A launchpad's metadata URI is at most ${MAX_METADATA_URI_BYTES} bytes.`,
    );
  }
  return uri;
}

/** The registry's payee arguments: payees, steady WAD shares and the decay split. */
export interface PadPayeeTerms {
  payees: Address[];
  steadySharesWad: bigint[];
  decay: { on: boolean; autoLpBps: number; sharesWad: bigint[] };
}

/**
 * `_setPayees`: 1–4 distinct non-zero payees, each share list at most 95 % in all, and a canonical decay split (on:
 * one share per payee and auto-LP within 10,000; off: neither). `register` refuses a decay split.
 */
export function padPayeeTerms(
  payees: readonly LaunchpadPayeeWithDecay[],
  decayAutoLpBps: number | undefined,
  decayAllowed: boolean,
  chain: LaunchChain,
): PadPayeeTerms {
  if (
    !Array.isArray(payees) ||
    payees.length === 0 ||
    payees.length > MAX_PAD_PAYEES
  ) {
    invalid(chain, `A launchpad has 1 to ${MAX_PAD_PAYEES} payees.`);
  }
  // The registry's `register` takes no decay split: refused, so a payee's decay share is never dropped unseen.
  if (!decayAllowed && payees.some((p) => p?.decayShareBps !== undefined)) {
    invalid(
      chain,
      "register takes no decay split: turn one on with setPayees after registering.",
    );
  }
  const addresses = payees.map((p, i) =>
    requirePadAddress(p?.address, `Payee ${i + 1}`, chain),
  );
  const distinct = new Set(addresses.map((x) => x.toLowerCase()));
  if (distinct.size !== addresses.length) {
    invalid(chain, "Each payee appears once.");
  }
  const most = `${MAX_OPERATOR_SHARE_BPS} bps (${bpsPct(MAX_OPERATOR_SHARE_BPS)})`;
  const share = (bps: unknown): number =>
    isUint(bps, MAX_OPERATOR_SHARE_BPS)
      ? bps
      : invalid(
          chain,
          `A payee's share is a whole number of bps up to ${most}.`,
        );
  const steady = payees.map((p) => share(p.shareBps));
  const on =
    decayAllowed &&
    (decayAutoLpBps !== undefined ||
      payees.some((p) => p.decayShareBps !== undefined));
  const decay = on ? payees.map((p) => share(p.decayShareBps ?? 0)) : [];
  if (
    sum(steady) > MAX_OPERATOR_SHARE_BPS ||
    sum(decay) > MAX_OPERATOR_SHARE_BPS
  ) {
    invalid(
      chain,
      `The payees' shares add up to at most ${most} of what is left after Bankr's slice and any referrer.`,
    );
  }
  const autoLpBps = on ? (decayAutoLpBps ?? 0) : 0;
  if (!isUint(autoLpBps, BPS)) {
    invalid(
      chain,
      "The decay split's auto-LP share is a whole number of bps from 0 to 10,000.",
    );
  }
  const wad = (bps: number) => BigInt(bps) * WAD_PER_BPS;
  return {
    payees: addresses,
    steadySharesWad: steady.map(wad),
    decay: { on, autoLpBps, sharesWad: decay.map(wad) },
  };
}

/** `_setFeeBounds`: inside the protocol's bounds, `minSteadyPips <= maxSteadyPips` and `<= maxStartPips`. */
export function checkPadFeeBounds(
  b: LaunchpadFeeBounds,
  chain: LaunchChain,
): LaunchpadFeeBounds {
  if (typeof b !== "object" || b === null) {
    refuse(chain, "INVALID_PARAMS", "Fee bounds are a LaunchpadFeeBounds.");
  }
  const {
    minSteadyPips,
    maxSteadyPips,
    maxStartPips,
    maxDecaySecs,
    maxReferrerBps,
  } = b;
  const whole = [
    minSteadyPips,
    maxSteadyPips,
    maxStartPips,
    maxDecaySecs,
    maxReferrerBps,
  ].every((n) => isUint(n, Number.MAX_SAFE_INTEGER));
  const ok =
    whole &&
    minSteadyPips >= MIN_STEADY_FEE_PIPS &&
    minSteadyPips <= maxSteadyPips &&
    maxSteadyPips <= MAX_STEADY_FEE_PIPS &&
    maxStartPips >= minSteadyPips &&
    maxStartPips <= MAX_START_FEE_PIPS &&
    maxDecaySecs <= MAX_DECAY_SECS &&
    maxReferrerBps <= MAX_REFERRER_BPS;
  if (!ok) {
    invalid(
      chain,
      `Fee bounds keep ${pct(MIN_STEADY_FEE_PIPS)} <= minSteadyPips <= maxSteadyPips <= ${pct(MAX_STEADY_FEE_PIPS)}, minSteadyPips <= maxStartPips <= ${pct(MAX_START_FEE_PIPS)}, maxDecaySecs <= ${MAX_DECAY_SECS} and maxReferrerBps <= ${MAX_REFERRER_BPS} (${bpsPct(MAX_REFERRER_BPS)}), all in whole units.`,
    );
  }
  return {
    minSteadyPips,
    maxSteadyPips,
    maxStartPips,
    maxDecaySecs,
    maxReferrerBps,
  };
}

/** `changes` over the live policy, typed field by field, then `setPolicy`'s rules on the whole. */
export function mergePadPolicy(
  live: LaunchpadPolicy,
  changes: Partial<LaunchpadPolicy>,
  chain: LaunchChain,
): LaunchpadPolicy {
  if (typeof changes !== "object" || changes === null) {
    refuse(chain, "INVALID_PARAMS", "Policy changes are a LaunchpadPolicy.");
  }
  const unknown = Object.keys(changes).find(
    (k) => !POLICY_FIELDS.includes(k as PolicyField),
  );
  if (unknown !== undefined) {
    invalid(chain, `"${shown(unknown)}" is not a launchpad policy field.`);
  }
  const p = { ...live };
  for (const [k, max] of Object.entries(POLICY_UINTS) as [
    keyof typeof POLICY_UINTS,
    number,
  ][]) {
    const v = changes[k];
    if (v === undefined) continue;
    p[k] = isUint(v, max)
      ? v
      : invalid(chain, `${k} is a whole number from 0 to ${max}.`);
  }
  if (changes.allowBuilderLane !== undefined) {
    p.allowBuilderLane = requireFlag(
      changes.allowBuilderLane,
      "allowBuilderLane",
      chain,
    );
  }
  // uint64 decodes to a bigint; a whole number of seconds is taken too.
  const secs: unknown = changes.minVestToHoldersSecs;
  if (secs !== undefined) {
    p.minVestToHoldersSecs =
      typeof secs === "bigint" && secs >= 0n
        ? secs
        : isUint(secs, Number.MAX_SAFE_INTEGER)
          ? BigInt(secs)
          : invalid(
              chain,
              "minVestToHoldersSecs is a whole number of seconds.",
            );
  }
  const rules: readonly [boolean, string][] = [
    [
      p.minHoldersBps <= p.defaultHoldersBps &&
        p.defaultHoldersBps <= p.maxHoldersBps &&
        p.maxHoldersBps <= BPS,
      "Holders keep minHoldersBps <= defaultHoldersBps <= maxHoldersBps <= 10,000.",
    ],
    [
      p.minAutoLpBps <= p.defaultAutoLpBps,
      "Auto-LP keeps minAutoLpBps <= defaultAutoLpBps.",
    ],
    [
      p.defaultHoldersBps + p.defaultAutoLpBps <= BPS,
      "defaultHoldersBps and defaultAutoLpBps add up to at most 10,000.",
    ],
    [
      p.minVestBps <= p.defaultVestBps &&
        p.defaultVestBps <= p.maxVestBps &&
        p.maxVestBps <= MAX_VEST_BPS,
      `Vesting keeps minVestBps <= defaultVestBps <= maxVestBps <= ${MAX_VEST_BPS} (${bpsPct(MAX_VEST_BPS)}).`,
    ],
    [
      p.allowedExtensions <= EXTENSION_MASK_ALL,
      "allowedExtensions is a mask of bits 0-2: presets, custom quote-only, custom calls-out.",
    ],
    [
      p.maxExtensionPips <= EXT_CEILING_PIPS,
      `maxExtensionPips is at most ${EXT_CEILING_PIPS} (${pct(EXT_CEILING_PIPS)}).`,
    ],
    [
      p.maxVestToHoldersBps <= MAX_VEST_BPS,
      `maxVestToHoldersBps is at most ${MAX_VEST_BPS} (${bpsPct(MAX_VEST_BPS)}).`,
    ],
    [
      p.minVestToHoldersSecs <= BigInt(VEST_TO_HOLDERS_MAX_DURATION_SECS),
      `minVestToHoldersSecs is at most ${VEST_TO_HOLDERS_MAX_DURATION_SECS} (365 days).`,
    ],
    [p.maxBuybackBps <= BPS, "maxBuybackBps is at most 10,000."],
    [
      p.maxStartDelay <= MAX_START_DELAY_SECS,
      `maxStartDelay is at most ${MAX_START_DELAY_SECS} seconds (7 days); 0 allows no scheduled start.`,
    ],
  ];
  const broken = rules.find(([ok]) => !ok);
  if (broken) invalid(chain, broken[1]);
  return p;
}

/** `setVanity`'s shape: 0 nibbles (none) or 4–6, id 0 aside, and a suffix that fits them. */
export function checkPadVanity(
  id: bigint,
  v: Vanity,
  chain: LaunchChain,
): Vanity {
  if (typeof v !== "object" || v === null) {
    refuse(chain, "INVALID_PARAMS", "A vanity is { suffix, nibbles }.");
  }
  const { suffix, nibbles } = v;
  if (
    !isUint(nibbles, MAX_VANITY_NIBBLES) ||
    !isUint(suffix, vanityMask(nibbles))
  ) {
    invalid(
      chain,
      `A vanity is a suffix of at most ${MAX_VANITY_NIBBLES} hex digits that fits its nibbles (0 nibbles: none).`,
    );
  }
  if (
    id !== BANKR_LAUNCHPAD_ID &&
    nibbles !== 0 &&
    nibbles < MIN_VANITY_NIBBLES
  ) {
    invalid(
      chain,
      `A launchpad's suffix is ${MIN_VANITY_NIBBLES} to ${MAX_VANITY_NIBBLES} hex digits, or none.`,
    );
  }
  return { suffix, nibbles };
}
