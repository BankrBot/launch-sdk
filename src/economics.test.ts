import { describe, expect, test } from "bun:test";
import { zeroAddress, zeroHash, type Address } from "viem";
import {
  DEFAULT_TOTAL_SUPPLY,
  EXT_AFTER_GAS,
  EXT_AFTER_GAS_MAX,
  EXT_QUOTE_GAS,
  EXT_QUOTE_GAS_MAX,
  checkExtensionBudgets,
  extensionGasBudgets,
  holderShareToHoldersBps,
  holdersBpsToHolderShare,
  quoteFdvTick,
  startTickForFdv,
  startTickForQuoteFdv,
  type LaunchParams,
} from "./economics.js";
import { isLaunchSdkError } from "./errors.js";

/** The detail of the INVALID_PARAMS `fn` refuses with. */
function refused(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(true);
    return (err as { detail?: string }).detail;
  }
  throw new Error("accepted");
}

describe("an extension's gas budgets", () => {
  test("omitted or 0 is the floor; a quote-only extension has no post-swap budget", () => {
    expect(extensionGasBudgets({ quoteOnly: false })).toEqual({
      quoteGas: EXT_QUOTE_GAS,
      afterGas: EXT_AFTER_GAS,
    });
    expect(
      extensionGasBudgets({ quoteOnly: false, quoteGas: 0, afterGas: 0 }),
    ).toEqual({ quoteGas: 50_000, afterGas: 150_000 });
    expect(extensionGasBudgets({ quoteOnly: true, quoteGas: 123_456 })).toEqual(
      { quoteGas: 123_456, afterGas: 0 },
    );
    expect(
      extensionGasBudgets({
        quoteOnly: false,
        quoteGas: EXT_QUOTE_GAS_MAX,
        afterGas: EXT_AFTER_GAS_MAX,
      }),
    ).toEqual({ quoteGas: 250_000, afterGas: 1_000_000 });
  });

  test("outside the floor and the ceiling is INVALID_PARAMS, naming the bounds", () => {
    for (const quoteGas of [1, 49_999, 250_001, 60_000.5, -1])
      expect(
        refused(() => extensionGasBudgets({ quoteOnly: false, quoteGas })),
      ).toBe(
        "The extension's quote gas budget must be between 50,000 and 250,000, or 0 for 50,000.",
      );
    for (const afterGas of [1, 149_999, 1_000_001])
      expect(
        refused(() => extensionGasBudgets({ quoteOnly: false, afterGas })),
      ).toBe(
        "The extension's post-swap gas budget must be between 150,000 and 1,000,000, or 0 for 150,000.",
      );
    expect(
      refused(() =>
        extensionGasBudgets({ quoteOnly: true, afterGas: 150_000 }),
      ),
    ).toContain("quote-only");
  });

  test("a launch's terms: a floor is written as 0, a preset names no budget, stray fields of no extension are ignored", () => {
    const none: LaunchParams["extension"] = {
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
    };
    const ext: Address = "0x0000000000000000000000000000000000000e47";
    const custom = { ...none, ext, maxBuyPips: 50_000 };
    for (const ok of [
      none,
      { ...none, quoteGas: 7, afterGas: 9 },
      custom,
      { ...custom, quoteGas: 50_001, afterGas: 1_000_000 },
      { ...custom, quoteOnly: true, quoteGas: 250_000 },
      { ...none, id: 4, params: "0x01" as const },
    ])
      expect(() => checkExtensionBudgets(ok, "base")).not.toThrow();
    expect(
      refused(() => checkExtensionBudgets({ ...custom, quoteGas: 50_000 })),
    ).toContain("written as 0");
    expect(
      refused(() => checkExtensionBudgets({ ...custom, afterGas: 150_000 })),
    ).toContain("written as 0");
    expect(
      refused(() => checkExtensionBudgets({ ...custom, afterGas: 1_000_001 })),
    ).toContain("post-swap gas budget");
    expect(
      refused(() =>
        checkExtensionBudgets({
          ...custom,
          quoteOnly: true,
          afterGas: 200_000,
        }),
      ),
    ).toContain("quote-only");
    expect(
      refused(() =>
        checkExtensionBudgets({ ...none, id: 1, quoteGas: 60_000 }),
      ),
    ).toContain("preset");
  });
});

