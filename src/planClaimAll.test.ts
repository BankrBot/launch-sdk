import { describe, expect, test } from "bun:test";
import {
  getAddress,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { EIP_7825_MAX_TX_GAS } from "./chains/index.js";
import { isLaunchSdkError } from "./errors.js";
import {
  CLAIM_ALL_GAS,
  CLAIM_ALL_MAX_GAS_PER_TX,
  CLAIM_PUSH_CHECK_GAS,
  planClaimAll,
  type ClaimAllBucket,
  type ClaimAllPlan,
} from "./planClaimAll.js";

const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
const coin = (i: number): Address =>
  getAddress(pad(toHex(0x7000_0000 + i), { size: 20 }));
const id = (i: number, tag: string): Hex => keccak256(toHex(`${tag}-${i}`));
const G = CLAIM_ALL_GAS;

function buckets(
  n: number,
  quote: Address,
  o: {
    firstTouch?: boolean;
    bothSides?: boolean;
    tag?: string;
    token?: (i: number) => Address;
  } = {},
): ClaimAllBucket[] {
  return Array.from({ length: n }, (_, i) => ({
    bucketId: id(i, o.tag ?? "c"),
    quote,
    token: (o.token ?? coin)(i),
    claimableQuote: 1_000n + BigInt(i),
    claimableToken: o.bothSides ? 500n : 0n,
    firstTouch: o.firstTouch ?? true,
    bothSides: o.bothSides ?? false,
  }));
}

/** Every bucket once, every quote once, each step within the budget, settles before withdraws, ids only in the first. */
function check(
  plan: ClaimAllPlan,
  ids: number,
  budget = CLAIM_ALL_MAX_GAS_PER_TX,
) {
  const all = plan.steps.flatMap((s) => s.bucketIds);
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBe(ids);
  expect(plan.buckets).toBe(ids);
  const quotes = plan.steps.flatMap((s) => s.quotes);
  expect(new Set(quotes).size).toBe(quotes.length);
  for (const s of plan.steps) {
    expect(s.gas).toBeLessThanOrEqual(budget);
    if (s.kind === "settle") expect(s.quotes).toEqual([]);
    else expect(s.quotes.length).toBeGreaterThan(0);
  }
  const firstWithdraw = plan.steps.findIndex((s) => s.kind === "withdraw");
  if (firstWithdraw >= 0) {
    const tail = plan.steps.slice(firstWithdraw);
    expect(tail.every((s) => s.kind === "withdraw")).toBe(true);
    expect(tail.slice(1).every((s) => s.bucketIds.length === 0)).toBe(true);
  }
  expect(plan.gas).toBe(plan.steps.reduce((a, s) => a + s.gas, 0n));
}

const sizes = (plan: ClaimAllPlan) => plan.steps.map((s) => s.bucketIds.length);

describe("planClaimAll: the claim-all model (re-measured against the contracts' own claim-all test)", () => {
  test("every planned transaction is at most 15M, more than 10 % under EIP-7825's 2^24", () => {
    expect(CLAIM_ALL_MAX_GAS_PER_TX).toBe(15_000_000n);
    expect(
      Number(EIP_7825_MAX_TX_GAS - CLAIM_ALL_MAX_GAS_PER_TX) /
        Number(EIP_7825_MAX_TX_GAS),
    ).toBeGreaterThan(0.1);
    expect(G).toEqual({
      base: 85_000n,
      bucketFirst: 37_000n,
      bucketSteady: 20_000n,
      bucketBoth: 62_000n,
      newBalance: 22_000n,
      openBalance: 5_000n,
      quote: 1_060_000n,
    });
  });

  test("one bucket is one withdraw(ids, [quote]): base, a payout, a first touch and a new balance", () => {
    const plan = planClaimAll({ buckets: buckets(1, WETH) });
    check(plan, 1);
    expect(plan.steps).toEqual([
      {
        kind: "withdraw",
        bucketIds: [id(0, "c")],
        quotes: [WETH],
        gas: G.base + G.quote + G.bucketFirst + G.newBalance,
      },
    ]);
    expect(plan.totals).toEqual([{ quote: WETH, amount: 1_000n }]);
  });

  test("a push: the last chunk never rides in the withdrawFor, and every step pays the account's isSuite probe", () => {
    const plan = planClaimAll({ buckets: buckets(1, WETH), push: true });
    check(plan, 1);
    expect(plan.steps).toEqual([
      {
        kind: "settle",
        bucketIds: [id(0, "c")],
        quotes: [],
        gas: G.base + CLAIM_PUSH_CHECK_GAS + G.bucketFirst + G.newBalance,
      },
      {
        kind: "withdraw",
        bucketIds: [],
        quotes: [WETH],
        gas: G.base + CLAIM_PUSH_CHECK_GAS + G.quote,
      },
    ]);
  });

  test("a referrer's balances alone: withdraw([], quotes), largest first, no balance to open", () => {
    const plan = planClaimAll({
      buckets: [],
      balances: [
        { quote: WETH, amount: 5n },
        { quote: USDC, amount: 7n },
      ],
    });
    check(plan, 0);
    expect(plan.steps).toEqual([
      {
        kind: "withdraw",
        bucketIds: [],
        quotes: [USDC, WETH],
        gas: G.base + 2n * G.quote,
      },
    ]);
  });

  test("nothing owed plans nothing", () => {
    const plan = planClaimAll({
      buckets: [],
      balances: [{ quote: WETH, amount: 0n }],
    });
    expect(plan).toEqual({
      steps: [],
      totals: [],
      buckets: 0,
      belowDust: 0,
      unlisted: [],
      gas: 0n,
    });
  });

  test("a 10,000-coin pad payee's first sweep (20,000 buckets): 49 settles, then a withdraw carrying the last 302", () => {
    const all = [
      ...buckets(10_000, WETH, { tag: "creator" }),
      ...buckets(10_000, WETH, { tag: "decay" }),
    ];
    const plan = planClaimAll({ buckets: all });
    check(plan, 20_000);
    expect(plan.steps).toHaveLength(50);
    // The first chunk opens the WETH balance (22k), every later one rewrites it cold (5k): 402 a chunk.
    expect(sizes(plan)).toEqual([...Array(49).fill(402), 302]);
    expect(plan.steps[0]!.gas).toBe(
      G.base + G.newBalance + 402n * G.bucketFirst,
    );
    expect(plan.steps[1]!.gas).toBe(
      G.base + G.openBalance + 402n * G.bucketFirst,
    );
    expect(plan.steps.at(-1)).toMatchObject({
      kind: "withdraw",
      quotes: [WETH],
    });
    // A settle-only pass: 50 chunks, the count the contracts' claim-all scale test ran under 15M each.
    const pass = planClaimAll({ buckets: all, settleOnly: true });
    check(pass, 20_000);
    expect(pass.steps).toHaveLength(50);
    expect(pass.steps.every((s) => s.kind === "settle")).toBe(true);
  });

  test("the same payee steady: 27 settle-only chunks; claiming itself, 26 settles and a withdraw", () => {
    const all = [
      ...buckets(10_000, WETH, { tag: "creator", firstTouch: false }),
      ...buckets(10_000, WETH, { tag: "decay", firstTouch: false }),
    ];
    const pass = planClaimAll({ buckets: all, settleOnly: true });
    check(pass, 20_000);
    expect(pass.steps).toHaveLength(27);
    expect(sizes(pass).slice(0, 2)).toEqual([744, 745]);
    const self = planClaimAll({ buckets: all });
    check(self, 20_000);
    expect(self.steps).toHaveLength(27);
    expect(self.steps.filter((s) => s.kind === "settle")).toHaveLength(26);
    expect(self.steps.at(-1)!.bucketIds).toHaveLength(631);
  });

  test("a balance already open costs a cold rewrite, not a new balance", () => {
    const fresh = planClaimAll({
      buckets: buckets(3, WETH, { firstTouch: false }),
    });
    const open = planClaimAll({
      buckets: buckets(3, WETH, { firstTouch: false }),
      balances: [{ quote: WETH, amount: 1n }],
    });
    expect(fresh.steps[0]!.gas - open.steps[0]!.gas).toBe(
      G.newBalance - G.openBalance,
    );
    expect(open.totals).toEqual([{ quote: WETH, amount: 3_004n }]);
  });

  test("the worst bucket (credited on both sides): at most 240 a transaction, under the 249 the contracts ran inside 2^24", () => {
    const token = getAddress(pad("0x7e", { size: 20 }));
    const plan = planClaimAll({
      buckets: buckets(1_000, WETH, { bothSides: true, token: () => token }),
    });
    check(plan, 1_000);
    // The first chunk opens both balances: 239, then 240; the last 41 ride in the withdraw.
    expect(sizes(plan)).toEqual([239, 240, 240, 240, 41]);
    expect(Math.max(...sizes(plan))).toBeLessThanOrEqual(249);
    expect(plan.steps.at(-1)!.quotes).toEqual([WETH, token]);
    expect(plan.steps.at(-1)!.gas).toBe(
      G.base + 2n * G.quote + 2n * G.openBalance + 41n * G.bucketBoth,
    );
    expect(plan.totals).toEqual([
      { quote: WETH, amount: 1_000n * 1_000n + (999n * 1_000n) / 2n },
      { quote: token, amount: 500_000n },
    ]);
  });

  test("a 1,000-coin creator on two quotes: 2 settles and a withdraw paying both", () => {
    const plan = planClaimAll({
      buckets: [
        ...buckets(700, WETH, { tag: "w" }),
        ...buckets(300, USDC, { tag: "u" }),
      ],
    });
    check(plan, 1_000);
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "settle",
      "settle",
      "withdraw",
    ]);
    expect(plan.steps.at(-1)!.quotes).toEqual([WETH, USDC]);
  });

  test("a chunk spanning many open quotes plans one cold write per quote", () => {
    // Robinhood lists 206 quotes: two fresh buckets on each, every balance already open.
    const quotes = Array.from({ length: 206 }, (_, i) => coin(5_000 + i));
    const owed = quotes.flatMap((q, i) =>
      buckets(2, q, { tag: `rh${i}` }).map((b) => ({ ...b, token: coin(i) })),
    );
    const plan = planClaimAll({
      buckets: owed,
      balances: quotes.map((quote) => ({ quote, amount: 1n })),
      settleOnly: true,
    });
    check(plan, 412);
    const quoteOf = new Map(owed.map((b) => [b.bucketId, b.quote]));
    for (const s of plan.steps) {
      const touched = new Set(s.bucketIds.map((b) => quoteOf.get(b)));
      expect(s.gas).toBe(
        G.base +
          BigInt(touched.size) * G.openBalance +
          BigInt(s.bucketIds.length) * G.bucketFirst,
      );
    }
    expect(sizes(plan)).toEqual([377, 35]);
  });

  test("many quotes: withdraws of at most 14, the one carrying bucket ids first and smallest", () => {
    const balances = Array.from({ length: 30 }, (_, i) => ({
      quote: coin(i),
      amount: 100n + BigInt(i),
    }));
    const plan = planClaimAll({ buckets: buckets(10, WETH), balances });
    check(plan, 10);
    expect(plan.steps.map((s) => s.quotes.length)).toEqual([3, 14, 14]);
    expect(plan.steps[0]!.bucketIds).toHaveLength(10);
    // Largest totals first: WETH's 10 buckets, then the biggest balances.
    expect(plan.steps[0]!.quotes).toEqual([WETH, coin(29), coin(28)]);
    expect(plan.steps[0]!.gas).toBe(
      G.base + 3n * G.quote + G.newBalance + 10n * G.bucketFirst,
    );
    expect(plan.totals).toHaveLength(31);
  });

  test("dust and duplicates leave the plan; a quote totalling under its dust is not withdrawn", () => {
    const s = buckets(10, WETH, { firstTouch: false });
    const plan = planClaimAll({
      buckets: [
        ...s,
        ...s,
        { ...s[0]!, bucketId: id(99, "z"), claimableQuote: 0n },
      ],
      balances: [{ quote: USDC, amount: 3n }],
      dust: (q) => (q === WETH ? 1_005n : 10n),
    });
    check(plan, 5);
    expect(plan.belowDust).toBe(6);
    expect(plan.steps[0]!.quotes).toEqual([WETH]);
  });

  test("a lower maxGasPerTx: more transactions, each within it; one that cannot hold a payout and a bucket is refused", () => {
    const plan = planClaimAll({
      buckets: buckets(1_000, WETH),
      maxGasPerTx: 5_000_000n,
    });
    check(plan, 1_000, 5_000_000n);
    expect(plan.steps.length).toBeGreaterThan(7);
    let thrown: unknown;
    try {
      planClaimAll({ buckets: buckets(1, WETH), maxGasPerTx: 1_100_000n });
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
  });

  test("a custom model is honoured", () => {
    const plan = planClaimAll(
      { buckets: buckets(10, WETH) },
      { ...G, bucketFirst: 2_000_000n },
    );
    check(plan, 10);
    expect(plan.steps.length).toBeGreaterThan(1);
  });
});

