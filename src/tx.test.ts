import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  hexToString,
  sliceHex,
  zeroAddress,
  type Hex,
} from "viem";
import { bankrLaunchFactoryAbi } from "./abis/generated.js";
import { CHAINS, EIP_7825_MAX_TX_GAS } from "./chains/index.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { buildLaunchParams } from "./normalize.js";
import type { LaunchParams, LaunchPlan } from "./providers/types.js";
import { testRecord } from "./__internal__/fakeRecord.js";
import {
  BANKR_BUILDER_CODE,
  LAUNCH_ALLOCATION_GAS,
  LAUNCH_LINK_BYTE_GAS,
  LAUNCH_PAD_PAYEE_GAS,
  buildApproveTx,
  buildLaunchTx,
  builderCodeSuffix,
  clampLaunchGas,
  encodeBuilderCodeSuffix,
  launchGasFallback,
  type LaunchGasWeight,
} from "./tx.js";

const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const ERC_MARKER = "80218021802180218021802180218021";

function expectCode(fn: () => unknown, code: LaunchSdkErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
}

const SUITE = testRecord(8453);
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const ECON = {
  buy: { startPips: 10_000, steadyPips: 10_000, decaySecs: 0 },
  sell: { startPips: 10_000, steadyPips: 10_000, decaySecs: 0 },
  referrerBps: 0,
  holdersBps: 0,
  autoLpBps: 3_000,
  buybackBps: 0,
  vestToHoldersBps: 0,
  vestToHoldersCliff: 0n,
  vestToHoldersDuration: 0n,
};
const PARAMS: LaunchParams = {
  options: "0x",
  ...buildLaunchParams({
    name: "Launch SDK Test",
    symbol: "LSDK",
    metadataUri: "ipfs://bafy-test",
    metadataAdmin: zeroAddress,
    salt: `0x${"ab".repeat(32)}`,
    quote: WETH,
    capExclusions: [],
    startTick: -200_000,
    deadline: 1_800_000_000n,
    economics: ECON,
    launchpadId: 1n,
    maxOperatorShareBps: 1_000,
    operatorPayeesHash: `0x${"cd".repeat(32)}`,
    feeRecipients: [{ recipient: LAUNCHER, shareBps: 10_000 }],
    allowOpenCodeFeeRecipients: false,
    vestingRecipient: LAUNCHER,
    vestBps: 0,
    allowCodeVestingRecipient: false,
    devBuyAmountIn: 0n,
    startTime: 0,
  }),
};

/** What a plan carries of its launch check; `gasWeight` is all these tests read of it. */
const resolvedWith = (gasWeight: LaunchGasWeight) =>
  ({ gasWeight }) as LaunchPlan["resolved"];

function plan(over: Partial<LaunchPlan<"base">> = {}): LaunchPlan<"base"> {
  return {
    chain: "base",
    provider: "bankr_v4",
    factory: SUITE.factory,
    launcher: LAUNCHER,
    launchpadId: 1n,
    params: PARAMS,
    value: 10n ** 16n,
    predictedToken: getAddress("0x0000000000000000000000000000000000000abc"),
    poolId: `0x${"01".repeat(32)}`,
    tokenIsCurrency0: true,
    distributor: getAddress("0x0000000000000000000000000000000000000def"),
    escrow: null,
    extension: null,
    quote: {
      symbol: "WETH",
      address: WETH,
      decimals: 18,
      isDefault: true,
      listed: true,
      pricing: "chainlink",
      devBuy: "native",
    },
    economics: ECON,
    holderShareBps: 0,
    volumeSplit: {
      feePips: 10_000,
      bankrPips: 500,
      holdersBnkrPips: 500,
      referrerPips: 0,
      payees: [],
      creatorHoldersPips: 0,
      autoLpPips: 2_700,
      buybackPips: 0,
      creatorPips: 6_300,
    },
    approvals: [],
    devBuyOut: 1n,
    gasEstimate: 8_000_000n,
    dataSuffix: undefined,
    resolved: resolvedWith({ padPayees: 2, linkBytes: 0 }),
    ...over,
  };
}

