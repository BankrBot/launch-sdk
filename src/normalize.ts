import {
  getAddress,
  isAddressEqual,
  stringToBytes,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import type { ChainCapabilities, LaunchChain } from "./chains/index.js";
import { normalizeCurve, type NormalizedCurve } from "./curveInput.js";
import {
  MAX_FEE_RECIPIENTS,
  MAX_METADATA_URI_BYTES,
  MAX_START_DELAY_SECS,
  MAX_VEST_BPS,
  holderShareToHoldersBps,
  type FeeRecipient,
  type FeeSchedule,
  type LaunchEconomics,
  type LaunchParams,
} from "./economics.js";
import { LaunchRefusedError, type CodeOfKind } from "./errors.js";
import { normalizeExtension, type NormalizedExtension } from "./extension.js";
import { padEconomics, type PadState } from "./launchpad.js";
import type { LaunchInput } from "./providers/types.js";
import { resolveQuote, type QuoteRef } from "./quotes.js";
import {
  SUITE4_ONLY_FIELDS,
  normalizeSuite4Choices,
  type Suite4Choices,
} from "./suite4/input.js";
import { requireAddress } from "./recipient.js";
import {
  EMPTY_AUTHORIZATION,
  EMPTY_PRICE_ATTESTATION,
  NO_EXTENSION,
} from "./terms.js";

const NAME_MAX = 100;
const SYMBOL_MAX = 20;
const BPS = 10_000;
const DEFAULT_SLIPPAGE_BPS = 200;
export const DEFAULT_DEADLINE_SECONDS = 1_200;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Public contracts that call anything for anyone: as launcher, their dev-buy output and default fees would be
 * sweepable by the next caller; as a claim operator, they let anyone claim for the account. Multicall3, Multicall2
 * and Multicall, at their canonical addresses.
 */
export const PUBLIC_FORWARDERS: readonly Address[] = [
  "0xcA11bde05977b3631167028862bE2a173976CA11",
  "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696",
  "0xeefBa1e63905eF1D7ACbA5a8513c70307C1cE441",
];

/** A launch input with its static refusals passed; economic fields stay undefined where the pad's default applies. */
export interface NormalizedLaunch<C extends LaunchChain = LaunchChain> {
  chain: C;
  name: string;
  symbol: string;
  metadataUri: string;
  /** The zero address: nobody may replace the metadata URI. */
  metadataAdmin: Address;
  launcher: Address;
  launchpadId: bigint;
  quote: QuoteRef;
  /** Resolved and in the input's order: the launcher alone when none is named; the first is the primary. */
  feeRecipients: readonly FeeRecipient[];
  allowContractFeeRecipient: boolean;
  allowOpenCodeFeeRecipients: boolean;
  /** Unix seconds public trading opens at; 0 = at launch. Held to the clock and the pad by {@link checkStartTime}. */
  startTime: number;
  schedule: { buy: FeeSchedule; sell: FeeSchedule } | undefined;
  referrerBps: number | undefined;
  holderShareBps: number | undefined;
  autoLpBps: number | undefined;
  buybackBps: number | undefined;
  vestBps: number | undefined;
  vestingRecipient: Address;
  allowContractVestingRecipient: boolean;
  vestToHolders:
    { bps: number; cliffSecs: number; durationSecs: number } | undefined;
  devBuyAmount: bigint;
  slippageBps: number;
  /** The start FDV in the quote's base units (required for a quote the factory does not list). */
  startFdv: bigint | undefined;
  /** The launch's curve: the default (id 0) when the input names none. */
  curve: NormalizedCurve;
  /** The launch's extension, its parameters held to their bounds; null when the input names none. */
  extension: NormalizedExtension | null;
  salt: Hex | undefined;
  deadlineSeconds: number;
  /** A suite 4 launch's own choices; null on suite 3, which can carry none of them. */
  suite4: Suite4Choices | null;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** LaunchEconomics.checkFeeRecipients' rules that need no chain state, in its order; one `feeRecipient` (or none: the
 *  launcher) is a one-entry list. The list keeps its order: the terms hash covers it and the first is the primary. */
function normalizeFeeRecipients(
  input: Pick<LaunchInput, "feeRecipient" | "feeRecipients">,
  launcher: Address,
  address: (v: unknown, what: string) => Address,
  invalid: (detail: string) => never,
  most: number = MAX_FEE_RECIPIENTS,
): FeeRecipient[] {
  const raw: unknown = input.feeRecipients;
  if (raw === undefined) {
    const one =
      input.feeRecipient === undefined
        ? launcher
        : address(input.feeRecipient, "feeRecipient");
    return [{ recipient: one, shareBps: BPS }];
  }
  if (input.feeRecipient !== undefined)
    invalid("Set feeRecipient or feeRecipients, not both.");
  if (!Array.isArray(raw) || raw.length === 0)
    invalid("Name at least one fee recipient.");
  const list = raw as readonly unknown[];
  if (list.length > most)
    invalid(`A launch can name at most ${most} fee recipients.`);
  const out: FeeRecipient[] = [];
  list.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null)
      invalid("Each fee recipient is { recipient, shareBps }.");
    const r = entry as { recipient?: unknown; shareBps?: unknown };
    const recipient = address(r.recipient, `feeRecipients[${i}].recipient`);
    if (!isInt(r.shareBps, 1, BPS))
      invalid(
        "Each fee recipient needs a share above 0%: shareBps is whole bps of the creator's own take.",
      );
    if (out.some((o) => o.recipient === recipient))
      invalid("Each fee recipient can be listed once.");
    out.push({ recipient, shareBps: r.shareBps as number });
  });
  if (out.reduce((sum, r) => sum + r.shareBps, 0) !== BPS)
    invalid("Fee recipient shares must add up to 100%.");
  return out;
}

