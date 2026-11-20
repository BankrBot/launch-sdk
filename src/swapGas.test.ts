import { describe, expect, test } from "bun:test";
import { SWAP_GAS_HEADROOM } from "./economics.js";
import { isLaunchSdkError } from "./errors.js";
import { encodeHookData } from "./hookData.js";
import {
  HOLDERS_WAKE_SWAP_GAS,
  MAX_EXT_SWAP_GAS_HEADROOM,
  MAX_POOL_GAS_HEADROOM,
  extSwapGasHeadroom,
  holdersWakeRequest,
  holdersWakeSwapGas,
  readExtSwapGasHeadroom,
  swapGasHeadroom,
  type RouteHop,
} from "./swapGas.js";
import {
  LAUNCHER,
  SUITE,
  WETH,
  installLaunch,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";

// The lens's answers for a binding at the floor budgets and at both ceilings (no pinned currency).
const FLOORS = 499_879n;
const CEILINGS = 1_687_316n;
const AT_FLOORS = { quoteGas: 50_000, afterGas: 150_000 };
const AT_CEILINGS = { quoteGas: 250_000, afterGas: 1_000_000 };

function refused(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(true);
    return (err as { detail?: string }).detail;
  }
  throw new Error("accepted");
}

describe("the lens figure from a binding's budgets", () => {
  test("BankrHookLens.extSwapGasHeadroom's five values: the floors, each ceiling alone, both, and both with 16 pins", () => {
    expect(extSwapGasHeadroom(AT_FLOORS)).toBe(FLOORS);
    expect(extSwapGasHeadroom({ quoteGas: 250_000, afterGas: 150_000 })).toBe(
      723_189n,
    );
    expect(extSwapGasHeadroom({ quoteGas: 50_000, afterGas: 1_000_000 })).toBe(
      1_464_007n,
    );
    expect(extSwapGasHeadroom(AT_CEILINGS)).toBe(CEILINGS);
    expect(extSwapGasHeadroom(AT_CEILINGS, 16)).toBe(1_726_284n);
    expect(MAX_EXT_SWAP_GAS_HEADROOM).toBe(1_726_284n);
    expect(MAX_POOL_GAS_HEADROOM).toBe(2_686_284n);
  });

  test("a pin costs a binding with a post-swap call about 2,435 and a quote-only one nothing", () => {
    expect(extSwapGasHeadroom(AT_FLOORS, 1) - FLOORS).toBe(2_436n);
    expect(extSwapGasHeadroom(AT_CEILINGS, 1) - CEILINGS).toBe(2_435n);
    expect(extSwapGasHeadroom(AT_FLOORS, 16)).toBe(538_847n);
    const quoteOnly = { quoteGas: 50_000, afterGas: 0 };
    expect(extSwapGasHeadroom(quoteOnly)).toBe(287_737n);
    expect(extSwapGasHeadroom(quoteOnly, 16)).toBe(287_737n);
    expect(extSwapGasHeadroom({ quoteGas: 250_000, afterGas: 0 })).toBe(
      511_046n,
    );
  });

  test("budgets no binding holds, or a pin count the hook refuses, are INVALID_PARAMS", () => {
    for (const b of [
      { quoteGas: 49_999, afterGas: 150_000 },
      { quoteGas: 250_001, afterGas: 150_000 },
      { quoteGas: 50_000, afterGas: 149_999 },
      { quoteGas: 50_000, afterGas: 1_000_001 },
      { quoteGas: 0, afterGas: 0 },
      { quoteGas: 60_000.5, afterGas: 0 },
    ])
      expect(refused(() => extSwapGasHeadroom(b))).toContain(
        "not a binding's gas budgets",
      );
    for (const pins of [-1, 17, 1.5])
      expect(refused(() => extSwapGasHeadroom(AT_FLOORS, pins))).toContain(
        "0 to 16",
      );
  });
});

describe("gas a swap adds per Bankr pool", () => {
  test("960,000 for a plain pool, plus the lens figure for a pool with an extension", () => {
    expect(swapGasHeadroom({ extHeadroom: 0n })).toBe(SWAP_GAS_HEADROOM);
    expect(swapGasHeadroom({ extHeadroom: FLOORS })).toBe(1_459_879n);
    expect(swapGasHeadroom({ extHeadroom: CEILINGS })).toBe(2_647_316n);
    expect(swapGasHeadroom({ extHeadroom: MAX_EXT_SWAP_GAS_HEADROOM })).toBe(
      MAX_POOL_GAS_HEADROOM,
    );
  });

  test("a figure the lens cannot answer is INVALID_PARAMS", () => {
    for (const extHeadroom of [-1n, MAX_EXT_SWAP_GAS_HEADROOM + 1n])
      expect(refused(() => swapGasHeadroom({ extHeadroom }))).toContain(
        "lens figure",
      );
    expect(
      refused(() => swapGasHeadroom({ extHeadroom: 0 as unknown as bigint })),
    ).toContain("bigint");
  });
});

