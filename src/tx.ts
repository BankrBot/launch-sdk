import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  numberToHex,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { bankrLaunchFactoryAbi as suite4FactoryAbi } from "./abis/generated.js";
import { bankrLaunchFactoryAbi } from "./abis/suite3.js";
import type { ChainCapabilities } from "./chains/index.js";
import { LaunchExecutionError, LaunchRefusedError } from "./errors.js";
import {
  SWAP_GAS_HEADROOM,
  checkExtensionBudgets,
  type LaunchParams,
} from "./economics.js";
import type { LaunchPlan, UnsignedTx } from "./providers/types.js";

/** Bankr's ERC-8021 builder code, appended only when a client sets `appendBankrBuilderCode`. */
export const BANKR_BUILDER_CODE = "bc_i85qhgg2";

/** The ERC-8021 marker that ends every attribution suffix. */
const ERC_8021_MARKER: Hex = "0x80218021802180218021802180218021";
// Schema 0 fits the joined codes' byte length in one byte.
const MAX_CODES_BYTES = 255;
const CODE = /^[\x21-\x2b\x2d-\x7e]+$/;

/**
 * ERC-8021 schema-0 calldata suffix: `codes.join(",")` ‖ its byte length ‖ `0x00` ‖ the 16-byte marker. Contracts
 * ignore it; indexers read the codes (claimed, unverified). `INVALID_PARAMS` for an empty list, a code outside
 * printable ASCII or holding a comma, or codes longer than 255 bytes together.
 */
export function encodeBuilderCodeSuffix(codes: readonly string[]): Hex {
  const joined = codes.join(",");
  if (
    codes.length === 0 ||
    !codes.every((c) => CODE.test(c)) ||
    joined.length > MAX_CODES_BYTES
  ) {
    throw new LaunchRefusedError("INVALID_PARAMS");
  }
  return concatHex([
    stringToHex(joined),
    numberToHex(joined.length, { size: 1 }),
    "0x00",
    ERC_8021_MARKER,
  ]);
}

/** The suffix a client appends to launch calldata, or undefined when it attributes nothing (the default). */
export function builderCodeSuffix(o: {
  builderCodes?: readonly string[];
  appendBankrBuilderCode?: boolean;
}): Hex | undefined {
  const codes = [
    ...(o.builderCodes ?? []),
    ...(o.appendBankrBuilderCode ? [BANKR_BUILDER_CODE] : []),
  ];
  return codes.length === 0 ? undefined : encodeBuilderCodeSuffix(codes);
}

// A launch's gas is near-deterministic; 20% covers state drift between the estimate and inclusion.
const GAS_HEADROOM_NUM = 12n;
const GAS_HEADROOM_DEN = 10n;

/** The lowest gas limit the heaviest launch measured on Bankr's pad (id 0, the default) lands at, without a builder
 *  allocation: on Base with its seven cap exclusions, seven band edges crossed by the dev buy, as a quote's first
 *  launch. Not a bound for every pad: more pad payees, a decay split or a longer link each weigh more. */
const LAUNCH_HEAVIEST_GAS = 15_174_754n;

/** What one builder allocation adds to that landing limit (15,174,754 without one). The factory caps their number by
 *  gas alone: 12 fit Base's 16,777,216 on Bankr's pad, and the 13th does not. */
export const LAUNCH_ALLOCATION_GAS = 129_400n;

/** What each launchpad payee past Bankr's two adds to the landing limit, on a steady and a decay share: forge's
 *  four-payee pin lands 9 allocations on Base as a quote's first launch, and 10 do not. A fit between that pin and
 *  Bankr's pad's figure, not a payee's measured cost. */
export const LAUNCH_PAD_PAYEE_GAS = 184_000n;

/** What a byte of metadata link past 2,048 adds to it (forge measures about 724 for a 4,096-byte link). */
export const LAUNCH_LINK_BYTE_GAS = 730n;