/** 86,400 → "1 day"; whole days, else whole hours, else seconds. */
function spell(secs: number): string {
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"}`;
  if (secs % 86_400 === 0) return n(secs / 86_400, "day");
  return secs % 3_600 === 0 ? n(secs / 3_600, "hour") : n(secs, "second");
}

/**
 * A scheduled start against the clock and the pad: LaunchEconomics.checkStartTick (`StartPassed`, `StartTooFar`) and
 * the registry's `StartDelayAboveLaunchpadMax`. `maxStartDelaySecs` is the pad's `policy.maxStartDelay` (0 = no
 * scheduled start there); omitted, the protocol's 7 days alone. The chain's own block is never before `nowSeconds`.
 */
export function checkStartTime(i: {
  startTime: number;
  nowSeconds: number;
  maxStartDelaySecs?: number;
  chain?: LaunchChain;
}): void {
  const refuse = (detail: string): never => {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain: i.chain, detail });
  };
  if (i.startTime === 0) return;
  if (!Number.isSafeInteger(i.startTime) || i.startTime <= i.nowSeconds)
    refuse("The trading start must be in the future.");
  const padMax = i.maxStartDelaySecs ?? MAX_START_DELAY_SECS;
  if (padMax === 0)
    refuse("This launchpad does not allow a scheduled trading start.");
  const max = Math.min(padMax, MAX_START_DELAY_SECS);
  if (i.startTime > i.nowSeconds + max)
    refuse(
      `Trading can start at most ${spell(max)} after the launch${padMax < MAX_START_DELAY_SECS ? " on this launchpad" : ""}.`,
    );
}

/**
 * Applies the refusals that need no chain state: name and symbol, metadata and its admin, launcher, pad id, quote,
 * recipients' shape and split, fee and split fields' shape, vesting, dev-buy amount, the start time's shape, the
 * curve's form, the extension's form and bounds, salt and deadline. `metadata` is refused unless `allowMetadata` (API
 * mode, where Bankr pins it).
 */
