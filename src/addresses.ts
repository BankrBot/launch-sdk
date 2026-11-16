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
  /**
   * Suite 4 only: BankrLaunchSettings, which holds every pad's terms and judges a launch (`resolve`). A record that
   * names it is suite 4's, and the client plans its launches against it; suite 3 has none.
   */
  readonly settings?: Address;
  /** Suite 4 only: BankrTermsLens, which reads a coin's stored terms and holds them to its record. */
  readonly termsLens?: Address;
}

/** A suite 4 record: core's `BankrV4Suite4Deployment` key for key, suite 3's keys and the seven DeploySuite adds. */
export interface Suite4Addresses extends ProviderAddresses {
  readonly settings: Address;
  readonly termsLens: Address;
  /** RaffleRunCode: Raffle Run's creation code, which the preset deployer reads. */
  readonly raffleRunCode: Address;
  readonly launchResolverLibrary: Address;
  readonly launchPricingLibrary: Address;
  readonly settingsColdLibrary: Address;
  readonly ledgerColdLibrary: Address;
}

/** Whether a record is suite 4's: it names a settings contract (core's `isBankrV4Suite4Record`). */
export const isSuite4Record = (
  a: Partial<ProviderAddresses>,
): a is Partial<ProviderAddresses> & { settings: Address } =>
  a.settings !== undefined;

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
 * Suite 4 per chain, core's `BANKR_V4_SUITE4_DEPLOYMENTS` key for key: `null` until that chain's suite 4 is
 * broadcast. Both suites run side by side. A chain's record here is its suite 4 go-live: from then `suite: 4`
 * launches there without `fork`. It moves no client that names no suite (`chooseSuite`).
 */
