import { describe, expect, test } from "bun:test";
import { zeroAddress, zeroHash } from "viem";
import { at } from "../__internal__/fakeSettings.js";
import { PAD_TREASURY_MARKER } from "../launchpad.js";
import {
  KNOB_NAMES,
  knobAt,
  knobId,
  knobsByName,
  limitsByName,
  rangeAtLaunch,
  switchNames,
  switchWord,
  switchesOf,
} from "./names.js";
import {
  WAD,
  clearedSwitchesProblem,
  cutFits,
  guardTermsProblem,
  limitProblem,
  newPayeesProblem,
  ownerCutProblem,
  padQuoteTermsProblem,
  padRowProblem,
  payeeLimitBreach,
  payeesProblem,
  presetLimitsProblem,
  presetRecordProblem,
  protocolTermsProblem,
  quoteTermsProblem,
  rangeProblem,
  splitFits,
  switchesProblem,
  type ChainPadTerms,
  type GuardTerms,
  type ProtocolTerms,
  type QuoteTerms,
} from "./rules.js";

const PROTOCOL: ProtocolTerms = {
  bankrFeeBps: 1_000,
  bankrMinPips: 250,
  holdersShareBps: 5_000,
  extBankrNum: 2,
  extBankrDen: 7,
  ctoNotice: 172_800,
  ctoGrace: 604_800,
  tokenActivationDivisor: 10_000,
  bnkrActivationDivisor: 10_000_000,
  maxPadPayees: 4,
};
const GUARDS: GuardTerms = {
  refTauSecs: 1_800,
  compoundSwapMaxTicks: 50,
  fillTravelTicks: 100,
  fillTravelCompoundingTicks: 25,
  fillStartGapTicks: 20,
  minRoundTripPips: 10_000,
  curveNearStep: 13,
  maxCompoundUsd: 10_000,
};
const r = (min: bigint, max: bigint, dflt = min) => ({
  min,
  max,
  default: dflt,
});
const terms = (
  shares: bigint[],
  decay?: { autoLpBps: number; sharesWad: bigint[] },
): ChainPadTerms => ({
  payees: shares.map((_, i) => at(0x100 + i)),
  steadySharesWad: shares,
  decay: decay
    ? { on: true, ...decay }
    : { on: false, autoLpBps: 0, sharesWad: [] },
});

describe("names", () => {
  test("every knob has its chain id at its own index, and a name round-trips", () => {
    KNOB_NAMES.forEach((name, i) => {
      expect(knobId(name)).toBe(i);
      expect(knobAt(i).name).toBe(name);
    });
    expect(knobId("nope")).toBeUndefined();
    expect(() => knobAt(KNOB_NAMES.length)).toThrow(RangeError);
  });

  test("a chain answer of another length is refused, not misread", () => {
    expect(() => knobsByName([{ min: 0n, max: 1n, dflt: 0n }])).toThrow(
      RangeError,
    );
    expect(() => limitsByName([])).toThrow(RangeError);
  });

  test("switches read from and write to the flags word by name", () => {
    const word = switchWord({ devBuy: true, takeover: true });
    expect(word).toBe(17n);
    expect(switchesOf(word).takeover).toBe(true);
    expect(switchesOf(word).allocations).toBe(false);
    expect(switchWord({ takeover: false }, word)).toBe(1n);
    expect(switchNames(word)).toEqual(["devBuy", "takeover"]);
  });
});

