import {
  hexToBytes,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { getCode, readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchpadRegistryAbi,
} from "./abis/suite3.js";
import type { ProviderAddresses } from "./addresses.js";
import type { LaunchChain } from "./chains/index.js";
import { MAX_STEADY_FEE_PIPS, type FeeSchedule } from "./economics.js";
import { LaunchRefusedError } from "./errors.js";
import {
  extensionAllowlistKey,
  extensionKind,
  normalizeExtension,
  padAllowsExtension,
  type LaunchExtensionInput,
  type NormalizedExtension,
} from "./extension.js";
import {
  BANKR_LAUNCHPAD_ID,
  padSchedule,
  readPad,
  type LaunchpadPolicy,
} from "./launchpad.js";
import {
  EXTENSION_PRESETS,
  describePreset,
  type ExtensionTerms,
  type PresetKey,
  type PresetParams,
} from "./presets.js";
import type { ReadClient } from "./providers/types.js";
import { isSentinel } from "./recipient.js";
import { extSwapGasHeadroom, type ExtensionGas } from "./swapGas.js";

// What a launch's extension does, for a confirm screen, and whether the chain takes it: vendored from core's bankr-v4
// extensionPreview.ts (its wording, fee table and code scan; src/__internal__ holds them equal), plus the reads the
// registry makes at launch. Custom code is shown at its declared maxima: its own quote is not simulated here.

/** Bankr's share of every extension fee, to the treasury: 2/7 (LaunchConstants.EXT_BANKR_NUM / EXT_BANKR_DEN). */
export const EXTENSION_TREASURY_BPS = Math.round((2 * 10_000) / 7);

/** FeeMath.feePipsAt: `startPips` falling linearly to `steadyPips` over `decaySecs`, the drop rounded down. */
export function feePipsAt(s: FeeSchedule, secsSinceLaunch: number): number {
  if (secsSinceLaunch >= s.decaySecs) return s.steadyPips;
  const drop = Math.floor(
    ((s.startPips - s.steadyPips) * secsSinceLaunch) / s.decaySecs,
  );
  return s.startPips - drop;
}

/** One second of a launch's life: its own fee each way, what the extension adds after the hook's clamps (its quote,
 *  its declared maximum, and the room the launch's fee leaves under 10 %), and the two together. */
export interface ExtensionFeeRow {
  secsSinceLaunch: number;
  buyFeePips: number;
  sellFeePips: number;
  buy: { extPips: number; totalPips: number };
  sell: { extPips: number; totalPips: number };
}

/** A launch's own fee schedule each way. */
export type LaunchFees = { buy: FeeSchedule; sell: FeeSchedule };

const BASE_GRID = [0, 60, 180, 600, 3_600, 21_600, 86_400, 604_800];
const MAX_SECS = 2 ** 32 - 1;

/** The first second a direction's fee is under the pool's ceiling, where its extension first has room to charge. */
function roomOpensAt(s: FeeSchedule, ceilingPips: number): number {
  let t = 0;
  while (t < s.decaySecs && feePipsAt(s, t) >= ceilingPips) t++;
  return t;
}

/** A preset's reviewed `quote()`, before the hook's clamps; custom code is read at its declared maximum. */
function quoteAt(
  e: Pick<NormalizedExtension, "preset" | "terms">,
  t: number,
  isBuy: boolean,
): number {
  const p = e.preset;
  if (p === null) return isBuy ? e.terms.maxBuyPips : e.terms.maxSellPips;
  switch (p.preset) {
    case "sniper_tax":
      return t >= p.endSecs ? 0 : isBuy ? p.buyPips : p.sellPips;
    case "decay_tax": {
      if (t >= p.decaySecs) return 0;
      const start = isBuy ? p.startBuyPips : p.startSellPips;
      return Math.floor((start * (p.decaySecs - t)) / p.decaySecs);
    }
    // Charged only while the price runs past the threshold: shown at its worst.
    case "pump_brake":
      return isBuy ? p.brakePips : 0;
    case "raffle_run":
      return t >= p.runSecs ? 0 : isBuy ? p.buyPips : p.sellPips;
  }
}

/**
 * The extension's fee across time after launch, on the launch's own schedules: every second something changes (the
 * sunset, each direction's room opening and decay end, a preset's own window) and a fixed grid out to a week.
 * BankrLaunchHook._extQuote: nothing from the sunset on, else min(quote, its maximum, 10 % less the launch's fee).
 */
export function extensionFeeTable(
  e: Pick<NormalizedExtension, "preset" | "terms">,
  fees: LaunchFees,
  /** The pool's fee ceiling: suite 3's fixed 10 %, a suite 4 coin's own (`CoinTerms.pool.feeCeilingPips`). */
  ceilingPips: number = MAX_STEADY_FEE_PIPS,
): ExtensionFeeRow[] {
  const { terms, preset: p } = e;
  const edges = [terms.sunsetSecs];
  for (const s of [fees.buy, fees.sell])
    edges.push(roomOpensAt(s, ceilingPips), s.decaySecs);
  if (p?.preset === "raffle_run") edges.push(p.runSecs);
  if (p?.preset === "decay_tax") edges.push(Math.floor(p.decaySecs / 2));
  const grid = [
    ...new Set([
      ...BASE_GRID,
      ...edges.flatMap((s) => (s > 0 ? [s - 1, s] : [])),
    ]),
  ]
    .filter((s) => s >= 0 && s <= MAX_SECS)
    .sort((a, b) => a - b);
  const cell = (t: number, isBuy: boolean) => {
    const own = feePipsAt(isBuy ? fees.buy : fees.sell, t);
    const asked = terms.sunsetSecs === 0 || t < terms.sunsetSecs;
    const declared = isBuy ? terms.maxBuyPips : terms.maxSellPips;
    const room = Math.max(ceilingPips - own, 0);
    const extPips = asked ? Math.min(quoteAt(e, t, isBuy), declared, room) : 0;
    return { own, cell: { extPips, totalPips: own + extPips } };
  };
  return grid.map((t) => {
    const [buy, sell] = [cell(t, true), cell(t, false)];
    return {
      secsSinceLaunch: t,
      buyFeePips: buy.own,
      sellFeePips: sell.own,
      buy: buy.cell,
      sell: sell.cell,
    };
  });
}

/** Call-family opcodes an extension's code can reach. */
export interface ExtensionCodeScan {
  /** CALL, CALLCODE, DELEGATECALL, CREATE, CREATE2 or SELFDESTRUCT can run. */
  callsOut: boolean;
  /** DELEGATECALL or CALLCODE can run: behaviour can change without the codehash moving. */
  upgradeable: boolean;
  opcodes: string[];
}

const CALL_FAMILY: Readonly<Record<number, string>> = {
  0xf0: "CREATE",
  0xf1: "CALL",
  0xf2: "CALLCODE",
  0xf4: "DELEGATECALL",
  0xf5: "CREATE2",
  0xff: "SELFDESTRUCT",
};
// STOP, JUMP, RETURN, REVERT, INVALID, SELFDESTRUCT: nothing falls through them.
const HALTS = new Set([0x00, 0x56, 0xf3, 0xfd, 0xfe, 0xff]);
const JUMPDEST = 0x5b;

/**
 * Walks instruction boundaries as the EVM's jumpdest analysis does; code after a halt counts again only from the next
 * JUMPDEST, so a compiler's tails rarely mislabel. A miss errs toward "calls out", never toward "self-contained".
 */
export function scanExtensionBytecode(code: Hex): ExtensionCodeScan {
  const bytes = hexToBytes(code);
  const found = new Set<string>();
  let reachable = true;
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc]!;
    if (op === JUMPDEST) reachable = true;
    const name = CALL_FAMILY[op];
    if (reachable && name) found.add(name);
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
    if (HALTS.has(op)) reachable = false;
  }
  const opcodes = [...found].sort();
  return {
    callsOut: opcodes.length > 0,
    upgradeable: found.has("DELEGATECALL") || found.has("CALLCODE"),
    opcodes,
  };
}

