import { describe, expect, test } from "bun:test";
import { ANY_CURVE, encodeCurve, placeCurve } from "./curve.js";
import {
  checkCurve,
  checkCurveBothOrders,
  checkCurveFormat,
  type CurveRules,
  type CurveVerdict,
} from "./curveCheck.js";
import {
  curveRevertDetail,
  padAllowsCurve,
  refuseBrokenCurve,
} from "./curveDetail.js";
import { isLaunchSdkError } from "./errors.js";
import { TEMPLATE_CURVE_RULES as RULES } from "./__internal__/fakeContractsState.js";

// Each rule at its limit and one step past it under the template's rules, with what forge answered: "ok" and the
// unplaced base units, or the revert. label | curve (`width:bps` bands or a word) | where | forge. where: start=<tick>,
// sale=1e<n>, t1 (token as currency1), own (the pool's own buys run); else a $10K WETH launch, 15 % vested, currency0.
const START = -239_200;
const SALE = 85n * 10n ** 27n;
const FORGE = `
A: an unused id | 0x3 | - | InvalidCurve
A: no first row | 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffff | - | InvalidCurve
A: the pad's any key | 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff | - | InvalidCurve
A: shares short of 100 % | 6800:300 0:9699 | - | InvalidCurve
A: a share of zero | 6800:0 0:10000 | - | InvalidCurve
A: a tail with a width | 6800:300 200:9700 | - | InvalidCurve
A: a width of zero before the tail | 0:300 0:9700 | - | InvalidCurve
A: a bit after the tail | 0x22012c000025e4000000000000000000000000000000000000000000000001 | - | InvalidCurve
A: the last finite edge at 887,000 | 1126200:9999 0:1 | - | CurveLiquidity(1)
A: the last finite edge at 887,200 | 1126400:9999 0:1 | - | InvalidCurve
one band | 0:10000 | own | ok 48868
one band, token as currency1 | 0:10000 | t1 own | ok 148203
C: a 289 bps pocket | 6800:289 0:9711 | - | ok 110537960
C: a 288 bps pocket | 6800:288 0:9712 | - | CurveTooThin(0)
C: a 368 bps tail from 20,000 ticks | 20000:9632 0:368 | - | ok 8870178827
C: a 367 bps tail from 20,000 ticks | 20000:9633 0:367 | - | CurveTooThin(1)
D: 198 bps in one spacing | 200:198 0:9802 | - | ok 179163300
D: 199 bps in one spacing | 200:199 0:9801 | - | CurveTooDense(0)
D: 1,903 bps in 2,000 ticks | 2000:1903 0:8097 | - | ok 1708141422
D: 1,904 bps in 2,000 ticks | 2000:1904 0:8096 | - | CurveTooDense(0)
F: one band from +243,200 at 100 B | 0:10000 | start=243200 sale=1e29 | ok 0
F: one band from +243,400 at 100 B | 0:10000 | start=243400 sale=1e29 | CurveLiquidity(0)
F: a dense spacing 100,000 ticks out, from +128,600 | 100000:9000 200:198 0:802 | start=128600 sale=1e29 | ok 0
F: the same from +128,800 | 100000:9000 200:198 0:802 | start=128800 sale=1e29 | CurveLiquidity(2)
G: a 303 bps pocket under one band, own buys | 6800:303 0:9697 | own | ok 115913654
G: a 302 bps pocket, own buys | 6800:302 0:9698 | own | CurveStep(1)
G: the 302 bps pocket with no own buys | 6800:302 0:9698 | - | ok 115418243
G: a 7,000-tick first band of 2,953 bps, own buys | 7000:2953 0:7047 | own | ok 5259930457
G: 2,952 bps, own buys | 7000:2952 0:7048 | own | CurveStep(1)
G: runner_v1's rows as a table, own buys | 6800:300 110000:9500 0:200 | own | CurveStep(2)
G: runner_v1's rows as a table, no own buys | 6800:300 110000:9500 0:200 | - | ok 115008486
G: the rehearsal's table, own buys | 6800:304 110000:9658 0:38 | own | ok 116479290
G: the same, token as currency1 | 6800:304 110000:9658 0:38 | t1 own | ok 124984
G: its tail one bp larger | 6800:304 110000:9657 0:39 | own | ok 116487894
G: its tail two bps larger | 6800:304 110000:9656 0:40 | own | CurveStep(2)
thin topside's rows as a table | 6800:300 7000:3565 3400:400 7600:3865 13800:1000 32200:300 46000:450 0:120 | - | ok 4031118335
G: thin topside's rows as a table, own buys | 6800:300 7000:3565 3400:400 7600:3865 13800:1000 32200:300 46000:450 0:120 | own | CurveStep(1)
built-in thin topside, own buys: no rule applies | 0x2 | own | ok 4031118335
built-in runner_v1 at the floor tick | 0x0 | start=-560000 | ok 5068623946845857923965
built-in degen, token as currency1 | 0x1 | t1 | ok 45373
built-in thin topside, one token for sale at the floor tick | 0x2 | start=-560000 sale=1e18 | ok 2466741442817
thin topside's rows as a table, the same launch | 6800:300 7000:3565 3400:400 7600:3865 13800:1000 32200:300 46000:450 0:120 | start=-560000 sale=1e18 | CurveDust(2466741442817)
E: 9,000 bps in 120,000 ticks | 120000:9000 0:1000 | - | ok 58123599
E: 8,999 bps in 120,000 ticks | 120000:8999 0:1001 | - | CurvePlacement
E: 8,990 bps in 119,800 ticks | 119800:8990 0:1010 | - | ok 53022150
E: 8,989 bps in 119,800 ticks | 119800:8989 0:1011 | - | CurvePlacement
H: seven dense bands from -543,400, token as currency0 | 200:150 200:150 400:300 1000:750 2000:1500 3400:2300 6800:3000 0:1850 | start=-543400 | ok 68883455992746125518676
H: the same from -559,800 | 200:150 200:150 400:300 1000:750 2000:1500 3400:2300 6800:3000 0:1850 | start=-559800 | CurveDust(584262532568682665469744)
`;

