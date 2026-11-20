import { describe, expect, test } from "bun:test";
import { decodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { FakeSettings, SUITE, at } from "../__internal__/fakeSettings.js";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bnkrHolderLegAbi,
} from "../abis/settings.js";
import { isLaunchSdkError } from "../errors.js";
import { bucketIds } from "../lens.js";
import { createHolderLegs } from "./holderLegs.js";
import {
  UNFLOORED,
  holderPileDue,
  type HolderPileReads,
} from "./holderPile.js";

const WETH = at(0xe7);
const USDC = at(0xc0);
const BNKR = at(0xb0);
const pool = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const lower = (a: string) => a.toLowerCase();

interface Coin {
  token: Address;
  poolId: Hex;
  quote: Address;
  leg: Address;
  legId: number;
  pile: bigint;
  pending: bigint;
  pendingSince: bigint;
}

/** Two leg generations on one ledger: the first converts WETH and pays USDC in quote, the second converts both. */
function setup() {
  const suite = new FakeSettings();
  const legOne = suite.holderLeg;
  const legTwo = at(0xd2);
  suite.legIds.set(lower(legTwo), 2);
  const coins: Coin[] = [
    {
      token: at(0x71),
      poolId: pool(1),
      quote: WETH,
      leg: legOne,
      legId: 1,
      pile: 50n,
      pending: 0n,
      pendingSince: 0n,
    },
    {
      token: at(0x72),
      poolId: pool(2),
      quote: USDC,
      leg: legOne,
      legId: 1,
      pile: 7n,
      pending: 0n,
      pendingSince: 0n,
    },
    {
      token: at(0x73),
      poolId: pool(3),
      quote: WETH,
      leg: legTwo,
      legId: 2,
      pile: 5n,
      pending: 0n,
      pendingSince: 0n,
    },
  ];
  const byToken = (t: Address) =>
    coins.find((c) => lower(c.token) === lower(t));
  const byPool = (p: Hex) => coins.find((c) => c.poolId === p)!;
  const state = {
    floor: 10n,
    window: [0n, 0n] as [bigint, bigint],
    cleared: new Set<string>(),
    staleAfter: 604_800,
  };
  for (const c of coins) suite.termsHashes.set(lower(c.token), pool(0xff));
  suite.chain.contract(SUITE.factory, bankrLaunchFactoryAbi, {
    poolOf: ([token]: readonly unknown[]) => {
      const c = byToken(token as Address);
      return [
        c?.poolId ?? pool(0),
        {
          currency0: c?.token ?? zeroAddress,
          currency1: c?.quote ?? zeroAddress,
          fee: 0,
          tickSpacing: 200,
          hooks: suite.hook,
        },
      ];
    },
  });
  const holders = new Map(coins.map((c) => [bucketIds.holders(c.poolId), c]));
  suite.chain.contract(SUITE.ledger, bankrFeeLedgerAbi, {
    poolTerms: ([id]: readonly unknown[]) => ({
      hook: suite.hook,
      flags: 0,
      referrerBps: 0,
      bankrFeeBps: 1_000,
      bankrMinPips: 250,
      holdersShareBps: 5_000,
      legId: byPool(id as Hex).legId,
      treasuryWad: 0n,
      treasuryDecayWad: 0n,
      distributor: zeroAddress,
      holderWad: 0n,
    }),
    beneficiariesOf: ([bucket]: readonly unknown[]) => [
      holders.get(bucket as Hex)!.leg,
    ],
    claimable: ([bucket]: readonly unknown[]) => [
      0n,
      holders.get(bucket as Hex)!.pile,
    ],
    // armed for WETH on both legs, at the floor; USDC is unarmed
    holdersWake: ([legId, quote]: readonly unknown[]) =>
      lower(quote as string) === lower(WETH)
        ? (state.floor << 160n) | BigInt(legId === 1 ? legOne : legTwo)
        : 0n,
    windowOf: () => state.window,
  });
  const route = (quote: Address, hops: boolean) => ({
    quote,
    pileFloor: state.floor,
    hops: hops
      ? [
          {
            tokenOut: BNKR,
            v3Pool: at(0x33),
            v4Key: {
              currency0: zeroAddress,
              currency1: zeroAddress,
              fee: 0,
              tickSpacing: 0,
              hooks: zeroAddress,
            },
          },
        ]
      : [],
  });
  for (const [leg, usdcHops] of [
    [legOne, false],
    [legTwo, true],
  ] as const) {
    suite.chain.contract(leg, bnkrHolderLegAbi, {
      payoutMode: 0,
      bnkr: BNKR,
      legTerms: () => ({
        minConvertInterval: 3_600,
        staleAfter: state.staleAfter,
        maxRouteFeePips: 10_000,
        referenceGuardSqrtBps: 100,
        fillSlackBps: 50,
        maxImpactBps: 100,
      }),
      routes: () => [route(WETH, true), route(USDC, usdcHops)],
      routeOf: ([q]: readonly unknown[]) =>
        state.cleared.has(lower(q as string))
          ? []
          : route(q as Address, lower(q as string) === lower(WETH) || usdcHops)
              .hops,
      converts: ([q]: readonly unknown[]) =>
        !state.cleared.has(lower(q as string)) &&
        (lower(q as string) === lower(WETH) || usdcHops),
      paidInQuote: ([q]: readonly unknown[]) =>
        lower(q as string) === lower(USDC) && !usdcHops,
      minPile: () => state.floor,
      pending: ([id]: readonly unknown[]) => byPool(id as Hex).pending,
      pendingSince: ([id]: readonly unknown[]) =>
        byPool(id as Hex).pendingSince,
      references: at(0x4e),
    });
  }
  return {
    suite,
    legs: createHolderLegs(suite.context()),
    coins,
    state,
    legOne,
    legTwo,
  };
}

