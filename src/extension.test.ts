import { describe, expect, test } from "bun:test";
import {
  encodeAbiParameters,
  getAddress,
  zeroAddress,
  zeroHash,
  type Hex,
} from "viem";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import {
  extensionAllowlistKey,
  extensionKind,
  normalizeExtension,
  type LaunchExtensionInput,
} from "./extension.js";
import {
  EXTENSION_PRESETS,
  describePreset,
  presetTerms,
  type PresetParams,
} from "./presets.js";
import {
  decodeExtensionPresetParams,
  encodeExtensionPresetParams,
} from "./launch/presets.js";
import { NO_EXTENSION } from "./terms.js";

const U24 = { type: "uint24" } as const;
const U32 = { type: "uint32" } as const;
const PAYEE = getAddress("0x00000000000000000000000000000000000a11ce");
const EXT = getAddress("0x0000000000000000000000000000000000000e47");
const CODEHASH: Hex = `0x${"ab".repeat(32)}`;

/** The refusal `fn` throws: its code and the SDK's own sentence. */
function refusal(fn: () => unknown): { code: string; detail: string } {
  try {
    fn();
  } catch (err) {
    if (isLaunchSdkError(err))
      return { code: err.code, detail: err.detail ?? "" };
    throw err;
  }
  throw new Error("not refused");
}

const refuses = (
  input: unknown,
  code: LaunchSdkErrorCode,
  says: string,
): void => {
  const r = refusal(() => normalizeExtension(input));
  expect(r.code, JSON.stringify(input)).toBe(code);
  expect(r.detail).toContain(says);
};

const sniper = {
  preset: "sniper_tax",
  buyPips: 50_000,
  sellPips: 20_000,
} as const;

describe("a preset by name or id: the launch struct the factory takes", () => {
  test("Sniper Tax: its id, the constructor's exact abi.encode, and every custom field zero", () => {
    const n = normalizeExtension({ ...sniper, endSecs: 300 });
    expect(n.params).toEqual({
      ...NO_EXTENSION,
      id: 1,
      params: encodeAbiParameters([U24, U24, U32], [50_000, 20_000, 300]),
    });
    expect(n.preset).toEqual({
      preset: "sniper_tax",
      buyPips: 50_000,
      sellPips: 20_000,
      endSecs: 300,
    });
    expect(n.terms).toEqual({
      maxBuyPips: 50_000,
      maxSellPips: 20_000,
      quoteOnly: true,
      sunsetSecs: 300,
    });
    // A preset runs on the floor budgets, and a quote-only one has no post-swap call.
    expect(n.gas).toEqual({ quoteGas: 50_000, afterGas: 0 });
    // By id: the same launch.
    expect(
      normalizeExtension({ ...sniper, preset: 1, endSecs: 300 }).params,
    ).toEqual(n.params);
  });

  test("Decay Tax and Pump Brake encode in their constructors' order; a payee is carried as named", () => {
    const decay = normalizeExtension({
      preset: "decay_tax",
      startBuyPips: 40_000,
      startSellPips: 40_000,
      decaySecs: 3_600,
      payee: PAYEE,
    });
    expect(decay.params).toEqual({
      ...NO_EXTENSION,
      id: 2,
      params: encodeAbiParameters([U24, U24, U32], [40_000, 40_000, 3_600]),
      payee: PAYEE,
    });
    expect(decay.terms.sunsetSecs).toBe(3_600);
    // The decoded parameters are the preset's own: the payee is the launch's, not the constructor's.
    expect(decay.preset).toEqual({
      preset: "decay_tax",
      startBuyPips: 40_000,
      startSellPips: 40_000,
      decaySecs: 3_600,
    });
    const brake = normalizeExtension({
      preset: 3,
      brakePips: 30_000,
      thresholdTicks: 6_932,
    });
    expect(brake.params.id).toBe(3);
    expect(brake.params.params).toBe(
      encodeAbiParameters([U24, { type: "int24" }], [30_000, 6_932]),
    );
    expect(brake.params.payee).toBe(zeroAddress);
    expect(brake.terms).toEqual({
      maxBuyPips: 30_000,
      maxSellPips: 0,
      quoteOnly: true,
      sunsetSecs: 0,
    });
  });

  test("the presets table: Bankr's three by name, Raffle Run a reference extension", () => {
    expect(EXTENSION_PRESETS).toEqual({
      sniper_tax: { id: 1, name: "Sniper Tax", reference: false },
      decay_tax: { id: 2, name: "Decay Tax", reference: false },
      pump_brake: { id: 3, name: "Pump Brake", reference: false },
      raffle_run: { id: 4, name: "Raffle Run", reference: true },
    });
    // Raffle Run is never taken by name: raw id and params only.
    refuses(
      { preset: "raffle_run", buyPips: 1, sellPips: 1, runSecs: 600 },
      "INVALID_PARAMS",
      "sniper_tax",
    );
    refuses({ ...sniper, preset: 4, endSecs: 300 }, "INVALID_PARAMS", "preset");
  });
});