export function normalizeLaunchInput<C extends LaunchChain>(
  caps: ChainCapabilities<C>,
  input: LaunchInput<C>,
  usedSalts: ReadonlySet<string>,
  options: { allowMetadata?: boolean; suite?: 3 | 4 } = {},
): NormalizedLaunch<C> {
  const chain = caps.chain;
  // Suite 3 compiles its bounds in, and they are held here; a suite 4 launch's are its pad's, held by `resolve`.
  const suite4 = options.suite === 4;
  const refuse = (code: CodeOfKind<"refused">, detail?: string): never => {
    throw new LaunchRefusedError(code, { chain, detail });
  };
  const invalid = (detail: string): never => refuse("INVALID_PARAMS", detail);
  const address = (v: unknown, what: string): Address =>
    requireAddress(v, chain, what);
  const bps = (v: unknown, what: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!isInt(v, 0, BPS))
      invalid(`${what} must be an integer number of bps from 0 to 10,000.`);
    return v as number;
  };

  if (!suite4) {
    const named = [
      ...SUITE4_ONLY_FIELDS.filter((k) => input[k] !== undefined),
      ...(input.vesting?.cliffSeconds !== undefined ||
      input.vesting?.durationSeconds !== undefined
        ? ["vesting.cliffSeconds and vesting.durationSeconds"]
        : []),
    ];
    if (named.length > 0)
      invalid(
        `${named.join(", ")}: this chain's suite takes no such option. It is a term of the configurable suite (suite 4), which this client is not on.`,
      );
  }
  if (typeof input.name !== "string" || !isInt(input.name.length, 1, NAME_MAX))
    invalid("The name must be 1–100 characters.");
  if (
    typeof input.symbol !== "string" ||
    !isInt(input.symbol.length, 1, SYMBOL_MAX)
  )
    invalid("The symbol must be 1–20 characters.");
  if (input.metadata !== undefined && !options.allowMetadata)
    invalid(
      "Pinning metadata needs Bankr's API: pass a ready metadataUri in pure mode.",
    );
  const metadataUri = input.metadataUri ?? "";
  if (typeof metadataUri !== "string") invalid("metadataUri must be a string.");
  // The token's deployer counts bytes, not characters (MetadataTooLong).
  if (!suite4 && stringToBytes(metadataUri).length > MAX_METADATA_URI_BYTES)
    invalid(
      `The metadata link can be at most ${MAX_METADATA_URI_BYTES.toLocaleString("en-US")} bytes.`,
    );
  const metadataAdmin =
    input.metadataAdmin === undefined
      ? zeroAddress
      : requireAddress(input.metadataAdmin, chain, "metadataAdmin", true);

  const launcher = address(input.launcher, "launcher");
  if (PUBLIC_FORWARDERS.some((f) => isAddressEqual(f, launcher)))
    refuse("LAUNCHER_IS_FORWARDER");
  const launchpadId = input.launchpadId ?? 0n;
  if (
    typeof launchpadId !== "bigint" ||
    launchpadId < 0n ||
    launchpadId > UINT64_MAX
  )
    invalid("launchpadId must be a uint64 bigint.");
  const quote = resolveQuote(caps, input.quote);
  const feeRecipients = normalizeFeeRecipients(
    input,
    launcher,
    address,
    invalid,
    // The ledger's own ceiling for one bucket; a pad's limit is its feeRecipients knob.
    suite4 ? 255 : MAX_FEE_RECIPIENTS,
  );

  if (input.fees !== undefined && input.schedule !== undefined)
    invalid("Set fees or schedule, not both.");
  const schedule =
    input.fees ??
    (input.schedule === undefined
      ? undefined
      : { buy: input.schedule, sell: input.schedule });
  if (schedule) {
    for (const s of [schedule.buy, schedule.sell]) {
      if (
        typeof s !== "object" ||
        s === null ||
        !isInt(s.startPips, 0, 1_000_000) ||
        !isInt(s.steadyPips, 0, 1_000_000) ||
        !isInt(s.decaySecs, 0, suite4 ? 0xffff_ffff : 65_535)
      )
        invalid(
          "A fee schedule is { startPips, steadyPips, decaySecs }, each a non-negative integer.",
        );
    }
  }

  const vestBps = bps(input.vesting?.bps, "vesting.bps");
  const vestingRecipient =
    input.vesting?.recipient === undefined
      ? launcher
      : address(input.vesting.recipient, "vesting.recipient");
  const v = input.vestToHolders;
  if (
    v !== undefined &&
    (!isInt(v.bps, 0, suite4 ? BPS : MAX_VEST_BPS) ||
      !isInt(v.cliffSeconds, 0, Number.MAX_SAFE_INTEGER) ||
      !isInt(v.durationSeconds, 0, Number.MAX_SAFE_INTEGER))
  )
    invalid(
      "vestToHolders is { bps, cliffSeconds, durationSeconds }, each a non-negative integer.",
    );

  const devBuyAmount = input.devBuy?.amount ?? 0n;
  const slippageBps = input.devBuy?.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (typeof devBuyAmount !== "bigint" || devBuyAmount < 0n)
    invalid(
      "devBuy.amount must be a non-negative bigint in the quote's base units.",
    );
  if (!isInt(slippageBps, 0, BPS - 1))
    invalid("devBuy.slippageBps must be 0–9,999.");

  const startFdv = input.startFdv;
  if (
    startFdv !== undefined &&
    (typeof startFdv !== "bigint" || startFdv <= 0n)
  )
    invalid("startFdv must be a positive bigint in the quote's base units.");
  const curve = normalizeCurve(input.curve, invalid);
  const extension =
    input.extension === undefined
      ? null
      : normalizeExtension(input.extension, chain, suite4 ? 4 : 3);
  // LaunchRegistry._feeRecipients (ExtensionPayeeUnnamed): with several recipients none stands in for the payee.
  if (
    extension &&
    feeRecipients.length > 1 &&
    BigInt(extension.params.payee) === 0n
  )
    invalid(
      "Name the extension's payee when a launch has several fee recipients.",
    );

  const start: unknown = input.startTime ?? 0;
  const startTime =
    start instanceof Date ? Math.floor(start.getTime() / 1000) : start;
  if (
    !isInt(startTime, 0, Number.MAX_SAFE_INTEGER) ||
    (start instanceof Date && startTime === 0)
  )
    invalid(
      "startTime is a Date or whole unix seconds; omit it to trade at launch.",
    );
  // The start is a uint64 on-chain; past 32 bits it is a millisecond timestamp passed as seconds.
  if ((startTime as number) > 0xffff_ffff)
    invalid("startTime is unix seconds, not milliseconds.");

  const salt = input.salt?.toLowerCase() as Hex | undefined;
  if (salt !== undefined && (!BYTES32.test(salt) || usedSalts.has(salt)))
    invalid("salt must be an unused bytes32.");
  const deadlineSeconds = input.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
  if (!isInt(deadlineSeconds, 1, Number.MAX_SAFE_INTEGER))
    invalid("deadlineSeconds must be a positive integer.");
  const choices = suite4
    ? normalizeSuite4Choices(input, address, invalid)
    : null;

  return {
    chain,
    name: input.name,
    symbol: input.symbol,
    metadataUri,
    metadataAdmin,
    launcher,
    launchpadId,
    quote,
    feeRecipients,
    allowContractFeeRecipient: input.allowContractFeeRecipient === true,
    allowOpenCodeFeeRecipients: input.allowOpenCodeFeeRecipients === true,
    startTime: startTime as number,
    schedule,
    referrerBps: bps(input.referrerBps, "referrerBps"),
    holderShareBps: bps(input.holderShareBps, "holderShareBps"),
    autoLpBps: choices ? choices.autoLpBps : bps(input.autoLpBps, "autoLpBps"),
    buybackBps: choices
      ? choices.buybackBps
      : bps(input.buybackBps, "buybackBps"),
    vestBps,
    vestingRecipient,
    allowContractVestingRecipient:
      input.vesting?.allowContractRecipient === true,
    vestToHolders:
      v === undefined || v.bps === 0
        ? undefined
        : {
            bps: v.bps,
            cliffSecs: v.cliffSeconds,
            durationSecs: v.durationSeconds,
          },
    devBuyAmount,
    slippageBps,
    startFdv,
    curve,
    extension,
    salt,
    deadlineSeconds,
    suite4: choices,
  };
}

