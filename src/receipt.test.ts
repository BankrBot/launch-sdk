import { describe, expect, test } from "bun:test";
import { getAddress, type TransactionReceipt } from "viem";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
} from "./abis/suite3.js";
import { curveWordHex, encodeCurve } from "./curve.js";
import { isLaunchSdkError } from "./errors.js";
import { bucketIds } from "./lens.js";
import {
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  installLaunch,
  launchReceipt,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";
import { eventLog } from "./__internal__/fakeRpc.js";
import { PAD_PAYEE } from "./__internal__/fakeSuite.js";

const A = getAddress("0x000000000000000000000000000000000000fee1");
const B = getAddress("0x000000000000000000000000000000000000fee2");
const ADMIN = getAddress("0x00000000000000000000000000000000000ad317");

function split() {
  const { f, client } = postLaunchFixture();
  const l = installLaunch(f, {
    launcher: LAUNCHER,
    quote: WETH,
    metadataAdmin: ADMIN,
    creatorShares: [
      { account: PAD_PAYEE, sharesWad: 2n * 10n ** 17n },
      { account: A, sharesWad: 6n * 10n ** 17n },
      { account: B, sharesWad: 2n * 10n ** 17n },
    ],
    creators: [A, B],
  });
  return { f, client, l };
}

// Receipt logs as a node returns them, renumbered after an edit.
const withLogs = (
  receipt: TransactionReceipt,
  logs: readonly object[],
): TransactionReceipt =>
  ({
    ...receipt,
    logs: logs.map((log, i) => ({ ...receipt.logs[0]!, ...log, logIndex: i })),
  }) as TransactionReceipt;

const missing = (run: () => unknown) => {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, "RECEIPT_MISSING_LAUNCH")).toBe(true);
};

describe("parseLaunchReceipt: the launch's recipients, admin and start", () => {
  test("fee recipients come from the ledger's creator bucket, the admin from the token's first log", () => {
    const { f, client, l } = split();
    const r = client.parseLaunchReceipt(launchReceipt(f, l));
    expect(r.feeRecipients).toEqual([
      { recipient: A, shareBps: 7_500 },
      { recipient: B, shareBps: 2_500 },
    ]);
    expect(r.metadataAdmin).toBe(ADMIN);
    expect(r.tradingStart).toBeNull();
  });

  test("a scheduled launch carries its start; a launch with no admin reads null", () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const r = client.parseLaunchReceipt(
      launchReceipt(f, l, { tradingStart: 1_900_000_000n }),
    );
    expect(r.tradingStart).toBe(1_900_000_000);
    expect(r.metadataAdmin).toBeNull();
    expect(r.feeRecipients).toEqual([
      { recipient: LAUNCHER, shareBps: 10_000 },
    ]);
  });

  test("look-alike logs from another emitter in the same transaction are never read", () => {
    const { f, client, l } = split();
    const receipt = launchReceipt(f, l);
    const creatorId = bucketIds.creator(l.poolId);
    // A launcher contract can log the same events first, for the same bucket and token.
    const forged = [
      eventLog(
        bankrFeeLedgerAbi,
        "BucketRegistered",
        {
          bucketId: creatorId,
          poolId: l.poolId,
          beneficiaries: [OTHER],
          shares: [10n ** 18n],
        },
        OTHER,
      ),
      eventLog(
        bankrFeeLedgerAbi,
        "CreatorShares",
        { bucketId: creatorId, creatorShares: [10n ** 18n], takeover: false },
        OTHER,
      ),
      eventLog(
        bankrLaunchTokenAbi,
        "MetadataAdminSet",
        { from: "0x0000000000000000000000000000000000000000", to: OTHER },
        OTHER,
      ),
    ];
    // A hand-over in the launch transaction itself is not the admin the launch named either.
    const handOver = eventLog(
      bankrLaunchTokenAbi,
      "MetadataAdminSet",
      { from: ADMIN, to: OTHER },
      l.token,
    );
    const r = client.parseLaunchReceipt(
      withLogs(receipt, [...forged, handOver, ...receipt.logs]),
    );
    expect(r.feeRecipients.map((x) => x.recipient)).toEqual([A, B]);
    expect(r.metadataAdmin).toBe(ADMIN);
  });

  test("a receipt without the ledger's creator bucket or the token's admin log is not a launch", () => {
    const { f, client, l } = split();
    const receipt = launchReceipt(f, l);
    const without = (address: string) =>
      withLogs(
        receipt,
        receipt.logs.filter(
          (log) => log.address.toLowerCase() !== address.toLowerCase(),
        ),
      );
    missing(() => client.parseLaunchReceipt(without(SUITE.ledger)));
    missing(() => client.parseLaunchReceipt(without(l.token)));
    // The bucket's entries without their creator parts name nobody.
    missing(() =>
      client.parseLaunchReceipt(
        withLogs(
          receipt,
          receipt.logs.filter((_, i) => i !== 2),
        ),
      ),
    );
  });
});

