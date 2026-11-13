import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { ANY_CURVE, BUILT_IN_CURVES, encodeCurve } from "./curve.js";
import {
  DEFAULT_CURVE,
  bandsFormDetail,
  curveAtStart,
  curveKey,
  normalizeCurve,
} from "./curveInput.js";

class Invalid extends Error {}

const invalid = (detail: string): never => {
  throw new Invalid(detail);
};
const detailOf = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(Invalid);
    return (err as Error).message;
  }
  throw new Error("not refused");
};

const POCKET = [
  { widthTicks: 6_800, shareBps: 304 },
  { widthTicks: 0, shareBps: 9_696 },
];

describe("normalizeCurve: the launch's curve option", () => {
  test("omitted is the default curve, runner_v1 (id 0)", () => {
    expect(normalizeCurve(undefined, invalid)).toBe(DEFAULT_CURVE);
    expect(DEFAULT_CURVE.word).toBe(0n);
    expect(DEFAULT_CURVE.builtIn).toBe(0);
  });

  test("a built-in by name or by id", () => {
    for (const [given, id] of [
      ["runner_v1", 0],
      ["degen", 1],
      ["thin_topside", 2],
      [0, 0],
      [1, 1],
      [2, 2],
    ] as const) {
      const n = normalizeCurve(given, invalid);
      expect([n.word, n.builtIn, n.startMarketCap]).toEqual([
        BigInt(id),
        id,
        undefined,
      ]);
      expect(n.bands).toEqual(BUILT_IN_CURVES[id].map((b) => ({ ...b })));
    }
    for (const bad of ["runner", 3, -1, 1.5, 1n, null, true]) {
      expect(
        detailOf(() => normalizeCurve(bad, invalid)),
        String(bad),
      ).toContain("curve must be");
    }
  });

  test("raw bands carry their word, and their own start when they name one", () => {
    const n = normalizeCurve({ bands: POCKET, startFdvUsd: 25_000 }, invalid);
    expect(n).toEqual({
      word: encodeCurve(POCKET)!,
      builtIn: null,
      bands: POCKET,
      startMarketCap: 25_000,
      marketCaps: null,
    });
    expect(
      normalizeCurve({ bands: POCKET }, invalid).startMarketCap,
    ).toBeUndefined();
    expect(
      detailOf(() =>
        normalizeCurve({ bands: POCKET, startFdvUsd: 0 }, invalid),
      ),
    ).toBe("curve.startFdvUsd must be a number of US dollars above 0.");
  });

  test("market-cap ranges convert to bands and start at the first range's start", () => {
    const marketCaps = [
      {
        marketCap: { start: 10_000, end: 20_000 },
        shares: parseEther("0.0304"),
      },
      {
        marketCap: { start: 20_000, end: "max" as const },
        shares: parseEther("0.9696"),
      },
    ];
    const n = normalizeCurve({ marketCaps }, invalid);
    expect(n).toEqual({
      word: encodeCurve(POCKET)!,
      builtIn: null,
      bands: POCKET,
      startMarketCap: 10_000,
      marketCaps,
    });
    // Once the launch's start tick is known, the ranges are placed from it: $20K is 6,931.8 ticks above $10K, so
    // from a start 100 ticks above its tick the pocket ends at the next grid line, 7,000.
    const placed = curveAtStart(n, 100, invalid);
    const wider = [{ widthTicks: 7_000, shareBps: 304 }, POCKET[1]!];
    expect(placed).toEqual({ ...n, word: encodeCurve(wider)!, bands: wider });
    expect(curveAtStart(n, 60, invalid)).toEqual(n);
    // Bands given as bands, and a built-in, are never moved.
    const own = normalizeCurve({ bands: POCKET, startFdvUsd: 10_000 }, invalid);
    expect(curveAtStart(own, 100, invalid)).toBe(own);
    expect(curveAtStart(DEFAULT_CURVE, 100, invalid)).toBe(DEFAULT_CURVE);
    // A range that spans no grid line from the launch's start is refused by number, as at the first conversion:
    // 390 to 405 ticks above the start crosses 400 from a start on the grid, and nothing from one 20 ticks up.
    const up = (ticks: number) => 100 * 1.0001 ** ticks;
    const thin = normalizeCurve(
      {
        marketCaps: [
          {
            marketCap: { start: 100, end: up(390) },
            shares: parseEther("0.5"),
          },
          {
            marketCap: { start: up(390), end: up(405) },
            shares: parseEther("0.3"),
          },
          {
            marketCap: { start: up(405), end: "max" },
            shares: parseEther("0.2"),
          },
        ],
      },
      invalid,
    );
    expect(thin.bands.map((b) => b.widthTicks)).toEqual([200, 200, 0]);
    expect(
      curveAtStart(thin, 9, invalid).bands.map((b) => b.widthTicks),
    ).toEqual([200, 200, 0]);
    expect(detailOf(() => curveAtStart(thin, 20, invalid))).toBe(
      "Market-cap range 2 is narrower than one tick spacing (about 2%) once its end is rounded down to the 200-tick grid. Widen it, or merge it into the next range.",
    );
    expect(
      detailOf(() =>
        normalizeCurve(
          {
            marketCaps: [
              { marketCap: { start: 1, end: 2 }, shares: parseEther("1") },
            ],
          },
          invalid,
        ),
      ),
    ).toBe(
      'Market-cap range 1 is the last, so it must end at "max": the last band is open-ended.',
    );
  });

  test("one form at a time", () => {
    expect(detailOf(() => normalizeCurve({}, invalid))).toBe(
      "A custom curve is { bands } or { marketCaps }: set exactly one.",
    );
    expect(
      detailOf(() =>
        normalizeCurve({ bands: POCKET, marketCaps: [] }, invalid),
      ),
    ).toBe("A custom curve is { bands } or { marketCaps }: set exactly one.");
    expect(
      detailOf(() =>
        normalizeCurve({ marketCaps: [], startFdvUsd: 1 }, invalid),
      ),
    ).toContain("omit curve.startFdvUsd");
  });
});