describe("a preset's parameters are held to their widths; the launchpad's limits for them follow on chain", () => {
  const SNIPER = { ...sniper, endSecs: 300 };
  const DECAY = {
    preset: "decay_tax",
    startBuyPips: 40_000,
    startSellPips: 40_000,
    decaySecs: 3_600,
  };
  const BRAKE = {
    preset: "pump_brake",
    brakePips: 30_000,
    thresholdTicks: 23_027,
  };
  const U24_MAX = 2 ** 24 - 1;
  const U32_MAX = 2 ** 32 - 1;
  // [input, field, the parameter's sentence, lowest and highest value its ABI type carries]
  const cases: [object, string, string, number, number][] = [
    [SNIPER, "buyPips", "Sniper Tax buy fee (pips)", 0, U24_MAX],
    [SNIPER, "sellPips", "Sniper Tax sell fee (pips)", 0, U24_MAX],
    [SNIPER, "endSecs", "Sniper Tax end (seconds)", 0, U32_MAX],
    [DECAY, "startBuyPips", "Decay Tax start buy fee (pips)", 0, U24_MAX],
    [DECAY, "startSellPips", "Decay Tax start sell fee (pips)", 0, U24_MAX],
    [DECAY, "decaySecs", "Decay Tax duration (seconds)", 0, U32_MAX],
    [BRAKE, "brakePips", "Pump Brake fee (pips)", 0, U24_MAX],
    [
      BRAKE,
      "thresholdTicks",
      "Pump Brake threshold (ticks above launch)",
      -(2 ** 23),
      2 ** 23 - 1,
    ],
  ];
  const count = (n: number) => n.toLocaleString("en-US");

  test("both edges pass, one step outside either is EXTENSION_OUT_OF_BOUNDS naming the width", () => {
    for (const [base, field, what, lo, hi] of cases) {
      for (const ok of [lo, hi])
        expect(
          () => normalizeExtension({ ...base, [field]: ok }),
          `${field}=${ok}`,
        ).not.toThrow();
      for (const bad of [lo - 1, hi + 1, lo + 0.5]) {
        const r = refusal(() => normalizeExtension({ ...base, [field]: bad }));
        expect(r, `${field}=${bad}`).toEqual({
          code: "EXTENSION_OUT_OF_BOUNDS",
          detail: `${what} must be between ${count(lo)} and ${count(hi)}.`,
        });
      }
    }
  });

  test("no launchpad's limit is typed here: a window or a fee only some launchpad allows is a shape the SDK takes", () => {
    // A minute's Sniper Tax, a year's Decay Tax, a 50 % fee: each launchpad's own limits judge them, on chain.
    for (const input of [
      { ...SNIPER, endSecs: 60 },
      { ...DECAY, decaySecs: 365 * 86_400 },
      { ...SNIPER, buyPips: 500_000 },
      { ...DECAY, startBuyPips: 0, startSellPips: 0 },
    ])
      expect(() => normalizeExtension(input)).not.toThrow();
  });

  test("a missing or non-numeric parameter is refused the same way", () => {
    refuses(sniper, "EXTENSION_OUT_OF_BOUNDS", "Sniper Tax end (seconds)");
    refuses(
      { ...SNIPER, buyPips: "50000" },
      "EXTENSION_OUT_OF_BOUNDS",
      "Sniper Tax buy fee (pips)",
    );
  });
});