/**
 * The launch's economics on its pad: each field the input set, the pad's default otherwise. `holderShareBps` is
 * converted to the contract's creator-side `holdersBps`; omitted, the pad's default `holdersBps` stands. A quote the
 * factory does not list takes no auto-LP (the factory's `UnlistedQuoteAutoLp`): nothing compounds it.
 */
export function resolveEconomics(
  n: NormalizedLaunch,
  pad: Pick<PadState, "id" | "pad" | "terms">,
  listed = true,
): LaunchEconomics {
  const defaults = padEconomics(pad);
  if (!listed) {
    const why =
      (n.autoLpBps ?? 0) > 0
        ? "takes no auto-liquidity: set autoLpBps to 0"
        : pad.pad.policy.minAutoLpBps > 0
          ? "takes no auto-liquidity, and this launchpad requires some"
          : pad.terms.decay.on && pad.terms.decay.autoLpBps > 0
            ? "takes no auto-liquidity, and this launchpad's decay split has some"
            : null;
    if (why !== null)
      throw new LaunchRefusedError("SPLIT_OUT_OF_BOUNDS", {
        chain: n.chain,
        detail: `A quote the factory does not list ${why}.`,
      });
  }
  const autoLpBps = n.autoLpBps ?? (listed ? defaults.autoLpBps : 0);
  const buybackBps = n.buybackBps ?? defaults.buybackBps;
  if (autoLpBps + buybackBps > BPS) {
    throw new LaunchRefusedError("SPLIT_OUT_OF_BOUNDS", {
      chain: n.chain,
      detail:
        "Auto-liquidity and buyback can total at most 100% of the creator side.",
    });
  }
  return padEconomics(
    pad,
    {
      schedule: n.schedule,
      holdersBps:
        n.holderShareBps === undefined
          ? undefined
          : holderShareToHoldersBps(n.holderShareBps, autoLpBps, buybackBps),
      autoLpBps,
      buybackBps,
      referrerBps: n.referrerBps,
      vestToHolders: n.vestToHolders,
    },
    n.chain,
  );
}