describe("parseLaunchReceipt: the launch's curve", () => {
  const POCKET = encodeCurve([
    { widthTicks: 6_800, shareBps: 304 },
    { widthTicks: 110_000, shareBps: 9_658 },
    { widthTicks: 0, shareBps: 38 },
  ])!;

  test("a built-in curve reads by id and name, each band with its pool ticks from the launch's start", () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH, curve: 1n });
    const r = client.parseLaunchReceipt(launchReceipt(f, l));
    const dir = l.tokenIsCurrency0 ? 1 : -1;
    const ticks = (near: number, far: number) =>
      l.tokenIsCurrency0
        ? { tickLower: near, tickUpper: far }
        : { tickLower: dir * far, tickUpper: dir * near };
    expect(r.startTick).toBe(-200_000);
    expect(r.curve).toEqual({
      curveId: 1,
      name: "degen",
      curveTable: null,
      startTick: -200_000,
      bands: [
        { widthTicks: 20_600, shareBps: 300, ...ticks(-200_000, -179_400) },
        { widthTicks: 110_000, shareBps: 9_500, ...ticks(-179_400, -69_400) },
        { widthTicks: 0, shareBps: 200, ...ticks(-69_400, 887_200) },
      ],
    });
  });

  test("a launcher's own bands read as the word the launch carried and its decoded bands", () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      curve: POCKET,
      startTick: -239_200,
    });
    const { curve } = client.parseLaunchReceipt(launchReceipt(f, l));
    expect(curve.curveId).toBeNull();
    expect(curve.name).toBeNull();
    expect(curve.curveTable).toBe(curveWordHex(POCKET));
    expect(curve.curveTable).toBe(
      `0x00220130022625ba00000026${"0".repeat(40)}`,
    );
    expect(curve.startTick).toBe(-239_200);
    expect(curve.bands.map((b) => [b.widthTicks, b.shareBps])).toEqual([
      [6_800, 304],
      [110_000, 9_658],
      [0, 38],
    ]);
    const first = curve.bands[0]!;
    expect([first.tickLower, first.tickUpper]).toEqual(
      l.tokenIsCurrency0 ? [-239_200, -232_400] : [232_400, 239_200],
    );
    // Two tables that differ in one late band are two words.
    const other = encodeCurve([
      { widthTicks: 6_800, shareBps: 304 },
      { widthTicks: 110_000, shareBps: 9_657 },
      { widthTicks: 0, shareBps: 39 },
    ])!;
    const l2 = installLaunch(f, { launcher: OTHER, quote: WETH, curve: other });
    expect(
      client.parseLaunchReceipt(launchReceipt(f, l2)).curve.curveTable,
    ).not.toBe(curve.curveTable);
  });

  test("a curve word that is no curve is not a launch this SDK reads", () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const receipt = launchReceipt(f, l);
    const resolved = receipt.logs.length - 1;
    const forged = eventLog(
      bankrLaunchFactoryAbi,
      "LaunchResolved",
      {
        token: l.token,
        curveId: 3n,
        holdersBps: 0,
        distributor: l.distributor,
        vestingEscrow: "0x0000000000000000000000000000000000000000",
        vestingRecipient: LAUNCHER,
        vestBps: 0,
        totalSupply: 10n ** 29n,
        devBuyOut: 0n,
      },
      SUITE.factory,
    );
    missing(() =>
      client.parseLaunchReceipt(
        withLogs(
          receipt,
          receipt.logs.map((log, i) => (i === resolved ? forged : log)),
        ),
      ),
    );
  });
});
