import type { Address } from "viem";
import type { LaunchChain } from "./chains/index.js";
import { LaunchConfigError } from "./errors.js";

/** Launch providers this SDK version launches through: Bankr's v4 hook suite. */
export type LaunchProviderId = "bankr_v4";

/**
 * One chain's Bankr v4 suite: `deployments/<chain>.json` key for key, as DeploySuite writes it and core's
 * `BANKR_V4_DEPLOYMENTS` copies it. Pointers the Safe can rotate (hook, treasury, cap controller) are read live from
 * the factory before anything depends on them.
 */
export interface ProviderAddresses {
  readonly chainId: number;
  /** The current hook generation's; older pools stay on theirs. */
  readonly hook: Address;
  readonly ledger: Address;
  readonly factory: Address;
  readonly locker: Address;
  readonly holderRewardsDeployer: Address;
  readonly tokenDeployer: Address;
  readonly tokenDeployerKind: "erc20";
  readonly vestingEscrowImpl: Address;
  readonly launchpadRegistry: Address;
  /** The zero address when presets are off. */
  readonly presetDeployer: Address;
  readonly claimsRedeemer: Address;
  readonly launchRegistryLibrary: Address;
  readonly launchEconomicsLibrary: Address;
  readonly launchPoolLibrary: Address;
  /** LedgerCto, linked into the ledger. */
  readonly ledgerCtoLibrary: Address;
  /** HookCold, linked into the hook. */
  readonly hookColdLibrary: Address;
  readonly create3Factory: Address;
  readonly deployer: Address;
  readonly owner: Address;
  readonly weth: Address;
  readonly treasury: Address;
  /** The chain's BNKR holder leg: sole beneficiary of every launch's holders bucket. */
  readonly holderLeg: Address;
  /** The holder leg's go-live price references (BankrReferenceOracle). A BNKR swap replaces them: the SDK reads the
   *  leg's own (`references()`) wherever it matters. */
  readonly referenceOracle: Address;
  /** BankrBuyback: the buyback payee of every creator bucket that opts in. */
  readonly buyback: Address;
  readonly blockNumber: number;
  /** The contracts commit DeploySuite ran from. */
  readonly gitCommit: string;
  /** Added after a hook rotation: every generation oldest first, `hook` last. */
  readonly hookGenerations?: readonly Address[];
  readonly claimsRedeemers?: readonly Address[];
}

export interface ProviderInfo<C extends LaunchChain = LaunchChain> {
  readonly id: LaunchProviderId;
  readonly chain: C;
  readonly addresses: ProviderAddresses;
  readonly contractsCommit: string;
}

/**
 * The v4 suite per chain, mirroring core's `BANKR_V4_DEPLOYMENTS`: `null` until the chain's suite is broadcast. A
 * record is not enough to launch: the chain's `deployed` flag in `CHAINS` must also be on, or the client a `fork`.
 */
export const BANKR_V4_ADDRESSES: {
  readonly [C in LaunchChain]: ProviderAddresses | null;
} = Object.freeze({
  base: Object.freeze({
    chainId: 8453,
    hook: "0x1ADd2b4b6807294B1944Be1dbb5C96d4d606B8cC",
    ledger: "0xC9448bD5d966e9e8337Dd88EbB795c47a7f8f222",
    factory: "0x6e1290ef311B5a52223a7B0341ac476028A9d367",
    locker: "0xCcCa9abb48eE952671E0cff0EF5eFc06AF259C6c",
    holderRewardsDeployer: "0xE26F651C607Dd0e4A935A584bC415d2FEB3F98dF",
    tokenDeployer: "0x50970A02A42CaC7eb7229C6Bf49853421AD3f32C",
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: "0x3E5e119513876F949aE185eDBa00FaeE20D79A70",
    launchpadRegistry: "0xBE05e9B50376765150aA1FB602a7D967A6fb9367",
    presetDeployer: "0xad46F67FE65219ccd929900961dE162a476629C2",
    claimsRedeemer: "0xB5371BA6059c38fbD3b88B6970Ecabd5f4800a6c",
    launchRegistryLibrary: "0x014B00243e9aF04bc672cB7a352F0afc750b71DD",
    launchEconomicsLibrary: "0x94c4149B13B01D94A402e37e65d6a51170251aAC",
    launchPoolLibrary: "0x7b4C179E7155930D088f27bDDeDcAE3bF89be491",
    ledgerCtoLibrary: "0x72aF0Cd235203F5c4cCf65e2542797165cB3A322",
    hookColdLibrary: "0x3162a4F4A0DB6e511C34c3aCbF939A974Ea4F321",
    create3Factory: "0xD1CBbA51EC36D05EaE7CaF748aF29B56f0c8cabA",
    deployer: "0xa73215E8226258e1A367C85A728AD346172d6530",
    owner: "0xa73215E8226258e1A367C85A728AD346172d6530",
    weth: "0x4200000000000000000000000000000000000006",
    treasury: "0x5f8DA8F88eC81e27f2E22fCB9CA5D926c595E508",
    holderLeg: "0xa80453F0039025C1c9F95574c40A639538980F41",
    referenceOracle: "0x5Af972D251a16a65A5337e6abe39b38808729521",
    buyback: "0x2CDebF12D68136142e068bF705406212CC145C10",
    blockNumber: 56657447,
    gitCommit: "1de5874855ade4715fec424f808c3d8236b23f76",
  }),
  robinhood: null,
  arbitrum: null,
  arc: null,
});

