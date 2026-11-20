import { describe, expect, test } from "bun:test";
import { decodeFunctionData, zeroAddress, type Address } from "viem";
import { bankrFeeLedgerAbi, bankrHookLensAbi } from "./abis/suite3.js";
import { CONVERT_GAS, EARLIER_HOLDER_LEG_WAKE_ABI } from "./conversion.js";
import { isLaunchSdkError } from "./errors.js";
import {
  FAKE_BNKR,
  HOOK_LENS,
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  installLaunch,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";
import { bucketIds } from "./lens.js";

const FLOOR = 2_000_000_000_000_000n;
const NOW = 1_800_000_000;
const STALE = 7 * 86_400;
const wakeWord = (floor: bigint, leg: Address) => (floor << 160n) | BigInt(leg);

const hop = (tokenOut: Address) => ({
  tokenOut,
  v3Pool: zeroAddress,
  v4Key: {
    currency0: zeroAddress,
    currency1: zeroAddress,
    fee: 0,
    tickSpacing: 0,
    hooks: zeroAddress,
  },
});

/** One launch with its holders' pile and the leg's state as given; the wake armed at FLOOR unless `wake` says. */
function setup(
  o: {
    pile?: bigint;
    wake?: bigint;
    paused?: boolean;
    mode?: number;
    lastConvertAt?: number;
    staged?: bigint;
    pendingSince?: number;
    bnkrExecuteAfter?: number;
    routeExecuteAfter?: number;
    routeTo?: Address;
    /** The route in force (`routeOf`), as its last hop's tokenOut: default to BNKR; null for none. */
    route?: Address | null;
    batch?: readonly `0x${string}`[];
  } = {},
) {
  const { f, client } = postLaunchFixture();
  const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
  const holders = bucketIds.holders(l.poolId);
  f.fake.contract(SUITE.ledger, bankrFeeLedgerAbi, {
    holdersWake: () => o.wake ?? wakeWord(FLOOR, SUITE.holderLeg),
    claimable: ([bucket, who]: readonly unknown[]) =>
      bucket === holders &&
      String(who).toLowerCase() === SUITE.holderLeg.toLowerCase()
        ? [0n, o.pile ?? FLOOR]
        : [0n, 0n],
  });
  f.fake.contract(SUITE.factory, [], { paused: o.paused ?? false });
  f.fake.contract(SUITE.holderLeg, EARLIER_HOLDER_LEG_WAKE_ABI, {
    payoutMode: o.mode ?? 0,
    bnkr: FAKE_BNKR,
    retiredBnkr: false,
    lastConvertAt: BigInt(o.lastConvertAt ?? 0),
    MIN_CONVERT_INTERVAL: 1_800,
    pending: o.staged ?? 0n,
    pendingSince: BigInt(o.pendingSince ?? 0),
    STALE_AFTER: BigInt(STALE),
    MAX_BATCH: 8,
    batchOf: o.batch ?? [],
    bnkrExecuteAfter: BigInt(o.bnkrExecuteAfter ?? 0),
    routeExecuteAfter: BigInt(o.routeExecuteAfter ?? 0),
    pendingRouteOf: o.routeTo === undefined ? [] : [hop(o.routeTo)],
    routeOf: o.route === null ? [] : [hop(o.route ?? FAKE_BNKR)],
  });
  return { f, client, l };
}

const expectCode = async (p: Promise<unknown>, code: string) => {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code as never)).toBe(true);
};