describe("ERC-8021 builder-code suffix (schema 0)", () => {
  test("codes ‖ length ‖ schema 0 ‖ the 16-byte marker, matching the reference vector", () => {
    // ox's documented vector for codes ["baseapp", "morpho"].
    expect(encodeBuilderCodeSuffix(["baseapp", "morpho"])).toBe(
      `0x626173656170702c6d6f7270686f0e00${ERC_MARKER}`,
    );
    const one = encodeBuilderCodeSuffix([BANKR_BUILDER_CODE]);
    expect(one.endsWith(`0b00${ERC_MARKER}`)).toBe(true);
    expect(hexToString(sliceHex(one, 0, 11))).toBe(BANKR_BUILDER_CODE);
  });

  test("refuses empty, comma-bearing, non-printable-ASCII or over-long code lists", () => {
    for (const codes of [
      [],
      [""],
      ["a,b"],
      ["café"],
      ["has space"],
      ["x".repeat(256)],
      ["x".repeat(200), "y".repeat(60)],
    ]) {
      expectCode(() => encodeBuilderCodeSuffix(codes), "INVALID_PARAMS");
    }
  });

  test("off by default; Bankr's code only on opt-in, after the builder's own", () => {
    expect(builderCodeSuffix({})).toBeUndefined();
    expect(builderCodeSuffix({ builderCodes: [] })).toBeUndefined();
    expect(builderCodeSuffix({ appendBankrBuilderCode: true })).toBe(
      encodeBuilderCodeSuffix([BANKR_BUILDER_CODE]),
    );
    expect(
      builderCodeSuffix({
        builderCodes: ["mypad"],
        appendBankrBuilderCode: true,
      }),
    ).toBe(encodeBuilderCodeSuffix(["mypad", BANKR_BUILDER_CODE]));
  });
});

describe("per-chain gas clamp", () => {
  test("20% headroom, plus the hook's 960k when the launch dev-buys, never above the chain's ceiling", () => {
    expect(clampLaunchGas(CHAINS.arbitrum, 10_000_000n)).toBe(12_000_000n);
    expect(clampLaunchGas(CHAINS.arbitrum, 10_000_000n, true)).toBe(
      12_960_000n,
    );
    expect(clampLaunchGas(CHAINS.arc, 14_000_000n)).toBe(EIP_7825_MAX_TX_GAS);
    expect(clampLaunchGas(CHAINS.base, 13_000_000n, true)).toBe(16_560_000n);
    expect(clampLaunchGas(CHAINS.base, 13_500_000n, true)).toBe(
      EIP_7825_MAX_TX_GAS,
    );
    expect(clampLaunchGas(CHAINS.base, 1_000_000n)).toBe(1_200_000n);
    // No estimate: the ceiling itself, so a wallet's own padding can never push past it.
    expect(clampLaunchGas(CHAINS.base, null)).toBe(EIP_7825_MAX_TX_GAS);
    expect(CHAINS.base.maxTxGas).toBe(16_777_216n);
  });

  test("an estimate above the ceiling cannot be mined: SIMULATION_REVERTED", () => {
    expectCode(
      () => clampLaunchGas(CHAINS.arc, 16_777_217n),
      "SIMULATION_REVERTED",
    );
  });
});

