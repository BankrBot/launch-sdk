import type { Address } from "viem";
import type { LaunchChain } from "./chains/index.js";

/** Launch providers this SDK version launches through: Bankr's Uniswap v4 launch contracts. */
export type LaunchProviderId = "bankr_v4";

/**
 * One chain's contracts: `deployments/<chain>.json` key for key, as the deploy script writes it and core's record copies
 * it. Pointers the owner can rotate (hook, treasury) are read live from the factory before anything depends on them.
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
  /** The chain's BNKR holder leg in force. A coin keeps the leg of its launch (`contracts().holderLegs`). */
  readonly holderLeg: Address;
  /** The holder leg's go-live price references (BankrReferenceOracle). A BNKR swap replaces them: the SDK reads the
   *  leg's own (`references()`) wherever it matters. */
  readonly referenceOracle: Address;
  /** BankrBuyback: the buyback payee of every creator bucket that opts in. */
  readonly buyback: Address;
  readonly blockNumber: number;
  /** The commit the contracts were deployed from. */
  readonly gitCommit: string;
  /** BankrLaunchSettings, which holds every launchpad's terms and judges a launch (`resolve`). */
  readonly settings: Address;
  /** BankrTermsLens, which reads a coin's stored terms and holds them to its record. */
  readonly termsLens: Address;
  /** RaffleRunCode: Raffle Run's creation code, which the preset deployer reads. */
  readonly raffleRunCode: Address;
  readonly launchResolverLibrary: Address;
  readonly launchPricingLibrary: Address;
  readonly settingsColdLibrary: Address;
  readonly ledgerColdLibrary: Address;
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
 * Bankr's contracts per chain, core's record key for key. A chain's record here is what makes it live: a client
 * launches there without `fork`.
 */
