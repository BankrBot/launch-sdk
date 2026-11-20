import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { getAddress, zeroAddress, type Address } from "viem";
import { readContract } from "viem/actions";
import { base } from "viem/chains";
import { launchParamsToJson } from "./abiJson.js";
import { bankrLaunchFactoryAbi } from "./abis/suite3.js";
import { requireCapExclusions } from "./addresses.js";
import type {
  FetchLike,
  PrepareRequest,
  PrepareResponse,
  Preparer,
  RegisterResult,
} from "./api.js";
import { CHAINS } from "./chains/index.js";
import { createLaunchClient, type LaunchClientOptions } from "./client.js";
import {
  ANY_CURVE,
  decodeCurve,
  encodeCurve,
  type CurveBand,
} from "./curve.js";
import { curveRevertDetail } from "./curveDetail.js";
import type { CurveMarketCapRange } from "./curveMarketCaps.js";
import type { LaunchParams } from "./economics.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { padSigner } from "./launchpad.js";
import {
  buildLaunchParams,
  normalizeLaunchInput,
  resolveEconomics,
} from "./normalize.js";
import { poolIdOf, readLaunchState, type PlanContext } from "./plan.js";
import type { LaunchInput } from "./providers/types.js";
import { mineVanitySalt, vanityRule } from "./salt.js";
import { EMPTY_PRICE_ATTESTATION } from "./terms.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import {
  FAKE_SIGNED_PRICE,
  START_TICK_BOUNDS,
  fakeAddress,
  fakeDistributor,
  installSuite,
  launchLogs,
  liveSuiteOf,
  setFakeCurveAllowed,
  testSuite,
  type SuiteFixture,
} from "./__internal__/fakeSuite.js";

// The fake Bankr mines a real …ba3 salt per prepare, which can pass bun's 5 s default on a slow CI runner.
setDefaultTimeout(30_000);

const SUITE = testSuite(8453);
const WETH = getAddress(CHAINS.base.quotes.WETH.address);
const USDC = getAddress(CHAINS.base.quotes.USDC.address);
const SIGNED_QUOTE = fakeAddress(0x7778);
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const PINNED = "ipfs://bafy-pinned-by-bankr";
const API_URL = "https://api.example";
const BANKR_SIG = `0x${"5b".repeat(65)}` as const;

const INPUT: LaunchInput<"base"> = {
  name: "Launch SDK Test",
  symbol: "LSDK",
  launcher: LAUNCHER,
  metadata: { description: "pinned by Bankr" },
};

const fixture = (): SuiteFixture =>
  installSuite(new FakeChain(base), SUITE, {
    [WETH]: { decimals: 18 },
    [USDC]: { decimals: 6 },
    [SIGNED_QUOTE]: { decimals: 18, pricing: 2 },
  });

async function expectCode(
  promise: Promise<unknown>,
  code: LaunchSdkErrorCode,
): Promise<unknown> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
  return thrown;
}

/**
 * Bankr's prepare endpoint over the fake suite: the pad's defaults, Bankr's salt and pin, id 0 signed by Bankr, a
 * SIGNED quote's price attested (`price`), and a launch's own bands started where core starts them: on the grid
 * tick at or under their named start, from the factory's bounds as this prepare reads them (`onRequest` runs first).
 */