describe("bandsFormDetail: bands that are not a table, by band", () => {
  const band = (widthTicks: unknown, shareBps: unknown) => ({
    widthTicks,
    shareBps,
  });

  test("a table has no detail", () => {
    expect(bandsFormDetail(POCKET)).toBeNull();
    expect(bandsFormDetail(BUILT_IN_CURVES[2])).toBeNull();
  });

  test("each broken band is named, counted from 1, with what to change", () => {
    expect(bandsFormDetail([])).toBe(
      "Name 1 to 8 liquidity bands, each { widthTicks, shareBps }.",
    );
    expect(bandsFormDetail("runner")).toBe(
      "Name 1 to 8 liquidity bands, each { widthTicks, shareBps }.",
    );
    expect(bandsFormDetail([...BUILT_IN_CURVES[2], band(0, 1)])).toBe(
      "A launch can name at most 8 liquidity bands: merge neighbouring bands.",
    );
    expect(bandsFormDetail([band(6_800, 300), band(200, 9_700)])).toBe(
      "Liquidity band 2 is the last, so its widthTicks must be 0: the last band is open-ended and runs to the top of the pool's range.",
    );
    expect(bandsFormDetail([band(6_900, 300), band(0, 9_700)])).toBe(
      "Liquidity band 1: widthTicks must be a multiple of 200 ticks, at least 200. Only the last band has width 0.",
    );
    expect(bandsFormDetail([band(0, 300), band(0, 9_700)])).toStartWith(
      "Liquidity band 1: widthTicks",
    );
    expect(
      bandsFormDetail([band(6_800, 300), band(undefined, 100), band(0, 9_600)]),
    ).toStartWith("Liquidity band 2: widthTicks");
    expect(bandsFormDetail([band(6_800, 0), band(0, 10_000)])).toBe(
      "Liquidity band 1: shareBps must be a whole number of basis points, at least 1.",
    );
    expect(bandsFormDetail([band(6_800, 30.5), band(0, 9_969.5)])).toStartWith(
      "Liquidity band 1: shareBps",
    );
    expect(bandsFormDetail([band(6_800, 300), null])).toBe(
      "Liquidity band 2 must be { widthTicks, shareBps }.",
    );
    expect(bandsFormDetail([band(6_800, 300), band(0, 9_699)])).toBe(
      "The bands' shares add up to 9999 basis points: change them to add up to exactly 10,000 (100% of the sale).",
    );
    expect(bandsFormDetail([band(0x10000 * 200, 300), band(0, 9_700)])).toBe(
      "Liquidity band 1 is wider than a band can be: make it narrower.",
    );
  });

  test("it agrees with the encoder on what is a table", () => {
    const cases: unknown[] = [
      POCKET,
      [band(6_800, 300), band(0, 9_699)],
      [band(200, 1), band(200, 1), band(0, 9_998)],
      [band(0, 10_000)],
      [band(100, 5_000), band(0, 5_000)],
    ];
    for (const c of cases) {
      expect(bandsFormDetail(c) === null, JSON.stringify(c)).toBe(
        encodeCurve(c as Parameters<typeof encodeCurve>[0]) !== null,
      );
    }
  });
});

describe("curveKey: what a launchpad lists", () => {
  test("a built-in's id, the bands' word, or the any key", () => {
    expect(curveKey("degen", invalid)).toBe(1n);
    expect(curveKey(2, invalid)).toBe(2n);
    expect(curveKey("any", invalid)).toBe(ANY_CURVE);
    expect(curveKey(ANY_CURVE, invalid)).toBe(ANY_CURVE);
    expect(curveKey({ bands: POCKET }, invalid)).toBe(encodeCurve(POCKET)!);
    expect(curveKey(encodeCurve(POCKET)!, invalid)).toBe(encodeCurve(POCKET)!);
    expect(curveKey(0n, invalid)).toBe(0n);
  });

  test("a word that is no curve, or market-cap ranges, are refused", () => {
    expect(detailOf(() => curveKey(3n, invalid))).toContain(
      "This word is not a curve",
    );
    expect(detailOf(() => curveKey({ marketCaps: [] }, invalid))).toContain(
      "curveFromMarketCaps",
    );
    expect(detailOf(() => curveKey("all", invalid))).toContain("curve must be");
  });
});