/** What {@link buildLaunchParams} needs beyond the economics: the pieces read from the chain or mined. */
export interface LaunchParamsInput {
  name: string;
  symbol: string;
  metadataUri: string;
  metadataAdmin: Address;
  salt?: Hex;
  quote: Address;
  /** The chain's settlers (BANKR_V4_CAP_EXCLUSIONS). */
  capExclusions: readonly Address[];
  startTick: number;
  deadline: bigint;
  economics: LaunchEconomics;
  launchpadId: bigint;
  maxOperatorShareBps: number;
  operatorPayeesHash: Hex;
  /** In order; empty reads on-chain as the launcher alone. */
  feeRecipients: readonly FeeRecipient[];
  allowOpenCodeFeeRecipients: boolean;
  vestingRecipient: Address;
  vestBps: number;
  allowCodeVestingRecipient: boolean;
  /** An ERC-20 dev buy's amount; a native one rides `msg.value` and is 0 here. */
  devBuyAmountIn: bigint;
  /** Unix seconds; 0 = trade at launch. */
  startTime: number;
  /** The launch's curve, of which the word enters the tuple; omitted, the default curve (id 0). */
  curve?: Pick<NormalizedCurve, "word">;
  /** The launch's extension as the factory takes it; omitted or null, none. */
  extension?: Pick<NormalizedExtension, "params"> | null;
}

/** `factory.launch`'s tuple for an SDK launch: default supply, no allocations, unsigned. */
export function buildLaunchParams(i: LaunchParamsInput): LaunchParams {
  return {
    name: i.name,
    symbol: i.symbol,
    metadataUri: i.metadataUri,
    metadataAdmin: getAddress(i.metadataAdmin),
    salt: i.salt ?? zeroHash,
    quote: getAddress(i.quote),
    totalSupply: 0n,
    expectedStartTick: i.startTick,
    deadline: i.deadline,
    curveId: i.curve?.word ?? 0n,
    econ: i.economics,
    feeRecipients: i.feeRecipients.map((r) => ({
      recipient: getAddress(r.recipient),
      shareBps: r.shareBps,
    })),
    allowOpenCodeFeeRecipients: i.allowOpenCodeFeeRecipients,
    vestingRecipient: getAddress(i.vestingRecipient),
    vestBps: i.vestBps,
    allowCodeVestingRecipient: i.allowCodeVestingRecipient,
    extraAllocations: [],
    capExclusions: i.capExclusions.map((a) => getAddress(a)),
    devBuyAmountIn: i.devBuyAmountIn,
    devBuyMinOut: 0n,
    launchpadId: i.launchpadId,
    maxOperatorShareBps: i.maxOperatorShareBps,
    operatorPayeesHash: i.operatorPayeesHash,
    authorization: { ...EMPTY_AUTHORIZATION },
    priceAttestation: { ...EMPTY_PRICE_ATTESTATION },
    extension: { ...(i.extension?.params ?? NO_EXTENSION) },
    startTime: BigInt(i.startTime),
  };
}
