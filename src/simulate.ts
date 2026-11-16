import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  erc20Abi,
  isAddressEqual,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type StateOverride,
} from "viem";
import {
  estimateContractGas,
  readContract,
  simulateContract,
} from "viem/actions";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  creatorVestingEscrowAbi,
  erc20TokenDeployerAbi,
  holderRewardsDeployerAbi,
} from "./abis/suite3.js";
import type { LaunchChain } from "./chains/index.js";
import type { CurveRevertName } from "./curveCheck.js";
import { curveRevertDetail, type CurveRuleFigures } from "./curveDetail.js";
import { erc20SlotsFor, type Erc20Slots } from "./data/erc20Slots.js";
import type { LaunchParams } from "./economics.js";
import {
  LaunchExecutionError,
  isLaunchSdkError,
  launchSdkError,
  type LaunchSdkErrorCode,
} from "./errors.js";
import type { LaunchPlan, ReadClient, SimResult } from "./providers/types.js";
import { suite4CallError, suite4LaunchAbi } from "./suite4/revert.js";

const isError = <T extends { type: string }>(
  item: T,
): item is Extract<T, { type: "error" }> => item.type === "error";

/** The hook's extension errors a launch or a buy can surface; the hook's ABI is not vendored. Held equal to core's
 *  hook ABI entries. */
export const HOOK_EXTENSION_ERRORS = [
  { type: "error", name: "ExtensionGasBudget", inputs: [] },
  { type: "error", name: "ExtensionRefusedBuy", inputs: [] },
  { type: "error", name: "ExtensionRejected", inputs: [] },
  { type: "error", name: "ExtensionCodehashMismatch", inputs: [] },
] as const;

/** What a preset launch reverts with from code the SDK vendors no ABI of: each preset's constructor (its bounds) and
 *  the preset deployer. Held equal to core's ABI entries. */
export const PRESET_ERRORS = [
  { type: "error", name: "PresetParamsMalformed", inputs: [] },
  { type: "error", name: "PresetFeeOutOfBounds", inputs: [] },
  { type: "error", name: "PresetTimeOutOfBounds", inputs: [] },
  { type: "error", name: "PresetThresholdOutOfBounds", inputs: [] },
  {
    type: "error",
    name: "UnknownPreset",
    inputs: [{ name: "preset", type: "uint8", internalType: "uint8" }],
  },
] as const;

// A launch reverts from the factory (its libraries' errors are declared there), the launchpad registry, the ledger,
// the token deployer, the distributor deployer, the escrow, the token's wallet cap or the hook; decode against all.
const LAUNCH_ABI = [
  ...bankrLaunchFactoryAbi,
  ...[
    ...bankrLaunchpadRegistryAbi,
    ...bankrFeeLedgerAbi,
    ...erc20TokenDeployerAbi,
    ...holderRewardsDeployerAbi,
    ...creatorVestingEscrowAbi,
    ...bankrLaunchTokenAbi,
  ].filter(isError),
  ...HOOK_EXTENSION_ERRORS,
  ...PRESET_ERRORS,
];