describe("holders.getConversion (keeperless Q4)", () => {
  test("a pile at its floor in BNKR mode with the window open is due", async () => {
    const { client, l } = setup();
    const c = await client.holders.getConversion(l.token, { now: NOW });
    expect(c).toEqual({
      token: l.token,
      poolId: l.poolId,
      quote: WETH,
      pile: FLOOR,
      floor: FLOOR,
      armed: true,
      paused: false,
      converts: true,
      routed: true,
      nextConvertAt: 0,
      due: true,
      staged: 0n,
      forwardsNow: false,
      convertDue: true,
    });
  });

  test("a pile already staged in the leg reads convertDue once the window opens, though no swap wakes for it (round 9 FF4)", async () => {
    // Its swap's wake staged it inside a spent window: the ledger pile is 0, so a swap's wake (`due`) skips it.
    let s = setup({
      pile: 0n,
      staged: FLOOR,
      pendingSince: NOW - 600,
      lastConvertAt: NOW - 1_800,
    });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ pile: 0n, staged: FLOOR, due: false, convertDue: true });
    s = setup({
      pile: 0n,
      staged: FLOOR,
      pendingSince: NOW - 600,
      lastConvertAt: NOW - 60,
    });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW }))
        .convertDue,
    ).toBe(false);
    // A batch full of other pools: the poke stages it outside and converts them, not it.
    const others = Array.from(
      { length: 8 },
      (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as const,
    );
    s = setup({ batch: others });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ due: true, convertDue: false });
    s = setup({ batch: [...others.slice(1)] });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW }))
        .convertDue,
    ).toBe(true);
  });

  test("the leg's forward rule holds inside the window: a queued BNKR swap or route to BNKR, a stale staged pile (round 9 RSEC-6)", async () => {
    const inside = { lastConvertAt: NOW - 60 };
    let s = setup({ ...inside, bnkrExecuteAfter: NOW + 3_600 });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ forwardsNow: true, due: true, convertDue: true });
    s = setup({ ...inside, bnkrExecuteAfter: NOW - STALE - 1 });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW })).due,
    ).toBe(false);
    s = setup({ ...inside, routeExecuteAfter: NOW + 60, routeTo: FAKE_BNKR });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW })).due,
    ).toBe(true);
    s = setup({ ...inside, routeExecuteAfter: NOW + 60, routeTo: OTHER });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW })).due,
    ).toBe(false);
    s = setup({
      ...inside,
      pile: 0n,
      staged: 1n,
      pendingSince: NOW - STALE,
    });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ forwardsNow: true, due: false, convertDue: true });
    // QUOTE mode forwards any pile at a poke, under the floor too; nothing at all forwards nothing.
    s = setup({ mode: 1, pile: 1n });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ due: false, convertDue: true });
    s = setup({ mode: 1, pile: 0n });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW }))
        .convertDue,
    ).toBe(false);
  });

  // Live-fork finding 11-07: AAPLc is listed and floored but has no route, so pokes converted nothing for 7 days.
  test("a quote with no route to BNKR: due once, to stage the pile and start its clock; then not until the stale forward", async () => {
    let s = setup({ route: null });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({
      converts: true,
      routed: false,
      forwardsNow: false,
      due: true,
      convertDue: true,
    });
    // Staged: no conversion can run, so nothing is due until the pile's STALE_AFTER.
    s = setup({ route: null, pile: 0n, staged: FLOOR, pendingSince: NOW - 60 });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ routed: false, due: false, convertDue: false });
    // A route still ending at a BNKR an executed swap retired cannot convert either: the leg reverts RouteNotToBnkr.
    s = setup({
      route: OTHER,
      pile: 0n,
      staged: FLOOR,
      pendingSince: NOW - 60,
    });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ routed: false, due: false, convertDue: false });
    // Staged past STALE_AFTER, the leg forwards it in quote: a poke pays the holders then.
    s = setup({
      route: null,
      pile: 0n,
      staged: FLOOR,
      pendingSince: NOW - STALE,
    });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({ forwardsNow: true, convertDue: true });
  });

  test("a wei under the floor waits; inside the window a wake only stages", async () => {
    let s = setup({ pile: FLOOR - 1n });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW })).due,
    ).toBe(false);
    s = setup({ lastConvertAt: NOW - 60 });
    const c = await s.client.holders.getConversion(s.l.token, { now: NOW });
    expect(c).toMatchObject({
      due: false,
      converts: true,
      nextConvertAt: NOW - 60 + 1_800,
    });
  });

  test("QUOTE mode forwards with no interval; a pause or an unarmed quote is never due", async () => {
    let s = setup({ mode: 1, lastConvertAt: NOW - 60 });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({
      converts: false,
      due: true,
    });
    s = setup({ paused: true });
    expect(
      (await s.client.holders.getConversion(s.l.token, { now: NOW })).due,
    ).toBe(false);
    s = setup({ wake: 0n });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({
      armed: false,
      due: false,
    });
  });

  test("an unlisted quote (any-quote pairing) never converts: its pile forwards on a poke, before or after its first", async () => {
    const max = (1n << 96n) - 1n;
    // After a first poke the leg floored it at type(uint96).max and armed the wake there: no swap wakes it.
    let s = setup({ wake: wakeWord(max, SUITE.holderLeg), pile: 5n });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({
      floor: max,
      converts: false,
      forwardsNow: true,
      due: false,
      convertDue: true,
    });
    // Before any poke the wake is unarmed: the chain's leg holds the pile, and its first poke floors and forwards it.
    s = setup({ wake: 0n, pile: 5n });
    expect(
      await s.client.holders.getConversion(s.l.token, { now: NOW }),
    ).toMatchObject({
      armed: false,
      pile: 5n,
      floor: max,
      converts: false,
      forwardsNow: true,
      due: false,
      convertDue: true,
    });
  });

  test("NOT_A_LAUNCH for a stranger", async () => {
    const { client } = setup();
    await expectCode(client.holders.getConversion(OTHER), "NOT_A_LAUNCH");
  });
});