/**
 * Each chain's `config/<chain>.json` capExclusions (core's `BANKR_V4_CAP_EXCLUSIONS`): the aggregator settlers every
 * launch excludes from its 24 h wallet cap. They enter the token's initcode. Absent = the chain has no suite config
 * yet, so no launch can be built for it, fork or not; every chain has one today.
 */
export const BANKR_V4_CAP_EXCLUSIONS: {
  readonly [C in LaunchChain]?: readonly Address[];
} = Object.freeze({
  base: Object.freeze([
    "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
    "0x7747f8d2a76bd6345cc29622a946a929647f2359",
    "0x8f10b468b06c6fd214b65f87778827f7d113f996",
    "0x6ff5693b99212da76ad316178a184ab56d299b43",
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
    "0x09ad820aac5779683b481c4674208a4e1b024afa",
    "0x20f6ee51340adeed01a59b0e65cb3703f3dc860c",
  ] as const),
  robinhood: Object.freeze([
    "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
    "0x1d4b86491ec211257cbedd77a4380a7494624eff",
    "0x8f10b468b06c6fd214b65f87778827f7d113f996",
    "0x8876789976decbfcbbbe364623c63652db8c0904",
  ] as const),
  arbitrum: Object.freeze([] as const),
  arc: Object.freeze([] as const),
});

// Every key a complete record carries: a fork override for a chain without a record must fill all of them.
export const PROVIDER_ADDRESS_KEYS = Object.freeze(
  Object.keys({
    chainId: true,
    hook: true,
    ledger: true,
    factory: true,
    locker: true,
    holderRewardsDeployer: true,
    tokenDeployer: true,
    tokenDeployerKind: true,
    vestingEscrowImpl: true,
    launchpadRegistry: true,
    presetDeployer: true,
    claimsRedeemer: true,
    launchRegistryLibrary: true,
    launchEconomicsLibrary: true,
    launchPoolLibrary: true,
    ledgerCtoLibrary: true,
    hookColdLibrary: true,
    create3Factory: true,
    deployer: true,
    owner: true,
    weth: true,
    treasury: true,
    holderLeg: true,
    referenceOracle: true,
    buyback: true,
    blockNumber: true,
    gitCommit: true,
  } satisfies Record<
    Exclude<keyof ProviderAddresses, "hookGenerations" | "claimsRedeemers">,
    true
  >) as (keyof ProviderAddresses)[],
);

export function isCompleteRecord(
  a: Partial<ProviderAddresses>,
): a is ProviderAddresses {
  return PROVIDER_ADDRESS_KEYS.every((k) => a[k] !== undefined);
}

/**
 * The chain's cap exclusions, the one gate on whether a launch can be built there at all: `PROVIDER_NOT_DEPLOYED`
 * for a chain without a suite config, even on a fork. Adding the chain's row above lifts it.
 */
export function requireCapExclusions(chain: LaunchChain): readonly Address[] {
  const ex = BANKR_V4_CAP_EXCLUSIONS[chain];
  if (!ex) throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", { chain });
  return ex;
}