describe("holderShareBps: bps of the creator's own take", () => {
  test("converts to the contract's creator-side holdersBps", () => {
    // Bankr's pad: auto-LP floor 30 %, so all of the creator's own take is 70 % of the creator side.
    expect(holderShareToHoldersBps(10_000, 3_000, 0)).toBe(7_000);
    expect(holderShareToHoldersBps(5_000, 3_000, 1_000)).toBe(3_000);
    expect(holderShareToHoldersBps(0, 3_000, 0)).toBe(0);
    expect(holderShareToHoldersBps(3_333, 3_000, 0)).toBe(2_333);
    expect(holderShareToHoldersBps(10_000, 10_000, 0)).toBe(0);
  });

  test("the inverse is the least share giving those holdersBps, and 0 when the creator keeps nothing", () => {
    expect(holdersBpsToHolderShare(7_000, 3_000, 0)).toBe(10_000);
    // A new pad's 1,167 hint: 1,667 would floor to 1,166.
    expect(holdersBpsToHolderShare(1_167, 3_000, 0)).toBe(1_668);
    for (let h = 0; h <= 7_000; h += 97) {
      expect(
        holderShareToHoldersBps(holdersBpsToHolderShare(h, 3_000, 0), 3_000, 0),
      ).toBe(h);
    }
    expect(holdersBpsToHolderShare(0, 10_000, 0)).toBe(0);
    for (const share of [0, 1, 2_500, 5_000, 9_999, 10_000]) {
      expect(
        holdersBpsToHolderShare(
          holderShareToHoldersBps(share, 3_000, 0),
          3_000,
          0,
        ),
      ).toBeCloseTo(share, -1);
    }
  });

  test("out-of-range inputs are a RangeError", () => {
    expect(() => holderShareToHoldersBps(10_001, 0, 0)).toThrow(RangeError);
    expect(() => holderShareToHoldersBps(5_000, 8_000, 3_000)).toThrow(
      RangeError,
    );
    expect(() => holderShareToHoldersBps(1.5, 0, 0)).toThrow(RangeError);
  });
});

describe("startTickForFdv", () => {
  // R7-13 fixup: the factory raises `lowest` to MIN_START_TICK (-560,000) when the min-FDV tick is deeper, so it no
  // longer prices minStartFdvUsd there. The target is placed from the unclamped `highest` (maxStartFdvUsd) instead.
  test("a lowest clamped to MIN_START_TICK does not shift the target FDV's tick", () => {
    const step = (usd: number) => Math.log(usd) / Math.log(1.0001);
    const trueLowest = -600_000;
    const i = {
      lowest: -560_000,
      highest: Math.round(trueLowest + step(125_000_000 / 2_000)),
      maxStartFdvUsd: 125_000_000,
      targetFdvUsd: 10_000_000,
    };
    const want =
      Math.floor((trueLowest + step(10_000_000 / 2_000)) / 200) * 200;
    expect(startTickForFdv(i)).toBe(want);
    // a target under the floor's own FDV clamps to the floor, not 40,000 ticks above it
    expect(startTickForFdv({ ...i, targetFdvUsd: 100_000 })).toBe(-560_000);
  });
});

describe("startTickForQuoteFdv (any-quote pairing)", () => {
  // Each vector is LaunchEconomics._fdvTick(fdv, dec, 1e18, supply) at a price of 1 per quote, floored to 200, as forge
  // computes it: the start FDV in the quote's base units over the raw supply.
  test("matches the factory's FDV tick at a price of 1, floored to the 200 spacing", () => {
    const e = (whole: bigint, dec: number) => whole * 10n ** BigInt(dec);
    const vectors: Array<[bigint, bigint, number]> = [
      [e(1_000_000n, 18), DEFAULT_TOTAL_SUPPLY, -115_200],
      [e(10_000n, 6), DEFAULT_TOTAL_SUPPLY, -437_600],
      [e(5n, 18), DEFAULT_TOTAL_SUPPLY, -237_400],
      [e(10n ** 15n, 18), DEFAULT_TOTAL_SUPPLY, 92_000],
      [e(2_000_000n, 8), 10n ** 27n, -292_600],
      [e(1n, 6), DEFAULT_TOTAL_SUPPLY, -529_800],
    ];
    for (const [fdv, supply, tick] of vectors)
      expect(startTickForQuoteFdv(fdv, supply)).toBe(tick);
    expect(startTickForQuoteFdv(e(1_000_000n, 18))).toBe(-115_200);
    // The tick before the grid, which places market-cap ranges: the start tick is its floor, under 200 ticks below.
    expect(quoteFdvTick(e(1_000_000n, 18))).toBeCloseTo(-115_135.011, 3);
    expect(quoteFdvTick(e(10_000n, 6))).toBeCloseTo(-437_513.042, 3);
    for (const [fdv, supply, tick] of vectors) {
      const above = quoteFdvTick(fdv, supply) - tick;
      expect(above >= 0 && above < 200, `${fdv}`).toBe(true);
    }
  });
});
