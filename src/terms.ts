import {
  decodeAbiParameters,
  encodeAbiParameters,
  hashTypedData,
  isAddressEqual,
  keccak256,
  zeroAddress,
  zeroHash,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { bankrLaunchFactoryAbi as suite4FactoryAbi } from "./abis/generated.js";
import { bankrLaunchFactoryAbi } from "./abis/suite3.js";
import type { LaunchParams } from "./economics.js";

// The terms a pad's signer signs and the EIP-712 authorization over them, vendored from core's bankr-v4
// launchAuthorization.ts with the launchpad id generalised (core's digest is id 0's). Pure: viem and the ABI only.

const launchFn = bankrLaunchFactoryAbi.find(
  (e) => e.type === "function" && e.name === "launch",
);
/** The `LaunchParams` tuple, as `abi.encode(p)` lays it out. */
export const LAUNCH_PARAMS_PARAM = (
  launchFn?.type === "function" ? launchFn.inputs[0] : undefined
) as AbiParameter;

const suite4LaunchFn = suite4FactoryAbi.find(
  (e) => e.type === "function" && e.name === "launch",
);
/** Suite 4's `LaunchParams` tuple: suite 3's fields, then `options`. */
export const SUITE4_LAUNCH_PARAMS_PARAM = (
  suite4LaunchFn?.type === "function" ? suite4LaunchFn.inputs[0] : undefined
) as AbiParameter;

/** A launch's tuple on either suite: a suite 4 launch carries `options` (empty bytes where it names nothing). */
export type AnyLaunchParams = LaunchParams & { options?: Hex };

/** The tuple a launch's params encode under: suite 4's exactly when they carry `options`. */
export const launchParamsParam = (p: { options?: unknown }): AbiParameter =>
  p.options === undefined ? LAUNCH_PARAMS_PARAM : SUITE4_LAUNCH_PARAMS_PARAM;

export type LaunchAuthorization = LaunchParams["authorization"];

export type PriceAttestation = LaunchParams["priceAttestation"];

export type LaunchExtension = LaunchParams["extension"];

export const EMPTY_PRICE_ATTESTATION: PriceAttestation = Object.freeze({
  priceUsdE18: 0n,
  observedAt: 0n,
  expiresAt: 0n,
  signature: "0x",
});
export const EMPTY_AUTHORIZATION: LaunchAuthorization = Object.freeze({
  nonce: zeroHash,
  deadline: 0n,
  signature: "0x",
});
/** A launch that names no extension: every field zero. The `extension` option fills it (extension.ts). */
export const NO_EXTENSION: LaunchExtension = Object.freeze({
  id: 0,
  params: "0x",
  payee: zeroAddress,
  ext: zeroAddress,
  codehash: zeroHash,
  maxBuyPips: 0,
  maxSellPips: 0,
  quoteOnly: false,
  sunsetSecs: 0,
  quoteGas: 0,
  afterGas: 0,
});

export function encodeLaunchParams(p: AnyLaunchParams): Hex {
  return encodeAbiParameters([launchParamsParam(p)], [p]);
}

/** A suite 4 launch's `abi.encode(p)` back into its tuple. */
export function decodeSuite4LaunchParams(
  data: Hex,
): LaunchParams & { options: Hex } {
  return decodeAbiParameters(
    [SUITE4_LAUNCH_PARAMS_PARAM],
    data,
  )[0] as LaunchParams & { options: Hex };
}

export function decodeLaunchParams(data: Hex): LaunchParams {
  return decodeAbiParameters([LAUNCH_PARAMS_PARAM], data)[0] as LaunchParams;
}

const isZero = (a: Address) => isAddressEqual(a, zeroAddress);

/** A launch's fee recipients as the factory resolves them: none named is the launcher alone, at the whole share. */
export function feeRecipientsOf(
  p: Pick<LaunchParams, "feeRecipients">,
  launcher: Address,
): LaunchParams["feeRecipients"] {
  return p.feeRecipients.length === 0
    ? [{ recipient: launcher, shareBps: 10_000 }]
    : p.feeRecipients;
}

/**
 * `factory.hashLaunchTerms(p, launcher, nativeDevBuy)`: what a pad's signer signs. Timing and signatures are blanked
 * (so `deadline` and `devBuyMinOut` may change after signing), payees resolved as the factory resolves them, a
 * native dev buy folded in, and the extension cleared when none is named. A named recipient list (in its order), the
 * open-code waiver, the metadata admin and the start time hash as given, and on suite 4 the launch's `options` with
 * both pins: a pad's signature covers the terms the launch was shown.
 */
export function launchTermsHash(
  p: AnyLaunchParams,
  launcher: Address,
  nativeDevBuy: bigint,
): Hex {
  const feeRecipients = feeRecipientsOf(p, launcher);
  const primary = feeRecipients[0]!.recipient;
  const named = p.extension.id !== 0 || !isZero(p.extension.ext);
  return keccak256(
    encodeLaunchParams({
      ...p,
      deadline: 0n,
      devBuyMinOut: 0n,
      authorization: EMPTY_AUTHORIZATION,
      priceAttestation: EMPTY_PRICE_ATTESTATION,
      feeRecipients,
      vestingRecipient: isZero(p.vestingRecipient)
        ? launcher
        : p.vestingRecipient,
      devBuyAmountIn: p.devBuyAmountIn + nativeDevBuy,
      extension: named
        ? {
            ...p.extension,
            payee: isZero(p.extension.payee) ? primary : p.extension.payee,
          }
        : { ...NO_EXTENSION },
    }),
  );
}

/** One launch authorization's EIP-712 message, domain `("Bankr Launchpads", "1", chainId, registry)`. */
export interface AuthorizationMessage {
  chainId: number;
  registry: Address;
  launchpadId: bigint;
  launcher: Address;
  paramsHash: Hex;
  nonce: Hex;
  deadline: bigint;
}

/** The typed data a pad's signer signs (`signTypedData`), as `registry.hashLaunchAuthorization` hashes it. */
export function launchAuthorizationTypedData(m: AuthorizationMessage) {
  return {
    domain: {
      name: "Bankr Launchpads",
      version: "1",
      chainId: m.chainId,
      verifyingContract: m.registry,
    },
    types: {
      LaunchAuthorization: [
        { name: "launchpadId", type: "uint64" },
        { name: "launcher", type: "address" },
        { name: "paramsHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "LaunchAuthorization",
    message: {
      launchpadId: m.launchpadId,
      launcher: m.launcher,
      paramsHash: m.paramsHash,
      nonce: m.nonce,
      deadline: m.deadline,
    },
  } as const;
}

/** `registry.hashLaunchAuthorization(id, launcher, paramsHash, nonce, deadline)`. */
export function launchAuthorizationDigest(m: AuthorizationMessage): Hex {
  return hashTypedData(launchAuthorizationTypedData(m));
}