describe("launch gas pre-flight: builder allocations against the per-transaction ceiling", () => {
  // The heaviest launch measured on Bankr's pad (id 0), as the lowest gas limit it lands at on Base with the chain's
  // seven cap exclusions (seven band edges crossed by the dev buy, a quote's first launch): 15,174,754, and about
  // 129,400 more for each builder allocation. 12 fit Base's 16,777,216; the 13th does not.
  const heaviest = (allocations: number): bigint =>
    15_174_754n + BigInt(allocations) * LAUNCH_ALLOCATION_GAS;
  const withAllocations = (
    count: number,
    gasEstimate: bigint | null = heaviest(count),
  ) =>
    plan({
      params: {
        ...PARAMS,
        extraAllocations: Array.from({ length: count }, (_, i) => ({
          recipient: getAddress(
            `0x${(0xa110 + i).toString(16).padStart(40, "0")}`,
          ),
          amount: 10n ** 21n,
          cliff: 2_592_000n,
          duration: 31_536_000n,
          push: false,
        })),
      },
      gasEstimate,
    });

  function refusal(fn: () => unknown): { detail?: string } {
    try {
      fn();
    } catch (err) {
      expect(isLaunchSdkError(err, "INVALID_PARAMS"), String(err)).toBe(true);
      return err as { detail?: string };
    }
    throw new Error("accepted");
  }

  test("12 allocations fit: the launch is built, its limit the ceiling", () => {
    expect(LAUNCH_ALLOCATION_GAS).toBe(129_400n);
    expect(heaviest(0)).toBe(15_174_754n);
    expect(heaviest(12)).toBe(16_727_554n);
    const tx = buildLaunchTx(CHAINS.base, withAllocations(12));
    expect(tx.gas).toBe(EIP_7825_MAX_TX_GAS);
    expect(clampLaunchGas(CHAINS.base, heaviest(12), true, 12)).toBe(
      EIP_7825_MAX_TX_GAS,
    );
  });

  test("13 do not: INVALID_PARAMS before a transaction is built, saying how many fit", () => {
    expect(heaviest(13)).toBe(16_856_954n);
    const err = refusal(() => buildLaunchTx(CHAINS.base, withAllocations(13)));
    expect(err.detail).toBe(
      "This launch needs about 16,856,954 gas, and this chain takes at most 16,777,216 in one transaction. A builder allocation adds about 129,400: 12 of its 13 builder allocations fit.",
    );
    // A caller's own gas changes nothing: the launch itself is over the ceiling.
    refusal(() =>
      buildLaunchTx(CHAINS.base, withAllocations(13), { gas: 16_000_000n }),
    );
    // An estimate for 13 that is 11,568 over the ceiling: 12 of them fit.
    expect(
      refusal(() =>
        buildLaunchTx(CHAINS.base, withAllocations(13, 16_788_784n)),
      ).detail,
    ).toContain("12 of its 13 builder allocations fit");
    // Further over, the same 12 fit; a launch over the ceiling without its allocations fits none.
    expect(
      refusal(() => buildLaunchTx(CHAINS.base, withAllocations(14))).detail,
    ).toContain("12 of its 14 builder allocations fit");
    expect(
      refusal(() => buildLaunchTx(CHAINS.base, withAllocations(32))).detail,
    ).toContain("12 of its 32 builder allocations fit");
    expect(
      refusal(() => buildLaunchTx(CHAINS.base, withAllocations(2, 17_100_000n)))
        .detail,
    ).toContain("0 of its 2 builder allocations fit");
    // A chain with a higher ceiling takes the same launch.
    expect(
      buildLaunchTx(CHAINS.arbitrum, {
        ...withAllocations(16),
        chain: "arbitrum",
      } as LaunchPlan).gas,
    ).toBe((heaviest(16) * 12n) / 10n + 960_000n);
  });

  test("a launch without allocations over the ceiling keeps SIMULATION_REVERTED", () => {
    expectCode(
      () => buildLaunchTx(CHAINS.base, plan({ gasEstimate: 16_777_217n })),
      "SIMULATION_REVERTED",
    );
  });

  // A node refuses to estimate a launch over its per-transaction cap, and gives none for other reasons too (an RPC
  // without estimate overrides): with no estimate the heaviest launch stands in, as the worst case.
  test("no estimate, 12 allocations: the heaviest launch fits, so the launch is built at the ceiling", () => {
    expect(clampLaunchGas(CHAINS.base, null, false, 12)).toBe(
      EIP_7825_MAX_TX_GAS,
    );
    expect(clampLaunchGas(CHAINS.base, null, true, 12)).toBe(
      EIP_7825_MAX_TX_GAS,
    );
    expect(buildLaunchTx(CHAINS.base, withAllocations(12, null)).gas).toBe(
      EIP_7825_MAX_TX_GAS,
    );
    // Without allocations nothing is refused: the ceiling itself, as before.
    expect(buildLaunchTx(CHAINS.base, plan({ gasEstimate: null })).gas).toBe(
      EIP_7825_MAX_TX_GAS,
    );
  });

  test("no estimate, 13 allocations: INVALID_PARAMS from the heaviest launch's figure, saying how many fit", () => {
    const err = refusal(() =>
      buildLaunchTx(CHAINS.base, withAllocations(13, null)),
    );
    // The figure is named as the worst case, never as what this launch needs, with the two ways past it.
    expect(err.detail).toBe(
      "The node gave no gas estimate for this launch, so the heaviest launch on Bankr's launchpad stands in for it: a gas limit of about 16,856,954 with its 13 builder allocations, and this chain takes at most 16,777,216 in one transaction. A builder allocation adds about 129,400: at that figure 12 of the 13 fit. A lighter launch can fit as it is: set the plan's gasEstimate to your own estimate, or pass buildLaunchTx your own gas limit.",
    );
    expect(err.detail).not.toContain("12 of its 13 builder allocations fit");
    expect(
      refusal(() => clampLaunchGas(CHAINS.base, null, false, 13)).detail,
    ).toBe(err.detail);
    // A caller's gas over the ceiling shows nothing: the launch is still held to the heaviest figure.
    expect(
      refusal(() =>
        buildLaunchTx(CHAINS.base, withAllocations(13, null), {
          gas: EIP_7825_MAX_TX_GAS + 1n,
        }),
      ).detail,
    ).toBe(err.detail);
    expect(
      refusal(() => buildLaunchTx(CHAINS.base, withAllocations(14, null)))
        .detail,
    ).toContain("at that figure 12 of the 14 fit");
    expect(
      refusal(() => buildLaunchTx(CHAINS.base, withAllocations(32, null)))
        .detail,
    ).toContain("at that figure 12 of the 32 fit");
    // A chain with a higher ceiling holds 130 at the heaviest launch's figure; the 131st is refused there too.
    const onArbitrum = (count: number) => () =>
      buildLaunchTx(CHAINS.arbitrum, {
        ...withAllocations(count, null),
        chain: "arbitrum",
      } as LaunchPlan);
    expect(onArbitrum(24)().gas).toBe(CHAINS.arbitrum.maxTxGas);
    expect(heaviest(130)).toBe(31_996_754n);
    expect(onArbitrum(130)().gas).toBe(32_000_000n);
    expect(refusal(onArbitrum(131)).detail).toContain(
      "at that figure 130 of the 131 fit",
    );
  });

  // A plain launch is about 7.5M gas, and even at 8M its 24 allocations make about 11.1M: the chain takes it, and
  // a missing estimate (any estimate failure nulls it) says nothing of its weight.
  test("no estimate, a light launch with 24 allocations: the caller's own gas limit builds it", () => {
    const light = 8_000_000n + 24n * LAUNCH_ALLOCATION_GAS;
    expect(light).toBe(11_105_600n);
    const unestimated = withAllocations(24, null);
    const tx = buildLaunchTx(CHAINS.base, unestimated, { gas: 13_326_720n });
    expect(tx.gas).toBe(13_326_720n);
    expect(tx.to).toBe(SUITE.factory);
    const decoded = decodeFunctionData({
      abi: bankrLaunchFactoryAbi,
      data: tx.data,
    });
    expect(decoded.args?.[0]).toEqual(unestimated.params);
    // Up to the ceiling itself; the same holds past 24.
    expect(
      buildLaunchTx(CHAINS.base, unestimated, { gas: EIP_7825_MAX_TX_GAS }).gas,
    ).toBe(EIP_7825_MAX_TX_GAS);
    expect(
      buildLaunchTx(CHAINS.base, withAllocations(32, null), {
        gas: 14_000_000n,
      }).gas,
    ).toBe(14_000_000n);
    // The caller's own estimate on the plan does the same, with the usual headroom.
    expect(buildLaunchTx(CHAINS.base, withAllocations(24, light)).gas).toBe(
      13_326_720n + 960_000n,
    );
    expect(clampLaunchGas(CHAINS.base, light, false, 24)).toBe(13_326_720n);
    // An estimate over the ceiling is knowledge, not a guess: no gas of the caller's builds that launch.
    refusal(() =>
      buildLaunchTx(CHAINS.base, withAllocations(24), { gas: 13_326_720n }),
    );
  });
});

