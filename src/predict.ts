import {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchTokenCreationCode,
} from "./abis/generated.js";
import type { LaunchParams } from "./economics.js";
import type { ReadClient } from "./providers/types.js";

// Token and escrow prediction, vendored from core's bankr-v4 saltMining.ts (src/__internal__ holds them equal). A
// token's address depends on the contracts as they are now (hook and treasury can rotate), so they are read live,
// and every prediction is cross-checked against `factory.computeTokenAddress`. A token is built with its coin's own
// terms: the supply, the wallet cap and who may end it.

/** LaunchConstants.DEAD: every token cap-excludes it (the locker's dust and the buyback's burns). */
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

/** Everything a token address depends on besides the launch itself, read live from the factory. */
export interface LivePointers {
  factory: Address;
  tokenDeployer: Address;
  vestingEscrowImpl: Address;
  poolManager: Address;
  locker: Address;
  hook: Address;
  ledger: Address;
  treasury: Address;
  buyback: Address;
}

/** What a token is deployed with of its coin's terms (`resolve`): the supply, the wallet cap, who may end it. */
export interface TokenTerms {
  totalSupply: bigint;
  capAmount: bigint;
  capSecs: number | bigint;
  capController: Address;
}

/** The factory's live pointers (`blockNumber` reads them as they stood then). */
export async function readLivePointers(
  client: ReadClient,
  factory: Address,
  blockNumber?: bigint,
): Promise<LivePointers> {
  const read = (
    functionName:
      | "tokenDeployer"
      | "vestingEscrowImpl"
      | "poolManager"
      | "locker"
      | "hook"
      | "ledger"
      | "treasury"
      | "buyback",
  ) =>
    readContract(client, {
      address: factory,
      abi: bankrLaunchFactoryAbi,
      functionName,
      blockNumber,
    });
  const [
    tokenDeployer,
    vestingEscrowImpl,
    poolManager,
    locker,
    hook,
    ledger,
    treasury,
    buyback,
  ] = await Promise.all([
    read("tokenDeployer"),
    read("vestingEscrowImpl"),
    read("poolManager"),
    read("locker"),
    read("hook"),
    read("ledger"),
    read("treasury"),
    read("buyback"),
  ]);
  return {
    factory,
    tokenDeployer,
    vestingEscrowImpl,
    poolManager,
    locker,
    hook,
    ledger,
    treasury,
    buyback,
  };
}

/** The token deployer's and the escrow clone's CREATE2 salt: keccak256(abi.encodePacked(launcher, salt)). */
export function deriveDeployerSalt(launcher: Address, salt: Hex): Hex {
  return keccak256(concatHex([launcher, salt]));
}

/** OpenZeppelin `Clones.predictDeterministicAddress`: the 55-byte EIP-1167 initcode of `implementation`. */
export function cloneInitCode(implementation: Address): Hex {
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

/** `factory.computeVestingEscrow(launcher, salt)`; the clone exists only when something vests. */
export function predictEscrow(
  live: Pick<LivePointers, "factory" | "vestingEscrowImpl">,
  launcher: Address,
  salt: Hex,
): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: live.factory,
    salt: deriveDeployerSalt(launcher, salt),
    bytecode: cloneInitCode(live.vestingEscrowImpl),
  });
}

/** What a token's address depends on in its launch: its identity, its metadata admin, the chain's cap exclusions
 *  and the terms the launch check resolved for its coin. */
export type TokenIdentity = Pick<
  LaunchParams,
  "name" | "symbol" | "metadataUri" | "metadataAdmin" | "capExclusions"
> & {
  terms: TokenTerms;
};

/** BankrLaunchToken creation code ‖ the constructor arguments the ERC-20 token deployer encodes. */
export function tokenInitCode(
  live: LivePointers,
  identity: TokenIdentity,
  escrow: Address,
): Hex {
  const { terms } = identity;
  const args = encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "uint256" },
      { type: "address" },
      { type: "string" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint64" },
      { type: "address" },
      { type: "address[]" },
    ],
    [
      identity.name,
      identity.symbol,
      terms.totalSupply,
      live.factory,
      identity.metadataUri,
      // The admin is a constructor argument; the trading start is not (the deployer hands it over transiently).
      identity.metadataAdmin,
      terms.capAmount,
      BigInt(terms.capSecs),
      terms.capController,
      // The factory's own exclusions, the escrow at index 5, then the launch's.
      [
        live.poolManager,
        live.locker,
        live.hook,
        live.ledger,
        live.treasury,
        escrow,
        live.buyback,
        DEAD,
        ...identity.capExclusions,
      ],
    ],
  );
  return concatHex([bankrLaunchTokenCreationCode, args]);
}

/** The token a launch of `identity` by `launcher` with `salt` deploys. Always cross-check `factory.computeTokenAddress`. */
export function predictToken(
  live: LivePointers,
  identity: TokenIdentity,
  launcher: Address,
  salt: Hex,
): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: live.tokenDeployer,
    salt: deriveDeployerSalt(launcher, salt),
    bytecode: tokenInitCode(
      live,
      identity,
      predictEscrow(live, launcher, salt),
    ),
  });
}

/** keccak256 of the vendored BankrLaunchToken creation code (core's `bankrLaunchTokenCreationCodeHash`). */
export const launchTokenCreationCodeHash = (): Hex =>
  keccak256(bankrLaunchTokenCreationCode);