describe("the owner's own terms", () => {
  test("the terms in force pass; each floor refuses one step under it", () => {
    expect(protocolTermsProblem(PROTOCOL)).toBeNull();
    const bad: Partial<ProtocolTerms>[] = [
      { bankrFeeBps: 10_001 },
      { holdersShareBps: 10_001 },
      { extBankrDen: 0 },
      { extBankrNum: 8 },
      { ctoNotice: 3_599 },
      { ctoGrace: 0 },
      { tokenActivationDivisor: 9_999 },
      { bnkrActivationDivisor: 9_999_999 },
      { maxPadPayees: 17 },
    ];
    for (const change of bad)
      expect(
        protocolTermsProblem({ ...PROTOCOL, ...change }),
        JSON.stringify(change),
      ).not.toBeNull();
    expect(
      protocolTermsProblem({ ...PROTOCOL, ctoNotice: 3_600, maxPadPayees: 16 }),
    ).toBeNull();
  });

  test("the guards hold travel to the fee it is measured against", () => {
    expect(guardTermsProblem(GUARDS)).toBeNull();
    const bad: Partial<GuardTerms>[] = [
      { refTauSecs: 1_799 },
      { compoundSwapMaxTicks: 0 },
      { fillTravelTicks: 101 },
      { fillTravelCompoundingTicks: 51 },
      { curveNearStep: 0 },
      { curveNearStep: 14 },
      { maxCompoundUsd: 0 },
    ];
    for (const change of bad)
      expect(
        guardTermsProblem({ ...GUARDS, ...change }),
        JSON.stringify(change),
      ).not.toBeNull();
    // the two travel sums sit exactly on the round-trip fee
    expect(
      guardTermsProblem({ ...GUARDS, fillTravelCompoundingTicks: 50 }),
    ).toBeNull();
  });

  test("Bankr's cut fits a fee beside a referrer rate, to the pip", () => {
    // 250 pips of volume inside a 500-pip fee with half of it referred: exactly fits, one more bp does not
    expect(cutFits(PROTOCOL, 500n, 5_000n)).toBe(true);
    expect(cutFits(PROTOCOL, 500n, 5_001n)).toBe(false);
    expect(cutFits(PROTOCOL, 249n, 0n)).toBe(false);
    // Bankr's share and the referrer's may take the whole fee between them, and not a bp more
    expect(cutFits({ bankrFeeBps: 6_000, bankrMinPips: 0 }, 1n, 4_000n)).toBe(
      true,
    );
    expect(cutFits({ bankrFeeBps: 6_000, bankrMinPips: 0 }, 1n, 4_001n)).toBe(
      false,
    );
  });

  test("an owner change is held to the limits, the template and Bankr's pad, in that order", () => {
    const fits = {
      protocol: PROTOCOL,
      limits: {
        steadyPips: { min: 500n, max: 999_999n },
        referrerBps: { min: 0n, max: 10_000n },
      },
      template: { steadyPips: r(500n, 100_000n), referrerBps: r(0n, 0n) },
      bankrPad: { steadyPips: r(17_500n, 17_500n), referrerBps: r(0n, 0n) },
    };
    expect(ownerCutProblem(fits)).toBeNull();
    expect(
      ownerCutProblem({
        ...fits,
        limits: { ...fits.limits, steadyPips: { min: 0n, max: 249n } },
      }),
    ).toContain("limits");
    expect(
      ownerCutProblem({
        ...fits,
        template: { ...fits.template, steadyPips: r(249n, 500n) },
      }),
    ).toContain("template");
    expect(
      ownerCutProblem({
        ...fits,
        bankrPad: { ...fits.bankrPad, referrerBps: r(0n, 9_001n) },
      }),
    ).toContain("pad 0");
  });
});