function fakeBankr(
  f: SuiteFixture,
  tamper?: (r: PrepareResponse) => PrepareResponse,
  o: { price?: () => bigint; onRequest?: (count: number) => void } = {},
) {
  const requests: PrepareRequest[] = [];
  const responses: PrepareResponse[] = [];
  const ctx: PlanContext = {
    chain: CHAINS.base,
    addresses: SUITE,
    provider: "bankr_v4",
    client: f.fake.publicClient(),
    dataSuffix: undefined,
    usedSalts: new Set(),
  };
  const namedStart = async (
    quote: Address,
    usd: number,
    attested: LaunchParams["priceAttestation"],
  ): Promise<number> => {
    const [, highest] = await readContract(ctx.client, {
      address: SUITE.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "startTickBounds",
      args: [quote, 0n, attested],
    });
    const exact = highest - Math.log(125_000_000 / usd) / Math.log(1.0001);
    return Math.floor(exact / 200) * 200;
  };
  const preparer: Preparer = async (request) => {
    requests.push(request);
    o.onRequest?.(requests.length);
    const e = request.economics ?? {};
    const n = normalizeLaunchInput(
      CHAINS.base,
      {
        name: request.name,
        symbol: request.symbol,
        launcher: request.launcher,
        launchpadId: BigInt(request.launchpadId ?? "0"),
        quote: request.quote,
        feeRecipients: request.feeRecipients?.map((r) => ({
          recipient: r.address,
          shareBps: r.bps,
        })),
        allowOpenCodeFeeRecipients: request.allowOpenCodeFeeRecipients,
        metadataAdmin: request.metadataAdmin,
        startTime: request.startTime,
        curve: request.curve,
        metadataUri: request.metadataUri,
        ...(e.buy && e.sell ? { fees: { buy: e.buy, sell: e.sell } } : {}),
        holderShareBps: e.holderShareBps,
        autoLpBps: e.autoLpBps,
        buybackBps: e.buybackBps,
        referrerBps: e.referrerBps,
        vestToHolders: e.vestToHolders,
        vesting: request.vesting,
        devBuy: request.devBuy
          ? { amount: BigInt(request.devBuy.amount) }
          : undefined,
      },
      new Set(),
    );
    const s = await readLaunchState(ctx, n);
    const native = n.devBuyAmount > 0n && n.quote.address === WETH;
    const priceAttestation: LaunchParams["priceAttestation"] =
      n.quote.address === SIGNED_QUOTE
        ? {
            priceUsdE18: o.price?.() ?? FAKE_SIGNED_PRICE,
            observedAt: 1_900_000_000n,
            expiresAt: 2_000_000_000n,
            signature: BANKR_SIG,
          }
        : EMPTY_PRICE_ATTESTATION;
    const built = buildLaunchParams({
      ...n,
      metadataUri: request.metadataUri ?? PINNED,
      quote: n.quote.address,
      capExclusions: requireCapExclusions("base"),
      startTick:
        typeof request.curve === "object"
          ? await namedStart(
              n.quote.address,
              request.curve.startFdvUsd,
              priceAttestation,
            )
          : -200_000,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1_200),
      economics: resolveEconomics(n, s.pad),
      launchpadId: n.launchpadId,
      maxOperatorShareBps: s.pad.maxOperatorShareBps,
      operatorPayeesHash: s.pad.termsHash,
      vestBps: n.vestBps ?? s.pad.pad.policy.defaultVestBps,
      allowCodeVestingRecipient: false,
      devBuyAmountIn: native ? 0n : n.devBuyAmount,
    });
    const draft: LaunchParams = { ...built, priceAttestation };
    const live = liveSuiteOf(SUITE);
    const mined = (await mineVanitySalt({
      suite: live,
      identity: draft,
      launcher: n.launcher,
      rule: vanityRule(n.launchpadId, s.pad.pad.vanity),
    }))!;
    const bankrSigns = n.launchpadId === 0n;
    const params: LaunchParams = {
      ...draft,
      salt: mined.salt,
      authorization: bankrSigns
        ? {
            nonce: `0x${"0a".repeat(32)}`,
            deadline: 2_000_000_000n,
            signature: BANKR_SIG,
          }
        : draft.authorization,
    };
    const pool = poolIdOf(mined.token, params.quote, live.hook);
    const response: PrepareResponse = {
      chain: "base",
      chainId: 8453,
      launchpadId: n.launchpadId.toString(),
      factory: SUITE.factory,
      launcher: n.launcher,
      params: launchParamsToJson(params) as Record<string, unknown>,
      value: (native ? n.devBuyAmount : 0n).toString(),
      approval:
        !native && n.devBuyAmount > 0n
          ? { token: params.quote, amount: n.devBuyAmount.toString() }
          : null,
      predictedToken: mined.token,
      poolId: pool.poolId,
      tokenIsCurrency0: pool.tokenIsCurrency0,
      distributor: fakeDistributor(mined.token),
      escrow: null,
      expectedStartTick: params.expectedStartTick,
      deadline: params.deadline.toString(),
      padSigner: bankrSigns ? null : padSigner(s.pad),
      authorization: bankrSigns
        ? {
            nonce: params.authorization.nonce,
            deadline: "2000000000",
            signature: BANKR_SIG,
          }
        : null,
      metadataUri: params.metadataUri,
      prepareId: `prep-${requests.length}`,
    };
    responses.push(response);
    return tamper ? tamper(response) : response;
  };
  return { preparer, requests, responses };
}

/** The same response with some launch params rewritten. */
const withParams = (
  r: PrepareResponse,
  change: Record<string, unknown>,
): PrepareResponse => ({
  ...r,
  params: { ...r.params, ...change },
});

const REGISTERED: RegisterResult = {
  chain: "base",
  txHash: `0x${"00".repeat(32)}`,
  confirmations: 5,
  launches: [],
};

/** Bankr's read API: register and the index. */
function fakeApi(o: { register?: () => Response } = {}) {
  const calls: { url: URL; body: unknown }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.pathname === "/launches/register")
      return o.register?.() ?? Response.json(REGISTERED);
    if (url.pathname === "/launches")
      return Response.json({ launches: [], nextCursor: null });
    return Response.json({ error: "Not found." }, { status: 404 });
  };
  return { fetch, calls, paths: () => calls.map((c) => c.url.pathname) };
}

function apiClient(
  f: SuiteFixture,
  api: LaunchClientOptions<"base">["api"],
  o: Partial<LaunchClientOptions<"base">> = {},
) {
  return createLaunchClient({
    chain: "base",
    suite: 3,
    addresses: SUITE,
    fork: true,
    publicClient: f.fake.publicClient(),
    walletClient: f.fake.walletClient(LAUNCHER),
    api,
    ...o,
  });
}

