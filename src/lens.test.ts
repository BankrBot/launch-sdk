import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { BUILT_IN_CURVES, curveWordHex, encodeCurve } from "./curve.js";
import { isLaunchSdkError } from "./errors.js";
import { bucketIds, creatorRecipientsOf } from "./lens.js";
import {
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  installLaunch,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";
import { FLYWHEEL, PAD_PAYEE } from "./__internal__/fakeSuite.js";

describe("launchInfo", () => {
  test("reads the factory's record, the pad, the hook's schedules and the creator bucket's shares by role", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      launchpadId: 0n,
      creatorShares: [
        { account: FLYWHEEL, sharesWad: 150n * 10n ** 15n },
        {
          account: getAddress("0x0000000000000000000000000000000000008013"),
          sharesWad: 10n ** 17n,
        },
        { account: SUITE.hook, sharesWad: 3n * 10n ** 17n },
        { account: LAUNCHER, sharesWad: 450n * 10n ** 15n },
      ],
      decayShares: [{ account: LAUNCHER, sharesWad: 10n ** 17n }],
      schedules: [
        {
          beneficiary: LAUNCHER,
          total: 10n,
          released: 0n,
          cliff: 1n,
          duration: 2n,
          push: false,
          available: 0n,
        },
      ],
    });
    const info = (await client.launchInfo(l.token))!;
    expect(info).toMatchObject({
      token: l.token,
      poolId: l.poolId,
      quote: WETH,
      launcher: LAUNCHER,
      launchpadId: 0n,
      distributor: l.distributor,
      escrow: l.escrow,
      hook: SUITE.hook,
      decaySplit: true,
    });
    expect(info.buckets.creator).toBe(bucketIds.creator(l.poolId));
    expect(info.buckets.decay).toBe(bucketIds.decay(l.poolId));
    expect(
      Object.fromEntries(info.creatorShares.map((s) => [s.role, s.account])),
    ).toEqual({
      payee: FLYWHEEL,
      buyback: getAddress("0x0000000000000000000000000000000000008013"),
      autoLp: SUITE.hook,
      creator: LAUNCHER,
    });
    expect(info.fees.buy.steadyPips).toBe(17_500);
    expect(info.feeRecipients).toEqual([
      { recipient: LAUNCHER, shareBps: 10_000 },
    ]);
    expect(info.metadataAdmin).toBeNull();
    expect(info.tradingStart).toBe(1);
  });

  // Live-fork finding 11-07: roles were read from the pad's live payees, so a setPayees after launch relabelled them.
  test("roles come from the ledger's creator parts, not the pad's live payees", async () => {
    const { f, client } = postLaunchFixture();
    const creator = getAddress("0x00000000000000000000000000000000000c0de1");
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      launchpadId: 1n,
      creatorShares: [
        { account: PAD_PAYEE, sharesWad: 10n ** 17n },
        { account: SUITE.hook, sharesWad: 27n * 10n ** 16n },
        { account: creator, sharesWad: 63n * 10n ** 16n },
      ],
      creators: [creator],
    });
    // The operator replaces its payees after the launch, naming the coin's fee recipient as its new one.
    f.pads.get(1n)!.terms = {
      payees: [creator],
      steadySharesWad: [2n * 10n ** 17n],
      decay: { on: false, autoLpBps: 0, sharesWad: [] },
    };
    const info = (await client.launchInfo(l.token))!;
    expect(info.creatorShares.map((s) => [s.account, s.role])).toEqual([
      [PAD_PAYEE, "payee"],
      [SUITE.hook, "autoLp"],
      [creator, "creator"],
    ]);
    const fees = await client.fees.get(l.token);
    expect(fees.account).toBe(creator);
    expect(fees.creator.role).toBe("creator");
  });

  test("a payee's share moved in place keeps its role: only the entry with a creator part is the creator", async () => {
    const { f, client } = postLaunchFixture();
    const moved = getAddress("0x00000000000000000000000000000000000a11ce");
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      launchpadId: 1n,
      creatorShares: [
        { account: moved, sharesWad: 10n ** 17n },
        { account: LAUNCHER, sharesWad: 9n * 10n ** 17n },
      ],
    });
    const info = (await client.launchInfo(l.token))!;
    expect(info.creatorShares.map((s) => [s.account, s.role])).toEqual([
      [moved, "payee"],
      [LAUNCHER, "creator"],
    ]);
    expect((await client.fees.get(l.token)).account).toBe(LAUNCHER);
  });

  test("a fee recipient merged into a pad payee: its entry is the creator's, and its creator part is told apart", async () => {
    const { f, client } = postLaunchFixture();
    const b = getAddress("0x00000000000000000000000000000000000000b2");
    // The operator launches on its own pad as its own fee recipient: the ledger merges it into its payee entry.
    f.pads.get(1n)!.terms = {
      payees: [LAUNCHER, b],
      steadySharesWad: [10n ** 17n, 2n * 10n ** 17n],
      decay: { on: false, autoLpBps: 0, sharesWad: [] },
    };
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      launchpadId: 1n,
      creatorShares: [
        {
          account: LAUNCHER,
          sharesWad: 8n * 10n ** 17n,
          creatorShareWad: 7n * 10n ** 17n,
        },
        { account: b, sharesWad: 2n * 10n ** 17n },
      ],
    });
    const info = (await client.launchInfo(l.token))!;
    expect(
      info.creatorShares.map((s) => [s.role, s.sharesWad, s.creatorShareWad]),
    ).toEqual([
      ["creator", 8n * 10n ** 17n, 7n * 10n ** 17n],
      ["payee", 2n * 10n ** 17n, 0n],
    ]);
    const fees = await client.fees.get(l.token);
    expect(fees.account).toBe(LAUNCHER);
    expect(fees.creator.creatorShareWad).toBe(7n * 10n ** 17n);
  });

  test("no creator part at all: nobody reads as the creator, and the launcher stands in for fees.get", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      creatorShares: [{ account: SUITE.hook, sharesWad: 10n ** 18n }],
    });
    const info = (await client.launchInfo(l.token))!;
    expect(info.creatorShares.map((s) => s.role)).toEqual(["autoLp"]);
    expect(info.feeRecipients).toEqual([]);
    expect((await client.fees.get(l.token)).account).toBe(LAUNCHER);
  });

  test("several fee recipients: each entry is a creator's, in the bucket's order, with its bps of the creators' take", async () => {
    const { f, client } = postLaunchFixture();
    const a = getAddress("0x000000000000000000000000000000000000fee1");
    const b = getAddress("0x000000000000000000000000000000000000fee2");
    const admin = getAddress("0x00000000000000000000000000000000000ad317");
    // The creators keep 60% of the bucket and split it 50 / 30 / 20.
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      metadataAdmin: admin,
      creatorShares: [
        { account: PAD_PAYEE, sharesWad: 10n ** 17n },
        { account: SUITE.hook, sharesWad: 3n * 10n ** 17n },
        { account: a, sharesWad: 3n * 10n ** 17n },
        { account: LAUNCHER, sharesWad: 18n * 10n ** 16n },
        { account: b, sharesWad: 12n * 10n ** 16n },
      ],
      creators: [a, LAUNCHER, b],
    });
    l.setToken("tradingStart", 1_900_000_000n);
    const info = (await client.launchInfo(l.token))!;
    expect(info.creatorShares.map((s) => s.role)).toEqual([
      "payee",
      "autoLp",
      "creator",
      "creator",
      "creator",
    ]);
    expect(info.feeRecipients).toEqual([
      { recipient: a, shareBps: 5_000 },
      { recipient: LAUNCHER, shareBps: 3_000 },
      { recipient: b, shareBps: 2_000 },
    ]);
    expect(info.metadataAdmin).toBe(admin);
    expect(info.tradingStart).toBe(1_900_000_000);
    // The default account is the first recipient; every other recipient reads its own entry.
    expect((await client.fees.get(l.token)).account).toBe(a);
    const mine = await client.fees.get(l.token, b);
    expect(mine.creator).toMatchObject({
      sharesWad: 12n * 10n ** 16n,
      creatorShareWad: 12n * 10n ** 16n,
      role: "creator",
    });
  });

  test("creatorRecipientsOf rounds each part to bps and leaves the remainder on the largest", () => {
    const [a, b, c] = [1, 2, 3].map((n) =>
      getAddress(`0x${n.toString(16).padStart(40, "0")}`),
    );
    const third = 10n ** 18n / 3n;
    expect(
      creatorRecipientsOf([
        { account: a!, creatorShareWad: third },
        { account: PAD_PAYEE, creatorShareWad: 0n },
        { account: b!, creatorShareWad: third },
        { account: c!, creatorShareWad: third },
      ]),
    ).toEqual([
      { recipient: a!, shareBps: 3_334 },
      { recipient: b!, shareBps: 3_333 },
      { recipient: c!, shareBps: 3_333 },
    ]);
    expect(creatorRecipientsOf([])).toEqual([]);
  });

  test("Bankr's pad: the ledger's creator part names the creator, after a partial takeover too", async () => {
    const { f, client } = postLaunchFixture();
    const taker = getAddress("0x00000000000000000000000000000000000c7001");
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      launchpadId: 0n,
      // The fee recipient was the Flywheel payee, so its entry merged both; the takeover moved only the creator's own
      // share to an appended entry, and the Flywheel keeps its payee share in place.
      creatorShares: [
        { account: FLYWHEEL, sharesWad: 150n * 10n ** 15n },
        { account: SUITE.hook, sharesWad: 3n * 10n ** 17n },
        { account: taker, sharesWad: 550n * 10n ** 15n },
      ],
      creators: [taker],
    });
    const info = (await client.launchInfo(l.token))!;
    expect(info.creatorShares.map((s) => [s.account, s.role])).toEqual([
      [FLYWHEEL, "payee"],
      [SUITE.hook, "autoLp"],
      [taker, "creator"],
    ]);
    // A takeover leaves one heir holding every creator part.
    expect(info.feeRecipients).toEqual([
      { recipient: taker, shareBps: 10_000 },
    ]);
  });

  test("null for a token the factory never launched; a malformed address rejects", async () => {
    const { client } = postLaunchFixture();
    expect(await client.launchInfo(OTHER)).toBeNull();
    let thrown: unknown;
    try {
      await client.launchInfo("0xnope" as never);
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
  });
});