describe("a pad's row", () => {
  test("a limit sits inside the hard range and a range inside the limit, default between", () => {
    const hard = { min: 0n, max: 999_999n };
    expect(
      limitProblem("steadyPips", { min: 500n, max: 999_999n }, hard),
    ).toBeNull();
    expect(
      limitProblem("steadyPips", { min: 500n, max: 1_000_000n }, hard),
    ).not.toBeNull();
    expect(
      limitProblem("steadyPips", { min: 600n, max: 500n }, hard),
    ).not.toBeNull();
    const limit = { min: 500n, max: 100_000n };
    expect(
      rangeProblem("steadyPips", r(500n, 100_000n, 20_000n), limit),
    ).toBeNull();
    expect(
      rangeProblem("steadyPips", r(499n, 100_000n, 500n), limit),
    ).toContain("limit");
    expect(rangeProblem("steadyPips", r(500n, 100_001n), limit)).toContain(
      "limit",
    );
    expect(rangeProblem("steadyPips", r(600n, 700n, 599n), limit)).toContain(
      "default",
    );
    expect(rangeProblem("steadyPips", r(600n, 700n, 701n), limit)).toContain(
      "default",
    );
  });

  test("a row carries Bankr's cut, and takeover holds the fee recipients to 64", () => {
    const knobs = {
      steadyPips: r(500n, 100_000n),
      referrerBps: r(0n, 5_000n),
      feeRecipients: r(1n, 64n),
    };
    expect(
      padRowProblem({ protocol: PROTOCOL, knobs, takeover: true }),
    ).toBeNull();
    expect(
      padRowProblem({
        protocol: PROTOCOL,
        knobs: { ...knobs, referrerBps: r(0n, 5_001n) },
        takeover: false,
      }),
    ).toContain("Bankr's cut");
    const many = { ...knobs, feeRecipients: r(1n, 65n) };
    expect(
      padRowProblem({ protocol: PROTOCOL, knobs: many, takeover: true }),
    ).toContain("64");
    expect(
      padRowProblem({ protocol: PROTOCOL, knobs: many, takeover: false }),
    ).toBeNull();
  });

  test("only what the owner allows is switched on, and never takeover in the template", () => {
    expect(switchesProblem(3n, 3n)).toBeNull();
    expect(switchesProblem(7n, 3n)).toContain("capExclusions");
    expect(switchesProblem(16n, 2_047n, true)).toContain("template");
    expect(switchesProblem(16n, 2_047n)).toBeNull();
  });

  test("payees: count, one share each, both sums inside the limit, distinct and non-zero", () => {
    const half = WAD / 2n;
    expect(payeesProblem(terms([half, half]), 4, 10_000n)).toBeNull();
    expect(payeesProblem(terms([half, half + 1n]), 4, 10_000n)).toContain(
      "10000 bps",
    );
    expect(payeesProblem(terms([half, half]), 1, 10_000n)).toContain(
      "at most 1",
    );
    expect(payeesProblem(terms([half]), 4, 4_999n)).not.toBeNull();
    expect(payeesProblem(terms([half]), 4, 5_000n)).toBeNull();
    // a decay split: one share per payee, its own sum, an auto-LP part of a whole at most
    expect(
      payeesProblem(
        terms([half], { autoLpBps: 10_000, sharesWad: [WAD] }),
        4,
        10_000n,
      ),
    ).toBeNull();
    expect(
      payeesProblem(
        terms([half], { autoLpBps: 10_001, sharesWad: [WAD] }),
        4,
        10_000n,
      ),
    ).toContain("decay");
    expect(
      payeesProblem(terms([half], { autoLpBps: 0, sharesWad: [] }), 4, 10_000n),
    ).toContain("decay");
    expect(
      payeesProblem(
        terms([half], { autoLpBps: 0, sharesWad: [WAD + 1n] }),
        4,
        10_000n,
      ),
    ).not.toBeNull();
    const twice = terms([1n, 1n]);
    expect(
      payeesProblem({ ...twice, payees: [at(1), at(1)] }, 4, 10_000n),
    ).toContain("twice");
    expect(
      payeesProblem({ ...twice, payees: [at(1), zeroAddress] }, 4, 10_000n),
    ).toContain("zero");
  });

  test("a paused switch a row still holds is named, with the words that go on", () => {
    expect(clearedSwitchesProblem(1n)).toContain(
      "stopped allowing devBuy, held on here",
    );
    expect(clearedSwitchesProblem(1n)).toContain(
      "(switches: { devBuy: false })",
    );
    expect(clearedSwitchesProblem(17n, "setSwitches")).toContain(
      "(setSwitches: { devBuy: false, takeover: false })",
    );
    // a bit this SDK version does not name cannot be named off: the sentence says so and offers no words
    const unnamed = clearedSwitchesProblem(1n << 200n);
    expect(unnamed).toContain("does not name");
    expect(unnamed).not.toContain("{");
  });

  test("a stored row as a launch meets it: clamped into the owner's limit, the default inside", () => {
    const row = r(60n, 86_400n, 3_600n);
    expect(rangeAtLaunch(row, { min: 0n, max: 100_000n })).toEqual(row);
    expect(rangeAtLaunch(row, { min: 0n, max: 86_399n })).toEqual(
      r(60n, 86_399n, 3_600n),
    );
    expect(rangeAtLaunch(row, { min: 0n, max: 3_599n })).toEqual(
      r(60n, 3_599n, 3_599n),
    );
    expect(rangeAtLaunch(row, { min: 3_601n, max: 100_000n })).toEqual(
      r(3_601n, 86_400n, 3_601n),
    );
    // a limit moved wholly past the row, either side: its nearest edge
    expect(rangeAtLaunch(row, { min: 0n, max: 59n })).toEqual(r(59n, 59n));
    expect(rangeAtLaunch(row, { min: 90_000n, max: 99_000n })).toEqual(
      r(90_000n, 90_000n),
    );
    expect(row).toEqual(r(60n, 86_400n, 3_600n));
  });

  test("the launch's split: the marker's cut under the whole, the rest rescaled and rounded up inside the remainder", () => {
    const marker = PAD_TREASURY_MARKER;
    const bps = (n: bigint) => n * 10n ** 14n;
    expect(splitFits([], [])).toBe(true);
    expect(splitFits([at(1), at(2)], [WAD / 2n, WAD / 2n])).toBe(true);
    // the marker at the whole leaves nothing to rescale over; one wei under, it does
    expect(splitFits([marker], [WAD])).toBe(false);
    expect(splitFits([marker], [WAD - 1n])).toBe(true);
    // 33.33 % to the marker: 33.33 % and 33.34 % of the whole round up past what is left
    const thirds = [marker, at(1), at(2)];
    expect(splitFits(thirds, [bps(3_333n), bps(3_333n), bps(3_334n)])).toBe(
      false,
    );
    expect(splitFits(thirds, [bps(3_333n), bps(3_333n), bps(3_333n)])).toBe(
      true,
    );
    expect(splitFits(thirds, [bps(3_000n), bps(3_000n), bps(3_000n)])).toBe(
      true,
    );
    // the same shares with no marker are a plain sum
    expect(
      splitFits([at(3), at(1), at(2)], [bps(3_333n), bps(3_333n), bps(3_334n)]),
    ).toBe(true);
  });

  test("payees a call names are also held to the launch's split, steady and decay; stored ones are not", () => {
    const marker = PAD_TREASURY_MARKER;
    const whole: ChainPadTerms = { ...terms([WAD]), payees: [marker] };
    // _setPayees takes it; every launch on the pad would revert InvalidPayees
    expect(payeesProblem(whole, 4, 10_000n)).toBeNull();
    expect(newPayeesProblem(whole, 4, 10_000n)).toContain("No launch");
    expect(
      newPayeesProblem({ ...terms([WAD - 1n]), payees: [marker] }, 4, 10_000n),
    ).toBeNull();
    // the decay list is split the same way, only while the decay split is on
    const decay: ChainPadTerms = {
      ...terms([1n], { autoLpBps: 0, sharesWad: [WAD] }),
      payees: [marker],
    };
    expect(payeesProblem(decay, 4, 10_000n)).toBeNull();
    expect(newPayeesProblem(decay, 4, 10_000n)).toContain("No launch");
    // the setter's own refusal comes first, in its own words
    expect(newPayeesProblem(terms([WAD, 1n]), 4, 10_000n)).toContain(
      "10000 bps",
    );
    expect(
      newPayeesProblem(terms([WAD / 2n, WAD / 2n]), 4, 10_000n),
    ).toBeNull();
  });

  test("the launch's own payee check names which limit a stored pad is over", () => {
    const stored = terms([WAD / 4n, WAD / 4n], {
      autoLpBps: 0,
      sharesWad: [WAD / 2n, WAD / 4n],
    });
    expect(payeeLimitBreach(stored, 2, 7_500n)).toBeNull();
    expect(payeeLimitBreach(stored, 1, 7_500n)).toBe("payeeCount");
    // the decay shares are the larger sum: 75 %
    expect(payeeLimitBreach(stored, 2, 7_499n)).toBe("payeeShare");
    expect(
      payeeLimitBreach(
        { ...stored, decay: { on: false, autoLpBps: 0, sharesWad: [] } },
        2,
        5_000n,
      ),
    ).toBeNull();
  });

  test("an allowed preset's anchor floor sits inside Raffle Run's range; one switched off is not held", () => {
    const l = {
      allowed: true,
      maxWindowSecs: 0,
      minBrakeTicks: 0,
      minAnchorTau: 21_600,
    };
    expect(presetLimitsProblem(l)).toBeNull();
    expect(presetLimitsProblem({ ...l, minAnchorTau: 21_599 })).not.toBeNull();
    expect(
      presetLimitsProblem({ ...l, minAnchorTau: 31_536_001 }),
    ).not.toBeNull();
    expect(
      presetLimitsProblem({ ...l, allowed: false, minAnchorTau: 0 }),
    ).toBeNull();
  });
});