describe("buildLaunchTx", () => {
  test("factory.launch(params) from the launcher with the native dev buy as value and the swap headroom", () => {
    const tx = buildLaunchTx(CHAINS.base, plan());
    expect(tx.chainId).toBe(8453);
    expect(tx.from).toBe(LAUNCHER);
    expect(tx.to).toBe(SUITE.factory);
    expect(tx.value).toBe(10n ** 16n);
    expect(tx.gas).toBe(9_600_000n + 960_000n);
    const decoded = decodeFunctionData({
      abi: bankrLaunchFactoryAbi,
      data: tx.data,
    });
    expect(decoded.functionName).toBe("launch");
    expect(decoded.args?.[0]).toEqual(PARAMS);
    expect(buildLaunchTx(CHAINS.base, plan({ value: 0n })).gas).toBe(
      9_600_000n,
    );
  });

  test("appends the builder-code suffix and clamps a caller's gas", () => {
    const suffix = encodeBuilderCodeSuffix(["mypad"]);
    const tx = buildLaunchTx(CHAINS.base, plan({ dataSuffix: suffix }), {
      gas: 40_000_000n,
    });
    expect(tx.data.endsWith(suffix.slice(2))).toBe(true);
    expect(tx.gas).toBe(EIP_7825_MAX_TX_GAS);
    const bare = buildLaunchTx(CHAINS.base, plan());
    expect(tx.data).toBe(`${bare.data}${suffix.slice(2)}` as Hex);
  });

  test("a launch naming an extension: the estimate carries its binding and the dev buy adds only the hook's 960k", () => {
    const extension = {
      ...PARAMS.extension,
      ext: getAddress("0x0000000000000000000000000000000000000e47"),
      codehash: `0x${"ab".repeat(32)}` as Hex,
      maxBuyPips: 50_000,
      maxSellPips: 10_000,
      quoteGas: 250_000,
      afterGas: 1_000_000,
    };
    // 7,214,029: a custom extension bound at both ceilings, measured on the suite.
    const tx = buildLaunchTx(
      CHAINS.base,
      plan({ params: { ...PARAMS, extension }, gasEstimate: 7_214_029n }),
    );
    expect(tx.gas).toBe((7_214_029n * 12n) / 10n + 960_000n);
    // The heaviest launch measured (a Raffle Run preset, 9,489,633) still fits Base's ceiling with a dev buy.
    expect(clampLaunchGas(CHAINS.base, 9_489_633n, true)).toBe(12_347_559n);
  });

  test("an extension's budgets outside the hook's bounds are INVALID_PARAMS before a transaction is built", () => {
    const custom = {
      ...PARAMS.extension,
      ext: getAddress("0x0000000000000000000000000000000000000e47"),
    };
    for (const budgets of [
      { quoteGas: 49_999 },
      { quoteGas: 250_001 },
      { afterGas: 1_000_001 },
      { afterGas: 150_000 },
      { quoteOnly: true, afterGas: 200_000 },
    ]) {
      const params = { ...PARAMS, extension: { ...custom, ...budgets } };
      expectCode(
        () => buildLaunchTx(CHAINS.base, plan({ params })),
        "INVALID_PARAMS",
      );
    }
  });

  test("approvals spend from the launcher to the factory, for the exact amount", () => {
    const usdc = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    const tx = buildApproveTx(8453, LAUNCHER, usdc, SUITE.factory, 5_000_000n);
    expect(tx).toMatchObject({
      chainId: 8453,
      from: LAUNCHER,
      to: usdc,
      value: 0n,
    });
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([SUITE.factory, 5_000_000n]);
  });
});

