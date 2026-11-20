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
import type { bankrLaunchFactoryAbi } from "./abis/generated.js";
import type { LaunchChain } from "./chains/index.js";
import type { CurveRuleFigures } from "./curveDetail.js";
import { erc20SlotsFor, type Erc20Slots } from "./data/erc20Slots.js";
import type { LaunchParams } from "./economics.js";
import { LaunchExecutionError, isLaunchSdkError } from "./errors.js";
import type { LaunchPlan, ReadClient, SimResult } from "./providers/types.js";
import { launchCallError, launchRevertAbi } from "./launch/revert.js";

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

/** The contract error a failed launch call reverted with (e.g. `"StartTickOutOfBounds"`), or null. Pass an error's `cause`. */
export function launchRevertName(error: unknown): string | null {
  return revertOf(error)?.data?.errorName ?? null;
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

// Funds a planning simulation's gas on top of the dev buy (1 native unit: 1 ETH, 1 BNB, or 1 USDC on Arc).
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
  params: LaunchParams;
  /** The coin's own curve rules, for a curve revert's sentence. */
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
  const request = {
    account: c.launcher,
    address: c.factory,
    // The factory's `launch` with every error on a launch's path, typed as the factory's own for the result.
    abi: launchRevertAbi() as unknown as typeof bankrLaunchFactoryAbi,
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
    throw launchCallError(err, c.chain, c.curveRules);
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
    curveRules: plan.resolved.terms.curve,
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
