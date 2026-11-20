import type { Address, Hex } from "viem";
import { readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchpadRegistryAbi,
} from "../abis/settings.js";
import type { ChainCapabilities, LaunchChain } from "../chains/index.js";
import { LaunchRefusedError } from "../errors.js";
import type { ReadClient, UnsignedTx } from "../providers/types.js";
import { requireAddress } from "../recipient.js";
import { buildCallTx } from "../tx.js";

/** The contracts the settings reads and admin builders call: a subset of the chain's record. */
export interface SettingsAddresses {
  readonly factory: Address;
  readonly launchpadRegistry: Address;
  /** BankrLaunchSettings: every setting, and the launch check. */
  readonly settings: Address;
  readonly ledger: Address;
  /** BankrTermsLens. Only a coin's stored terms and its fingerprint check need it. */
  readonly termsLens?: Address;
  /** The block the contracts were deployed in: where a scan of their logs starts. */
  readonly blockNumber?: number;
}

/** One chain's contracts and a client to read them. Nothing built from it signs or sends. */
export interface SettingsContext {
  chain: ChainCapabilities;
  client: ReadClient;
  addresses: SettingsAddresses;
}

/**
 * The contracts' addresses from the factory alone: the settings contract, the launchpad registry and the ledger are the
 * factory's own pointers, set once. The lens has no pointer on chain, so pass it where the coin reads are used.
 */
export async function readSettingsAddresses(
  client: ReadClient,
  factory: Address,
  termsLens?: Address,
): Promise<SettingsAddresses> {
  const f = { address: factory, abi: bankrLaunchFactoryAbi } as const;
  const [settings, launchpadRegistry, ledger] = await Promise.all([
    readContract(client, { ...f, functionName: "settings" }),
    readContract(client, { ...f, functionName: "launchpadRegistry" }),
    readContract(client, { ...f, functionName: "ledger" }),
  ]);
  return { factory, launchpadRegistry, settings, ledger, termsLens };
}

export const MAX_UINT64 = 2n ** 64n - 1n;
/** Bankr's own launchpad. Its rows in the settings contract are the owner's. */
export const BANKR_PAD = 0n;

type Refuse = (detail: string) => never;

/** What every builder and read in this folder shares: who sends, and how a broken rule is refused. */
export interface SettingsKit {
  chain: LaunchChain;
  client: ReadClient;
  addresses: SettingsAddresses;
  factory: { address: Address; abi: typeof bankrLaunchFactoryAbi };
  registry: { address: Address; abi: typeof bankrLaunchpadRegistryAbi };
  /** A value that is not what the call takes: `INVALID_PARAMS`. */
  invalid: Refuse;
  /** A pad change the settings contract or the registry would revert: `INVALID_LAUNCHPAD_CONFIG`. */
  padRule: Refuse;
  /** An owner change the settings contract, the factory or the registry would revert: `INVALID_SETTINGS`. */
  ownerRule: Refuse;
  requireId(id: unknown): bigint;
  address(value: unknown, what: string, zeroOk?: boolean): Address;
  flag(value: unknown, what: string): boolean;
  /** A whole number in `[0, max]`, as a bigint. */
  uint(value: unknown, max: bigint, what: string): bigint;
  /** The factory's owner: sends every owner change of the settings contract and the factory. */
  owner(): Promise<Address>;
  registryOwner(): Promise<Address>;
  /** `UNKNOWN_LAUNCHPAD` past the last registered id. Ids are sequential from 1; 0 is Bankr's. */
  requireRegistered(id: bigint): Promise<void>;
  /** Who sends a pad's settings change: its operator, read live; for Bankr's pad the factory's owner. */
  settingsOperator(id: bigint): Promise<Address>;
  /** Who sends a pad's registry calls (signer, link, pause, vanity, handover); Bankr's pad: the registry's owner. */
  registryOperator(id: bigint): Promise<Address>;
  call(from: Address, to: Address, data: Hex): UnsignedTx;
}

export function settingsKit(ctx: SettingsContext): SettingsKit {
  const { client, addresses: a } = ctx;
  const chain = ctx.chain.chain;
  const factory = { address: a.factory, abi: bankrLaunchFactoryAbi } as const;
  const registry = {
    address: a.launchpadRegistry,
    abi: bankrLaunchpadRegistryAbi,
  } as const;

  function invalid(detail: string): never {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain, detail });
  }

  function padRule(detail: string): never {
    throw new LaunchRefusedError("INVALID_LAUNCHPAD_CONFIG", { chain, detail });
  }

  function ownerRule(detail: string): never {
    throw new LaunchRefusedError("INVALID_SETTINGS", { chain, detail });
  }

  const requireId = (id: unknown): bigint =>
    typeof id === "bigint" && id >= 0n && id <= MAX_UINT64
      ? id
      : invalid("A launchpad id is a bigint, such as 1n.");

  const address = (value: unknown, what: string, zeroOk = false): Address =>
    requireAddress(value, chain, what, zeroOk);

  const flag = (value: unknown, what: string): boolean =>
    typeof value === "boolean" ? value : invalid(`${what} is true or false.`);

  function uint(value: unknown, max: bigint, what: string): bigint {
    const n =
      typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : value;
    return typeof n === "bigint" && n >= 0n && n <= max
      ? n
      : invalid(`${what} is a whole number from 0 to ${max}.`);
  }

  const owner = (): Promise<Address> =>
    readContract(client, { ...factory, functionName: "owner" });
  const registryOwner = (): Promise<Address> =>
    readContract(client, { ...registry, functionName: "owner" });

  async function requireRegistered(id: bigint): Promise<void> {
    const count = await readContract(client, {
      ...registry,
      functionName: "launchpadCount",
    });
    if (id > count)
      throw new LaunchRefusedError("UNKNOWN_LAUNCHPAD", { chain });
  }

  async function settingsOperator(id: bigint): Promise<Address> {
    const [, who] = await Promise.all([
      requireRegistered(id),
      id === BANKR_PAD
        ? owner()
        : readContract(client, {
            ...registry,
            functionName: "operatorOf",
            args: [id],
          }),
    ]);
    return who;
  }

  async function registryOperator(id: bigint): Promise<Address> {
    const [, who] = await Promise.all([
      requireRegistered(id),
      readContract(client, {
        ...registry,
        functionName: "operatorOf",
        args: [id],
      }),
    ]);
    return who;
  }

  const call = (from: Address, to: Address, data: Hex): UnsignedTx =>
    buildCallTx(ctx.chain.chainId, from, to, data);

  return {
    chain,
    client,
    addresses: a,
    factory,
    registry,
    invalid,
    padRule,
    ownerRule,
    requireId,
    address,
    flag,
    uint,
    owner,
    registryOwner,
    requireRegistered,
    settingsOperator,
    registryOperator,
    call,
  };
}