export const BANKR_V4_LAUNCH_ADDRESSES: {
  readonly [C in LaunchChain]: ProviderAddresses;
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
    holderLeg: "0x022624267f01a1F034809943bDB5d92F256d5991",
    referenceOracle: "0x0e30e91f298aB6FF8f200c04c17F34C73b6Cc1ee",
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
  robinhood: Object.freeze({
    chainId: 4663,
    hook: "0xf8Df392d399aF9c1235B02e5df8c56fEdb7978Cc",
    ledger: "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
    factory: "0x2F2FDedE5b61D9B624462FB9e138913fD2620427",
    locker: "0x6436f3A1755a11553af9E0399dFf3d5c1ddbA5f6",
    holderRewardsDeployer: "0xbd0C5159C97d12916957E33E509aF7d652Ec6b77",
    tokenDeployer: "0x77900f98aBd1a84e0F96088A81233423061E4698",
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: "0xFcd738eC0ed08b8d151aef5d41DF448E12ca11da",
    launchpadRegistry: "0x893Bfef8dD523e9cf28f91498eE305Cbeb37ac80",
    presetDeployer: "0x7428a12d9A3543b6EF4A2aD3275e45bb87e2440C",
    claimsRedeemer: "0x5AF6F17dB59f7E7d7279184900446AbCf127B546",
    launchRegistryLibrary: "0x93d8Ec767b641d7Ca6fef1544a1911FA24F4FB86",
    launchEconomicsLibrary: "0x39a0d989dC68967c0b1084eAc7d0AD0608CC4F10",
    launchPoolLibrary: "0x3FaBf898070fCed54321218Af13590AdfDD3d240",
    ledgerCtoLibrary: "0x41B2c9dea6FC0E588620bE61fb513Ef300B45bef",
    hookColdLibrary: "0x13f79Efa7272BfC6EBB823fDf6419446A8dAbFa7",
    create3Factory: "0xD1CBbA51EC36D05EaE7CaF748aF29B56f0c8cabA",
    deployer: "0xa73215E8226258e1A367C85A728AD346172d6530",
    owner: "0xa73215E8226258e1A367C85A728AD346172d6530",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    treasury: "0x5f8DA8F88eC81e27f2E22fCB9CA5D926c595E508",
    holderLeg: "0xB25d2E3e72a00bDd97d47cF8e22B3BE6C74A38A8",
    referenceOracle: "0x89d03Da2ecDa2dC7D8C08900174CD3710A53ebe2",
    buyback: "0xce14daAF9f405BF18382022C3cA335C9Faf92D55",
    blockNumber: 118608550,
    gitCommit: "a24a73f4fcf908ab92467672afbc909850eb23d8",
    settings: "0x7fD2Bd17387e3dA342db0952Ba0b2f250114Fda2",
    termsLens: "0xeDd74F56afDc34d9Bf6a083C580588514dd4aA62",
    raffleRunCode: "0x2761Ff8aFe0d37e26b1f614DCad081c3799D65B1",
    launchResolverLibrary: "0xBcFA0Ca101b719EBde9b00e63a18981Be403f4F3",
    launchPricingLibrary: "0x0f8947CF24cfb872cc455a4232f6cDaEff723B77",
    settingsColdLibrary: "0x5015D7e1c307e2A7B85a302EC9a3901E9BCc3Ff6",
    ledgerColdLibrary: "0x928B8D8F728144Cf43b5BBf251b575CE6013d667",
  }),
  arbitrum: Object.freeze({
    chainId: 42161,
    hook: "0xf8Df392d399aF9c1235B02e5df8c56fEdb7978Cc",
    ledger: "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
    factory: "0x2F2FDedE5b61D9B624462FB9e138913fD2620427",
    locker: "0x6436f3A1755a11553af9E0399dFf3d5c1ddbA5f6",
    holderRewardsDeployer: "0xbd0C5159C97d12916957E33E509aF7d652Ec6b77",
    tokenDeployer: "0x77900f98aBd1a84e0F96088A81233423061E4698",
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: "0xFcd738eC0ed08b8d151aef5d41DF448E12ca11da",
    launchpadRegistry: "0x893Bfef8dD523e9cf28f91498eE305Cbeb37ac80",
    presetDeployer: "0x7428a12d9A3543b6EF4A2aD3275e45bb87e2440C",
    claimsRedeemer: "0x5AF6F17dB59f7E7d7279184900446AbCf127B546",
    launchRegistryLibrary: "0x93d8Ec767b641d7Ca6fef1544a1911FA24F4FB86",
    launchEconomicsLibrary: "0x39a0d989dC68967c0b1084eAc7d0AD0608CC4F10",
    launchPoolLibrary: "0x3FaBf898070fCed54321218Af13590AdfDD3d240",
    ledgerCtoLibrary: "0x41B2c9dea6FC0E588620bE61fb513Ef300B45bef",
    hookColdLibrary: "0x13f79Efa7272BfC6EBB823fDf6419446A8dAbFa7",
    create3Factory: "0xD1CBbA51EC36D05EaE7CaF748aF29B56f0c8cabA",
    deployer: "0xa73215E8226258e1A367C85A728AD346172d6530",
    owner: "0xa73215E8226258e1A367C85A728AD346172d6530",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    treasury: "0x5f8DA8F88eC81e27f2E22fCB9CA5D926c595E508",
    holderLeg: "0xB25d2E3e72a00bDd97d47cF8e22B3BE6C74A38A8",
    referenceOracle: "0x89d03Da2ecDa2dC7D8C08900174CD3710A53ebe2",
    buyback: "0xce14daAF9f405BF18382022C3cA335C9Faf92D55",
    blockNumber: 525760842,
    gitCommit: "a24a73f4fcf908ab92467672afbc909850eb23d8",
    settings: "0x7fD2Bd17387e3dA342db0952Ba0b2f250114Fda2",
    termsLens: "0xeDd74F56afDc34d9Bf6a083C580588514dd4aA62",
    raffleRunCode: "0x2761Ff8aFe0d37e26b1f614DCad081c3799D65B1",
    launchResolverLibrary: "0xBcFA0Ca101b719EBde9b00e63a18981Be403f4F3",
    launchPricingLibrary: "0x0f8947CF24cfb872cc455a4232f6cDaEff723B77",
    settingsColdLibrary: "0x5015D7e1c307e2A7B85a302EC9a3901E9BCc3Ff6",
    ledgerColdLibrary: "0x928B8D8F728144Cf43b5BBf251b575CE6013d667",
  }),
  arc: Object.freeze({
    chainId: 5042,
    hook: "0xf8Df392d399aF9c1235B02e5df8c56fEdb7978Cc",
    ledger: "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
    factory: "0x2F2FDedE5b61D9B624462FB9e138913fD2620427",
    locker: "0x6436f3A1755a11553af9E0399dFf3d5c1ddbA5f6",
    holderRewardsDeployer: "0xbd0C5159C97d12916957E33E509aF7d652Ec6b77",
    tokenDeployer: "0x77900f98aBd1a84e0F96088A81233423061E4698",
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: "0xFcd738eC0ed08b8d151aef5d41DF448E12ca11da",
    launchpadRegistry: "0x893Bfef8dD523e9cf28f91498eE305Cbeb37ac80",
    presetDeployer: "0x7428a12d9A3543b6EF4A2aD3275e45bb87e2440C",
    claimsRedeemer: "0x5AF6F17dB59f7E7d7279184900446AbCf127B546",
    launchRegistryLibrary: "0x93d8Ec767b641d7Ca6fef1544a1911FA24F4FB86",
    launchEconomicsLibrary: "0x39a0d989dC68967c0b1084eAc7d0AD0608CC4F10",
    launchPoolLibrary: "0x3FaBf898070fCed54321218Af13590AdfDD3d240",
    ledgerCtoLibrary: "0x41B2c9dea6FC0E588620bE61fb513Ef300B45bef",
    hookColdLibrary: "0x13f79Efa7272BfC6EBB823fDf6419446A8dAbFa7",
    create3Factory: "0xD1CBbA51EC36D05EaE7CaF748aF29B56f0c8cabA",
    deployer: "0xa73215E8226258e1A367C85A728AD346172d6530",
    owner: "0xa73215E8226258e1A367C85A728AD346172d6530",
    weth: "0x0000000000000000000000000000000000000000",
    treasury: "0x5f8DA8F88eC81e27f2E22fCB9CA5D926c595E508",
    holderLeg: "0xB25d2E3e72a00bDd97d47cF8e22B3BE6C74A38A8",
    referenceOracle: "0x89d03Da2ecDa2dC7D8C08900174CD3710A53ebe2",
    buyback: "0xce14daAF9f405BF18382022C3cA335C9Faf92D55",
    blockNumber: 32132861,
    gitCommit: "a24a73f4fcf908ab92467672afbc909850eb23d8",
    settings: "0x7fD2Bd17387e3dA342db0952Ba0b2f250114Fda2",
    termsLens: "0xeDd74F56afDc34d9Bf6a083C580588514dd4aA62",
    raffleRunCode: "0x2761Ff8aFe0d37e26b1f614DCad081c3799D65B1",
    launchResolverLibrary: "0xBcFA0Ca101b719EBde9b00e63a18981Be403f4F3",
    launchPricingLibrary: "0x0f8947CF24cfb872cc455a4232f6cDaEff723B77",
    settingsColdLibrary: "0x5015D7e1c307e2A7B85a302EC9a3901E9BCc3Ff6",
    ledgerColdLibrary: "0x928B8D8F728144Cf43b5BBf251b575CE6013d667",
  }),
  ethereum: Object.freeze({
    chainId: 1,
    hook: "0xf8Df392d399aF9c1235B02e5df8c56fEdb7978Cc",
    ledger: "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
    factory: "0x2F2FDedE5b61D9B624462FB9e138913fD2620427",
    locker: "0x6436f3A1755a11553af9E0399dFf3d5c1ddbA5f6",
    holderRewardsDeployer: "0xbd0C5159C97d12916957E33E509aF7d652Ec6b77",
    tokenDeployer: "0x77900f98aBd1a84e0F96088A81233423061E4698",
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: "0xFcd738eC0ed08b8d151aef5d41DF448E12ca11da",
    launchpadRegistry: "0x893Bfef8dD523e9cf28f91498eE305Cbeb37ac80",
    presetDeployer: "0x7428a12d9A3543b6EF4A2aD3275e45bb87e2440C",
    claimsRedeemer: "0x5AF6F17dB59f7E7d7279184900446AbCf127B546",
    launchRegistryLibrary: "0x93d8Ec767b641d7Ca6fef1544a1911FA24F4FB86",
    launchEconomicsLibrary: "0x39a0d989dC68967c0b1084eAc7d0AD0608CC4F10",
    launchPoolLibrary: "0x3FaBf898070fCed54321218Af13590AdfDD3d240",
    ledgerCtoLibrary: "0x41B2c9dea6FC0E588620bE61fb513Ef300B45bef",
    hookColdLibrary: "0x13f79Efa7272BfC6EBB823fDf6419446A8dAbFa7",
    create3Factory: "0xD1CBbA51EC36D05EaE7CaF748aF29B56f0c8cabA",
    deployer: "0xa73215E8226258e1A367C85A728AD346172d6530",
    owner: "0xa73215E8226258e1A367C85A728AD346172d6530",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    treasury: "0x5f8DA8F88eC81e27f2E22fCB9CA5D926c595E508",
    holderLeg: "0xB25d2E3e72a00bDd97d47cF8e22B3BE6C74A38A8",
    referenceOracle: "0x89d03Da2ecDa2dC7D8C08900174CD3710A53ebe2",
    buyback: "0xce14daAF9f405BF18382022C3cA335C9Faf92D55",
    blockNumber: 26452592,
    gitCommit: "a24a73f4fcf908ab92467672afbc909850eb23d8",
    settings: "0x7fD2Bd17387e3dA342db0952Ba0b2f250114Fda2",
    termsLens: "0xeDd74F56afDc34d9Bf6a083C580588514dd4aA62",
    raffleRunCode: "0x2761Ff8aFe0d37e26b1f614DCad081c3799D65B1",
    launchResolverLibrary: "0xBcFA0Ca101b719EBde9b00e63a18981Be403f4F3",
    launchPricingLibrary: "0x0f8947CF24cfb872cc455a4232f6cDaEff723B77",
    settingsColdLibrary: "0x5015D7e1c307e2A7B85a302EC9a3901E9BCc3Ff6",
    ledgerColdLibrary: "0x928B8D8F728144Cf43b5BBf251b575CE6013d667",
  }),
  bnb: Object.freeze({
    chainId: 56,
    hook: "0xf8Df392d399aF9c1235B02e5df8c56fEdb7978Cc",
    ledger: "0x15e5F60817ee337f58A0B6c34b905C7C2dBC2F64",
    factory: "0x2F2FDedE5b61D9B624462FB9e138913fD2620427",
    locker: "0x6436f3A1755a11553af9E0399dFf3d5c1ddbA5f6",
    holderRewardsDeployer: "0xbd0C5159C97d12916957E33E509aF7d652Ec6b77",
    tokenDeployer: "0x77900f98aBd1a84e0F96088A81233423061E4698",
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: "0xFcd738eC0ed08b8d151aef5d41DF448E12ca11da",
    launchpadRegistry: "0x893Bfef8dD523e9cf28f91498eE305Cbeb37ac80",
    presetDeployer: "0x7428a12d9A3543b6EF4A2aD3275e45bb87e2440C",
    claimsRedeemer: "0x5AF6F17dB59f7E7d7279184900446AbCf127B546",
    launchRegistryLibrary: "0x93d8Ec767b641d7Ca6fef1544a1911FA24F4FB86",
    launchEconomicsLibrary: "0x39a0d989dC68967c0b1084eAc7d0AD0608CC4F10",
    launchPoolLibrary: "0x3FaBf898070fCed54321218Af13590AdfDD3d240",
    ledgerCtoLibrary: "0x41B2c9dea6FC0E588620bE61fb513Ef300B45bef",
    hookColdLibrary: "0x13f79Efa7272BfC6EBB823fDf6419446A8dAbFa7",
    create3Factory: "0xD1CBbA51EC36D05EaE7CaF748aF29B56f0c8cabA",
    deployer: "0xa73215E8226258e1A367C85A728AD346172d6530",
    owner: "0xa73215E8226258e1A367C85A728AD346172d6530",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    treasury: "0x5f8DA8F88eC81e27f2E22fCB9CA5D926c595E508",
    holderLeg: "0xB25d2E3e72a00bDd97d47cF8e22B3BE6C74A38A8",
    referenceOracle: "0x89d03Da2ecDa2dC7D8C08900174CD3710A53ebe2",
    buyback: "0xce14daAF9f405BF18382022C3cA335C9Faf92D55",
    blockNumber: 134621794,
    gitCommit: "2ede38d0ec729484a3c44c3029ef4175cee9d283",
    settings: "0x7fD2Bd17387e3dA342db0952Ba0b2f250114Fda2",
    termsLens: "0xeDd74F56afDc34d9Bf6a083C580588514dd4aA62",
    raffleRunCode: "0x2761Ff8aFe0d37e26b1f614DCad081c3799D65B1",
    launchResolverLibrary: "0xBcFA0Ca101b719EBde9b00e63a18981Be403f4F3",
    launchPricingLibrary: "0x0f8947CF24cfb872cc455a4232f6cDaEff723B77",
    settingsColdLibrary: "0x5015D7e1c307e2A7B85a302EC9a3901E9BCc3Ff6",
    ledgerColdLibrary: "0x928B8D8F728144Cf43b5BBf251b575CE6013d667",
  }),
});