describe("a raw preset: id and encoded params", () => {
  const U256 = { type: "uint256" } as const;
  const raffle = encodeAbiParameters(
    [U24, U24, U32, U256, U256, U32],
    [10_000, 5_000, 86_400, 10n ** 15n, 10n ** 13n, 43_200],
  );

  test("Raffle Run (the reference extension) binds by id 4 and its six words; it calls out", () => {
    const n = normalizeExtension({ presetId: 4, params: raffle });
    expect(n.params).toEqual({ ...NO_EXTENSION, id: 4, params: raffle });
    expect(n.preset).toEqual({
      preset: "raffle_run",
      buyPips: 10_000,
      sellPips: 5_000,
      runSecs: 86_400,
      minTicketQuote: 10n ** 15n,
      minBuyback: 10n ** 13n,
      anchorTauSecs: 43_200,
    });
    expect(n.terms).toEqual({
      maxBuyPips: 10_000,
      maxSellPips: 5_000,
      quoteOnly: false,
      sunsetSecs: 0,
    });
    expect(n.gas).toEqual({ quoteGas: 50_000, afterGas: 150_000 });
  });

  test("a Bankr preset by raw id is the typed form's launch", () => {
    const typed = normalizeExtension({ ...sniper, endSecs: 300 });
    expect(
      normalizeExtension({ presetId: 1, params: typed.params.params }),
    ).toEqual(typed);
  });

  test("params of another length, or with bits above a parameter's width, are refused (PresetParamsMalformed)", () => {
    refuses(
      { presetId: 3, params: raffle },
      "EXTENSION_OUT_OF_BOUNDS",
      "exactly 2 ABI words",
    );
    refuses({ presetId: 1, params: "0x" }, "EXTENSION_OUT_OF_BOUNDS", "3 ABI");
    const dirty = `0x${"ff".repeat(32)}${"00".repeat(64)}` as Hex;
    refuses({ presetId: 1, params: dirty }, "EXTENSION_OUT_OF_BOUNDS", "ABI");
    refuses({ presetId: 1, params: "0xzz" }, "INVALID_PARAMS", "params");
  });

  test("an id no preset has is refused (UnknownPreset)", () => {
    for (const presetId of [0, 5, 256, 1.5, "1"])
      refuses({ presetId, params: raffle }, "INVALID_PARAMS", "presetId");
  });

  test("decodeExtensionPresetParams reads a launch's id and params back, and is null for anything malformed", () => {
    const p: PresetParams = {
      preset: "pump_brake",
      brakePips: 30_000,
      thresholdTicks: 23_027,
    };
    const bytes = encodeExtensionPresetParams(p);
    expect(decodeExtensionPresetParams(3, bytes)).toEqual(p);
    expect(decodeExtensionPresetParams(9, bytes)).toBeNull();
    expect(decodeExtensionPresetParams(1, bytes)).toBeNull();
  });
});

