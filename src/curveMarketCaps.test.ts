import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import {
  BUILT_IN_CURVES,
  decodeCurve,
  encodeCurve,
  type CurveBand,
} from "./curve.js";
import { checkCurveBothOrders } from "./curveCheck.js";
import {
  curveFromMarketCaps,
  curveMarketCaps,
  type CurveMarketCapRange,
} from "./curveMarketCaps.js";
import { isLaunchSdkError } from "./errors.js";

const range = (
  start: number,
  end: number | "max",
  percent: string,
): CurveMarketCapRange => ({
  marketCap: { start, end },
  shares: parseEther(percent) / 100n,
});

// Doppler's own schedules, as Bankr's Doppler launches configure them.
const RUNNER_V1 = [
  range(10_000, 20_000, "3"),
  range(20_000, 1_200_000_000, "95"),
  range(1_200_000_000, "max", "2"),
];
const THIN_TOPSIDE = [
  range(10_000, 20_000, "3"),
  range(20_000, 40_000, "35.65"),
  range(40_000, 56_000, "4"),
  range(56_000, 120_000, "38.65"),
  range(120_000, 480_000, "10"),
  range(480_000, 12_000_000, "3"),
  range(12_000_000, 1_200_000_000, "4.5"),
  range(1_200_000_000, "max", "1.2"),
];

const detailOf = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(true);
    return (err as { detail: string }).detail;
  }
  throw new Error("not refused");
};