/**
 * Each chain's `config/<chain>.json` capExclusions (core's `BANKR_V4_CAP_EXCLUSIONS`): the aggregator settlers every
 * launch excludes from its wallet cap. They enter the token's initcode.
 */
export const BANKR_V4_CAP_EXCLUSIONS: {
  readonly [C in LaunchChain]: readonly Address[];
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
  ethereum: Object.freeze([] as const),
  bnb: Object.freeze([] as const),
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
    settings: true,
    termsLens: true,
    raffleRunCode: true,
    launchResolverLibrary: true,
    launchPricingLibrary: true,
    settingsColdLibrary: true,
    ledgerColdLibrary: true,
  } satisfies Record<
    Exclude<keyof ProviderAddresses, "hookGenerations" | "claimsRedeemers">,
    true
  >) as (keyof ProviderAddresses)[],
);

/**
 * The addresses a client starts from: an override is merged over the chain's record, unless it names another
 * factory. That factory's contracts are its own, so the override then stands alone and must be the whole record.
 */
export function mergeAddresses(
  chain: LaunchChain,
  override: Partial<ProviderAddresses> | undefined,
): Partial<ProviderAddresses> {
  const record = BANKR_V4_LAUNCH_ADDRESSES[chain];
  const factory = override?.factory;
  const own =
    factory !== undefined &&
    factory.toLowerCase() !== record.factory.toLowerCase();
  return own ? { ...override } : { ...record, ...override };
}

/** Whether `a` is the record this SDK version ships for `chain`: the one thing that makes a chain live. */
export function isShippedRecord(
  chain: LaunchChain,
  a: Pick<ProviderAddresses, "factory" | "settings">,
): boolean {
  const record = BANKR_V4_LAUNCH_ADDRESSES[chain];
  return (
    record.settings.toLowerCase() === a.settings.toLowerCase() &&
    record.factory.toLowerCase() === a.factory.toLowerCase()
  );
}

export function isCompleteRecord(
  a: Partial<ProviderAddresses>,
): a is ProviderAddresses {
  return PROVIDER_ADDRESS_KEYS.every((k) => a[k] !== undefined);
}