/** Hook admission, read off-chain: code that exists, does not start with 0xEF, and hashes to what the launch pins
 *  (the hook's `ExtensionRejected` and `ExtensionCodehashMismatch`). */
export async function inspectExtensionCode(
  ctx: Pick<ExtensionReadContext, "chain" | "client">,
  address: Address,
  codehash: Hex,
): Promise<ExtensionCodeScan> {
  const refuse = (detail: string): never => {
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain: ctx.chain.chain,
      detail,
    });
  };
  const code = await getCode(ctx.client, { address });
  if (!code || code === "0x")
    return refuse("The extension address has no contract code.");
  if (code.slice(2, 4).toLowerCase() === "ef")
    refuse("Delegated accounts, EOF and Stylus code cannot be extensions.");
  if (keccak256(code) !== codehash.toLowerCase())
    refuse("The extension's code does not match the expected codehash.");
  return scanExtensionBytecode(code);
}

/** A launch's extension as the hook will bind it, what it does in Bankr's own words, and whether the chain takes it. */
export interface LaunchExtensionPreview {
  kind: "preset" | "custom";
  /** The preset; `reference` marks Raffle Run, a reference extension and not a Bankr product. Null for custom code. */
  preset: {
    id: number;
    key: PresetKey;
    name: string;
    reference: boolean;
  } | null;
  presetParams: PresetParams | null;
  /** Custom code's address, code hash and reachable call opcodes; null for a preset (deployed by the launch). */
  address: Address | null;
  codehash: Hex | null;
  scan: ExtensionCodeScan | null;
  /** A short tag, and one line on what it charges. Bankr's reading of the parameters, never the launcher's words. */
  label: string;
  description: string;
  terms: ExtensionTerms;
  /** The gas budgets the hook hands the extension on every swap, and what they add to a swap's gas limit for the
   *  pool's whole life (`swapGasHeadroom` adds it to the 960,000 every Bankr pool takes). */
  gas: ExtensionGas;
  swapGasHeadroom: bigint;
  /** Who is paid the extension's fee; null: the launch's first fee recipient (Raffle Run always pays itself). */
  payee: Address | null;
  /** The fee's split, in bps: the payee's 5/7 and Bankr's 2/7. */
  payeeShareBps: number;
  treasuryShareBps: number;
  /** The key the registry's allowlist is asked for, and its answer. */
  allowlistKey: Hex;
  allowlisted: boolean;
  /** The launchpad's policy admits this kind of extension (and custom code's declared maximum). */
  launchpadAllows: boolean;
  /** Why `plan()` refuses this extension now (`EXTENSION_NOT_ALLOWED`'s detail); null when it does not. */
  refusal: string | null;
  feeTable: ExtensionFeeRow[];
  warnings: string[];
}