describe("holders.buildConvert (keeperless Q4: the permissionless convert action)", () => {
  test("leg.poke(poolId) from anyone, at the wake's stipend so a full batch converts", async () => {
    const { client, l } = setup();
    const tx = await client.holders.buildConvert(l.token, OTHER);
    expect(tx).toMatchObject({
      from: OTHER,
      to: SUITE.holderLeg,
      value: 0n,
      gas: CONVERT_GAS,
    });
    expect(
      decodeFunctionData({ abi: EARLIER_HOLDER_LEG_WAKE_ABI, data: tx.data }),
    ).toEqual({
      functionName: "poke",
      args: [l.poolId],
    });
    await expectCode(
      client.holders.buildConvert(l.token, "0x12" as never),
      "INVALID_PARAMS",
    );
    await expectCode(client.holders.buildConvert(OTHER, OTHER), "NOT_A_LAUNCH");
  });

  test("two leg generations live: the poke goes to the coin's own leg, not the one the record names", async () => {
    const { f, client, l } = setup();
    const EARLIER_LEG = "0x00000000000000000000000000000000000001e9" as Address;
    // the coin was launched under an earlier generation: its holders' bucket is locked to that leg
    f.fake.contract(SUITE.ledger, bankrFeeLedgerAbi, {
      beneficiariesOf: ([bucket]: readonly unknown[]) =>
        bucket === bucketIds.holders(l.poolId) ? [EARLIER_LEG] : [],
    });
    const tx = await client.holders.buildConvert(l.token, OTHER);
    expect(tx.to).toBe(EARLIER_LEG);
    expect(tx.to).not.toBe(SUITE.holderLeg);
    expect(
      decodeFunctionData({ abi: EARLIER_HOLDER_LEG_WAKE_ABI, data: tx.data })
        .args,
    ).toEqual([l.poolId]);
  });
});

describe("fees.getClaimPolicy (Q9)", () => {
  test("open by default; restricted, only the account and its operators", async () => {
    const { f, client } = setup();
    const restricted = new Set<string>();
    const operators = new Set<string>();
    f.fake.contract(SUITE.ledger, bankrFeeLedgerAbi, {
      claimRestricted: ([a]: readonly unknown[]) =>
        restricted.has(String(a).toLowerCase()),
      mayClaimFor: ([a, c]: readonly unknown[]) => {
        const [acct, caller] = [
          String(a).toLowerCase(),
          String(c).toLowerCase(),
        ];
        return (
          acct === caller ||
          !restricted.has(acct) ||
          operators.has(`${acct}:${caller}`)
        );
      },
    });
    expect(await client.fees.getClaimPolicy(OTHER)).toEqual({
      restricted: false,
      mayClaim: null,
    });
    expect(await client.fees.getClaimPolicy(OTHER, LAUNCHER)).toEqual({
      restricted: false,
      mayClaim: true,
    });
    restricted.add(OTHER.toLowerCase());
    expect(await client.fees.getClaimPolicy(OTHER, LAUNCHER)).toEqual({
      restricted: true,
      mayClaim: false,
    });
    operators.add(`${OTHER.toLowerCase()}:${LAUNCHER.toLowerCase()}`);
    expect(await client.fees.getClaimPolicy(OTHER, LAUNCHER)).toEqual({
      restricted: true,
      mayClaim: true,
    });
    await expectCode(
      client.fees.getClaimPolicy("0x12" as never),
      "INVALID_PARAMS",
    );
  });
});

describe("launchInfo.buybackAt (decision 3)", () => {
  test("null without a buyback share; else the second the next in-swap fill may run from", async () => {
    const { f, client, l } = setup();
    expect((await client.launchInfo(l.token))!.buybackAt).toBeNull();
    f.fake.contract(HOOK_LENS, bankrHookLensAbi, {
      poolConfig: () => ({
        registered: true,
        tokenIsCurrency0: l.tokenIsCurrency0,
        initTimestamp: 1,
        startTick: -200_000,
        token: l.token,
        hasExtension: false,
        decaySplit: false,
        refTick: 0,
        refTs: 0,
        lastCompoundTs: 0,
        creatorLp: true,
        refFrac: 0,
        buybackAt: NOW + 300,
        openTick: 0,
        heldQuote: 0n,
        heldToken: 0n,
        buy: { startPips: 17_500, steadyPips: 17_500, decaySecs: 0 },
        sell: { startPips: 17_500, steadyPips: 17_500, decaySecs: 0 },
      }),
    });
    expect((await client.launchInfo(l.token))!.buybackAt).toBe(NOW + 300);
  });
});