describe("API mode: plan", () => {
  test("Bankr's pad (id 0): Bankr signs, salts and pins; the SDK verifies, simulates and sets the dev-buy floor", async () => {
    const f = fixture();
    const bankr = fakeBankr(f);
    const plan = await apiClient(f, { preparer: bankr.preparer }).plan({
      ...INPUT,
      devBuy: { amount: 10n ** 15n },
      holderShareBps: 5_000,
    });
    const req = bankr.requests[0]!;
    expect(req).toMatchObject({
      chain: "base",
      launcher: LAUNCHER,
      launchpadId: "0",
      quote: WETH,
      metadata: INPUT.metadata,
      devBuy: { amount: "1000000000000000" },
      economics: { holderShareBps: 5_000 },
      feeRecipients: [{ address: LAUNCHER, bps: 10_000 }],
    });
    expect(req.metadataUri).toBeUndefined();
    expect(req.metadataAdmin).toBeUndefined();
    expect(req.allowOpenCodeFeeRecipients).toBeUndefined();
    expect(req.startTime).toBeUndefined();
    expect(plan.prepareId).toBe("prep-1");
    expect(plan.launchpadId).toBe(0n);
    expect(plan.params.metadataUri).toBe(PINNED);
    expect(plan.params.authorization.signature).toBe(BANKR_SIG);
    expect(plan.predictedToken.toLowerCase().endsWith("ba3")).toBe(true);
    expect(plan.params.vestBps).toBe(1_500);
    expect(plan.params.econ.buy).toEqual({
      startPips: 800_000,
      steadyPips: 17_500,
      decaySecs: 14,
    });
    // holderShareBps 50 % of the creator's own take (70 % after the 30 % auto-LP floor) = 35 % of the creator side.
    expect(plan.params.econ.holdersBps).toBe(3_500);
    expect(plan.value).toBe(10n ** 15n);
    expect(plan.params.devBuyMinOut).toBe((plan.devBuyOut * 9_800n) / 10_000n);
  });

  test("a SIGNED quote launches in API mode (Bankr attests its price)", async () => {
    const f = fixture();
    const plan = await apiClient(f, { preparer: fakeBankr(f).preparer }).plan({
      ...INPUT,
      quote: SIGNED_QUOTE,
    });
    expect(plan.quote).toMatchObject({
      address: SIGNED_QUOTE,
      pricing: "signed",
    });
  });

  test("a caller's salt, or metadata with metadataUri, is INVALID_PARAMS before Bankr is called", async () => {
    const f = fixture();
    const bankr = fakeBankr(f);
    const c = apiClient(f, { preparer: bankr.preparer });
    await expectCode(
      c.plan({ ...INPUT, salt: `0x${"ab".repeat(32)}` }),
      "INVALID_PARAMS",
    );
    await expectCode(
      c.plan({ ...INPUT, metadataUri: "ipfs://x" }),
      "INVALID_PARAMS",
    );
    expect(bankr.requests).toEqual([]);
  });

  test("a prepare that does not match the request or the suite is API_ERROR, and nothing is sent", async () => {
    const tampers: [string, (r: PrepareResponse) => PrepareResponse][] = [
      ["factory", (r) => ({ ...r, factory: OTHER })],
      ["launcher", (r) => ({ ...r, launcher: OTHER })],
      ["launchpadId", (r) => ({ ...r, launchpadId: "1" })],
      [
        "feeRecipients",
        (r) =>
          withParams(r, {
            feeRecipients: [{ recipient: OTHER, shareBps: 10_000 }],
          }),
      ],
      [
        "allowOpenCodeFeeRecipients",
        (r) => withParams(r, { allowOpenCodeFeeRecipients: true }),
      ],
      ["metadataAdmin", (r) => withParams(r, { metadataAdmin: OTHER })],
      ["startTime", (r) => withParams(r, { startTime: "1" })],
      ["vestingRecipient", (r) => withParams(r, { vestingRecipient: OTHER })],
      ["quote", (r) => withParams(r, { quote: USDC })],
      ["name", (r) => withParams(r, { name: "Other" })],
      ["curve", (r) => withParams(r, { curveId: "1" })],
      ["capExclusions", (r) => withParams(r, { capExclusions: [] })],
      [
        "operatorPayeesHash",
        (r) => withParams(r, { operatorPayeesHash: `0x${"00".repeat(32)}` }),
      ],
      [
        "extension",
        (r) =>
          withParams(r, {
            extension: { ...(r.params.extension as object), ext: OTHER },
          }),
      ],
      ["value", (r) => ({ ...r, value: "1" })],
      ["approval", (r) => ({ ...r, approval: { token: USDC, amount: "1" } })],
      ["params shape", (r) => withParams(r, { vestBps: "lots" })],
      ["predictedToken", (r) => ({ ...r, predictedToken: OTHER })],
    ];
    for (const [what, tamper] of tampers) {
      const f = fixture();
      const err = await expectCode(
        apiClient(f, { preparer: fakeBankr(f, tamper).preparer }).plan(INPUT),
        what === "predictedToken" ? "PREDICTION_MISMATCH" : "API_ERROR",
      );
      expect(err, what).toBeDefined();
      expect(f.fake.sent).toEqual([]);
    }
    // Each prepare mines Bankr's …ba3 salt.
  }, 60_000);

  test("a recipient list, the waiver, a metadata admin and a scheduled start go out in the API's units and come back as terms", async () => {
    const f = fixture();
    const bankr = fakeBankr(f);
    const start = Math.floor(Date.now() / 1000) + 3_600;
    const input: LaunchInput<"base"> = {
      ...INPUT,
      feeRecipients: [
        { recipient: OTHER, shareBps: 6_000 },
        { recipient: LAUNCHER, shareBps: 4_000 },
      ],
      allowOpenCodeFeeRecipients: true,
      metadataAdmin: OTHER,
      startTime: new Date(start * 1_000),
    };
    const plan = await apiClient(f, { preparer: bankr.preparer }).plan(input);
    expect(bankr.requests[0]).toMatchObject({
      feeRecipients: [
        { address: OTHER, bps: 6_000 },
        { address: LAUNCHER, bps: 4_000 },
      ],
      allowOpenCodeFeeRecipients: true,
      metadataAdmin: OTHER,
      startTime: start,
    });
    expect(plan.params.feeRecipients).toEqual([
      { recipient: OTHER, shareBps: 6_000 },
      { recipient: LAUNCHER, shareBps: 4_000 },
    ]);
    expect(plan.params.allowOpenCodeFeeRecipients).toBe(true);
    expect(plan.params.metadataAdmin).toBe(OTHER);
    expect(plan.params.startTime).toBe(BigInt(start));
    // The order is a term (the first is the primary), and so is each share: neither may come back changed.
    const tampers: ((r: PrepareResponse) => PrepareResponse)[] = [
      (r) =>
        withParams(r, {
          feeRecipients: [...(r.params.feeRecipients as unknown[])].reverse(),
        }),
      (r) =>
        withParams(r, {
          feeRecipients: [
            { recipient: OTHER, shareBps: 6_001 },
            { recipient: LAUNCHER, shareBps: 3_999 },
          ],
        }),
      (r) => withParams(r, { startTime: String(start + 1) }),
    ];
    for (const tamper of tampers) {
      const g = fixture();
      await expectCode(
        apiClient(g, { preparer: fakeBankr(g, tamper).preparer }).plan(input),
        "API_ERROR",
      );
    }
    // A start past the pad's window is refused before Bankr is asked.
    const late = fakeBankr(f);
    const refused = await expectCode(
      apiClient(f, { preparer: late.preparer }).plan({
        ...INPUT,
        startTime: start + 8 * 86_400,
      }),
      "INVALID_PARAMS",
    );
    expect((refused as { detail?: string }).detail).toBe(
      "Trading can start at most 7 days after the launch.",
    );
    expect(late.requests).toEqual([]);
  }, 60_000);

  test("economics the caller set must come back as set", async () => {
    const f = fixture();
    const tamper = (r: PrepareResponse) =>
      withParams(r, { econ: { ...(r.params.econ as object), holdersBps: 1 } });
    await expectCode(
      apiClient(f, { preparer: fakeBankr(f, tamper).preparer }).plan({
        ...INPUT,
        holderShareBps: 5_000,
      }),
      "API_ERROR",
    );
  });

  test("a third-party signed pad comes back unsigned: the client's authorizer signs, or AUTHORIZATION_REQUIRED", async () => {
    const f = fixture();
    const input = {
      ...INPUT,
      launchpadId: 2n,
      metadata: undefined,
      metadataUri: "ipfs://own",
    };
    await expectCode(
      apiClient(f, { preparer: fakeBankr(f).preparer }).plan(input),
      "AUTHORIZATION_REQUIRED",
    );
    let asked = 0;
    const plan = await apiClient(
      f,
      { preparer: fakeBankr(f).preparer },
      {
        authorizer: async () => {
          asked++;
          return {
            nonce: `0x${"0c".repeat(32)}`,
            deadline: 2_000_000_000n,
            signature: `0x${"0d".repeat(65)}`,
          };
        },
      },
    ).plan(input);
    expect(asked).toBe(1);
    expect(plan.params.authorization.nonce).toBe(`0x${"0c".repeat(32)}`);
  });

  test("a built-in curve goes out by name; the default curve sends nothing", async () => {
    const f = fixture();
    const bankr = fakeBankr(f);
    const c = apiClient(f, { preparer: bankr.preparer });
    expect((await c.plan({ ...INPUT, curve: "degen" })).params.curveId).toBe(
      1n,
    );
    expect((await c.plan({ ...INPUT, curve: 2 })).params.curveId).toBe(2n);
    expect(
      (await c.plan({ ...INPUT, curve: "runner_v1" })).params.curveId,
    ).toBe(0n);
    expect(bankr.requests.map((r) => r.curve)).toEqual([
      "degen",
      "thin_topside",
      undefined,
    ]);
    expect("curve" in bankr.requests[2]!).toBe(false);
  }, 60_000);

  test("own bands go out as bands with their USD start, in either input form, and come back as the same word", async () => {
    const POCKET = [
      { widthTicks: 6_800, shareBps: 304 },
      { widthTicks: 110_000, shareBps: 9_658 },
      { widthTicks: 0, shareBps: 38 },
    ];
    const wad = (bps: number) => BigInt(bps) * 10n ** 14n;
    const f = fixture();
    setFakeCurveAllowed(f.pads.get(1n)!, ANY_CURVE, true);
    const bankr = fakeBankr(f);
    const c = apiClient(f, { preparer: bankr.preparer });
    const on = { ...INPUT, launchpadId: 1n, metadata: undefined };
    const raw = await c.plan({
      ...on,
      curve: { bands: POCKET, startFdvUsd: 25_000 },
    });
    const ranged = await c.plan({
      ...on,
      curve: {
        marketCaps: [
          { marketCap: { start: 25_000, end: 50_000 }, shares: wad(304) },
          { marketCap: { start: 50_000, end: 3e9 }, shares: wad(9_658) },
          { marketCap: { start: 3e9, end: "max" }, shares: wad(38) },
        ],
      },
    });
    // $25K is 23.8 ticks above its start tick: the ranges' grid lines from it are the bands' own.
    for (const plan of [raw, ranged]) {
      expect(plan.params.curveId).toBe(encodeCurve(POCKET)!);
      expect(plan.params.expectedStartTick).toBe(-205_200);
    }
    expect(bankr.requests.map((r) => r.curve)).toEqual([
      { bands: POCKET, startFdvUsd: 25_000 },
      { bands: POCKET, startFdvUsd: 25_000 },
    ]);
  });

  test("a closed launchpad, or own bands with no USD start, are refused before Bankr is called", async () => {
    const bands = [
      { widthTicks: 6_800, shareBps: 304 },
      { widthTicks: 0, shareBps: 9_696 },
    ];
    const f = fixture();
    const bankr = fakeBankr(f);
    const c = apiClient(f, { preparer: bankr.preparer });
    const closed = (await expectCode(
      c.plan({ ...INPUT, curve: { bands, startFdvUsd: 10_000 } }),
      "CURVE_NOT_ALLOWED",
    )) as { detail?: string };
    expect(closed.detail).toBe(
      "Bankr's launchpad does not take launcher-defined liquidity bands yet. Launch on one of its built-in curves.",
    );
    setFakeCurveAllowed(f.pads.get(1n)!, ANY_CURVE, true);
    const noStart = (await expectCode(
      c.plan({
        ...INPUT,
        launchpadId: 1n,
        metadata: undefined,
        curve: { bands },
      }),
      "INVALID_PARAMS",
    )) as { detail?: string };
    expect(noStart.detail).toBe(
      "In API mode a launch with its own liquidity bands names its start price in USD: set curve.startFdvUsd.",
    );
    expect(bankr.requests).toEqual([]);
  });

  test("prepared bands that break a rule in the token's own order are INVALID_PARAMS naming the band", async () => {
    const f = fixture();
    setFakeCurveAllowed(f.pads.get(1n)!, ANY_CURVE, true);
    const bankr = fakeBankr(f);
    // runner_v1's own rows rise again at band 3, which the pad's default auto-liquidity does not allow.
    const err = (await expectCode(
      apiClient(f, { preparer: bankr.preparer }).plan({
        ...INPUT,
        launchpadId: 1n,
        metadata: undefined,
        curve: {
          bands: [
            { widthTicks: 6_800, shareBps: 300 },
            { widthTicks: 110_000, shareBps: 9_500 },
            { widthTicks: 0, shareBps: 200 },
          ],
          startFdvUsd: 10_000,
        },
      }),
      "INVALID_PARAMS",
    )) as { detail?: string };
    expect(err.detail).toBe(curveRevertDetail("CurveStep", 2));
    expect(bankr.requests).toHaveLength(1);
    expect(f.fake.sent).toEqual([]);
  });

  test("a preparer that throws something other than an SDK error is API_ERROR with it on the cause", async () => {
    const boom = new Error("socket hang up");
    const err = await expectCode(
      apiClient(fixture(), { preparer: async () => Promise.reject(boom) }).plan(
        INPUT,
      ),
      "API_ERROR",
    );
    expect((err as Error).cause).toBe(boom);
  });
});

