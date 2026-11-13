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
import {
  CAP_BPS,
  CAP_DURATION_SECS,
  DEFAULT_TOTAL_SUPPLY,
  type LaunchParams,
} from "./economics.js";
import type { ReadClient } from "./providers/types.js";

// Token and escrow prediction, vendored from core's bankr-v4 saltMining.ts (src/__internal__ holds them equal). A
// token's address depends on the suite as it is now (hook, treasury and cap controller can rotate), so the suite is
// read live, and every prediction is cross-checked against `factory.computeTokenAddress`.

/** LaunchConstants.DEAD: every token cap-excludes it (the locker's dust and the buyback's burns). */
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

/** Everything a token address depends on besides the launch itself, read live from the factory. */
export interface LiveSuite {
  factory: Address;
  tokenDeployer: Address;
  vestingEscrowImpl: Address;
  poolManager: Address;
  locker: Address;
  hook: Address;
  ledger: Address;
  treasury: Address;
  capController: Address;
  buyback: Address;
}

/** The factory's live pointers (`blockNumber` reads them as they stood then). */
export async function readLiveSuite(
  client: ReadClient,
  factory: Address,
  blockNumber?: bigint,
): Promise<LiveSuite> {
  const read = <
    N extends
      | "tokenDeployer"
      | "vestingEscrowImpl"
      | "poolManager"
      | "locker"
      | "hook"
      | "ledger"
      | "treasury"
      | "capController"
      | "buyback",
  >(
    functionName: N,
  ) =>
    readContract(client, {
      address: factory,
      abi: bankrLaunchFactoryAbi,
      functionName,
      blockNumber,
    } as const) as Promise<Address>;
  const [
    tokenDeployer,
    vestingEscrowImpl,
    poolManager,
    locker,
    hook,
    ledger,
    treasury,
    capController,
    buyback,
  ] = await Promise.all([
    read("tokenDeployer"),
    read("vestingEscrowImpl"),
    read("poolManager"),
    read("locker"),
    read("hook"),
    read("ledger"),
    read("treasury"),
    read("capController"),
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
    capController,
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
  suite: Pick<LiveSuite, "factory" | "vestingEscrowImpl">,
  launcher: Address,
  salt: Hex,
): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: suite.factory,
    salt: deriveDeployerSalt(launcher, salt),
    bytecode: cloneInitCode(suite.vestingEscrowImpl),
  });
}

/** What a token's address depends on in its launch: its identity, its metadata admin and the chain's cap exclusions. */
export type TokenIdentity = Pick<
  LaunchParams,
  | "name"
  | "symbol"
  | "metadataUri"
  | "metadataAdmin"
  | "totalSupply"
  | "capExclusions"
>;

/** BankrLaunchToken creation code ‖ the constructor arguments the ERC-20 token deployer encodes. */
export function tokenInitCode(
  suite: LiveSuite,
  identity: TokenIdentity,
  escrow: Address,
): Hex {
  const supply = identity.totalSupply || DEFAULT_TOTAL_SUPPLY;
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
      supply,
      suite.factory,
      identity.metadataUri,
      // The admin is a constructor argument; the trading start is not (the deployer hands it over transiently).
      identity.metadataAdmin,
      (supply * BigInt(CAP_BPS)) / 10_000n,
      BigInt(CAP_DURATION_SECS),
      suite.capController,
      // The factory's own exclusions, the escrow at index 5, then the launch's.
      [
        suite.poolManager,
        suite.locker,
        suite.hook,
        suite.ledger,
        suite.treasury,
        escrow,
        suite.buyback,
        DEAD,
        ...identity.capExclusions,
      ],
    ],
  );
  return concatHex([bankrLaunchTokenCreationCode, args]);
}

/** The token a launch of `identity` by `launcher` with `salt` deploys. Always cross-check `factory.computeTokenAddress`. */
export function predictToken(
  suite: LiveSuite,
  identity: TokenIdentity,
  launcher: Address,
  salt: Hex,
): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: suite.tokenDeployer,
    salt: deriveDeployerSalt(launcher, salt),
    bytecode: tokenInitCode(
      suite,
      identity,
      predictEscrow(suite, launcher, salt),
    ),
  });
}

/** keccak256 of the vendored BankrLaunchToken creation code (core's `bankrLaunchTokenCreationCodeHash`). */
export const launchTokenCreationCodeHash = (): Hex =>
  keccak256(bankrLaunchTokenCreationCode);
