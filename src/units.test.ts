import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { isLaunchSdkError, LaunchRefusedError } from "./errors.js";
import { volumeSplit } from "./launchpad.js";
import {
  bpsToPercent,
  percentToBps,
  percentToPips,
  pipsToPercent,
} from "./units.js";

function refused(fn: () => unknown): LaunchRefusedError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, "INVALID_PERCENT"), String(thrown)).toBe(
    true,
  );
  expect(thrown).toBeInstanceOf(LaunchRefusedError);
  expect((thrown as LaunchRefusedError).detail?.length).toBeGreaterThan(10);
  return thrown as LaunchRefusedError;
}

// The docs' unit table: Bankr's pad start, the steady caps and rates, the lowest steady fee, Bankr's floor and one pip.
const TABLE: readonly [string, number, number][] = [
  ["80", 800_000, 8_000],
  ["10", 100_000, 1_000],
  ["1.75", 17_500, 175],
  ["1", 10_000, 100],
  ["0.665", 6_650, 66.5],
  ["0.475", 4_750, 47.5],
  ["0.0875", 875, 8.75],
  ["0.05", 500, 5],
  ["0.025", 250, 2.5],
  ["0.0001", 1, 0.01],
];

describe("percent and pips", () => {
  test("the table converts exactly, from a string or a number, and back", () => {
    for (const [percent, pips] of TABLE) {
      expect(percentToPips(percent), percent).toBe(pips);
      expect(percentToPips(Number(percent)), percent).toBe(pips);
      expect(pipsToPercent(pips), percent).toBe(percent);
      expect(pipsToPercent(BigInt(pips)), percent).toBe(percent);
    }
    expect(pipsToPercent(4_750)).toBe("0.475");
    expect(percentToPips("1.75")).toBe(17_500);
  });

  test("every pips value round-trips through its percentage", () => {
    for (let pips = 0; pips <= 1_000_000; pips++) {
      if (percentToPips(pipsToPercent(pips)) !== pips) {
        throw new Error(`pips ${pips} did not round-trip`);
      }
    }
  });

  test("bounds and trailing zeros: 0, 100 % and `1.750000` are exact", () => {
    expect(percentToPips("0")).toBe(0);
    expect(percentToPips(0)).toBe(0);
    expect(percentToPips(-0)).toBe(0);
    expect(percentToPips("100")).toBe(1_000_000);
    expect(percentToPips("100.0000")).toBe(1_000_000);
    expect(percentToPips("1.750000")).toBe(17_500);
    expect(percentToPips("007.5")).toBe(75_000);
    expect(pipsToPercent(0)).toBe("0");
    expect(pipsToPercent(1_000_000)).toBe("100");
    expect(pipsToPercent(100_100)).toBe("10.01");
  });

  test("refuses more than 4 decimal places, negatives, NaN, non-decimals and above 100 %", () => {
    expect(refused(() => percentToPips("1.75001")).detail).toContain(
      "4 decimal places",
    );
    refused(() => percentToPips("0.00001"));
    refused(() => percentToPips(0.00001));
    // A number in exponent form is refused as too precise, not as malformed.
    expect(refused(() => percentToPips(1e-7)).detail).toContain(
      "4 decimal places",
    );
    // A float sum's shortest form carries 17 decimal places.
    refused(() => percentToPips(0.1 + 0.2));
    refused(() => percentToPips("-1"));
    expect(refused(() => percentToPips(-1)).detail).toContain("at least 0");
    refused(() => percentToPips(-0.5));
    refused(() => percentToPips(Number.NaN));
    refused(() => percentToPips(Number.POSITIVE_INFINITY));
    for (const bad of ["", " 1", "1 ", "1.", ".5", "+1", "1e2", "1,5", "abc"]) {
      refused(() => percentToPips(bad));
    }
    expect(refused(() => percentToPips("100.0001")).detail).toContain(
      "above 100 %",
    );
    expect(refused(() => percentToPips(101)).detail).toContain("above 100 %");
    // Without the number's own bound, 1e21's exponent form would read as too precise.
    expect(refused(() => percentToPips(1e21)).detail).toContain("above 100 %");
    refused(() => percentToPips(null as never));
    refused(() => percentToPips(17_500n as never));
  });

  test("a detail repeats at most 32 characters of the input", () => {
    const long = `1.${"0".repeat(398)}1`;
    for (const detail of [
      refused(() => percentToPips(long)).detail!,
      refused(() => percentToPips(`x${long}`)).detail!,
      refused(() => percentToPips(`1${"0".repeat(400)}`)).detail!,
    ]) {
      expect(detail).toContain("…");
      expect(detail.length).toBeLessThan(120);
    }
  });

  test("volumeSplit names each payee in EIP-55, as the client's other addresses are", () => {
    const lower = "0xa0cf798816d4b9b9866b5330eea46a18382f251e";
    const split = volumeSplit({
      steadyPips: percentToPips("1"),
      terms: { payees: [lower], steadySharesWad: [5n * 10n ** 17n] },
      economics: { referrerBps: 0, holdersBps: 0, autoLpBps: 0, buybackBps: 0 },
    });
    expect(split.payees[0]!.address).toBe(getAddress(lower));
    expect(split.payees[0]!.address).not.toBe(lower);
  });

  test("pipsToPercent takes a volumeSplit leg's 2 decimal places", () => {
    expect(pipsToPercent(525.15)).toBe("0.052515");
    expect(pipsToPercent(2_624.85)).toBe("0.262485");
    expect(pipsToPercent(0.01)).toBe("0.000001");
    expect(pipsToPercent(999_999.99)).toBe("99.999999");
    // The docs' worked split: a 1 % fee, one payee at 50 %, holders 11.67 % and auto-LP 30 % of the creator side.
    const split = volumeSplit({
      steadyPips: percentToPips("1"),
      terms: {
        payees: ["0x3333333333333333333333333333333333333333"],
        steadySharesWad: [5n * 10n ** 17n],
      },
      economics: {
        referrerBps: 0,
        holdersBps: 1_167,
        autoLpBps: 3_000,
        buybackBps: 0,
      },
    });
    expect({
      fee: pipsToPercent(split.feePips),
      bankr: pipsToPercent(split.bankrPips),
      holdersBnkr: pipsToPercent(split.holdersBnkrPips),
      payee: pipsToPercent(split.payees[0]!.pips),
      creatorHolders: pipsToPercent(split.creatorHoldersPips),
      autoLp: pipsToPercent(split.autoLpPips),
      creator: pipsToPercent(split.creatorPips),
    }).toEqual({
      fee: "1",
      bankr: "0.05",
      holdersBnkr: "0.05",
      payee: "0.45",
      creatorHolders: "0.052515",
      autoLp: "0.135",
      creator: "0.262485",
    });
  });

  test("pipsToPercent refuses a negative, over-precise, non-numeric or above-100 % value", () => {
    refused(() => pipsToPercent(-1));
    refused(() => pipsToPercent(-1n));
    expect(refused(() => pipsToPercent(1.555)).detail).toContain(
      "2 decimal places",
    );
    refused(() => pipsToPercent(1e-7));
    refused(() => pipsToPercent(0.1 + 0.2));
    refused(() => pipsToPercent(Number.NaN));
    refused(() => pipsToPercent(Number.POSITIVE_INFINITY));
    refused(() => pipsToPercent(2 ** 53));
    expect(refused(() => pipsToPercent(1_000_001)).detail).toContain(
      "between 0 and 1000000",
    );
    refused(() => pipsToPercent(1_000_001n));
    expect(refused(() => pipsToPercent("5" as never)).detail).toBe(
      "Pips must be a number or bigint.",
    );
    refused(() => pipsToPercent(null as never));
  });
});