/** What the reads below need of a client's context. */
export interface ExtensionReadContext {
  chain: { chain: LaunchChain };
  addresses: Pick<
    ProviderAddresses,
    "factory" | "launchpadRegistry" | "create3Factory"
  >;
  client: ReadClient;
}

const pct = (pips: number) => `${pips / 10_000}%`;
/** A declared maximum above 5 % is said out loud. */
const HIGH_FEE_PIPS = 50_000;
const NO_SCAN: ExtensionCodeScan = {
  callsOut: false,
  upgradeable: false,
  opcodes: [],
};

function labelOf(e: NormalizedExtension, scan: ExtensionCodeScan): string {
  if (e.preset) {
    const p = EXTENSION_PRESETS[e.preset.preset];
    return `${p.name} · ${p.reference ? "Reference extension" : "Bankr preset"}`;
  }
  const base =
    scan.callsOut && !e.terms.quoteOnly
      ? "Calls out during your trade · DYOR"
      : "Custom fee · DYOR";
  return scan.upgradeable ? `${base} · Upgradeable` : base;
}

function warningsOf(e: NormalizedExtension, scan: ExtensionCodeScan): string[] {
  const { terms, preset: p } = e;
  const high: string[] = [];
  if (terms.maxBuyPips > HIGH_FEE_PIPS)
    high.push(`Buys can pay up to ${pct(terms.maxBuyPips)} extra.`);
  if (terms.maxSellPips > HIGH_FEE_PIPS)
    high.push(`Sells can pay up to ${pct(terms.maxSellPips)} extra.`);
  if (p?.preset === "pump_brake")
    return [
      ...high,
      `Charged only while the price is over ${p.thresholdTicks} ticks above launch; the table shows that case.`,
    ];
  if (p?.preset === "raffle_run")
    return [
      ...high,
      "Runs code during your trade: tickets on buys, buybacks on sells.",
      "Raffle Run is a reference extension, not a Bankr product.",
    ];
  if (p) return high;
  return [
    "Unreviewed code (DYOR): Bankr shows its declared maximum, not a promise.",
    "An extension can tell a simulation from a real trade; the maximum is what counts.",
    ...high,
    ...(scan.callsOut && !terms.quoteOnly
      ? ["Runs code during your trade that can call other contracts."]
      : []),
    ...(scan.upgradeable
      ? ["Can change what it does without changing its code."]
      : []),
    "May refuse buys: a refused buy reverts. Sells can never be refused.",
  ];
}