const REVERT_CODES: Readonly<Record<string, LaunchSdkErrorCode>> = {
  Paused: "PAUSED",
  LaunchGated: "LAUNCHPAD_GATED",
  UnknownLaunchpad: "UNKNOWN_LAUNCHPAD",
  LaunchpadPaused: "LAUNCHPAD_PAUSED",
  QuoteNotAllowed: "QUOTE_NOT_ALLOWED",
  QuoteNotAllowedByLaunchpad: "QUOTE_NOT_ALLOWED",
  DevBuyNativeOnlyForWeth: "DEV_BUY_UNAVAILABLE",
  AmbiguousDevBuy: "DEV_BUY_UNAVAILABLE",
  DevBuyTooLarge: "CREATOR_CAP_EXCEEDED",
  VestBpsTooHigh: "CREATOR_CAP_EXCEEDED",
  SentinelPayee: "FEE_RECIPIENT_CANNOT_CLAIM",
  InvalidFeeRecipient: "FEE_RECIPIENT_CANNOT_CLAIM",
  InvalidVestingRecipient: "INVALID_PARAMS",
  SupplyOutOfRange: "INVALID_PARAMS",
  InvalidTick: "INVALID_PARAMS",
  InvalidFeeSchedule: "FEE_OUT_OF_BOUNDS",
  FeeOutsideLaunchpadBounds: "FEE_OUT_OF_BOUNDS",
  InvalidSplits: "SPLIT_OUT_OF_BOUNDS",
  InvalidReferrerBps: "SPLIT_OUT_OF_BOUNDS",
  ReferrerAboveLaunchpadMax: "SPLIT_OUT_OF_BOUNDS",
  HolderShareOutsideLaunchpadBounds: "SPLIT_OUT_OF_BOUNDS",
  AutoLpBelowLaunchpadMin: "SPLIT_OUT_OF_BOUNDS",
  UnlistedQuoteAutoLp: "SPLIT_OUT_OF_BOUNDS",
  InvalidVestToHolders: "VESTING_OUT_OF_BOUNDS",
  VestBpsNotAllowedByLaunchpad: "VESTING_OUT_OF_BOUNDS",
  VestToHoldersNotAllowedByLaunchpad: "VESTING_OUT_OF_BOUNDS",
  BuybackAboveLaunchpadMax: "SPLIT_OUT_OF_BOUNDS",
  BuybackFeeTooLow: "FEE_OUT_OF_BOUNDS",
  BuilderLaneNotAllowedByLaunchpad: "BUILDER_LANE_NOT_ALLOWED",
  StartTickOutOfBounds: "START_TICK_CHANGED",
  TokenSaltTaken: "POOL_ALREADY_INITIALIZED",
  VanityMismatch: "PREDICTION_MISMATCH",
  VanityTaken: "PREDICTION_MISMATCH",
  AuthorizationExpired: "AUTHORIZATION_INVALID",
  NonceUsed: "AUTHORIZATION_INVALID",
  InvalidAuthorization: "AUTHORIZATION_INVALID",
  BankrSignerUnset: "AUTHORIZATION_INVALID",
  OperatorShareAboveLauncherBound: "LAUNCHPAD_TERMS_CHANGED",
  OperatorPayeesMismatch: "LAUNCHPAD_TERMS_CHANGED",
  InvalidFeeRecipients: "INVALID_PARAMS",
  ExtensionPayeeUnnamed: "INVALID_PARAMS",
  OpenContractFeeRecipient: "FEE_RECIPIENT_CANNOT_CLAIM",
  InvalidBeneficiary: "FEE_RECIPIENT_CANNOT_CLAIM",
  TooManyCreators: "INVALID_PARAMS",
  MetadataTooLong: "INVALID_PARAMS",
  StartPassed: "INVALID_PARAMS",
  StartTooFar: "INVALID_PARAMS",
  StartDelayAboveLaunchpadMax: "INVALID_PARAMS",
  DevBuyerExcluded: "DEV_BUY_UNAVAILABLE",
  ExtensionGasBudget: "INVALID_PARAMS",
  AmbiguousExtension: "INVALID_PARAMS",
  ExtensionNotAllowlisted: "EXTENSION_NOT_ALLOWED",
  ExtensionNotAllowedByLaunchpad: "EXTENSION_NOT_ALLOWED",
  PresetsUnavailable: "EXTENSION_NOT_ALLOWED",
  PresetParamsMalformed: "EXTENSION_OUT_OF_BOUNDS",
  PresetFeeOutOfBounds: "EXTENSION_OUT_OF_BOUNDS",
  PresetTimeOutOfBounds: "EXTENSION_OUT_OF_BOUNDS",
  PresetThresholdOutOfBounds: "EXTENSION_OUT_OF_BOUNDS",
  UnknownPreset: "INVALID_PARAMS",
  InvalidExtensionPayee: "INVALID_PARAMS",
  ExtensionRejected: "INVALID_PARAMS",
  ExtensionCodehashMismatch: "INVALID_PARAMS",
  InvalidCurve: "INVALID_PARAMS",
  CurveNotAllowedByLaunchpad: "CURVE_NOT_ALLOWED",
  CurveTooThin: "INVALID_PARAMS",
  CurveLiquidity: "INVALID_PARAMS",
  CurveTooDense: "INVALID_PARAMS",
  CurveStep: "INVALID_PARAMS",
  CurvePlacement: "INVALID_PARAMS",
  CurveDust: "INVALID_PARAMS",
};

/** The suite's errors for a launch's own bands; the first four carry the band's row as their one argument. */
const CURVE_REVERTS: readonly CurveRevertName[] = [
  "CurveTooThin",
  "CurveLiquidity",
  "CurveTooDense",
  "CurveStep",
  "InvalidCurve",
  "CurvePlacement",
  "CurveDust",
];
const CURVE_ROW_REVERTS = 4;