interface Named {
  label: string;
  forge: string;
  curve: bigint;
  startTick: number;
  tokenIsCurrency0: boolean;
  ownBuys: boolean;
  sale: bigint;
  rules: CurveRules;
}

const pack = (text: string): bigint =>
  text
    .split(" ")
    .map((r) => r.split(":").map(Number) as [number, number])
    .reduce(
      (word, [w, bps], i) =>
        word |
        (((BigInt(w / 200) << 16n) | BigInt(bps)) << BigInt(224 - 32 * i)),
      0n,
    );

const NAMED: Named[] = FORGE.trim()
  .split("\n")
  .map((line) => {
    const [label, curve, where, forge] = line.split(" | ") as [
      string,
      string,
      string,
      string,
    ];
    const at = where.split(" ");
    const start = at.find((w) => w.startsWith("start="));
    const sale = at.find((w) => w.startsWith("sale=1e"));
    return {
      label,
      forge,
      curve: curve.startsWith("0x") ? BigInt(curve) : pack(curve),
      startTick: start ? Number(start.slice(6)) : START,
      tokenIsCurrency0: !at.includes("t1"),
      ownBuys: at.includes("own"),
      sale: sale ? 10n ** BigInt(sale.slice(7)) : SALE,
      rules: RULES,
    };
  });

const named = (labelStart: string): Named => {
  const found = NAMED.find((n) => n.label.startsWith(labelStart));
  if (!found) throw new Error(`no named case "${labelStart}"`);
  return found;
};

function worded(v: CurveVerdict): string {
  if (v.ok) return `ok ${v.unplaced}`;
  const { name, row, unplaced } = v.revert;
  if (row !== null) return `${name}(${row})`;
  return unplaced !== null ? `${name}(${unplaced})` : name;
}