/** Why the registry or the factory would revert a launch naming `e` now, in the order they check; null when neither would. */
function refusalOf(
  e: NormalizedExtension,
  i: { launchpadAllows: boolean; allowlisted: boolean; presetsOn: boolean },
  policy: Pick<LaunchpadPolicy, "allowedExtensions" | "maxExtensionPips">,
  key: Hex,
): string | null {
  if (!i.launchpadAllows) {
    const kind = extensionKind(e.params);
    const what = [
      "Bankr's presets",
      "custom extension code that only quotes a fee",
      "custom extension code the hook calls after each swap",
    ][kind - 1];
    const off = ((policy.allowedExtensions >> (kind - 1)) & 1) === 0;
    return off
      ? `This launchpad's policy does not allow ${what} (bit ${kind - 1} of policy.allowedExtensions is off): its operator turns it on with setPolicy.`
      : `This launchpad allows custom extension code to add at most ${pct(policy.maxExtensionPips)} (policy.maxExtensionPips), and this one declares more.`;
  }
  if (!i.allowlisted)
    return `The extension allowlist does not hold this extension's key (${key}). Only Bankr, the registry's owner, adds a key: a launchpad's operator cannot.`;
  if (!i.presetsOn)
    return "Bankr's presets are switched off on this chain right now.";
  return null;
}

/**
 * Reads what the registry reads at launch (the allowlist's answer for the extension's key, against the pad's policy),
 * a preset's deployer or custom code's own bytes, and builds the preview. Never refuses an extension the chain would
 * turn away: that is `refusal`. Custom code that fails the hook's admission is `INVALID_PARAMS`.
 */
export async function readExtensionPreview(
  ctx: ExtensionReadContext,
  e: NormalizedExtension,
  i: {
    policy: Pick<LaunchpadPolicy, "allowedExtensions" | "maxExtensionPips">;
    fees: LaunchFees;
    payee: Address | null;
  },
): Promise<LaunchExtensionPreview> {
  const key = extensionAllowlistKey(e.params)!;
  const custom = e.preset === null;
  const [allowlisted, presetDeployer, scan] = await Promise.all([
    readContract(ctx.client, {
      address: ctx.addresses.launchpadRegistry,
      abi: bankrLaunchpadRegistryAbi,
      functionName: "extensionAllowed",
      args: [key],
    }),
    // Rotated (or zeroed) behind the factory's queue, so read live.
    custom
      ? null
      : readContract(ctx.client, {
          address: ctx.addresses.factory,
          abi: bankrLaunchFactoryAbi,
          functionName: "presetDeployer",
        }),
    custom ? inspectExtensionCode(ctx, e.params.ext, e.params.codehash) : null,
  ]);
  const launchpadAllows = padAllowsExtension(i.policy, e.params);
  const presetsOn = presetDeployer === null || BigInt(presetDeployer) !== 0n;
  return buildExtensionPreview(e, {
    key,
    allowlisted,
    launchpadAllows,
    refusal: refusalOf(
      e,
      { launchpadAllows, allowlisted, presetsOn },
      i.policy,
      key,
    ),
    scan,
    payee: i.payee,
    fees: i.fees,
  });
}

/** What the chain answered about an extension, read by the suite's own reader. */
export interface ExtensionFacts {
  key: Hex;
  allowlisted: boolean;
  launchpadAllows: boolean;
  refusal: string | null;
  /** Custom code's scan; null for a preset. */
  scan: ExtensionCodeScan | null;
  payee: Address | null;
  fees: LaunchFees;
  /** Bankr's share of the extension's fee in bps: suite 3's 2/7, a suite 4 coin's own. */
  treasuryShareBps?: number;
  /** The pool's fee ceiling: suite 3's 10 %, a suite 4 coin's own. */
  feeCeilingPips?: number;
}

