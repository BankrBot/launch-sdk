import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Abi,
} from "viem";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  creatorVestingEscrowAbi,
  erc20TokenDeployerAbi,
  holderRewardsDeployerAbi,
} from "../abis/generated.js";
import type { LaunchChain } from "../chains/index.js";
import type { CurveRevertName } from "../curveCheck.js";
import { curveRevertDetail, type CurveRuleFigures } from "../curveDetail.js";
import { launchSdkError } from "../errors.js";
import { HOOK_EXTENSION_ERRORS, PRESET_ERRORS } from "../simulate.js";
import { suite4LaunchRefusal } from "./refusals.js";

// A reverted suite 4 call as an SDK error: the revert is decoded against every error a contract on the launch's
// path declares, and worded by refusals.ts from its own arguments.

const isError = <T extends { type: string }>(
  e: T,
): e is Extract<T, { type: "error" }> => e.type === "error";

/** Every error a suite 4 launch or its `resolve` preview can revert with, to decode a revert against. */
export const SUITE4_LAUNCH_ERRORS = [
  ...bankrLaunchSettingsAbi,
  ...bankrLaunchFactoryAbi,
  ...bankrLaunchpadRegistryAbi,
  ...bankrFeeLedgerAbi,
  ...erc20TokenDeployerAbi,
  ...holderRewardsDeployerAbi,
  ...creatorVestingEscrowAbi,
  ...bankrLaunchTokenAbi,
].filter(isError);

/** The hook's error where it holds a hard bound again as it registers the pool; the hook's ABI is not vendored.
 *  Held equal to core's hook ABI entry. */
export const SUITE4_HOOK_ERRORS = [
  {
    type: "error",
    name: "InvalidPoolInit",
    inputs: [{ name: "bound", type: "uint8", internalType: "uint8" }],
  },
] as const;

let revertErrors: Abi | undefined;
let launchAbi: Abi | undefined;

/** Every error a contract on a suite 4 launch's path declares. A library's revert carries the name of the contract
 *  that declares it, whichever contract was called. Built on first use: simulate.ts and this module import each other. */
const suite4RevertErrors = (): Abi =>
  (revertErrors ??= [
    ...SUITE4_LAUNCH_ERRORS,
    ...HOOK_EXTENSION_ERRORS,
    ...SUITE4_HOOK_ERRORS,
    ...PRESET_ERRORS,
  ] as Abi);

/** `factory.launch` with every error it can revert with, for a simulation's decode. */
export const suite4LaunchAbi = (): Abi =>
  (launchAbi ??= [
    ...bankrLaunchFactoryAbi.filter((e) => !isError(e)),
    ...suite4RevertErrors(),
  ] as Abi);

const CURVE_ROW_REVERTS: readonly string[] = [
  "CurveTooThin",
  "CurveLiquidity",
  "CurveTooDense",
  "CurveStep",
];
const CURVE_REVERTS: readonly string[] = [
  ...CURVE_ROW_REVERTS,
  "CurvePlacement",
  "CurveDust",
];

function revertOf(error: unknown): ContractFunctionRevertedError | null {
  if (!(error instanceof BaseError)) return null;
  const hit = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return hit instanceof ContractFunctionRevertedError ? hit : null;
}

/** The revert's name and arguments: viem's, decoded against the one contract called, else the raw data's against
 *  every suite 4 error (`resolve` and `computeTokenAddress` raise the factory's and the settings contract's alike). */
function namedRevert(revert: ContractFunctionRevertedError): {
  name: string | undefined;
  args: readonly unknown[];
} {
  if (revert.data?.errorName)
    return { name: revert.data.errorName, args: revert.data.args ?? [] };
  if (!revert.raw || revert.raw === "0x") return { name: undefined, args: [] };
  try {
    const d = decodeErrorResult({
      abi: suite4RevertErrors(),
      data: revert.raw,
    });
    return { name: d.errorName, args: d.args ?? [] };
  } catch {
    return { name: undefined, args: [] };
  }
}

/**
 * The SDK error for a reverted suite 4 call (`resolve`, or `launch` in a simulation): the refusal's code with its
 * sentence in `detail`, else `SIMULATION_REVERTED`, the original on `cause`. A curve revert names the coin's own
 * `rules` when the caller has them. Anything that is not a contract revert is returned as it came.
 */
export function suite4CallError(
  error: unknown,
  chain: LaunchChain,
  rules?: CurveRuleFigures | null,
): unknown {
  const revert = revertOf(error);
  if (revert === null) return error;
  const { name, args } = namedRevert(revert);
  if (name && CURVE_REVERTS.includes(name)) {
    const row = CURVE_ROW_REVERTS.includes(name) ? args[0] : undefined;
    return launchSdkError("INVALID_PARAMS", {
      chain,
      cause: error,
      detail: curveRevertDetail(
        name as CurveRevertName,
        typeof row === "bigint" ? Number(row) : null,
        rules ?? null,
      ),
    });
  }
  const refusal = name ? suite4LaunchRefusal(name, args) : null;
  return launchSdkError(refusal?.code ?? "SIMULATION_REVERTED", {
    chain,
    cause: error,
    detail: refusal?.detail,
  });
}