describe("quotes and presets", () => {
  const row: QuoteTerms = {
    allowed: true,
    mode: 1,
    decimals: 18,
    maxPriceAge: 3_600,
    feed: at(0xfeed),
    compoundFloor: 100n,
    compoundCap: 200n,
    quoteActivation: 10n,
    quotePaid: false,
  };

  test("a quote row: listed, its amounts in order, a priced row with an age and the right feed", () => {
    expect(quoteTermsProblem(row)).toBeNull();
    expect(quoteTermsProblem({ ...row, allowed: false })).toContain(
      "removeQuote",
    );
    expect(quoteTermsProblem({ ...row, quoteActivation: 101n })).not.toBeNull();
    expect(quoteTermsProblem({ ...row, compoundCap: 99n })).not.toBeNull();
    expect(
      quoteTermsProblem({
        ...row,
        quoteActivation: 1n << 112n,
        compoundFloor: 0n,
      }),
    ).not.toBeNull();
    // no compound floor: the activation amount stands alone
    expect(
      quoteTermsProblem({ ...row, compoundFloor: 0n, compoundCap: 0n }),
    ).toBeNull();
    expect(quoteTermsProblem({ ...row, maxPriceAge: 0 })).toContain(
      "maxPriceAge",
    );
    expect(quoteTermsProblem({ ...row, feed: zeroAddress })).toContain("feed");
    expect(quoteTermsProblem({ ...row, mode: 2 })).toContain("no feed");
    expect(
      quoteTermsProblem({ ...row, mode: 2, feed: zeroAddress }),
    ).toBeNull();
    // an unpriced row takes no launches and needs no age
    expect(
      quoteTermsProblem({ ...row, mode: 0, maxPriceAge: 0, feed: zeroAddress }),
    ).toBeNull();
  });

  test("a pad's own amounts run floor to cap, and are empty without ownAmounts", () => {
    const t = {
      allowed: true,
      ownAmounts: true,
      compoundFloor: 5n,
      compoundCap: 5n,
    };
    expect(padQuoteTermsProblem(t)).toBeNull();
    expect(padQuoteTermsProblem({ ...t, compoundFloor: 6n })).not.toBeNull();
    expect(padQuoteTermsProblem({ ...t, ownAmounts: false })).not.toBeNull();
    expect(
      padQuoteTermsProblem({
        ...t,
        ownAmounts: false,
        compoundFloor: 0n,
        compoundCap: 0n,
      }),
    ).toBeNull();
  });

  test("a preset record is whole, or all empty to clear the id", () => {
    const hash = `0x${"11".repeat(32)}` as const;
    const record = {
      deployer: at(0xdead),
      deployerCodeHash: hash,
      creationCodeHash: hash,
      selfPayee: false,
      active: true,
    };
    expect(presetRecordProblem(record)).toBeNull();
    expect(
      presetRecordProblem({ ...record, creationCodeHash: zeroHash }),
    ).not.toBeNull();
    const cleared = {
      deployer: zeroAddress,
      deployerCodeHash: zeroHash,
      creationCodeHash: zeroHash,
      selfPayee: false,
      active: false,
    };
    expect(presetRecordProblem(cleared)).toBeNull();
    expect(presetRecordProblem({ ...cleared, active: true })).not.toBeNull();
    expect(
      presetRecordProblem({ ...cleared, deployerCodeHash: hash }),
    ).not.toBeNull();
  });
});