// The SDK's own sentence for a revert whose code alone does not say which rule failed. Never upstream text.
// TradingNotStarted has no code of its own: a launch only meets it through cap exclusions the caller chose. Nor has
// ExtensionRefusedBuy: the hook never asks an extension about the launch's own dev buy, so only a later buy meets it.
const REVERT_DETAILS: Readonly<Record<string, string>> = {
  InvalidFeeRecipients:
    "The fee recipients are invalid: 1 to 10 distinct, non-zero addresses whose shares are each above 0 and add up to 100%.",
  ExtensionPayeeUnnamed:
    "A launch with several fee recipients must name its extension's payee.",
  OpenContractFeeRecipient:
    "A fee recipient is a contract with open claims: it restricts its claims on the ledger first, or the launch sets allowOpenCodeFeeRecipients.",
  InvalidBeneficiary:
    "A fee recipient, or one of this launchpad's payees, is the launch's quote token, and a token's own contract could never collect its share. Use a wallet address, or launch against another quote token.",
  TooManyCreators: "A launch can name at most 10 fee recipients.",
  MetadataTooLong: "The metadata link can be at most 2,048 bytes.",
  StartPassed:
    "The trading start passed before the launch was mined: plan again with a later startTime.",
  StartTooFar: "Trading can start at most 7 days after the launch.",
  StartDelayAboveLaunchpadMax:
    "The trading start is later than this launchpad allows.",
  DevBuyerExcluded:
    "A launcher on the wallet-cap exclusion list cannot dev buy on a launch with a scheduled start.",
  TradingNotStarted:
    "The token does not trade or leave a wallet before its trading start.",
  ExtensionGasBudget:
    "An extension's gas budgets are out of range: 50,000 to 250,000 for its quote, 150,000 to 1,000,000 for its post-swap call, and none for a quote-only extension.",
  AmbiguousExtension:
    "The extension is named two ways at once: a preset takes only its id and parameters, and custom code takes no preset parameters and writes a gas budget at its floor as 0.",
  ExtensionRefusedBuy:
    "The token's extension refused this buy. It can refuse buys from the pool's first swap; it can never refuse a sell.",
  ExtensionNotAllowlisted:
    "The suite's extension allowlist does not hold this extension's key. Only Bankr, the registry's owner, adds a key.",
  ExtensionNotAllowedByLaunchpad:
    "This launchpad's policy does not allow this kind of extension, or caps custom code's fee under what this one declares (policy.allowedExtensions, policy.maxExtensionPips).",
  PresetsUnavailable:
    "Bankr's presets are switched off on this chain right now.",
  PresetParamsMalformed:
    "The preset's params are not its parameters' exact ABI encoding.",
  PresetFeeOutOfBounds:
    "A preset fee is out of bounds: at most 100,000 pips (10%) each way; Sniper Tax's buy fee and Pump Brake's fee at least 1, and a Decay Tax needs a buy or a sell fee.",
  PresetTimeOutOfBounds:
    "A preset's window is out of bounds: more than 120 seconds after launch, and at most 3,600 (Sniper Tax), 7 days (Decay Tax) or 30 days (Raffle Run).",
  PresetThresholdOutOfBounds:
    "Pump Brake's threshold is out of bounds: 6,932 to 887,272 ticks above the launch price.",
  UnknownPreset: "The suite deploys no preset with this id.",
  InvalidExtensionPayee:
    "The extension's payee cannot be a Bankr launch contract, or this launch's own token, escrow or holder-rewards distributor.",
  ExtensionRejected:
    "The extension address has no contract code the hook admits (none, a delegated account, EOF or Stylus).",
  ExtensionCodehashMismatch:
    "The extension's code does not match the codehash the launch names.",
  CurveNotAllowedByLaunchpad:
    "This launchpad does not allow this launch's curve. Its operator must open it first: list these bands, open the launchpad to launcher-defined bands, or switch the built-in curve back on, with setCurveAllowed.",
};

/** A curve revert's sentence, with the band its argument names; undefined for any other revert. */
function curveDetailOf(
  name: string,
  args: readonly unknown[] | undefined,
): string | undefined {
  const at = CURVE_REVERTS.indexOf(name as CurveRevertName);
  if (at === -1) return undefined;
  const row = at < CURVE_ROW_REVERTS ? args?.[0] : undefined;
  return curveRevertDetail(
    CURVE_REVERTS[at]!,
    typeof row === "bigint" ? Number(row) : null,
  );
}

function revertOf(error: unknown): ContractFunctionRevertedError | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk(
    (e) => e instanceof ContractFunctionRevertedError,
  );
  return reverted instanceof ContractFunctionRevertedError ? reverted : null;
}