describe("custom code by address and codehash", () => {
  const custom = {
    address: EXT,
    codehash: CODEHASH,
    maxBuyPips: 50_000,
    maxSellPips: 10_000,
    quoteOnly: false,
    sunsetSecs: 0,
  };

  test("the binding as the launch names it: a budget at its floor is written as 0", () => {
    const n = normalizeExtension({
      ...custom,
      quoteGas: 50_000,
      afterGas: 400_000,
      payee: PAYEE,
    });
    expect(n.params).toEqual({
      ...NO_EXTENSION,
      ext: EXT,
      codehash: CODEHASH,
      maxBuyPips: 50_000,
      maxSellPips: 10_000,
      quoteOnly: false,
      sunsetSecs: 0,
      quoteGas: 0,
      afterGas: 400_000,
      payee: PAYEE,
    });
    expect(n.preset).toBeNull();
    expect(n.gas).toEqual({ quoteGas: 50_000, afterGas: 400_000 });
    expect(normalizeExtension(custom).gas).toEqual({
      quoteGas: 50_000,
      afterGas: 150_000,
    });
    expect(
      normalizeExtension({ ...custom, quoteOnly: true, quoteGas: 250_000 }).gas,
    ).toEqual({ quoteGas: 250_000, afterGas: 0 });
  });

  test("the hook's bounds: 24-bit maxima (the launchpad's ceiling judges them on chain), a 32-bit sunset, budgets inside their floors and ceilings", () => {
    expect(() =>
      normalizeExtension({ ...custom, maxBuyPips: 250_000 }),
    ).not.toThrow();
    refuses(
      { ...custom, maxBuyPips: 2 ** 24 },
      "EXTENSION_OUT_OF_BOUNDS",
      "Maximum buy fee (pips) must be between 0 and 16777215.",
    );
    refuses(
      { ...custom, maxSellPips: -1 },
      "EXTENSION_OUT_OF_BOUNDS",
      "Maximum sell fee (pips) must be between 0 and 16777215.",
    );
    refuses(
      { ...custom, sunsetSecs: 2 ** 32 },
      "EXTENSION_OUT_OF_BOUNDS",
      "Sunset (seconds after launch) must be between 0 and 4294967295.",
    );
    refuses({ ...custom, quoteGas: 250_001 }, "INVALID_PARAMS", "250,000");
    refuses({ ...custom, afterGas: 149_999 }, "INVALID_PARAMS", "150,000");
    refuses(
      { ...custom, quoteOnly: true, afterGas: 150_000 },
      "INVALID_PARAMS",
      "quote-only",
    );
  });

  test("an address, codehash, flag or payee that is not one is INVALID_PARAMS", () => {
    refuses({ ...custom, address: zeroAddress }, "INVALID_PARAMS", "address");
    refuses({ ...custom, codehash: zeroHash }, "INVALID_PARAMS", "codehash");
    refuses({ ...custom, codehash: "0x12" }, "INVALID_PARAMS", "codehash");
    refuses({ ...custom, quoteOnly: 1 }, "INVALID_PARAMS", "quoteOnly");
    refuses({ ...custom, payee: zeroAddress }, "INVALID_PARAMS", "payee");
    refuses({ ...custom, payee: "0x12" }, "INVALID_PARAMS", "payee");
  });
});

describe("one way to name an extension", () => {
  test("no form, two forms at once, or a field the form does not take is INVALID_PARAMS", () => {
    refuses({}, "INVALID_PARAMS", "preset");
    refuses(null, "INVALID_PARAMS", "preset");
    refuses(
      { ...sniper, endSecs: 300, presetId: 1, params: "0x" },
      "INVALID_PARAMS",
      "one way",
    );
    // A preset names no budget and no maximum of its own (the factory's AmbiguousExtension).
    refuses(
      { ...sniper, endSecs: 300, quoteGas: 60_000 },
      "INVALID_PARAMS",
      "quoteGas",
    );
    refuses(
      { presetId: 1, params: "0x", maxBuyPips: 1 },
      "INVALID_PARAMS",
      "maxBuyPips",
    );
  });
});

