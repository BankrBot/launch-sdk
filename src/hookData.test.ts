import { describe, expect, test } from "bun:test";
import { getAddress, type Address, type Hex } from "viem";
import { isLaunchSdkError } from "./errors.js";
import {
  HOOKDATA_HOLDERS_WAKE,
  HOOKDATA_MAGIC,
  HOOKDATA_MAX_KEEP_GAS,
  encodeHookData,
  type HookDataInput,
} from "./hookData.js";

const WETH = getAddress("0x4200000000000000000000000000000000000006");
const REFERRER = getAddress("0x1111111111111111111111111111111111111111");

function refused(input: HookDataInput): string | undefined {
  try {
    encodeHookData(input);
  } catch (err) {
    expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(true);
    return (err as { detail?: string }).detail;
  }
  throw new Error("encoded");
}

describe("encodeHookData", () => {
  test("nothing to say is empty hookData, what every other router sends", () => {
    expect(encodeHookData()).toBe("0x");
    expect(encodeHookData({ holdersWake: null, routeCurrencies: [] })).toBe(
      "0x",
    );
  });

  test("a wake request is the magic, flag 8 and three bytes of kept gas, zero included", () => {
    expect(HOOKDATA_HOLDERS_WAKE).toBe(8);
    expect(encodeHookData({ holdersWake: { keepGas: 0 } })).toBe(
      `${HOOKDATA_MAGIC}08000000`,
    );
    expect(encodeHookData({ holdersWake: { keepGas: 4_607_195 } })).toBe(
      "0xba7c4a7c08464cdb",
    );
    expect(
      encodeHookData({ holdersWake: { keepGas: HOOKDATA_MAX_KEEP_GAS } }),
    ).toBe("0xba7c4a7c08ffffff");
  });

  test("every field in the hook's order: pins, the referrer, the kept gas, then the extension's data", () => {
    expect(
      encodeHookData({
        skipAfterSwap: true,
        routeCurrencies: [WETH],
        referrer: REFERRER,
        holdersWake: { keepGas: 1_698_888 },
        extData: "0xdeadbeef",
      }),
    ).toBe(
      "0xba7c4a7c0f014200000000000000000000000000000000000006111111111111111111111111111111111111111119ec48deadbeef",
    );
    // Without the magic the whole hookData is the extension's: extData alone still gets the prefix.
    expect(encodeHookData({ extData: "0xdeadbeef" })).toBe(
      "0xba7c4a7c00deadbeef",
    );
  });

  test("a field the hook would revert on is INVALID_PARAMS with the rule it breaks", () => {
    const pins = Array.from({ length: 17 }, () => WETH);
    expect(refused({ routeCurrencies: pins })).toContain("at most 16");
    expect(refused({ extData: `0x${"00".repeat(2_049)}` })).toContain("2,048");
    expect(refused({ extData: "0xabc" as Hex })).toContain("whole bytes");
    expect(refused({ routeCurrencies: ["0x1234" as Address] })).toContain(
      "route currency",
    );
    expect(
      refused({ referrer: "0x0000000000000000000000000000000000000000" }),
    ).toContain("non-zero");
    for (const keepGas of [-1, 1.5, HOOKDATA_MAX_KEEP_GAS + 1, Number.NaN])
      expect(refused({ holdersWake: { keepGas } })).toContain("kept gas");
  });
});