describe("curveFromMarketCaps: Doppler's market-cap ranges as a launch's bands", () => {
  test("runner_v1's ranges are the built-in runner_v1's bands: $20K is 6,800 ticks up, $1.2B 116,800", () => {
    const made = curveFromMarketCaps({ ranges: RUNNER_V1 });
    expect(made.bands).toEqual(BUILT_IN_CURVES[0].map((b) => ({ ...b })));
    expect(made.curve).toBe(
      BigInt(`0x0022012c0226251c000000c8${"0".repeat(40)}`),
    );
    expect(made.startMarketCap).toBe(10_000);
    expect(decodeCurve(made.curve)).toEqual(made.bands);
  });

  test("thin topside's eight ranges are the built-in thin topside's bands", () => {
    const made = curveFromMarketCaps({
      ranges: THIN_TOPSIDE,
      startMarketCap: 10_000,
    });
    expect(made.bands).toEqual(BUILT_IN_CURVES[2].map((b) => ({ ...b })));
  });

  test("only ratios place a band: the same ranges in another unit are the same bands", () => {
    const inWei = RUNNER_V1.map((r) => ({
      ...r,
      marketCap: {
        start: r.marketCap.start * 4e14,
        end:
          r.marketCap.end === "max" ? ("max" as const) : r.marketCap.end * 4e14,
      },
    }));
    expect(curveFromMarketCaps({ ranges: inWei }).curve).toBe(
      curveFromMarketCaps({ ranges: RUNNER_V1 }).curve,
    );
  });

  const ASKED = [
    [
      range(10_000, 15_000, "3.5"),
      range(15_000, 123_456, "60"),
      range(123_456, 9_876_543, "30.5"),
      range(9_876_543, "max", "6"),
    ],
    [
      range(2_500, 7_777, "10"),
      range(7_777, 7_777 * 1.03, "1.5"),
      range(7_777 * 1.03, "max", "88.5"),
    ],
    [range(1, 1.0203, "1"), range(1.0203, 1e9, "97"), range(1e9, "max", "2")],
    RUNNER_V1,
    THIN_TOPSIDE,
  ];
  const ticksOf = (ratio: number) => Math.log(ratio) / Math.log(1.0001);
  // Where each band of `bands` ends and where its range asked to end, both in ticks above the launch's start tick,
  // which sits `startOffsetTicks` under the start market cap.
  const ends = (
    ranges: readonly CurveMarketCapRange[],
    bands: readonly CurveBand[],
    startOffsetTicks: number,
  ) => {
    let placed = 0;
    return bands.slice(0, -1).map((b, n) => {
      placed += b.widthTicks;
      const asked =
        startOffsetTicks +
        ticksOf(
          (ranges[n]!.marketCap.end as number) / ranges[0]!.marketCap.start,
        );
      return { placed, under: asked - placed };
    });
  };

  test("rounding on the launched pool: given the start's offset inside its spacing, each band ends at or under the market cap asked for, less than one tick spacing under it", () => {
    for (const ranges of ASKED) {
      for (const startOffsetTicks of [0, 0.5, 60.5, 100, 150.25, 199.99]) {
        const made = curveFromMarketCaps({ ranges, startOffsetTicks });
        expect(decodeCurve(made.curve)).toEqual(made.bands);
        expect(made.bands.map((b) => BigInt(b.shareBps) * 10n ** 14n)).toEqual(
          ranges.map((r) => r.shares),
        );
        for (const [n, end] of ends(
          ranges,
          made.bands,
          startOffsetTicks,
        ).entries()) {
          const at = `range ${n + 1} at offset ${startOffsetTicks}`;
          expect(end.under >= -1e-6, `${at} ends above`).toBe(true);
          expect(end.under < 200, `${at} ends a spacing under`).toBe(true);
          expect(end.placed % 200).toBe(0);
        }
      }
    }
  });

  test("the offset moves a band's edge to the grid line at or under its market cap: runner_v1's $1.2B from a start 60.5 ticks above its tick", () => {
    // $20K is 6,931.8 ticks above $10K and $1.2B 116,958.0: from 60.5 up, the second crosses the next grid line.
    expect(
      curveFromMarketCaps({ ranges: RUNNER_V1, startOffsetTicks: 60.5 }).bands,
    ).toEqual([
      { widthTicks: 6_800, shareBps: 300 },
      { widthTicks: 110_200, shareBps: 9_500 },
      { widthTicks: 0, shareBps: 200 },
    ]);
    expect(
      curveFromMarketCaps({ ranges: RUNNER_V1, startOffsetTicks: 150 }).bands,
    ).toEqual([
      { widthTicks: 7_000, shareBps: 300 },
      { widthTicks: 110_000, shareBps: 9_500 },
      { widthTicks: 0, shareBps: 200 },
    ]);
    for (const bad of [-1, 200, 250, Number.NaN, "60" as unknown as number])
      expect(
        detailOf(() =>
          curveFromMarketCaps({ ranges: RUNNER_V1, startOffsetTicks: bad }),
        ),
        String(bad),
      ).toBe(
        "startOffsetTicks is how far the start market cap sits above the launch's start tick: a number from 0 up to, not including, 200.",
      );
  });

  test("without the offset the start's own rounding adds to it: a band ends under two tick spacings below its market cap, and can end more than one below", () => {
    let worst = 0;
    for (const ranges of ASKED) {
      const made = curveFromMarketCaps({ ranges });
      // The same bands on a launch whose start market cap sits anywhere inside its tick spacing.
      for (const startOffsetTicks of [0, 60.5, 150.25, 199.99]) {
        for (const end of ends(ranges, made.bands, startOffsetTicks)) {
          expect(end.under >= -1e-6).toBe(true);
          expect(end.under < 400).toBe(true);
          worst = Math.max(worst, end.under);
        }
      }
    }
    expect(worst).toBeGreaterThan(300);
    // $20K asked from a start 150.25 ticks above its tick: 6,800 placed, 282 ticks (2.9 %) under.
    const [pocket] = ends(
      RUNNER_V1,
      curveFromMarketCaps({ ranges: RUNNER_V1 }).bands,
      150.25,
    );
    expect(pocket!.placed).toBe(6_800);
    expect(Math.round(pocket!.under)).toBe(282);
  });

  test("the README's ranges launch on a pool that buys its own token wherever the start sits: the pocket ends under 1.97 times the start", () => {
    const readme = [
      range(10_000, 19_500, "3.04"),
      range(19_500, 1_200_000_000, "96.58"),
      range(1_200_000_000, "max", "0.38"),
    ];
    const sale = 100_000_000_000n * 10n ** 18n;
    const pockets = new Set<number>();
    for (
      let startOffsetTicks = 0;
      startOffsetTicks < 200;
      startOffsetTicks += 0.5
    ) {
      const made = curveFromMarketCaps({ ranges: readme, startOffsetTicks });
      pockets.add(made.bands[0]!.widthTicks);
      // $10K at WETH $2,500 and $4,000, and on a 6-decimal dollar quote.
      for (const startTick of [-239_600, -244_200, -437_600])
        expect(
          checkCurveBothOrders({
            curve: made.curve,
            startTick,
            sale,
            ownBuys: true,
          }).ok,
          `offset ${startOffsetTicks} from ${startTick}`,
        ).toBe(true);
    }
    expect([...pockets].sort()).toEqual([6_600, 6_800]);
    // The same ranges with the pocket to $20K: 7,000 ticks from a start 68.2 or more above its tick, where the
    // step rule refuses the band after it.
    const twice = [
      range(10_000, 20_000, "3.04"),
      range(20_000, 1_200_000_000, "96.58"),
      range(1_200_000_000, "max", "0.38"),
    ];
    const verdict = (startOffsetTicks: number) =>
      checkCurveBothOrders({
        curve: curveFromMarketCaps({ ranges: twice, startOffsetTicks }).curve,
        startTick: -239_600,
        sale,
        ownBuys: true,
      });
    expect(verdict(68).ok).toBe(true);
    const refused = verdict(68.5);
    expect(refused.ok ? null : refused.revert).toEqual({
      name: "CurveStep",
      row: 1,
      unplaced: null,
    });
  });

  test("in the helper's own frame, a start on the grid: the bands decode to ranges at or under the ones asked for, less than one tick spacing under", () => {
    const spacing = Math.pow(1.0001, 200);
    for (const ranges of ASKED.slice(0, 3)) {
      const made = curveFromMarketCaps({ ranges });
      const decoded = curveMarketCaps({
        bands: decodeCurve(made.curve)!,
        startMarketCap: made.startMarketCap,
      });
      expect(decoded).toHaveLength(ranges.length);
      ranges.forEach((r, n) => {
        const got = decoded[n]!;
        expect(got.shares).toBe(r.shares);
        if (r.marketCap.end === "max") {
          expect(got.marketCap.end).toBe("max");
          return;
        }
        const end = got.marketCap.end as number;
        expect(
          end <= r.marketCap.end * (1 + 1e-12),
          `range ${n + 1} ends above`,
        ).toBe(true);
        expect(
          r.marketCap.end < end * spacing,
          `range ${n + 1} ends a spacing under`,
        ).toBe(true);
        expect(got.widthTicks % 200).toBe(0);
      });
    }
  });

  test("shares are never rounded: one that is not whole basis points is refused, and so is a sum off 100 %", () => {
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [
            { marketCap: { start: 1, end: 2 }, shares: parseEther("0.35655") },
            {
              marketCap: { start: 2, end: "max" },
              shares: parseEther("0.64345"),
            },
          ],
        }),
      ),
    ).toBe(
      "Market-cap range 1: shares must be a bigint above 0 in whole basis points of the sale (10^18 is all of it, 10^14 one basis point).",
    );
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [range(1, 2, "3"), range(2, "max", "96.99")],
        }),
      ),
    ).toBe("The ranges' shares must add up to 100% of the sale (10^18).");
  });

  test("ranges are contiguous from the start, and only the last is open-ended", () => {
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [range(1, 2, "3"), range(3, "max", "97")],
        }),
      ),
    ).toBe(
      "Market-cap range 2 must start where range 1 ends (2): ranges are contiguous.",
    );
    expect(
      detailOf(() =>
        curveFromMarketCaps({ ranges: RUNNER_V1, startMarketCap: 12_000 }),
      ),
    ).toBe(
      "Market-cap range 1 must start at the launch's start market cap (12000).",
    );
    expect(
      detailOf(() =>
        curveFromMarketCaps({ ranges: [range(1, 2, "3"), range(2, 4, "97")] }),
      ),
    ).toBe(
      'Market-cap range 2 is the last, so it must end at "max": the last band is open-ended.',
    );
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [range(1, "max", "3"), range(2, "max", "97")],
        }),
      ),
    ).toBe(
      'Market-cap range 1 must end at a market cap above its start; only the last range ends at "max".',
    );
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [{ marketCap: null, shares: 1n }] as never,
          startMarketCap: 1,
        }),
      ),
    ).toBe("Market-cap range 1 must be { marketCap: { start, end }, shares }.");
    expect(detailOf(() => curveFromMarketCaps({ ranges: [] }))).toBe(
      "Name at least one market-cap range.",
    );
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [
            ...Array.from({ length: 8 }, (_, n) =>
              range(2 ** n, 2 ** (n + 1), "10"),
            ),
            range(256, "max", "20"),
          ],
        }),
      ),
    ).toBe("A launch can name at most 8 market-cap ranges.");
  });

  test("a range under one tick spacing after rounding is refused by number", () => {
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [range(10_000, 10_100, "1"), range(10_100, "max", "99")],
        }),
      ),
    ).toBe(
      "Market-cap range 1 is narrower than one tick spacing (about 2%) once its end is rounded down to the 200-tick grid. Widen it, or merge it into the next range.",
    );
  });

  test("a range is one band: Doppler's numPositions is 1 or left out", () => {
    const one = RUNNER_V1.map((r) => ({ ...r, numPositions: 1 }));
    expect(curveFromMarketCaps({ ranges: one }).bands).toEqual(
      BUILT_IN_CURVES[0].map((b) => ({ ...b })),
    );
    expect(
      detailOf(() =>
        curveFromMarketCaps({
          ranges: [
            { ...RUNNER_V1[0]!, numPositions: 4 },
            ...RUNNER_V1.slice(1),
          ],
        }),
      ),
    ).toStartWith("Market-cap range 1: numPositions must be 1 or left out.");
  });
});