describe("the holders' wake request", () => {
  const route: RouteHop[] = [
    { extHeadroom: 0n },
    { extHeadroom: FLOORS },
    { extHeadroom: CEILINGS },
  ];

  test("every Bankr pool asks and keeps what the hops after it need; the last keeps nothing", () => {
    // 250,000 + 960,000 + the pool's lens figure for each later Bankr pool.
    expect(holdersWakeRequest(route, 0)).toEqual({ keepGas: 4_607_195 });
    expect(holdersWakeRequest(route, 1)).toEqual({ keepGas: 2_897_316 });
    expect(holdersWakeRequest(route, 2)).toEqual({ keepGas: 0 });
    expect(
      route.map((_, i) =>
        encodeHookData({ holdersWake: holdersWakeRequest(route, i) }),
      ),
    ).toEqual([
      "0xba7c4a7c08464cdb",
      "0xba7c4a7c082c35a4",
      "0xba7c4a7c08000000",
    ]);
  });

  test("another venue's pool carries no request and is kept 300,000", () => {
    const mixed: RouteHop[] = [
      { extHeadroom: 0n },
      null,
      { extHeadroom: FLOORS },
    ];
    expect(holdersWakeRequest(mixed, 0)).toEqual({ keepGas: 2_009_879 });
    expect(holdersWakeRequest(mixed, 1)).toBeNull();
    expect(holdersWakeRequest(mixed, 2)).toEqual({ keepGas: 0 });
  });

  test("no hop at the index, or a route too long for three bytes of kept gas, is INVALID_PARAMS", () => {
    for (const index of [-1, 3, 0.5])
      expect(refused(() => holdersWakeRequest(route, index))).toContain(
        "no hop",
      );
    const long: RouteHop[] = Array.from({ length: 8 }, () => ({
      extHeadroom: MAX_EXT_SWAP_GAS_HEADROOM,
    }));
    expect(refused(() => holdersWakeRequest(long, 0))).toContain("more gas");
    expect(holdersWakeRequest(long, 7)).toEqual({ keepGas: 0 });
  });

  test("funding the first asking pool's wake: 5,470,000 plus the kept gas through six call frames", () => {
    expect(holdersWakeSwapGas(0)).toBe(HOLDERS_WAKE_SWAP_GAS);
    expect(holdersWakeSwapGas(2_897_316)).toBe(8_654_436n);
    expect(holdersWakeSwapGas(4_607_195)).toBe(10_533_761n);
    for (const keepGas of [-1, 0.5, 0x1000000])
      expect(refused(() => holdersWakeSwapGas(keepGas))).toContain("kept gas");
  });
});

describe("readExtSwapGasHeadroom", () => {
  test("reads the hook's lens for the pool and the pin count; 0 without an extension", async () => {
    const { f, client } = postLaunchFixture();
    const plain = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const ext = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      symbol: "EXT",
    });
    ext.extSwapGasHeadroom = (pins) =>
      extSwapGasHeadroom(AT_FLOORS, Number(pins));
    const read = (poolId: typeof plain.poolId, pins?: number) =>
      readExtSwapGasHeadroom(client.publicClient, {
        hook: SUITE.hook,
        poolId,
        pins,
      });
    expect(await read(plain.poolId)).toBe(0n);
    expect(await read(ext.poolId)).toBe(FLOORS);
    expect(await read(ext.poolId, 16)).toBe(538_847n);
    const info = (await client.launchInfo(ext.token))!;
    expect(await readExtSwapGasHeadroom(client.publicClient, info)).toBe(
      FLOORS,
    );
  });

  test("a pin count the hook refuses is INVALID_PARAMS before any read", async () => {
    const { client } = postLaunchFixture();
    for (const pins of [-1, 17, 1.5]) {
      const err = await readExtSwapGasHeadroom(client.publicClient, {
        hook: SUITE.hook,
        poolId: `0x${"00".repeat(32)}`,
        pins,
      }).catch((e: unknown) => e);
      expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(true);
    }
  });
});