describe("the chain's view of an extension", () => {
  const preset = (input: LaunchExtensionInput) =>
    normalizeExtension(input).params;
  const custom = (o: object = {}) =>
    normalizeExtension({
      address: EXT,
      codehash:
        "0xb7d4a1371b0cc4b0e66fa6fd602f6a90bf25731533f670c393e7303c7488d56a",
      maxBuyPips: 50_000,
      maxSellPips: 10_000,
      quoteOnly: false,
      sunsetSecs: 0,
      ...o,
    }).params;

  test("the allowlist key: Base's four Day-0 preset keys (config/base.extension-keys.json), each with its creation-code hash", () => {
    const sniperTax = preset({ ...sniper, endSecs: 300 });
    expect(
      extensionAllowlistKey(
        sniperTax,
        "0x97cbc1c7137f415b6cc4b19f044f979774cdc80514f0b02a8759ae20c96786cb",
      ),
    ).toBe(
      "0xf80001c93438d14882ba9d72107d6b061180b49d61bc94508910cc450bd22d1c",
    );
    expect(
      extensionAllowlistKey(
        preset({
          preset: "decay_tax",
          startBuyPips: 1,
          startSellPips: 0,
          decaySecs: 600,
        }),
        "0x9144cb4a6abb224139a698d55e5f801971b09da35b4791bdf80ea8cae6f1ccac",
      ),
    ).toBe(
      "0x3d61b513b1284fd5e664da4ef40bdc7ed58bbf2a685f7efa0fa1901c02b7beb0",
    );
    expect(
      extensionAllowlistKey(
        preset({ preset: "pump_brake", brakePips: 1, thresholdTicks: 6_932 }),
        "0x9400acb3d3cee5af519a244abdc4845f06074fdfca988958d7a15afbc12020b5",
      ),
    ).toBe(
      "0xe8e7b3d9b1f873c3d79879e5798194bc2d9c59ed543208eb2a8135568927ac88",
    );
    expect(
      extensionAllowlistKey(
        { ...NO_EXTENSION, id: 4 },
        "0xc736c4218cdf1a0f64be7be98580bccd526210ce3e73a8cd985127575c839eab",
      ),
    ).toBe(
      "0xcf30961002197f70b721de7217c69f5464a8b40702770d61aa143c05b86e3aec",
    );
    // A preset's key is its code's: without the creation-code hash there is no key to ask for.
    expect(() => extensionAllowlistKey(sniperTax)).toThrow(TypeError);
  });

  test("custom code at the floors is keyed by its codehash; with a budget named, by sha256 over it and both budgets", () => {
    expect(extensionAllowlistKey(custom())).toBe(
      "0xb7d4a1371b0cc4b0e66fa6fd602f6a90bf25731533f670c393e7303c7488d56a",
    );
    expect(
      extensionAllowlistKey(custom({ quoteGas: 250_000, afterGas: 1_000_000 })),
    ).toBe(
      "0xf4397952d78839f39a73a7acee4e735165e3f98ed4e3e5aa9c1d03a2005410bf",
    );
    expect(extensionAllowlistKey({ ...NO_EXTENSION })).toBeNull();
  });

  test("the kind a launchpad's switches name: preset, custom quote-only, custom with a post-swap call", () => {
    expect(extensionKind({ ...NO_EXTENSION })).toBe(0);
    expect(extensionKind(preset({ ...sniper, endSecs: 300 }))).toBe(1);
    expect(extensionKind(custom({ quoteOnly: true }))).toBe(2);
    expect(extensionKind(custom())).toBe(3);
  });
});

describe("what a preset does, in Bankr's own words", () => {
  test("one line per preset from its parameters", () => {
    const lines: [PresetParams, string][] = [
      [
        {
          preset: "sniper_tax",
          buyPips: 50_000,
          sellPips: 20_000,
          endSecs: 300,
        },
        "Sniper Tax: buys +5%, sells +2% until 300s after launch, then 0",
      ],
      [
        {
          preset: "decay_tax",
          startBuyPips: 40_000,
          startSellPips: 40_000,
          decaySecs: 3_600,
        },
        "Decay Tax: buys +4%, sells +4% falling to 0 over 3600s",
      ],
      [
        { preset: "pump_brake", brakePips: 30_000, thresholdTicks: 6_932 },
        "Pump Brake: buys +3% while the price is over 6932 ticks above launch",
      ],
    ];
    for (const [p, line] of lines) expect(describePreset(p)).toBe(line);
    expect(presetTerms(lines[1]![0])).toEqual({
      maxBuyPips: 40_000,
      maxSellPips: 40_000,
      quoteOnly: true,
      sunsetSecs: 3_600,
    });
  });
});