describe("curveMarketCaps: a curve's bands as market-cap ranges for a chart", () => {
  test("runner_v1 from $10K: its pocket ends just under $20K, its backbone just under $1.2B", () => {
    const [pocket, backbone, tail] = curveMarketCaps({
      bands: BUILT_IN_CURVES[0],
      startMarketCap: 10_000,
    });
    expect(pocket!.marketCap.start).toBe(10_000);
    expect(pocket!.marketCap.end).toBeCloseTo(10_000 * 1.0001 ** 6_800, 6);
    expect(Math.round(pocket!.marketCap.end as number)).toBe(19_738);
    expect(backbone!.marketCap.start).toBe(pocket!.marketCap.end as number);
    expect((backbone!.marketCap.end as number) / 1e9).toBeCloseTo(1.1812, 3);
    expect(tail!.marketCap).toEqual({
      start: backbone!.marketCap.end as number,
      end: "max",
    });
    expect([pocket!.shareBps, backbone!.shareBps, tail!.shareBps]).toEqual([
      300, 9_500, 200,
    ]);
    expect(pocket!.shares).toBe(parseEther("0.03"));
  });

  test("the ranges convert back to the same bands, for any start and any table", () => {
    const tables: CurveBand[][] = [
      BUILT_IN_CURVES[0].map((b) => ({ ...b })),
      BUILT_IN_CURVES[1].map((b) => ({ ...b })),
      BUILT_IN_CURVES[2].map((b) => ({ ...b })),
      [{ widthTicks: 0, shareBps: 10_000 }],
      [
        { widthTicks: 200, shareBps: 198 },
        { widthTicks: 400_000, shareBps: 9_000 },
        { widthTicks: 200, shareBps: 1 },
        { widthTicks: 0, shareBps: 801 },
      ],
    ];
    for (const bands of tables) {
      for (const startMarketCap of [10_000, 2_500, 0.000371, 4.1e18, 7e30]) {
        const ranges = curveMarketCaps({ bands, startMarketCap });
        const back = curveFromMarketCaps({ ranges, startMarketCap });
        expect(back.bands).toEqual(bands);
        expect(back.curve).toBe(encodeCurve(bands)!);
      }
    }
  });

  test("bands that are no curve, or a start that is no market cap, are INVALID_PARAMS", () => {
    expect(
      detailOf(() =>
        curveMarketCaps({
          bands: [{ widthTicks: 200, shareBps: 10_000 }],
          startMarketCap: 1,
        }),
      ),
    ).toBe("These are not a curve's bands.");
    expect(
      detailOf(() =>
        curveMarketCaps({ bands: BUILT_IN_CURVES[0], startMarketCap: 0 }),
      ),
    ).toBe("The start market cap must be a number above 0.");
  });
});