describe("API mode: market-cap ranges", () => {
  const wad = (bps: number) => BigInt(bps) * 10n ** 14n;
  const bands = (...r: [number, number][]): CurveBand[] =>
    r.map(([widthTicks, shareBps]) => ({ widthTicks, shareBps }));
  // Ranges from `start`: each row is where the range ends, as a multiple of the start (0 for "max"), and its bps.
  const ranges = (
    start: number,
    rows: readonly (readonly [number, number])[],
  ): CurveMarketCapRange[] => {
    let from = start;
    return rows.map(([times, bps]) => {
      const marketCap = { start: from, end: times ? start * times : "max" };
      if (times) from = start * times;
      return { marketCap, shares: wad(bps) } as CurveMarketCapRange;
    });
  };
  // The rehearsal's shares: a pocket to `pocket` times the start, a backbone to 120,000 times it, a tail.
  const caps = (start: number, pocket = 2) =>
    ranges(start, [
      [pocket, 304],
      [120_000, 9_658],
      [0, 38],
    ]);
  // Two, five and eight ranges and a wide pocket: each passes the rules on a pool that buys nothing of its own.
  const SHAPES: readonly (readonly [number, number])[][] = [
    [
      [30, 9_000],
      [0, 1_000],
    ],
    [
      [1.5, 300],
      [2.5, 400],
      [60, 3_000],
      [100_000, 6_200],
      [0, 100],
    ],
    [
      [1.3, 200],
      [1.7, 250],
      [2.4, 350],
      [6, 800],
      [40, 2_000],
      [1_000, 3_100],
      [150_000, 3_200],
      [0, 100],
    ],
    [
      [4, 800],
      [200_000, 9_150],
      [0, 50],
    ],
  ];
  // How far under `cap` a tick sits, in ticks, with the factory's bounds moved `shift` ticks ($125M at its highest).
  const under = (cap: number, tick: number, shift = 0) =>
    Math.log(cap / 125_000_000) / Math.log(1.0001) -
    (tick - START_TICK_BOUNDS[1] - shift);
  const moveBounds = (f: SuiteFixture, shift: number) =>
    f.set(
      "factory",
      "startTickBounds",
      START_TICK_BOUNDS.map((t) => t + shift),
    );
  const open = (f: SuiteFixture, key: bigint = ANY_CURVE) =>
    setFakeCurveAllowed(f.pads.get(1n)!, key, true);
  const ON_PAD = { ...INPUT, launchpadId: 1n, metadata: undefined };
  /** Every band of `plan` ends on its pool at or under the market cap asked for, by less than one tick spacing. */
  const expectPlaced = (
    plan: { params: LaunchParams },
    asked: CurveMarketCapRange[],
    shift = 0,
  ) => {
    const tick = plan.params.expectedStartTick;
    const start = under(asked[0]!.marketCap.start, tick, shift);
    expect(start >= 0 && start < 200, `start, ${start} ticks under`).toBe(true);
    let end = tick;
    decodeCurve(plan.params.curveId)!
      .slice(0, -1)
      .forEach((b, n) => {
        end += b.widthTicks;
        const by = under(asked[n]!.marketCap.end as number, end, shift);
        expect(by >= -1e-6 && by < 200, `band ${n + 1}, ${by} under`).toBe(
          true,
        );
      });
    return start;
  };
  // $10K is 60.4 ticks above its start tick: $1.2B's grid line is 117,000 ticks up, not the 116,800 from $10K itself.
  const AT_10K = bands([6_800, 304], [110_200, 9_658], [0, 38]);
  // The same ranges with the pocket ending at 1.95 times the start, from 60.4 ticks above the tick and from 20.4.
  const LOW_AT_60 = bands([6_600, 304], [110_400, 9_658], [0, 38]);
  const LOW_AT_20 = bands([6_600, 304], [110_200, 9_658], [0, 38]);

  test("the ranges go out placed from the launch's own start tick: each band ends on the pool under its market cap by less than one tick spacing", async () => {
    const f = fixture();
    open(f);
    const bankr = fakeBankr(f);
    const c = apiClient(f, { preparer: bankr.preparer });
    const plan = await c.plan({
      ...ON_PAD,
      curve: { marketCaps: caps(10_000) },
    });
    expect(plan.params.expectedStartTick).toBe(-214_400);
    expect(decodeCurve(plan.params.curveId)).toEqual(AT_10K);
    expect(bankr.requests.map((r) => r.curve)).toEqual([
      { bands: AT_10K, startFdvUsd: 10_000 },
    ]);
    expectPlaced(plan, caps(10_000));
    // Twenty-four starts from $3K to $50K, in every quarter of a tick spacing. No own buys: not the step rule's test.
    // Each is the launch pure mode plans for the same ranges: the same start tick and the same bands.
    const pure = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      fork: true,
      publicClient: f.fake.publicClient(),
    });
    const quarters = new Set<number>();
    for (let i = 0; i < 24; i++) {
      const asked = caps(3_100 * 1.13 ** i);
      const launch = { ...ON_PAD, autoLpBps: 0, curve: { marketCaps: asked } };
      const at = await c.plan(launch);
      quarters.add(Math.floor(expectPlaced(at, asked) / 50));
      const alone = await pure.plan({ ...launch, metadataUri: PINNED });
      expect(at.params.curveId).toBe(alone.params.curveId);
      expect(at.params.expectedStartTick).toBe(alone.params.expectedStartTick);
    }
    expect([...quarters].sort()).toEqual([0, 1, 2, 3]);
    for (const rows of SHAPES)
      for (let i = 0; i < 6; i++) {
        const asked = ranges(2_700 * 1.61 ** i, rows);
        const at = await c.plan({
          ...ON_PAD,
          autoLpBps: 0,
          curve: { marketCaps: asked },
        });
        expect(decodeCurve(at.params.curveId)).toHaveLength(rows.length);
        expectPlaced(at, asked);
      }
    // One prepare each: Bankr's start tick is the one the SDK read.
    expect(bankr.requests).toHaveLength(49);
    // Bankr's own pad, once it takes launcher-defined bands: the same placement, on terms Bankr signs.
    setFakeCurveAllowed(f.pads.get(0n)!, ANY_CURVE, true);
    const low = caps(10_000, 1.95);
    const signed = await c.plan({ ...INPUT, curve: { marketCaps: low } });
    expect(signed.launchpadId).toBe(0n);
    expect(signed.params.authorization.signature).toBe(BANKR_SIG);
    expect(decodeCurve(signed.params.curveId)).toEqual(LOW_AT_60);
    expectPlaced(signed, low);
    expect(bankr.requests).toHaveLength(50);
  }, 120_000);

  test("the quote's price moves between the SDK's read and Bankr's: the ranges are placed from the start Bankr gave, prepared again when that changes the bands", async () => {
    const asked = caps(10_000, 1.95);
    // 1.5 % up: Bankr starts one grid line lower, and from there the ranges are the same bands. One prepare.
    const line = fixture();
    open(line);
    const lower = fakeBankr(line, undefined, {
      onRequest: () => moveBounds(line, -150),
    });
    const moved = await apiClient(line, { preparer: lower.preparer }).plan({
      ...ON_PAD,
      curve: { marketCaps: asked },
    });
    expect(moved.params.expectedStartTick).toBe(-214_600);
    expect(decodeCurve(moved.params.curveId)).toEqual(LOW_AT_60);
    expect(lower.requests).toHaveLength(1);
    expectPlaced(moved, asked, -150);
    // 0.4 % up: the same start tick, but $10K is now 20.4 ticks above it and $1.2B's grid line one spacing nearer.
    const f = fixture();
    open(f);
    const bankr = fakeBankr(f, undefined, {
      onRequest: () => moveBounds(f, -40),
    });
    const plan = await apiClient(f, { preparer: bankr.preparer }).plan({
      ...ON_PAD,
      curve: { marketCaps: asked },
    });
    expect(plan.params.expectedStartTick).toBe(-214_400);
    expect(bankr.requests.map((r) => r.curve)).toEqual([
      { bands: LOW_AT_60, startFdvUsd: 10_000 },
      { bands: LOW_AT_20, startFdvUsd: 10_000 },
    ]);
    expect(decodeCurve(plan.params.curveId)).toEqual(LOW_AT_20);
    expect(plan.prepareId).toBe("prep-2");
    expectPlaced(plan, asked, -40);
  });

  test("a price that moves across every prepare is START_TICK_CHANGED after three, and nothing is sent", async () => {
    const f = fixture();
    open(f);
    // Each prepare leaves the price where the bands just sent are the wrong ones.
    const bankr = fakeBankr(f, undefined, {
      onRequest: (count) => moveBounds(f, count % 2 === 1 ? -40 : 0),
    });
    const err = (await expectCode(
      apiClient(f, { preparer: bankr.preparer }).plan({
        ...ON_PAD,
        curve: { marketCaps: caps(10_000, 1.95) },
      }),
      "START_TICK_CHANGED",
    )) as { detail?: string };
    expect(err.detail).toBe(
      "The quote's price kept moving while the launch's market-cap ranges were placed from its start tick. Plan the launch again, or convert the ranges once with curveFromMarketCaps and launch with those bands.",
    );
    expect(bankr.requests).toHaveLength(3);
    expect(f.fake.sent).toEqual([]);
  });

  test("a SIGNED quote's price is Bankr's attestation: the ranges are placed from the prepare's own, and prepared again when the bands differ", async () => {
    const asked = caps(10_000, 1.95);
    const input = { ...ON_PAD, quote: SIGNED_QUOTE, autoLpBps: 0 };
    // At the attested price $10K is 60.4 ticks above its tick: not the bands of a start on the grid.
    const f = fixture();
    open(f);
    const bankr = fakeBankr(f);
    const plan = await apiClient(f, { preparer: bankr.preparer }).plan({
      ...input,
      curve: { marketCaps: asked },
    });
    expect(bankr.requests.map((r) => r.curve)).toEqual([
      { bands: LOW_AT_20, startFdvUsd: 10_000 },
      { bands: LOW_AT_60, startFdvUsd: 10_000 },
    ]);
    expect(plan.params.expectedStartTick).toBe(-214_400);
    expect(decodeCurve(plan.params.curveId)).toEqual(LOW_AT_60);
    expect(plan.params.priceAttestation.priceUsdE18).toBe(FAKE_SIGNED_PRICE);
    expectPlaced(plan, asked);
    // 0.4 % dearer, $10K is 20.4 ticks above its tick and the first prepare's bands are the launch's.
    const dear = fixture();
    open(dear);
    const price = (FAKE_SIGNED_PRICE * 10_040_078n) / 10_000_000n;
    const once = fakeBankr(dear, undefined, { price: () => price });
    const second = await apiClient(dear, { preparer: once.preparer }).plan({
      ...input,
      curve: { marketCaps: asked },
    });
    expect(once.requests).toHaveLength(1);
    expect(decodeCurve(second.params.curveId)).toEqual(LOW_AT_20);
    expectPlaced(second, asked, -40);
  });

  test("placed bands are held to the rules, the launchpad's key and the factory's window before Bankr is called", async () => {
    const f = fixture();
    const bankr = fakeBankr(f);
    const c = apiClient(f, { preparer: bankr.preparer });
    const own = { ...ON_PAD, curve: { marketCaps: caps(10_000) } };
    // A launchpad that lists exact bands: the key is read for the word the start tick gives the ranges.
    const closed = (await expectCode(c.plan(own), "CURVE_NOT_ALLOWED")) as {
      detail?: string;
    };
    expect(closed.detail).toStartWith(
      "This launchpad is closed to these liquidity bands. Its operator must open it first",
    );
    open(f, encodeCurve(bands([6_800, 304], [110_000, 9_658], [0, 38]))!);
    await expectCode(c.plan(own), "CURVE_NOT_ALLOWED");
    expect(bankr.requests).toEqual([]);
    open(f, encodeCurve(AT_10K)!);
    expect((await c.plan(own)).params.curveId).toBe(encodeCurve(AT_10K)!);
    expect(bankr.requests).toHaveLength(1);
    // $7K is 93 ticks above its tick, so a pocket to $14K is 7,000 ticks: past the step rule's 6,800 on a pool
    // that buys its own token, as this pad's default auto-liquidity makes it.
    open(f);
    const step = (await expectCode(
      c.plan({ ...ON_PAD, curve: { marketCaps: caps(7_000) } }),
      "INVALID_PARAMS",
    )) as { detail?: string };
    expect(step.detail).toBe(
      `${curveRevertDetail("CurveStep", 1)} Market-cap ranges are placed from the launch's start tick, so the band after a range begins within those 6,800 ticks for certain only when the range ends under 1.97 times the start market cap. End that range lower, or convert the ranges once with curveFromMarketCaps and launch with its bands.`,
    );
    // The same ranges on a pool that buys nothing of its own, and a pocket that ends at 1.95 times the start, pass.
    const free = await c.plan({
      ...ON_PAD,
      autoLpBps: 0,
      curve: { marketCaps: caps(7_000) },
    });
    expect(decodeCurve(free.params.curveId)![0]!.widthTicks).toBe(7_000);
    const low = await c.plan({
      ...ON_PAD,
      curve: { marketCaps: caps(7_000, 1.95) },
    });
    expect(decodeCurve(low.params.curveId)![0]!.widthTicks).toBe(6_600);
    // A start under the factory's window is refused, never moved up into it.
    const outside = (await expectCode(
      c.plan({ ...ON_PAD, curve: { marketCaps: caps(10) } }),
      "INVALID_PARAMS",
    )) as { detail?: string };
    expect(outside.detail).toBe(
      "The curve's start market cap is outside the factory's USD window for this quote.",
    );
    expect(bankr.requests).toHaveLength(3);
    expect(f.fake.sent).toEqual([]);
  });
});