const code = async (run: Promise<unknown>) =>
  run.then(
    () => null,
    (err: unknown) => (isLaunchSdkError(err) ? err.code : String(err)),
  );

describe("holder legs, per generation", () => {
  test("the leg in force, with its terms and each route's live answer", async () => {
    const { legs, legOne, legTwo } = setup();
    const current = await legs.current();
    expect(current).toMatchObject({
      leg: legOne,
      legId: 1,
      current: true,
      payoutMode: "bnkr",
      bnkr: BNKR,
    });
    expect(current.terms.staleAfter).toBe(604_800);
    expect(
      current.routes.map((r) => [r.quote, r.converts, r.paidInQuote]),
    ).toEqual([
      [WETH, true, false],
      [USDC, false, true],
    ]);
    const next = await legs.get(legTwo);
    expect(next).toMatchObject({ legId: 2, current: false });
    expect(next.routes.every((r) => r.converts)).toBe(true);
    expect(await code(legs.get(at(0x99)))).not.toBeNull();
  });

  test("a coin keeps the leg of its launch: the holders' bucket's one beneficiary", async () => {
    const { legs, coins, legOne, legTwo } = setup();
    expect(await legs.ofCoin(coins[0]!.token)).toEqual({
      token: coins[0]!.token,
      poolId: pool(1),
      quote: WETH,
      leg: legOne,
      legId: 1,
    });
    expect((await legs.ofCoin(coins[2]!.token)).leg).toBe(legTwo);
    expect(await code(legs.ofCoin(at(0x99)))).toBe("NOT_A_LAUNCH");
    const groups = await legs.byLeg(coins.map((c) => c.token));
    expect(
      groups.map((g) => [g.leg, g.legId, g.coins.map((c) => c.poolId)]),
    ).toEqual([
      [legOne, 1, [pool(1), pool(2)]],
      [legTwo, 2, [pool(3)]],
    ]);
  });

  test("a pile is asked about at the coin's own leg", async () => {
    const { suite, legs, coins, state } = setup();
    // the factory starts paused: a pause skips the wake
    expect(await legs.pile(coins[0]!.token, 1_000)).toMatchObject({
      paused: true,
      wakes: false,
      due: false,
    });
    suite.paused = false;
    // over the floor on a converting quote with the window open: a swap's wake converts it
    expect(await legs.pile(coins[0]!.token, 1_000)).toMatchObject({
      legId: 1,
      pile: 50n,
      staged: 0n,
      armed: true,
      floor: 10n,
      converts: true,
      wakes: true,
      forwardsNow: false,
      due: true,
      nextConvertAt: 0n,
    });
    // under the floor on the second leg: nothing wakes
    expect(await legs.pile(coins[2]!.token, 1_000)).toMatchObject({
      legId: 2,
      wakes: false,
      due: false,
    });
    // an unarmed quote the leg pays in quote: no swap wakes it, and a poke would forward it
    expect(await legs.pile(coins[1]!.token, 1_000)).toMatchObject({
      armed: false,
      converts: false,
      wakes: false,
      forwardsNow: true,
      due: false,
    });
    // the shared window is shut with under a floor pile left: the conversion waits for it
    state.window = [2_000n, 9n];
    expect(await legs.pile(coins[0]!.token, 1_000)).toMatchObject({
      due: false,
      nextConvertAt: 2_000n,
    });
    expect(await legs.pile(coins[0]!.token, 2_000)).toMatchObject({
      due: true,
      nextConvertAt: 0n,
    });
  });

  test("a poke goes to the coin's own leg; a convert only to a leg that converts the quote", async () => {
    const { legs, coins, legOne, legTwo } = setup();
    const sender = at(0x5e);
    const poke = await legs.buildPoke(coins[2]!.token, sender);
    expect(poke).toMatchObject({ from: sender, to: legTwo, value: 0n });
    expect(
      decodeFunctionData({ abi: bnkrHolderLegAbi, data: poke.data }),
    ).toEqual({
      functionName: "poke",
      args: [pool(3)],
    });
    expect((await legs.buildPoke(coins[0]!.token, sender)).to).toBe(legOne);
    const convert = await legs.buildConvert(legOne, WETH, sender);
    expect(
      decodeFunctionData({ abi: bnkrHolderLegAbi, data: convert.data }),
    ).toEqual({
      functionName: "convert",
      args: [WETH],
    });
    expect(await code(legs.buildConvert(legOne, USDC, sender))).toBe(
      "INVALID_PARAMS",
    );
    expect((await legs.buildConvert(legTwo, USDC, sender)).to).toBe(legTwo);
  });

  test("an address that is no leg is refused by name, with or without code, before any of a leg's views is read", async () => {
    const { suite, legs } = setup();
    const sender = at(0x5e);
    // no code at all, and a contract that is not a leg: the ledger answers 0 for both
    const stranger = at(0x99);
    const token = at(0x9a);
    suite.chain.setCode(token, "0x60");
    for (const address of [stranger, token]) {
      expect(await code(legs.get(address))).toBe("INVALID_PARAMS");
      expect(await code(legs.buildConvert(address, WETH, sender))).toBe(
        "INVALID_PARAMS",
      );
    }
    expect(suite.chain.callsTo("payoutMode")).toEqual([]);
    // a leg is asked for its id once: the answer that let it through is the one returned
    const asked = suite.chain.callsTo("legIdOf").length;
    expect((await legs.get(suite.holderLeg)).legId).toBe(1);
    expect(suite.chain.callsTo("legIdOf").length).toBe(asked + 1);
    expect(await code(legs.get("0x1" as never))).toBe("INVALID_PARAMS");
  });
});