const bands = (...r: [number, number][]) =>
  encodeCurve(r.map(([widthTicks, shareBps]) => ({ widthTicks, shareBps })))!;

describe("each rule at its limit and one step past it, as forge answered", () => {
  for (const n of NAMED) {
    test(`${n.label}: ${n.forge}`, () => {
      expect(worded(checkCurve(n))).toBe(n.forge);
    });
  }

  test("the cases cover every verdict, both token orders and both own-buys settings", () => {
    const verdicts = new Set(NAMED.map((n) => n.forge.split(/[ (]/)[0]));
    expect([...verdicts].sort()).toEqual([
      "CurveDust",
      "CurveLiquidity",
      "CurvePlacement",
      "CurveStep",
      "CurveTooDense",
      "CurveTooThin",
      "InvalidCurve",
      "ok",
    ]);
    expect(new Set(NAMED.map((n) => n.tokenIsCurrency0)).size).toBe(2);
    expect(new Set(NAMED.map((n) => n.ownBuys)).size).toBe(2);
  });

  test("the form alone, with the start tick: what the factory checks before it deploys anything", () => {
    expect(
      checkCurveFormat(named("G: the rehearsal's table").curve, START),
    ).toBe(true);
    expect(
      checkCurveFormat(
        named("A: the last finite edge at 887,000").curve,
        START,
      ),
    ).toBe(true);
    expect(
      checkCurveFormat(
        named("A: the last finite edge at 887,200").curve,
        START,
      ),
    ).toBe(false);
    for (const word of [0n, 1n, 2n, 3n, ANY_CURVE]) {
      expect(checkCurveFormat(word, START), word.toString(16)).toBe(false);
    }
  });

  test("a launch's bands are its placement, and the mints never take more than the sale", () => {
    for (const n of NAMED) {
      const v = checkCurve(n);
      if (!v.ok) continue;
      expect(v.bands, n.label).toEqual(placeCurve(n));
      expect(v.unplaced >= 0n, n.label).toBe(true);
    }
  });
});

describe("before the salt is mined: both token orders", () => {
  test("bands that pass both ways pass; a refusal in either order is the verdict", () => {
    const ok = named("G: the rehearsal's table, own buys");
    expect(checkCurveBothOrders(ok).ok).toBe(true);
    // Rule H binds with the token as currency0 only: the same launch places as currency1.
    const dust = named("H: the same from -559,800");
    expect(
      worded(checkCurve({ ...dust, tokenIsCurrency0: false })),
    ).toStartWith("ok ");
    expect(worded(checkCurveBothOrders(dust))).toStartWith("CurveDust(");
  });
});

describe("refusals: the band and what to change", () => {
  const detailOf = (run: () => void): string => {
    try {
      run();
    } catch (err) {
      expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(true);
      return (err as { detail: string }).detail;
    }
    throw new Error("not refused");
  };

  test("each per-band rule names its band, counted from 1, the coin's own figures and a way out", () => {
    expect(curveRevertDetail("CurveTooThin", 0, RULES)).toBe(
      "Liquidity band 1 is too thin: it holds under 1/10 of the liquidity the whole sale would have as a single band from the start price. Give band 1 a larger share, or make it narrower.",
    );
    expect(curveRevertDetail("CurveTooDense", 3, RULES)).toStartWith(
      "Liquidity band 4 is too dense: it holds more than 2 times",
    );
    expect(curveRevertDetail("CurveStep", 2, RULES)).toContain(
      "a band that begins within 6,800 ticks of the start can hold at most 13 times the thinnest band before it",
    );
    expect(curveRevertDetail("CurveStep", 2, RULES)).toContain(
      "Give band 3 a smaller share or make it wider, or give the earlier bands more.",
    );
    expect(curveRevertDetail("CurveLiquidity", 0)).toBe(
      "Liquidity band 1 puts more liquidity at one price than the pool allows. Give band 1 a smaller share or make it wider, or start the launch at a lower price.",
    );
    expect(curveRevertDetail("CurveLiquidity", 2)).toContain(
      "where it meets the band before it",
    );
    expect(curveRevertDetail("CurveStep")).toStartWith(
      "One of the launch's liquidity bands",
    );
    expect(curveRevertDetail("CurvePlacement", null, RULES)).toContain(
      "at least 90% of it must be sold within 120,000 ticks",
    );
    expect(curveRevertDetail("CurveDust", null, RULES)).toContain(
      "over 2 parts per million",
    );
    expect(curveRevertDetail("InvalidCurve")).toContain("1 to 8 bands");
  });

  test("with no rules to hand a sentence names no figure", () => {
    expect(curveRevertDetail("CurveTooThin", 0)).toContain(
      "it holds less than this launchpad requires of the liquidity",
    );
    expect(curveRevertDetail("CurveDust")).toContain(
      "(more than this launchpad allows)",
    );
  });

  test("refuseBrokenCurve is INVALID_PARAMS with that sentence, in the order given or in both", () => {
    const step = named("G: runner_v1's rows as a table, own buys");
    expect(detailOf(() => refuseBrokenCurve(step, "base"))).toBe(
      curveRevertDetail("CurveStep", 2, RULES),
    );
    const { tokenIsCurrency0: _order, ...either } = step;
    expect(detailOf(() => refuseBrokenCurve(either))).toBe(
      curveRevertDetail("CurveStep", 2, RULES),
    );
    expect(() => refuseBrokenCurve({ ...step, ownBuys: false })).not.toThrow();
    const dust = named("H: the same from -559,800");
    expect(() =>
      refuseBrokenCurve({ ...dust, tokenIsCurrency0: false }),
    ).not.toThrow();
    expect(
      detailOf(() =>
        refuseBrokenCurve({ ...dust, tokenIsCurrency0: undefined }),
      ),
    ).toBe(curveRevertDetail("CurveDust", null, RULES));
  });

  test("bands placed from market caps add where a range must end, from the coin's own near window", () => {
    const step = named("G: runner_v1's rows as a table, own buys");
    expect(detailOf(() => refuseBrokenCurve(step, "base", true))).toEndWith(
      "the band after a range begins within those 6,800 ticks for certain only when the range ends under 1.97 times the start market cap. End that range lower, or convert the ranges once with curveFromMarketCaps and launch with its bands.",
    );
    // 1.0001^2,000 is 1.2214.
    const near = { ...RULES, nearTicks: 2_000, nearStep: 1 };
    expect(
      detailOf(() => refuseBrokenCurve({ ...step, rules: near }, "base", true)),
    ).toContain(
      "within those 2,000 ticks for certain only when the range ends under 1.22 times",
    );
  });

  test("well-formed bands that end past the pool's range from this start say so", () => {
    const past = named("A: the last finite edge at 887,200");
    expect(detailOf(() => refuseBrokenCurve(past))).toBe(
      "The launch's liquidity bands end past the top of the pool's price range from this start price. Make the bands narrower, or start the launch at a lower price.",
    );
    expect(detailOf(() => refuseBrokenCurve({ ...past, curve: 3n }))).toBe(
      curveRevertDetail("InvalidCurve"),
    );
  });
});

describe("the launchpad's key", () => {
  const table = bands([6_800, 304], [0, 9_696]);
  test("a built-in needs its own key; a launcher's bands their own key or the pad's any key", () => {
    expect(padAllowsCurve(0n, { listed: true, anyBands: false })).toBe(true);
    // "any" never re-opens a built-in the pad switched off.
    expect(padAllowsCurve(1n, { listed: false, anyBands: true })).toBe(false);
    expect(padAllowsCurve(table, { listed: true, anyBands: false })).toBe(true);
    expect(padAllowsCurve(table, { listed: false, anyBands: true })).toBe(true);
    expect(padAllowsCurve(table, { listed: false, anyBands: false })).toBe(
      false,
    );
  });
});
