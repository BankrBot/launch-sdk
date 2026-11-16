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
  bankrLaunchFactoryAbi as suite4FactoryAbi,
  bankrLaunchTokenCreationCode as suite4TokenCreationCode,
} from "./abis/generated.js";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchTokenCreationCode,
} from "./abis/suite3.js";
import {
  CAP_BPS,
  CAP_DURATION_SECS,
  DEFAULT_TOTAL_SUPPLY,
  type LaunchParams,
} from "./economics.js";
import type { ReadClient } from "./providers/types.js";

// Token and escrow prediction, vendored from core's bankr-v4 saltMining.ts (src/__internal__ holds them equal). A
// token's address depends on the suite as it is now (hook, treasury and cap controller can rotate), so the suite is
// read live, and every prediction is cross-checked against `factory.computeTokenAddress`. Suite 3 compiles the
// wallet cap in; a suite 4 token is built with its coin's own terms, under suite 4's creation code.

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

/** A suite 4 factory holds no cap controller: a coin's own is in its terms. */
export type Suite4LiveSuite = Omit<LiveSuite, "capController">;

/** What a suite 4 token is deployed with of its coin's terms (`resolve`): the supply, the wallet cap, who may end it. */
export interface TokenTerms {
  totalSupply: bigint;
  capAmount: bigint;
  capSecs: number | bigint;
  capController: Address;
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

/** A suite 4 factory's live pointers: the same eight, and no cap controller. */
export async function readSuite4LiveSuite(
  client: ReadClient,
  factory: Address,
  blockNumber?: bigint,
): Promise<Suite4LiveSuite> {
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
      abi: suite4FactoryAbi,
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
> & {
  /** A suite 4 launch's resolved terms; absent, the token is suite 3's. */
  terms?: TokenTerms;
};

/** The supply, cap and cap controller a token is built with: its terms' on suite 4, the compiled figures on suite 3. */
function tokenTerms(
  suite: LiveSuite | Suite4LiveSuite,
  identity: TokenIdentity,
): TokenTerms {
  if (identity.terms) return identity.terms;
  if (!("capController" in suite))
    throw new Error("a suite 4 token is predicted from its resolved terms");
  const totalSupply = identity.totalSupply || DEFAULT_TOTAL_SUPPLY;
  return {
    totalSupply,
    capAmount: (totalSupply * BigInt(CAP_BPS)) / 10_000n,
    capSecs: CAP_DURATION_SECS,
    capController: suite.capController,
  };
}

/** BankrLaunchToken creation code ‖ the constructor arguments the ERC-20 token deployer encodes. */
export function tokenInitCode(
  suite: LiveSuite | Suite4LiveSuite,
  identity: TokenIdentity,
  escrow: Address,
): Hex {
  const terms = tokenTerms(suite, identity);
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
      suite.factory,
      identity.metadataUri,
      // The admin is a constructor argument; the trading start is not (the deployer hands it over transiently).
      identity.metadataAdmin,
      terms.capAmount,
      BigInt(terms.capSecs),
      terms.capController,
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
  return concatHex([
    identity.terms ? suite4TokenCreationCode : bankrLaunchTokenCreationCode,
    args,
  ]);
}

/** The token a launch of `identity` by `launcher` with `salt` deploys. Always cross-check `factory.computeTokenAddress`. */
export function predictToken(
  suite: LiveSuite | Suite4LiveSuite,
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

/** keccak256 of the vendored BankrLaunchToken creation code (core's `bankrLaunchTokenCreationCodeHash`), per suite. */
export const launchTokenCreationCodeHash = (suite: 3 | 4 = 3): Hex =>
  keccak256(
    suite === 4 ? suite4TokenCreationCode : bankrLaunchTokenCreationCode,
  );