describe("any-quote pairing: currencies Bankr does not list", () => {
  const MEME = getAddress(pad("0x3e3e", { size: 20 }));
  const BOMB = (i: number) =>
    getAddress(pad(toHex(0x3e00_0000 + i), { size: 20 }));
  const unlisted = (q: Address) =>
    q === MEME ||
    q.toLowerCase().startsWith("0x000000000000000000000000000000003e");
  // A WETH coin owed, a MEME coin owed on both sides (its token side is a launch token, listed), and 20 planted
  // balances in gas-burning currencies (a referrer named by any swapper).
  const input = () => ({
    buckets: [
      ...buckets(3, WETH),
      {
        ...buckets(1, MEME, { bothSides: true, tag: "m" })[0]!,
        token: coin(77),
      },
      { ...buckets(1, MEME, { tag: "n" })[0]!, token: coin(78) },
    ],
    balances: Array.from({ length: 20 }, (_, i) => ({
      quote: BOMB(i),
      amount: 1n,
    })),
    unlisted,
  });

  test("by default no unlisted currency is withdrawn: the plan reports them, and a bucket owing only them waits", () => {
    const plan = planClaimAll(input());
    expect(plan.steps.flatMap((s) => s.quotes)).toEqual([WETH, coin(77)]);
    expect(plan.steps.every((s) => s.unlisted === undefined)).toBe(true);
    // the MEME coin's token side is paid, its MEME side settles into the balance for an opt-in
    expect(plan.buckets).toBe(4);
    expect(plan.unlisted.map((t) => t.quote)).toEqual([
      MEME,
      ...Array.from({ length: 20 }, (_, i) => BOMB(i)),
    ]);
    expect(plan.unlisted[0]!.amount).toBe(2_000n);
  });

  test("includeUnlisted pays them last, in withdraws of their own; the listed withdraw keeps the settle and its gas", () => {
    const listedOnly = planClaimAll(input());
    const plan = planClaimAll({ ...input(), includeUnlisted: true });
    const listed = plan.steps.filter((s) => !s.unlisted);
    const tail = plan.steps.filter((s) => s.unlisted);
    // the listed withdraw pays what it paid without the opt-in, and settles every bucket, the MEME-only one too
    expect(listed.flatMap((s) => s.quotes)).toEqual(
      listedOnly.steps.flatMap((s) => s.quotes),
    );
    expect(listed.flatMap((s) => s.bucketIds)).toHaveLength(5);
    expect(plan.steps.slice(-tail.length)).toEqual(tail);
    expect(tail.map((s) => s.quotes.length)).toEqual([14, 7]);
    expect(
      tail.every((s) => s.bucketIds.length === 0 && s.kind === "withdraw"),
    ).toBe(true);
    expect(tail.map((s) => s.gas)).toEqual([
      G.base + 14n * G.quote,
      G.base + 7n * G.quote,
    ]);
    expect(tail.flatMap((s) => s.quotes)).toContain(MEME);
    expect(plan.unlisted).toEqual([]);
  });

  test("no predicate: every currency is paid as before", () => {
    const { unlisted: _, ...rest } = input();
    const plan = planClaimAll(rest);
    expect(plan.steps.some((s) => s.quotes.includes(MEME))).toBe(true);
    expect(plan.unlisted).toEqual([]);
  });
});