describe("API mode: launch", () => {
  test("prepares, sends, waits for 5 confirmations and registers the launch with Bankr's index", async () => {
    const f = fixture();
    f.fake.onSend = (tx) => {
      f.fake.blockNumber += 10n;
      return launchLogs(f, tx);
    };
    const bankr = fakeBankr(f);
    const api = fakeApi();
    const result = await apiClient(f, {
      preparer: bankr.preparer,
      fetch: api.fetch,
      url: API_URL,
    }).launch(INPUT);
    expect(f.fake.sent).toHaveLength(1);
    expect(result.token).toBe(getAddress(bankr.responses[0]!.predictedToken));
    expect(result.launchpadId).toBe(0n);
    expect(api.paths()).toEqual(["/launches/register"]);
    expect(api.calls[0]!.body).toEqual({
      chain: "base",
      txHash: result.txHash,
    });
    expect(result.registration).toEqual(REGISTERED);
  });

  test("a failed registration never fails the launch: registration is null", async () => {
    const f = fixture();
    f.fake.onSend = (tx) => {
      f.fake.blockNumber += 10n;
      return launchLogs(f, tx);
    };
    const api = fakeApi({
      register: () =>
        Response.json({ error: "No.", code: "NOT_A_LAUNCH" }, { status: 422 }),
    });
    const result = await apiClient(f, {
      preparer: fakeBankr(f).preparer,
      fetch: api.fetch,
    }).launch(INPUT);
    expect(result.registration).toBeNull();
  });
});