describe("the gas that stands in for a launch with no estimate is sized from its own launchpad", () => {
  const cap = EIP_7825_MAX_TX_GAS;
  /** The most builder allocations the fallback passes under Base's ceiling for a pad's weight. */
  const fits = (weight?: LaunchGasWeight): number => {
    let n = 0;
    while (launchGasFallback(n + 1, weight) <= cap) n++;
    return n;
  };

  test("Bankr's pad, and any lighter one, is held to what forge pins on id 0: 12 fit Base, the 13th does not", () => {
    expect(fits()).toBe(12);
    // Two payees, a decay split and a 2,048-byte link are what the measured launch carried.
    expect(fits({ padPayees: 2, linkBytes: 2_048 })).toBe(12);
    // An open pad with no payee lands more on chain (forge: 18); the fallback never claims more than id 0's count.
    expect(fits({ padPayees: 0, linkBytes: 0 })).toBe(12);
  });

  test("a pad with four payees lands 9 as forge pins it (GasV2HeaviestLaunchPads), and the 10th is refused", () => {
    const weight = { padPayees: 4, linkBytes: 2_048 };
    expect(fits(weight)).toBe(9);
    expect(launchGasFallback(0, weight) - launchGasFallback(0)).toBe(
      2n * LAUNCH_PAD_PAYEE_GAS,
    );
    expectCode(
      () => clampLaunchGas(CHAINS.base, null, false, 10, weight),
      "INVALID_PARAMS",
    );
    expect(clampLaunchGas(CHAINS.base, null, false, 9, weight)).toBe(cap);
    // Where Bankr's pair alone would have passed 12 at the ceiling, to revert whole on chain.
    expect(clampLaunchGas(CHAINS.base, null, false, 12)).toBe(cap);
  });

  test("a 4,096-byte link, once a pad raised its limit, never passes more than the 7 forge lands on an open pad", () => {
    const weight = { padPayees: 1, linkBytes: 4_096 };
    expect(launchGasFallback(0, weight) - launchGasFallback(0)).toBe(
      2_048n * LAUNCH_LINK_BYTE_GAS,
    );
    // Sized from Bankr's pad, where that link leaves no room: forge's 7 are an open pad's.
    expect(fits(weight)).toBe(0);
  });

  test("a plan carries its launch's weight: buildLaunchTx refuses the count its own pad cannot land", () => {
    const params = {
      ...buildLaunchParams({
        name: "Coin",
        symbol: "COIN",
        metadataUri: "",
        metadataAdmin: zeroAddress,
        quote: testRecord(8453).weth,
        capExclusions: [],
        startTick: -239_600,
        deadline: 1n,
        economics: {
          buy: { startPips: 5_000, steadyPips: 5_000, decaySecs: 0 },
          sell: { startPips: 5_000, steadyPips: 5_000, decaySecs: 0 },
          referrerBps: 0,
          holdersBps: 0,
          autoLpBps: 0,
          buybackBps: 0,
          vestToHoldersBps: 0,
          vestToHoldersCliff: 0n,
          vestToHoldersDuration: 0n,
        },
        launchpadId: 7n,
        maxOperatorShareBps: 0,
        operatorPayeesHash: `0x${"00".repeat(32)}`,
        feeRecipients: [],
        allowOpenCodeFeeRecipients: false,
        vestingRecipient: LAUNCHER,
        vestBps: 0,
        allowCodeVestingRecipient: false,
        devBuyAmountIn: 0n,
        startTime: 0,
      }),
      extraAllocations: Array.from({ length: 10 }, (_, i) => ({
        recipient: getAddress(`0x${(i + 1).toString(16).padStart(40, "a")}`),
        amount: 10n ** 20n,
        cliff: 0n,
        duration: 0n,
        push: false,
      })),
      options: "0x" as Hex,
    };
    const plan = (gasWeight: LaunchGasWeight) =>
      ({
        chain: "base",
        launcher: LAUNCHER,
        factory: testRecord(8453).factory,
        params,
        value: 0n,
        gasEstimate: null,
        dataSuffix: undefined,
        resolved: { gasWeight },
      }) as unknown as LaunchPlan;
    expectCode(
      () =>
        buildLaunchTx(CHAINS.base, plan({ padPayees: 4, linkBytes: 2_048 })),
      "INVALID_PARAMS",
    );
    const tx = buildLaunchTx(
      CHAINS.base,
      plan({ padPayees: 2, linkBytes: 2_048 }),
    );
    expect(tx.gas).toBe(cap);
    // The launch's calldata is the factory's tuple: `options` rides at its end.
    const sent = decodeFunctionData({
      abi: bankrLaunchFactoryAbi,
      data: tx.data,
    });
    if (sent.functionName !== "launch") throw new Error("not a launch");
    expect(sent.args[0].options).toBe("0x");
  });
});