/** Whether a failed call is a contract's own revert, not a transport or RPC failure. */
export const isContractRevert = (error: unknown): boolean =>
  revertOf(error) !== null;

/** The suite error a failed launch call reverted with (e.g. `"StartTickOutOfBounds"`), or null. Pass an error's `cause`. */
export function launchRevertName(error: unknown): string | null {
  return revertOf(error)?.data?.errorName ?? null;
}

/**
 * The SDK error for a reverted launch call: a mapped revert, else `SIMULATION_REVERTED`, with the original on
 * `cause`. Anything that is not a contract revert (a transport or RPC failure) is returned as it came.
 */
export function launchCallError(error: unknown, chain: LaunchChain): unknown {
  if (revertOf(error) === null) return error;
  const name = launchRevertName(error);
  const code = (name && REVERT_CODES[name]) || "SIMULATION_REVERTED";
  const detail =
    name === null
      ? undefined
      : (curveDetailOf(name, revertOf(error)?.data?.args) ??
        REVERT_DETAILS[name]);
  return launchSdkError(code, { chain, cause: error, detail });
}

const bytes32 = (v: bigint): Hex => toHex(v, { size: 32 });

/** Solidity's `mapping(address => …)` slot for `key` in the mapping declared at `slot`. */
const addressKeySlot = (key: Address, slot: bigint): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [key, slot],
    ),
  );

/** The inner mapping's slot: `mapping(address => mapping(address => …))[owner][spender]`. */
const nestedKeySlot = (spender: Address, outer: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [spender, outer],
    ),
  );

/** `_allowances[owner][spender]` set to `allowance` and, when `balance` is given and has a slot, `_balances[owner]`. */
export function erc20Override(i: {
  token: Address;
  owner: Address;
  spender: Address;
  allowance: bigint;
  balance?: bigint;
  slots: Erc20Slots;
}): StateOverride[number] {
  const stateDiff: { slot: Hex; value: Hex }[] = [];
  if (i.balance !== undefined && i.slots.balances !== null) {
    stateDiff.push({
      slot: addressKeySlot(i.owner, BigInt(i.slots.balances)),
      value: bytes32(i.balance),
    });
  }
  stateDiff.push({
    slot: nestedKeySlot(
      i.spender,
      addressKeySlot(i.owner, BigInt(i.slots.allowances)),
    ),
    value: bytes32(i.allowance),
  });
  return { address: i.token, stateDiff };
}

// Funds a planning simulation's gas on top of the dev buy (1 native unit: 1 ETH, or 1 USDC on Arc).
const SIM_GAS_FUNDS = 10n ** 18n;

/**
 * The override that lets a plan simulate before the launcher is funded or has approved: the launcher's native
 * balance covers the value and gas, and an ERC-20 dev buy's balance and allowance slots hold the amount. Arc's USDC
 * has no balance slot (it reports the native balance), so the amount is added there in 18-dp units.
 */
export function fundingOverride(i: {
  chain: LaunchChain;
  launcher: Address;
  factory: Address;
  params: LaunchParams;
  value: bigint;
  quoteDecimals: number;
}): StateOverride {
  const amount = i.params.devBuyAmountIn;
  const slots =
    amount > 0n ? erc20SlotsFor(i.chain, i.params.quote) : undefined;
  const nativeErc20 =
    slots?.balances === null
      ? amount * 10n ** BigInt(18 - i.quoteDecimals)
      : 0n;
  return [
    { address: i.launcher, balance: i.value + SIM_GAS_FUNDS + nativeErc20 },
    ...(slots
      ? [
          erc20Override({
            token: i.params.quote,
            owner: i.launcher,
            spender: i.factory,
            allowance: amount,
            balance: amount,
            slots,
          }),
        ]
      : []),
  ];
}

export interface LaunchCall {
  chain: LaunchChain;
  factory: Address;
  launcher: Address;
  /** A suite 4 launch's tuple carries `options`; it is called and its reverts read on suite 4's ABIs. */
  params: LaunchParams & { options?: Hex };
  /** A suite 4 coin's own curve rules, for a curve revert's sentence. */
  curveRules?: CurveRuleFigures | null;
  value: bigint;
  dataSuffix: Hex | undefined;
  stateOverride?: StateOverride;
  /** Run at this block instead of the latest. */
  blockNumber?: bigint;
}

/**
 * `factory.launch(params)` as an `eth_call` from the launcher, then a gas estimate of the same call. A revert
 * throws its mapped SDK error; a failed estimate (an RPC without estimate overrides, or a launch over the node's
 * per-transaction cap, which it refuses to estimate) leaves `gas` null.
 */
