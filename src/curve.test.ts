import { describe, expect, test } from "bun:test";
import {
  ANY_CURVE,
  BUILT_IN_CURVES,
  CURVE_NAMES,
  builtInCurveId,
  curveBandsOf,
  curveWordHex,
  decodeCurve,
  encodeCurve,
  launchCurveAt,
  placeCurve,
  type CurveBand,
} from "./curve.js";
import { MAX_USABLE_TICK } from "./economics.js";
import { sqrtPriceX96AtTick } from "./tickMath.js";

const rows = (...r: [number, number][]): CurveBand[] =>
  r.map(([widthTicks, shareBps]) => ({ widthTicks, shareBps }));
const word = (head: string) => BigInt(`0x${head.padEnd(64, "0")}`);

describe("a launch's own bands as one word", () => {
  // The suite's design note, 2.1: the words forge launches with.
  const NOTE: [string, CurveBand[], string][] = [
    [
      "runner_v1's own rows",
      rows([6_800, 300], [110_000, 9_500], [0, 200]),
      "0022012c0226251c000000c8",
    ],
    ["one band to the edge", rows([0, 10_000]), "00002710"],
    [
      "a pocket of 3.04 % under one band",
      rows([6_800, 304], [0, 9_696]),
      "00220130000025e0",
    ],
    [
      "the rehearsal's table",
      rows([6_800, 304], [110_000, 9_658], [0, 38]),
      "00220130022625ba00000026",
    ],
  ];

  for (const [label, bands, head] of NOTE) {
    test(`${label}: ${head}`, () => {
      expect(encodeCurve(bands)).toBe(word(head));
      expect(decodeCurve(word(head))).toEqual(bands);
    });
  }

  test("eight bands fill the word; a ninth is no table", () => {
    const eight = BUILT_IN_CURVES[2].map((b) => ({ ...b }));
    const packed = encodeCurve(eight)!;
    expect(packed & 0xffff_ffffn).toBe(120n);
    expect(decodeCurve(packed)).toEqual(eight);
    expect(
      encodeCurve([...rows([200, 1]), ...eight.slice(0, 7), ...rows([0, 119])]),
    ).toBeNull();
  });

  test("what is not a table encodes to null, with no rounding", () => {
    for (const bad of [
      [],
      rows([6_800, 300], [0, 9_699]),
      rows([6_800, 300], [0, 9_701]),
      rows([6_800, 0], [0, 10_000]),
      rows([6_800, 300], [200, 9_700]),
      rows([0, 300], [0, 9_700]),
      rows([6_900, 300], [0, 9_700]),
      rows([-200, 300], [0, 9_700]),
      rows([6_800, 300.5], [0, 9_699.5]),
      rows([0xffff * 200 + 200, 300], [0, 9_700]),
    ]) {
      expect(encodeCurve(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("a word decodes only when its bands encode back to it", () => {
    for (const no of [
      0n,
      1n,
      2n,
      3n,
      ANY_CURVE,
      (1n << 224n) - 1n,
      // a bit after the tail
      word("0022012c000025e4") | 1n,
      // a zero row in the middle
      word("0022012c00000000000025e4"),
      -1n,
      1n << 256n,
    ]) {
      expect(decodeCurve(no), no.toString(16)).toBeNull();
    }
  });

  test("the word is stored as 0x and 64 lower-case hex digits", () => {
    expect(curveWordHex(word("00220130022625BA00000026"))).toBe(
      `0x00220130022625ba00000026${"0".repeat(40)}`,
    );
    expect(curveWordHex(2n)).toBe(`0x${"0".repeat(63)}2`);
    expect(() => curveWordHex(1n << 256n)).toThrow(RangeError);
  });
});

describe("the built-in curves", () => {
  test("ids 0, 1 and 2 are runner_v1, degen and thin topside, and nothing else is built in", () => {
    expect([...CURVE_NAMES]).toEqual(["runner_v1", "degen", "thin_topside"]);
    expect([0n, 1n, 2n, 3n, ANY_CURVE].map(builtInCurveId)).toEqual([
      0,
      1,
      2,
      null,
      null,
    ]);
  });

  test("each is a well-formed set of bands: shares of 100 %, an open tail", () => {
    for (const id of [0, 1, 2] as const) {
      const bands = BUILT_IN_CURVES[id];
      expect(bands.reduce((s, b) => s + b.shareBps, 0)).toBe(10_000);
      expect(bands.at(-1)!.widthTicks).toBe(0);
      expect(curveBandsOf(BigInt(id))).toEqual(bands.map((b) => ({ ...b })));
    }
    expect(BUILT_IN_CURVES[1][0]).toEqual({
      widthTicks: 20_600,
      shareBps: 300,
    });
    expect(curveBandsOf(3n)).toBeNull();
  });
});

describe("where a curve's bands sit", () => {
  const curve = word("00220130022625ba00000026");
  const sale = 85n * 10n ** 27n;

  test("a currency0 token's bands run up from the start tick, the last to the usable edge", () => {
    const bands = placeCurve({
      curve,
      startTick: -239_200,
      tokenIsCurrency0: true,
      sale,
    });
    expect(bands.map((b) => [b.lower, b.upper])).toEqual([
      [-239_200, -232_400],
      [-232_400, -122_400],
      [-122_400, MAX_USABLE_TICK],
    ]);
    expect(bands.map((b) => b.amount)).toEqual([
      (sale * 304n) / 10_000n,
      (sale * 9_658n) / 10_000n,
      sale - (sale * 304n) / 10_000n - (sale * 9_658n) / 10_000n,
    ]);
    expect(bands.every((b) => b.liquidity > 0n)).toBe(true);
  });

  test("a currency1 token's bands are mirrored below its pool tick", () => {
    const bands = placeCurve({
      curve,
      startTick: -239_200,
      tokenIsCurrency0: false,
      sale,
    });
    expect(bands.map((b) => [b.lower, b.upper])).toEqual([
      [232_400, 239_200],
      [122_400, 232_400],
      [-MAX_USABLE_TICK, 122_400],
    ]);
  });

  test("a word that is no curve, or bands past the pool's range, throw", () => {
    const at = { startTick: 0, tokenIsCurrency0: true, sale };
    expect(() => placeCurve({ ...at, curve: 3n })).toThrow(RangeError);
    const wide = encodeCurve(rows([887_200, 9_999], [0, 1]))!;
    expect(() => placeCurve({ ...at, curve: wide })).toThrow(RangeError);
  });

  test("launchCurveAt names a built-in, or carries the launcher's own word, with each band's pool ticks", () => {
    expect(launchCurveAt(1n, -253_000, true)).toEqual({
      curveId: 1,
      name: "degen",
      curveTable: null,
      startTick: -253_000,
      bands: [
        {
          widthTicks: 20_600,
          shareBps: 300,
          tickLower: -253_000,
          tickUpper: -232_400,
        },
        {
          widthTicks: 110_000,
          shareBps: 9_500,
          tickLower: -232_400,
          tickUpper: -122_400,
        },
        {
          widthTicks: 0,
          shareBps: 200,
          tickLower: -122_400,
          tickUpper: 887_200,
        },
      ],
    });
    expect(launchCurveAt(curve, -239_200, false)).toEqual({
      curveId: null,
      name: null,
      curveTable: curveWordHex(curve),
      startTick: -239_200,
      bands: [
        {
          widthTicks: 6_800,
          shareBps: 304,
          tickLower: 232_400,
          tickUpper: 239_200,
        },
        {
          widthTicks: 110_000,
          shareBps: 9_658,
          tickLower: 122_400,
          tickUpper: 232_400,
        },
        {
          widthTicks: 0,
          shareBps: 38,
          tickLower: -887_200,
          tickUpper: 122_400,
        },
      ],
    });
    expect(launchCurveAt(3n, 0, true)).toBeNull();
    expect(launchCurveAt(ANY_CURVE, 0, true)).toBeNull();
  });
});

describe("TickMath.getSqrtPriceAtTick", () => {
  // Uniswap's own vectors (v4-core TickMath.t.sol).
  test("the pool's square-root price at its edges and at par", () => {
    expect(sqrtPriceX96AtTick(0)).toBe(1n << 96n);
    expect(sqrtPriceX96AtTick(-887_272)).toBe(4_295_128_739n);
    expect(sqrtPriceX96AtTick(887_272)).toBe(
      1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n,
    );
    expect(() => sqrtPriceX96AtTick(887_273)).toThrow(RangeError);
    expect(() => sqrtPriceX96AtTick(0.5)).toThrow(RangeError);
  });
});