export const BANKR_V4_SUITE4_ADDRESSES: {
  readonly [C in LaunchChain]: Suite4Addresses | null;
} = Object.freeze({
  base: Object.freeze({
    chainId: 8453,
    hook: "0xf8Df392d399aF9c1235B02e5df8c56fEdb7978Cc",
    ledger: "0x7C836e937831Cd5931A1ACbB9117dF9714D7d1F7",
    factory: "0x8cdE4Edb9A51909eef93F102f5Ce1b950769792E",
    locker: "0x9525077330d2f7954CC85820227921acD7BD45ff",
    holderRewardsDeployer: "0x91DD41b8DFfAC2ca59FAD5Cd2bB8fa032189F245",
    tokenDeployer: "0x9176b7E0dd4A8d1d42aFA4a13FB254d74F2E095f",
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: "0xa93b63846dcDf351B489d9b528aFe9a670FC7592",
    launchpadRegistry: "0x893Bfef8dD523e9cf28f91498eE305Cbeb37ac80",
    presetDeployer: "0x26cD5E95d577492F72E24529e7A64B6cFdD6896e",
    claimsRedeemer: "0x5AF6F17dB59f7E7d7279184900446AbCf127B546",
    launchRegistryLibrary: "0x93d8Ec767b641d7Ca6fef1544a1911FA24F4FB86",
    launchEconomicsLibrary: "0x39a0d989dC68967c0b1084eAc7d0AD0608CC4F10",
    launchPoolLibrary: "0x3FaBf898070fCed54321218Af13590AdfDD3d240",
    ledgerCtoLibrary: "0x41B2c9dea6FC0E588620bE61fb513Ef300B45bef",
    hookColdLibrary: "0x13f79Efa7272BfC6EBB823fDf6419446A8dAbFa7",
    create3Factory: "0xD1CBbA51EC36D05EaE7CaF748aF29B56f0c8cabA",
    deployer: "0xa73215E8226258e1A367C85A728AD346172d6530",
    owner: "0xa73215E8226258e1A367C85A728AD346172d6530",
    weth: "0x4200000000000000000000000000000000000006",
    treasury: "0x5f8DA8F88eC81e27f2E22fCB9CA5D926c595E508",
    holderLeg: "0x5F18019C00Eed28fADC7B41Bd9218e0f1d3c5359",
    referenceOracle: "0x667dBeE98d7fbBb16A303B2571546Fc6175A69bC",
    buyback: "0x54EC7852807D3F002EB64b360fC06C938c8b71f7",
    blockNumber: 57978620,
    gitCommit: "5bffed4ea0936473fb09c6fd027312762f5bf692",
    settings: "0xdaaee43D50D7b081C6b990eD362E2d4cFc56e1aa",
    termsLens: "0x0Ec2F172D558FA1289B695C06B8d265C8795F43F",
    raffleRunCode: "0x60B5A40e87938eD02287F17ad96e6e37aDD5b984",
    launchResolverLibrary: "0xBcFA0Ca101b719EBde9b00e63a18981Be403f4F3",
    launchPricingLibrary: "0x0f8947CF24cfb872cc455a4232f6cDaEff723B77",
    settingsColdLibrary: "0x5015D7e1c307e2A7B85a302EC9a3901E9BCc3Ff6",
    ledgerColdLibrary: "0x928B8D8F728144Cf43b5BBf251b575CE6013d667",
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

/** The seven keys a suite 4 record adds to suite 3's (core's `BANKR_V4_SUITE4_RECORD_KEYS`). */
export const SUITE4_ADDRESS_KEYS = Object.freeze(
  Object.keys({
    settings: true,
    termsLens: true,
    raffleRunCode: true,
    launchResolverLibrary: true,
    launchPricingLibrary: true,
    settingsColdLibrary: true,
    ledgerColdLibrary: true,
  } satisfies Record<
    | Exclude<keyof Suite4Addresses, keyof ProviderAddresses>
    | "settings"
    | "termsLens",
    true
  >) as (keyof Suite4Addresses)[],
);

/**
 * The suite of a client that names none. Suite 3 until suite 4's after-launch reads and API mode are ported: a
 * suite 4 record landing must not move a caller off suite 3 (Bankr's own launchpad launches only in API mode).
 */
export const DEFAULT_SUITE: 3 | 4 = 3;

/** The records a client is built from; a test passes its own. */
export interface SuiteRecords {
  readonly suite3: { readonly [C in LaunchChain]: ProviderAddresses | null };
  readonly suite4: { readonly [C in LaunchChain]: Suite4Addresses | null };
}

/**
 * The suite a client is on and the addresses it starts from. A named `suite` wins; unnamed, `addresses` that name
 * a settings contract are suite 4's and anything else is `DEFAULT_SUITE`. The override is merged over that suite's
 * own record only, so a client never holds one suite's settings beside the other's contracts.
 */
export function chooseSuite(
  chain: LaunchChain,
  o: { suite?: 3 | 4; addresses?: Partial<ProviderAddresses> },
  records: SuiteRecords = {
    suite3: BANKR_V4_ADDRESSES,
    suite4: BANKR_V4_SUITE4_ADDRESSES,
  },
): { suite: 3 | 4; addresses: Partial<ProviderAddresses> } {
  const suite =
    o.suite ?? (o.addresses?.settings !== undefined ? 4 : DEFAULT_SUITE);
  const record = suite === 4 ? records.suite4[chain] : records.suite3[chain];
  return { suite, addresses: { ...record, ...o.addresses } };
}

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
    Exclude<
      keyof ProviderAddresses,
      "hookGenerations" | "claimsRedeemers" | "settings" | "termsLens"
    >,
    true
  >) as (keyof ProviderAddresses)[],
);

/** Whether `a` is the suite 4 this SDK version ships for `chain`: the record that went through its go-live. */
export function isShippedSuite4(
  chain: LaunchChain,
  a: Pick<ProviderAddresses, "factory" | "settings">,
): boolean {
  const record = BANKR_V4_SUITE4_ADDRESSES[chain];
  return (
    record !== null &&
    a.settings !== undefined &&
    record.settings.toLowerCase() === a.settings.toLowerCase() &&
    record.factory.toLowerCase() === a.factory.toLowerCase()
  );
}

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