export async function callLaunch(
  client: ReadClient,
  c: LaunchCall,
): Promise<Omit<SimResult, "assumedApprovals">> {
  const suite4 = c.params.options !== undefined;
  const request = {
    account: c.launcher,
    address: c.factory,
    abi: (suite4 ? suite4LaunchAbi() : LAUNCH_ABI) as typeof LAUNCH_ABI,
    functionName: "launch",
    args: [c.params],
    value: c.value,
    dataSuffix: c.dataSuffix,
    stateOverride: c.stateOverride,
    blockNumber: c.blockNumber,
  } as const;
  let result: {
    token: Address;
    poolId: Hex;
    distributor: Address;
    vestingEscrow: Address;
    devBuyOut: bigint;
  };
  try {
    ({ result } = await simulateContract(client, request));
  } catch (err) {
    throw suite4
      ? suite4CallError(err, c.chain, c.curveRules)
      : launchCallError(err, c.chain);
  }
  let gas: bigint | null;
  try {
    gas = await estimateContractGas(client, request);
  } catch {
    gas = null;
  }
  return {
    token: result.token,
    poolId: result.poolId,
    distributor: result.distributor,
    escrow: isAddressEqual(result.vestingEscrow, zeroAddress)
      ? null
      : result.vestingEscrow,
    devBuyOut: result.devBuyOut,
    gas,
  };
}

/**
 * A plan's simulation. A dev buy is simulated as if the launcher were already funded and approved (the
 * {@link fundingOverride}); a launch without one sends no override. If the RPC refuses the override (any failure that
 * is not a revert), the plain call runs instead, so a launcher that already holds the funds and allowance still plans.
 */
export async function callPlannedLaunch(
  client: ReadClient,
  c: LaunchCall,
  quoteDecimals: number,
): Promise<Omit<SimResult, "assumedApprovals">> {
  if (c.value === 0n && c.params.devBuyAmountIn === 0n) {
    return callLaunch(client, c);
  }
  const stateOverride = fundingOverride({ ...c, quoteDecimals });
  try {
    return await callLaunch(client, { ...c, stateOverride });
  } catch (err) {
    if (isLaunchSdkError(err)) throw err;
    try {
      return await callLaunch(client, c);
    } catch {
      // Unfunded without the override too: the RPC's refusal of the override is the cause to report.
      throw err;
    }
  }
}

/** The launcher's current allowance to the factory for an ERC-20 dev buy (0n for none). */
export async function readFactoryAllowance(
  client: ReadClient,
  plan: Pick<LaunchPlan, "params" | "launcher" | "factory">,
): Promise<bigint> {
  if (plan.params.devBuyAmountIn === 0n) return 0n;
  return readContract(client, {
    address: plan.params.quote,
    abi: erc20Abi,
    functionName: "allowance",
    args: [plan.launcher, plan.factory],
  });
}

/**
 * Simulates the planned launch as it would execute now (or at `blockNumber`), from the launcher's real balances.
 * When an ERC-20 approval is still pending and `assumeApprovals` is set (the default), only the allowance slot is
 * overridden, as a Safe or 4337 `approve + launch` batch would leave it. The token must be the plan's prediction.
 */
export async function simulateLaunch(
  client: ReadClient,
  plan: LaunchPlan,
  options: { assumeApprovals?: boolean; blockNumber?: bigint } = {},
): Promise<SimResult> {
  const amount = plan.params.devBuyAmountIn;
  const allowance = await readFactoryAllowance(client, plan);
  const slots =
    amount > allowance && options.assumeApprovals !== false
      ? erc20SlotsFor(plan.chain, plan.params.quote)
      : undefined;
  const sim = await callLaunch(client, {
    chain: plan.chain,
    factory: plan.factory,
    launcher: plan.launcher,
    params: plan.params,
    curveRules: plan.suite4?.terms.curve,
    value: plan.value,
    dataSuffix: plan.dataSuffix,
    blockNumber: options.blockNumber,
    stateOverride: slots
      ? [
          erc20Override({
            token: plan.params.quote,
            owner: plan.launcher,
            spender: plan.factory,
            allowance: amount,
            slots,
          }),
        ]
      : undefined,
  });
  if (!isAddressEqual(sim.token, plan.predictedToken)) {
    throw new LaunchExecutionError("PREDICTION_MISMATCH", {
      chain: plan.chain,
    });
  }
  return { ...sim, assumedApprovals: slots !== undefined };
}