describe("index", () => {
  test("reads and registers on the client's chain", async () => {
    const f = fixture();
    const api = fakeApi();
    const c = apiClient(f, { fetch: api.fetch, url: `${API_URL}/` });
    expect(await c.index.launches({ builder: "mypad", launchpad: 3n })).toEqual(
      { launches: [], nextCursor: null },
    );
    const token = "0x000000000000000000000000000000000000beef" as Address;
    expect(await c.index.launch(token)).toBeNull();
    expect(await c.index.register(REGISTERED.txHash)).toEqual(REGISTERED);
    expect(Object.fromEntries(api.calls[0]!.url.searchParams)).toEqual({
      builder: "mypad",
      launchpad: "3",
      chain: "base",
    });
    expect(api.calls[1]!.url.pathname).toBe(
      `/launches/base/${getAddress(token)}`,
    );
    await expectCode(c.index.launch("0xnope" as Address), "INVALID_PARAMS");
    expect(zeroAddress).toBeDefined();
  });

  test("launchpadStats reads the pad on the client's chain", async () => {
    const f = fixture();
    const api = fakeApi();
    const c = apiClient(f, { fetch: api.fetch, url: `${API_URL}/` });
    // The fake API serves no stats: the call is what this pins.
    await expectCode(
      c.index.launchpadStats(3n, { visibility: "listed" }),
      "API_ERROR",
    );
    expect(api.calls[0]!.url.pathname).toBe("/launchpads/base/3/stats");
    expect(api.calls[0]!.url.searchParams.get("visibility")).toBe("listed");
  });

  test("all walks the client's chain", async () => {
    const f = fixture();
    const api = fakeApi();
    const c = apiClient(f, { fetch: api.fetch, url: `${API_URL}/` });
    const seen = [];
    for await (const l of c.index.all({ launchpad: 3n })) seen.push(l);
    expect(seen).toEqual([]);
    expect(Object.fromEntries(api.calls[0]!.url.searchParams)).toEqual({
      launchpad: "3",
      chain: "base",
      limit: "100",
    });
  });
});
