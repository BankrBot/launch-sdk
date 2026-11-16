import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, type Hex } from "viem";
import { normalizeExtension } from "./extension.js";
import {
  EXTENSION_TREASURY_BPS,
  extensionFeeTable,
  feePipsAt,
  scanExtensionBytecode,
} from "./extensionPreview.js";

// Bankr's own pad at 1.75 %: 80 % falling to it over 14 seconds.
const SNIPE = { startPips: 800_000, steadyPips: 17_500, decaySecs: 14 };
const FLAT = { startPips: 10_000, steadyPips: 10_000, decaySecs: 0 };
const both = <T>(s: T) => ({ buy: s, sell: s });

describe("the fee an extension adds, second by second", () => {
  const rows = (input: unknown, s = SNIPE) => {
    const table = extensionFeeTable(normalizeExtension(input), both(s));
    return new Map(table.map((r) => [r.secsSinceLaunch, r]));
  };

  test("FeeMath.feePipsAt: a linear fall to the steady rate, the drop rounded down", () => {
    expect(feePipsAt(SNIPE, 0)).toBe(800_000);
    expect(feePipsAt(SNIPE, 13)).toBe(
      800_000 - Math.floor((782_500 * 13) / 14),
    );
    expect(feePipsAt(SNIPE, 14)).toBe(17_500);
    expect(feePipsAt(FLAT, 0)).toBe(10_000);
  });

  test("Sniper Tax on a decaying launch fee: no room while it is at 10 % or more, part of it, then all, then 0", () => {
    const sniper = {
      preset: "sniper_tax",
      buyPips: 90_000,
      sellPips: 20_000,
      endSecs: 300,
    };
    const at = rows(sniper);
    // At 12 s the launch's own fee is still above 10 %: the hook charges nothing for the extension.
    expect(at.get(12)!.buy).toEqual({ extPips: 0, totalPips: 129_286 });
    // At 13 s it is 7.34 %: the extension gets the 2.66 % of room left under 10 %, and its whole sell fee.
    expect(at.get(13)).toEqual({
      secsSinceLaunch: 13,
      buyFeePips: 73_393,
      sellFeePips: 73_393,
      buy: { extPips: 26_607, totalPips: 100_000 },
      sell: { extPips: 20_000, totalPips: 93_393 },
    });
    // From 14 s the room is 8.25 %: the 9 % buy fee is still clamped to it.
    expect(at.get(14)!.buy).toEqual({ extPips: 82_500, totalPips: 100_000 });
    expect(at.get(299)!.sell.extPips).toBe(20_000);
    // From its end the hook never asks it again.
    expect(at.get(300)!.buy).toEqual({ extPips: 0, totalPips: 17_500 });
    expect(at.get(604_800)!.sell.extPips).toBe(0);
  });

  test("Decay Tax falls linearly to 0; Pump Brake is shown where it charges, on buys only", () => {
    const decay = rows(
      {
        preset: "decay_tax",
        startBuyPips: 40_000,
        startSellPips: 20_000,
        decaySecs: 3_600,
      },
      FLAT,
    );
    expect(decay.get(0)!.buy.extPips).toBe(40_000);
    expect(decay.get(1_800)!.buy.extPips).toBe(20_000);
    expect(decay.get(1_800)!.sell.extPips).toBe(10_000);
    expect(decay.get(3_600)!.buy.extPips).toBe(0);
    const brake = rows(
      { preset: "pump_brake", brakePips: 30_000, thresholdTicks: 6_932 },
      FLAT,
    );
    expect(brake.get(86_400)!.buy).toEqual({
      extPips: 30_000,
      totalPips: 40_000,
    });
    expect(brake.get(86_400)!.sell.extPips).toBe(0);
  });

  test("custom code is shown at its declared maxima until its sunset: its own quote is not run", () => {
    const custom = rows(
      {
        address: "0x0000000000000000000000000000000000000E47",
        codehash: `0x${"ab".repeat(32)}`,
        maxBuyPips: 100_000,
        maxSellPips: 5_000,
        quoteOnly: true,
        sunsetSecs: 600,
      },
      FLAT,
    );
    expect(custom.get(0)!.buy).toEqual({ extPips: 90_000, totalPips: 100_000 });
    expect(custom.get(599)!.sell.extPips).toBe(5_000);
    expect(custom.get(600)!.buy.extPips).toBe(0);
  });

  test("Raffle Run by its raw params: its fee runs for the run", () => {
    const params = encodeAbiParameters(
      [
        { type: "uint24" },
        { type: "uint24" },
        { type: "uint32" },
        { type: "uint256" },
      ],
      [10_000, 5_000, 3_600, 0n],
    );
    const raffle = rows({ presetId: 4, params }, FLAT);
    expect(raffle.get(3_599)!.buy.extPips).toBe(10_000);
    expect(raffle.get(3_600)!.buy.extPips).toBe(0);
  });

  test("Bankr takes 2/7 of an extension's fee", () => {
    expect(EXTENSION_TREASURY_BPS).toBe(2_857);
  });
});

describe("what custom code can reach", () => {
  const scan = (code: Hex) => scanExtensionBytecode(code);

  test("a reachable call-family opcode is found; push data and code after a halt are not code", () => {
    expect(scan("0x6000f100")).toEqual({
      callsOut: true,
      upgradeable: false,
      opcodes: ["CALL"],
    });
    // PUSH1 0xf1 pushes a byte that is not an instruction.
    expect(scan("0x60f100").callsOut).toBe(false);
    // STOP, then a CALL nothing jumps to; a JUMPDEST makes what follows reachable again.
    expect(scan("0x00f1").callsOut).toBe(false);
    expect(scan("0x005bf1").callsOut).toBe(true);
  });

  test("DELEGATECALL or CALLCODE means its behaviour can change without its codehash moving", () => {
    expect(scan("0xf4")).toEqual({
      callsOut: true,
      upgradeable: true,
      opcodes: ["DELEGATECALL"],
    });
    expect(scan("0xf2").upgradeable).toBe(true);
    expect(scan("0xf0f5ff").opcodes).toEqual([
      "CREATE",
      "CREATE2",
      "SELFDESTRUCT",
    ]);
  });
});