/** What the fallback's base is measured with: Bankr's two payees and a 2,048-byte link. */
const BASE_PAD_PAYEES = 2;
const BASE_LINK_BYTES = 2_048;

/** What makes a suite 4 launch weigh more than the measured one: its pad's payees and its link's length. */
export interface LaunchGasWeight {
  /** The launchpad's payee count (`padConfig(id).terms.payees.length`). */
  padPayees: number;
  /** The metadata link's length in bytes. */
  linkBytes: number;
}

/**
 * The gas limit that stands in for a launch a node gave no estimate for: the heaviest launch measured on Bankr's pad,
 * each builder allocation, and on suite 4 what its own pad adds (payees past two, a link past 2,048 bytes). Never
 * under the measured figure, so a lighter pad is held to Bankr's count, which lands there too.
 */
export function launchGasFallback(
  allocations: number,
  weight?: LaunchGasWeight,
): bigint {
  const more = (n: number, base: number) => BigInt(Math.max(n - base, 0));
  return (
    LAUNCH_HEAVIEST_GAS +
    BigInt(allocations) * LAUNCH_ALLOCATION_GAS +
    (weight
      ? more(weight.padPayees, BASE_PAD_PAYEES) * LAUNCH_PAD_PAYEE_GAS +
        more(weight.linkBytes, BASE_LINK_BYTES) * LAUNCH_LINK_BYTE_GAS
      : 0n)
  );
}

const grouped = (n: bigint): string => n.toLocaleString("en-US");

/**
 * The launch's gas limit: its estimate plus 20%, plus the hook's 960,000 when it dev-buys (a compound can come due
 * before inclusion), at most the chain's ceiling, which is the limit with no estimate. An estimate over the ceiling is
 * `SIMULATION_REVERTED`; with `allocations` that, or the heaviest launch's figure with no estimate, is `INVALID_PARAMS`.
 */
export function clampLaunchGas(
  chain: ChainCapabilities,
  estimate: bigint | null,
  devBuy = false,
  allocations = 0,
  weight?: LaunchGasWeight,
): bigint {
  const cap = chain.maxTxGas;
  // No estimate can mean a launch over the node's cap, which it refuses to estimate, or only an RPC that gives
  // none: the heaviest launch stands in for it as the worst case, sized from the launch's own pad on suite 4.
  const need =
    estimate ?? (allocations > 0 ? launchGasFallback(allocations, weight) : 0n);
  if (need > cap) {
    const cause = { gasEstimate: estimate, maxTxGas: cap };
    if (allocations === 0)
      throw new LaunchExecutionError("SIMULATION_REVERTED", {
        chain: chain.chain,
        cause,
      });
    // Rounded against the caller: dropping this many brings the figure under the ceiling.
    const drop =
      (need - cap + LAUNCH_ALLOCATION_GAS - 1n) / LAUNCH_ALLOCATION_GAS;
    const fit = BigInt(allocations) > drop ? BigInt(allocations) - drop : 0n;
    const adds = `A builder allocation adds about ${grouped(LAUNCH_ALLOCATION_GAS)}:`;
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain: chain.chain,
      cause,
      detail:
        estimate === null
          ? `The node gave no gas estimate for this launch, so the heaviest launch on Bankr's launchpad${weight && launchGasFallback(0, weight) > LAUNCH_HEAVIEST_GAS ? ", with what this launchpad's payees and this metadata link add," : ""} stands in for it: a gas limit of about ${grouped(need)} with its ${allocations} builder allocations, and this chain takes at most ${grouped(cap)} in one transaction. ${adds} at that figure ${fit} of the ${allocations} fit. A lighter launch can fit as it is: set the plan's gasEstimate to your own estimate, or pass buildLaunchTx your own gas limit.`
          : `This launch needs about ${grouped(need)} gas, and this chain takes at most ${grouped(cap)} in one transaction. ${adds} ${fit} of its ${allocations} builder allocations fit.`,
    });
  }
  // Without an estimate the ceiling itself is the limit, so a wallet's own padding cannot exceed it.
  if (estimate === null) return cap;
  // An extension adds nothing here: the estimate carries its binding (a preset's deploy included), and the hook
  // neither quotes nor calls it on the factory's own dev buy.
  const padded =
    (estimate * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN +
    (devBuy ? SWAP_GAS_HEADROOM : 0n);
  return padded > cap ? cap : padded;
}