describe("launchInfo: the launch's curve, read from the locker's launch positions", () => {
  const rows = (curve: { bands: { widthTicks: number; shareBps: number }[] }) =>
    curve.bands.map((b) => ({
      widthTicks: b.widthTicks,
      shareBps: b.shareBps,
    }));

  test("each built-in curve reads by id and name, with its bands' pool ticks", async () => {
    const { f, client } = postLaunchFixture();
    for (const id of [0, 1, 2] as const) {
      const l = installLaunch(f, {
        launcher: LAUNCHER,
        quote: WETH,
        curve: BigInt(id),
        startTick: -239_200 + 200 * id,
      });
      const { curve } = (await client.launchInfo(l.token))!;
      expect(curve.curveId).toBe(id);
      expect(curve.name).toBe(
        (["runner_v1", "degen", "thin_topside"] as const)[id],
      );
      expect(curve.curveTable).toBeNull();
      expect(curve.startTick).toBe(-239_200 + 200 * id);
      expect(rows(curve)).toEqual(BUILT_IN_CURVES[id].map((b) => ({ ...b })));
      const first = curve.bands[0]!;
      const start = -239_200 + 200 * id;
      expect([first.tickLower, first.tickUpper]).toEqual(
        l.tokenIsCurrency0
          ? [start, start + first.widthTicks]
          : [-start - first.widthTicks, -start],
      );
      const last = curve.bands.at(-1)!;
      expect(l.tokenIsCurrency0 ? last.tickUpper : last.tickLower).toBe(
        l.tokenIsCurrency0 ? 887_200 : -887_200,
      );
    }
  });

  test("a launcher's own bands read back to the basis point, whatever the hook compounded since", async () => {
    const { f, client } = postLaunchFixture();
    const tables = [
      [
        { widthTicks: 6_800, shareBps: 304 },
        { widthTicks: 110_000, shareBps: 9_658 },
        { widthTicks: 0, shareBps: 38 },
      ],
      [{ widthTicks: 0, shareBps: 10_000 }],
      [
        { widthTicks: 200, shareBps: 1 },
        { widthTicks: 400, shareBps: 2 },
        { widthTicks: 1_000, shareBps: 750 },
        { widthTicks: 2_000, shareBps: 1_500 },
        { widthTicks: 3_400, shareBps: 2_300 },
        { widthTicks: 6_800, shareBps: 3_000 },
        { widthTicks: 60_000, shareBps: 2_446 },
        { widthTicks: 0, shareBps: 1 },
      ],
    ];
    for (const [n, bands] of tables.entries()) {
      for (const sale of [85n * 10n ** 27n, 10n ** 18n + 12_345n]) {
        const l = installLaunch(f, {
          launcher: n % 2 ? OTHER : LAUNCHER,
          quote: WETH,
          curve: encodeCurve(bands)!,
          startTick: -239_200,
          sale,
          compounds: [
            { lower: -239_200, upper: -232_400, liquidity: 10n ** 20n },
            { lower: 232_400, upper: 239_200, liquidity: 7n },
          ],
        });
        const { curve } = (await client.launchInfo(l.token))!;
        expect(curve.curveId).toBeNull();
        expect(curve.curveTable).toBe(curveWordHex(encodeCurve(bands)!));
        expect(rows(curve)).toEqual(bands);
        expect(curve.startTick).toBe(-239_200);
      }
    }
  });
});