/** The preview from an extension and the chain's answers about it: wording, shares, fee table and warnings. */
export function buildExtensionPreview(
  e: NormalizedExtension,
  f: ExtensionFacts,
): LaunchExtensionPreview {
  const custom = e.preset === null;
  const p = e.preset;
  const { maxBuyPips, maxSellPips, sunsetSecs } = e.terms;
  const treasuryShareBps = f.treasuryShareBps ?? EXTENSION_TREASURY_BPS;
  return {
    kind: custom ? "custom" : "preset",
    preset: p ? { key: p.preset, ...EXTENSION_PRESETS[p.preset] } : null,
    presetParams: p,
    address: custom ? e.params.ext : null,
    codehash: custom ? e.params.codehash : null,
    scan: f.scan,
    label: labelOf(e, f.scan ?? NO_SCAN),
    description: p
      ? describePreset(p)
      : `Custom extension: buys up to +${pct(maxBuyPips)}, sells up to +${pct(maxSellPips)}${
          sunsetSecs ? `, never after ${sunsetSecs}s from launch` : ""
        }`,
    terms: e.terms,
    gas: e.gas,
    swapGasHeadroom: extSwapGasHeadroom(e.gas),
    // Raffle Run is its own payee, whatever the launch names.
    payee: p?.preset === "raffle_run" ? null : f.payee,
    payeeShareBps: 10_000 - treasuryShareBps,
    treasuryShareBps,
    allowlistKey: f.key,
    allowlisted: f.allowlisted,
    launchpadAllows: f.launchpadAllows,
    refusal: f.refusal,
    feeTable: extensionFeeTable(e, f.fees, f.feeCeilingPips),
    warnings: warningsOf(e, f.scan ?? NO_SCAN),
  };
}

/** The factory's `InvalidExtensionPayee` for a payee the launch names, before any address is mined: never a reserved
 *  marker or a suite contract (the CREATE3 factory included, which could never collect either). */
export async function refuseExtensionPayee(
  ctx: ExtensionReadContext,
  payee: Address,
): Promise<void> {
  const suite =
    isSentinel(payee) ||
    isAddressEqual(payee, ctx.addresses.create3Factory) ||
    (await readContract(ctx.client, {
      address: ctx.addresses.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "isSuite",
      args: [payee],
    }));
  if (suite)
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain: ctx.chain.chain,
      detail:
        "extension.payee cannot be a reserved address or a Bankr launch contract: it could never collect the extension's fee.",
    });
}

type Policy = Pick<LaunchpadPolicy, "allowedExtensions" | "maxExtensionPips">;

/**
 * A launch's extension held to the chain before anything is mined or signed: `EXTENSION_NOT_ALLOWED`, with the
 * reason, when the registry or the launchpad would turn it away. `payee` is the launch's first fee recipient, paid
 * when the extension names nobody.
 */
export async function requireExtension(
  ctx: ExtensionReadContext,
  e: NormalizedExtension,
  i: { policy: Policy; fees: LaunchFees; payee: Address },
): Promise<LaunchExtensionPreview> {
  const named = BigInt(e.params.payee) !== 0n;
  const [preview] = await Promise.all([
    readExtensionPreview(ctx, e, {
      ...i,
      payee: named ? e.params.payee : i.payee,
    }),
    named ? refuseExtensionPayee(ctx, e.params.payee) : null,
  ]);
  if (preview.refusal !== null)
    throw new LaunchRefusedError("EXTENSION_NOT_ALLOWED", {
      chain: ctx.chain.chain,
      detail: preview.refusal,
    });
  return preview;
}

/** {@link LaunchClient.previewExtension}'s options. */
export interface PreviewExtensionOptions {
  /** The launchpad whose policy is read. Default `0n`, Bankr's own. */
  launchpadId?: bigint;
  /** The launch's fee schedules, for the fee table: each way, or one for both. Default: the launchpad's. */
  fees?: LaunchFees;
  schedule?: FeeSchedule;
}

/** `client.previewExtension`: the extension's static refusals, then the launchpad's policy and the chain's answers. */
export async function previewExtension(
  ctx: ExtensionReadContext,
  input: LaunchExtensionInput,
  o: PreviewExtensionOptions = {},
): Promise<LaunchExtensionPreview> {
  const chain = ctx.chain.chain;
  const e = normalizeExtension(input, chain);
  const id = o.launchpadId ?? BANKR_LAUNCHPAD_ID;
  const named = BigInt(e.params.payee) !== 0n ? e.params.payee : null;
  const [{ pad }] = await Promise.all([
    readPad(ctx.client, ctx.addresses.launchpadRegistry, id, chain),
    named ? refuseExtensionPayee(ctx, named) : null,
  ]);
  const own = o.schedule ?? padSchedule(id, pad.feeBounds);
  return readExtensionPreview(ctx, e, {
    policy: pad.policy,
    fees: o.fees ?? { buy: own, sell: own },
    payee: named,
  });
}