/** `factory.launch(params)` calldata, with the builder-code suffix when there is one. */
export function encodeLaunchCalldata(
  params: LaunchParams & { options?: Hex },
  dataSuffix?: Hex,
): Hex {
  // A suite 4 launch's tuple ends with `options`; suite 3's factory takes none.
  const { options } = params;
  const data =
    options === undefined
      ? encodeFunctionData({
          abi: bankrLaunchFactoryAbi,
          functionName: "launch",
          args: [params],
        })
      : encodeFunctionData({
          abi: suite4FactoryAbi,
          functionName: "launch",
          args: [{ ...params, options }],
        });
  return dataSuffix ? concatHex([data, dataSuffix]) : data;
}

/** Whether a plan dev-buys (natively or in an ERC-20). */
export const hasDevBuy = (
  plan: Pick<LaunchPlan, "value" | "params">,
): boolean => plan.value > 0n || plan.params.devBuyAmountIn > 0n;

/**
 * The unsigned launch transaction for any signer: wagmi, a Safe, an ERC-4337 bundler. Pure (no RPC). Gas comes
 * from the plan's estimate with headroom, or from `options.gas`, clamped either way to the chain's ceiling. Send
 * `plan.approvals` first (or in the same batch). Multisig and 4337 signing latency can outlast the plan's deadline
 * (`Expired`), its pad authorization, or a price move can push the start tick out of the factory's bounds
 * (`START_TICK_CHANGED`): plan with a longer `deadlineSeconds`, prefer a USDC quote, and re-plan on either.
 */
export function buildLaunchTx(
  chain: ChainCapabilities,
  plan: LaunchPlan,
  options: { gas?: bigint } = {},
): UnsignedTx {
  checkExtensionBudgets(plan.params.extension, chain.chain);
  const cap = chain.maxTxGas;
  const own = options.gas;
  let gas: bigint;
  if (plan.gasEstimate === null && own !== undefined && own <= cap) {
    // With no estimate the caller's own limit is the only measurement: the heaviest launch's figure would refuse
    // a lighter launch the chain takes.
    gas = own;
  } else {
    // Run for a caller's own gas too: a launch whose estimate is over the ceiling lands at no limit.
    const clamped = clampLaunchGas(
      chain,
      plan.gasEstimate,
      hasDevBuy(plan),
      plan.params.extraAllocations.length,
      plan.resolved?.gasWeight,
    );
    gas = own === undefined ? clamped : own > cap ? cap : own;
  }
  return {
    chainId: chain.chainId,
    from: plan.launcher,
    to: plan.factory,
    data: encodeLaunchCalldata(plan.params, plan.dataSuffix),
    value: plan.value,
    gas,
  };
}

/** A zero-value call to `to` from `from`: the shape of every post-launch builder (claims, releases, rotations). */
export function buildCallTx(
  chainId: number,
  from: Address,
  to: Address,
  data: Hex,
): UnsignedTx {
  return {
    chainId,
    from: getAddress(from),
    to: getAddress(to),
    data,
    value: 0n,
  };
}

/** `quote.approve(spender, amount)` from the launcher: exactly the dev buy, never an unlimited allowance. */
export function buildApproveTx(
  chainId: number,
  launcher: Address,
  quote: Address,
  spender: Address,
  amount: bigint,
): UnsignedTx {
  return {
    chainId,
    from: launcher,
    to: quote,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
    value: 0n,
  };
}