describe("the wake rule", () => {
  const reads: HolderPileReads = {
    wake: (10n << 160n) | 1n,
    paused: false,
    pile: 10n,
    quote: WETH,
    payoutMode: 0,
    bnkr: BNKR,
    legFloor: 10n,
    paidInQuote: false,
    routed: true,
    windowUntil: 0n,
    windowLeft: 0n,
    pending: 0n,
    pendingSince: 0n,
    staleAfter: 100n,
  };
  const due = (
    change: Partial<HolderPileReads>,
    now = 1_000n,
    holdersIn = 0n,
  ) => holderPileDue({ ...reads, ...change }, now, holdersIn);

  test("armed, unpaused and at the floor wakes; the swap's own part counts", () => {
    expect(due({})).toMatchObject({
      armed: true,
      floor: 10n,
      wakes: true,
      converts: true,
      due: true,
    });
    expect(due({ pile: 9n }).wakes).toBe(false);
    expect(due({ pile: 9n }, 1_000n, 1n).wakes).toBe(true);
    expect(due({ paused: true }).wakes).toBe(false);
    expect(due({ wake: 0n })).toMatchObject({
      armed: false,
      wakes: false,
      due: false,
    });
  });

  test("what does not convert forwards at once: quote mode, BNKR itself, no floor, paid in quote", () => {
    for (const change of [
      { payoutMode: 1 },
      { bnkr: zeroAddress },
      { quote: BNKR },
      { legFloor: 0n },
      { legFloor: UNFLOORED },
      { paidInQuote: true },
    ] as Partial<HolderPileReads>[])
      expect(
        due(change),
        JSON.stringify(change, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
      ).toMatchObject({
        converts: false,
        forwardsNow: true,
        due: true,
      });
  });

  test("a staged pile forwards once it is stale; a cleared route leaves one stage to start that clock", () => {
    expect(due({ pending: 5n, pendingSince: 900n }).forwardsNow).toBe(true);
    expect(due({ pending: 5n, pendingSince: 901n }).forwardsNow).toBe(false);
    expect(due({ routed: false })).toMatchObject({
      forwardsNow: false,
      due: true,
    });
    expect(due({ routed: false, pending: 5n, pendingSince: 950n }).due).toBe(
      false,
    );
    expect(due({ windowUntil: 1_001n, windowLeft: 9n })).toMatchObject({
      due: false,
      nextConvertAt: 1_001n,
    });
    expect(due({ windowUntil: 1_001n, windowLeft: 10n }).due).toBe(true);
    expect(due({ windowUntil: 1_000n, windowLeft: 0n }).due).toBe(true);
  });
});