describe("percent and bps", () => {
  test("the table's whole-bp rows convert both ways; the finer ones only back to a percentage", () => {
    for (const [percent, , bps] of TABLE) {
      expect(bpsToPercent(bps), percent).toBe(percent);
      if (!Number.isInteger(bps)) {
        expect(refused(() => percentToBps(percent)).detail, percent).toContain(
          "2 decimal places",
        );
        refused(() => percentToBps(Number(percent)));
        continue;
      }
      expect(percentToBps(percent), percent).toBe(bps);
      expect(percentToBps(Number(percent)), percent).toBe(bps);
      expect(bpsToPercent(bps), percent).toBe(percent);
      expect(bpsToPercent(BigInt(bps)), percent).toBe(percent);
    }
    // The share table: the payees' cap, a holder share and the referrer cap.
    expect(percentToBps("95")).toBe(9_500);
    expect(percentToBps("50")).toBe(5_000);
    expect(percentToBps("5")).toBe(500);
    expect(bpsToPercent(875)).toBe("8.75");
    expect(percentToBps("0.01")).toBe(1);
    expect(percentToBps("100")).toBe(10_000);
  });

  test("every bps value round-trips through its percentage", () => {
    for (let bps = 0; bps <= 10_000; bps++) {
      expect(percentToBps(bpsToPercent(bps))).toBe(bps);
    }
  });

  test("refuses more than 2 decimal places, negatives, NaN and above 100 %", () => {
    refused(() => percentToBps("8.755"));
    refused(() => percentToBps(0.001));
    refused(() => percentToBps("-0.01"));
    refused(() => percentToBps(Number.NaN));
    refused(() => percentToBps("100.01"));
    refused(() => bpsToPercent(-1));
    expect(bpsToPercent(0.5)).toBe("0.005");
    refused(() => bpsToPercent(0.555));
    refused(() => bpsToPercent(10_001));
    refused(() => bpsToPercent(10_001n));
    expect(refused(() => bpsToPercent("5" as never)).detail).toBe(
      "Bps must be a number or bigint.",
    );
  });
});
