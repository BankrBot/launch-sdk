import { describe, expect, test } from "bun:test";
import { getAddress, type Hex } from "viem";
import { arbitrum, base, robinhood } from "viem/chains";
import {
  BANKR_V4_EARLIER_ADDRESSES,
  BANKR_V4_LAUNCH_ADDRESSES,
  DEFAULT_SUITE,
  chooseSuite,
  type LaunchAddresses,
  type SuiteRecords,
} from "./addresses.js";
import { CHAINS } from "./chains/index.js";
import { createLaunchClient, type LaunchClient } from "./client.js";
import { ANY_CURVE, curveWordHex, encodeCurve } from "./curve.js";
import { curveMarketCaps } from "./curveMarketCaps.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import * as sdk from "./index.js";
import type { LaunchParams } from "./providers/types.js";
import { encodeBuilderCodeSuffix } from "./tx.js";
import { FakeChain, Revert } from "./__internal__/fakeRpc.js";
import {
  FAKE_TOKENS_PER_UNIT,
  START_TICK_BOUNDS,
  fakeDistributor,
  installSuite,
  launchLogs,
  sentLaunch,
  setFakeCurveAllowed,
  testSuite,
  type SuiteFixture,
} from "./__internal__/fakeSuite.js";

const SUITE = testSuite(8453);
const WETH = getAddress(CHAINS.base.quotes.WETH.address);
const USDC = getAddress(CHAINS.base.quotes.USDC.address);
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const INPUT = {
  name: "Launch SDK Test",
  symbol: "LSDK",
  metadataUri: "ipfs://bafy-test",
  launcher: LAUNCHER,
  launchpadId: 1n,
} as const;

const fixture = (): SuiteFixture =>
  installSuite(new FakeChain(base), SUITE, {
    [WETH]: { decimals: 18 },
    [USDC]: { decimals: 6 },
  });

function expectSync(fn: () => unknown, code: LaunchSdkErrorCode): unknown {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
  return thrown;
}

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

describe("which contracts a client is on", () => {
  const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
  // A made-up suite 4 row: what a chain's go-live adds to the SDK's table.
  const row = (chainId: number): LaunchAddresses => ({
    ...testSuite(chainId),
    factory: at(0x4f),
    settings: at(0x45),
    termsLens: at(0x46),
    raffleRunCode: at(0x47),
    launchResolverLibrary: at(0x48),
    launchPricingLibrary: at(0x49),
    settingsColdLibrary: at(0x4a),
    ledgerColdLibrary: at(0x4b),
  });
  // Base has both suites, Arbitrum suite 4 alone, Robinhood none: a table from before a chain's go-live.
  const SHIPPED: SuiteRecords = {
    suite3: BANKR_V4_EARLIER_ADDRESSES,
    suite4: {
      ...BANKR_V4_LAUNCH_ADDRESSES,
      base: row(8453),
      arbitrum: row(42161),
      robinhood: null,
    },
  };
  const detailOf = (fn: () => unknown) =>
    (expectSync(fn, "PROVIDER_NOT_DEPLOYED") as { detail?: string }).detail;

  test("a client that names nothing is on the chain's latest contracts, on every chain", () => {
    expect(DEFAULT_SUITE).toBe(4);
    for (const chain of sdk.LAUNCH_CHAINS) {
      const record = BANKR_V4_LAUNCH_ADDRESSES[chain];
      if (record === null) throw new Error(`${chain} has no record`);
      // Arc has no usable public RPC, so every client names one.
      const c = createLaunchClient({ chain, rpcUrl: "http://127.0.0.1:1" });
      expect(c.provider.addresses, chain).toEqual(record);
      expect(c.provider.addresses.settings).toBe(record.settings);
      expect(Object.keys(c.contracts()).sort()).toEqual([
        "coinTerms",
        "holderLegs",
        "launchpads",
        "owner",
        "settings",
      ]);
    }
  });

  test("the default follows the latest contracts' table alone: suite 3's record moves no client that names none", () => {
    expect(chooseSuite("base", {}, SHIPPED)).toEqual({
      suite: 4,
      addresses: row(8453),
    });
    expect(chooseSuite("arbitrum", {}, SHIPPED)).toEqual({
      suite: 4,
      addresses: row(42161),
    });
    expect(chooseSuite("robinhood", {}, SHIPPED)).toEqual({
      suite: 4,
      addresses: {},
    });
  });

  test("an override is merged over the latest record, and stands alone where the chain has none or it names another factory", () => {
    const hook = at(0x77);
    expect(chooseSuite("base", { addresses: { hook } }, SHIPPED)).toEqual({
      suite: 4,
      addresses: { ...row(8453), hook },
    });
    // Another factory's contracts are its own, all of them: nothing of the shipped record is left beside it.
    const other = { factory: at(0x5f), settings: at(0x99), hook };
    expect(chooseSuite("base", { addresses: other }, SHIPPED)).toEqual({
      suite: 4,
      addresses: other,
    });
    expect(
      chooseSuite("base", { suite: 3, addresses: { factory: at(0x5f) } }),
    ).toEqual({ suite: 3, addresses: { factory: at(0x5f) } });
    const own = { ...row(8453), settings: at(0x99) };
    expect(chooseSuite("base", { addresses: own }, SHIPPED)).toEqual({
      suite: 4,
      addresses: own,
    });
    expect(
      chooseSuite("robinhood", { addresses: { settings: at(0x99) } }, SHIPPED),
    ).toEqual({ suite: 4, addresses: { settings: at(0x99) } });
  });

  test("an override that brings its own factory is a whole record by itself: nothing shipped is left beside it", () => {
    const shipped = BANKR_V4_LAUNCH_ADDRESSES.base!;
    // A whole record of the earlier contracts, passed without saying so, is refused and told how to say so.
    for (const addresses of [SUITE, { factory: SUITE.factory }]) {
      const detail = detailOf(() =>
        createLaunchClient({ chain: "base", addresses }),
      );
      expect(detail).toContain("addresses.settings");
      expect(detail).toContain("`suite: 3`");
    }
    // Its factory and settings alone are not a record: the ledger, hook and registry would be the shipped ones.
    const partial = detailOf(() =>
      createLaunchClient({
        chain: "base",
        addresses: { factory: SUITE.factory, settings: at(0x45) },
      }),
    );
    expect(partial).toContain("addresses.ledger");
    expect(partial).toContain("addresses.hook");
    // The record's own factory, or a pointer beside it, moves nothing.
    const hook = at(0x77);
    const c = createLaunchClient({
      chain: "base",
      addresses: { factory: shipped.factory, hook },
    });
    expect(c.provider.addresses).toEqual({ ...shipped, hook });
    // A fork's record that names its settings contract is taken as it is, the shipped terms lens not added.
    const fork = { ...SUITE, settings: at(0x45) };
    expect(
      createLaunchClient({ chain: "base", addresses: fork }).provider.addresses,
    ).toEqual(fork);
    expect(
      detailOf(() =>
        createLaunchClient({
          chain: "robinhood",
          addresses: { factory: SUITE.factory },
        }),
      ),
    ).toContain("addresses.settings");
  });

  test("suite 3, the test deployment before, is reached only by name, on Base alone", () => {
    expect(chooseSuite("base", { suite: 3 }, SHIPPED)).toEqual({
      suite: 3,
      addresses: { ...BANKR_V4_EARLIER_ADDRESSES.base },
    });
    // A whole suite 3 fork record takes no settings contract from the shipped row.
    const fork = chooseSuite("base", { suite: 3, addresses: SUITE }, SHIPPED);
    expect(fork).toEqual({ suite: 3, addresses: { ...SUITE } });
    expect(fork.addresses.settings).toBeUndefined();
    const c = createLaunchClient({ chain: "base", suite: 3 });
    expect(c.provider.addresses).toEqual(BANKR_V4_EARLIER_ADDRESSES.base!);
    expectSync(() => c.contracts(), "PROVIDER_NOT_DEPLOYED");
    for (const chain of sdk.LAUNCH_CHAINS) {
      if (BANKR_V4_EARLIER_ADDRESSES[chain] !== null) continue;
      expect(detailOf(() => createLaunchClient({ chain, suite: 3 }))).toContain(
        "drop `suite: 3`",
      );
    }
  });

  test("suite 3 with a settings contract is refused, not read as suite 4", () => {
    const detail = (
      expectSync(
        () =>
          createLaunchClient({
            chain: "base",
            suite: 3,
            addresses: { ...SUITE, settings: at(0x45) },
          }),
        "PROVIDER_NOT_DEPLOYED",
      ) as { detail?: string }
    ).detail;
    expect(detail).toContain("addresses.settings");
  });
});

describe("createLaunchClient", () => {
  test("UNSUPPORTED_CHAIN for a chain outside CHAINS; RPC_REQUIRED on Arc without an RPC", () => {
    expectSync(
      () => createLaunchClient({ chain: "ethereum" as never }),
      "UNSUPPORTED_CHAIN",
    );
    expectSync(
      () =>
        createLaunchClient({
          chain: "arc",
          suite: 3,
          addresses: testSuite(5042),
        }),
      "RPC_REQUIRED",
    );
  });

  test("PROVIDER_NOT_DEPLOYED with an incomplete override, a foreign chain id or another provider", () => {
    for (const chain of sdk.LAUNCH_CHAINS)
      expect(BANKR_V4_EARLIER_ADDRESSES[chain] === null, chain).toBe(
        chain !== "base",
      );
    // Each refusal says what to pass. Every chain has a record, so a client with no addresses is refused nowhere.
    const detail = (fn: () => unknown) =>
      (expectSync(fn, "PROVIDER_NOT_DEPLOYED") as { detail?: string }).detail;
    expect(
      detail(() =>
        createLaunchClient({
          chain: "robinhood",
          addresses: { factory: SUITE.factory, settings: SUITE.factory },
        }),
      ),
    ).toContain("addresses.weth,");
    expect(
      detail(() =>
        createLaunchClient({
          chain: "base",
          suite: 3,
          addresses: testSuite(42161),
        }),
      ),
    ).toContain("42161");
    expectSync(
      () =>
        createLaunchClient({
          chain: "base",
          suite: 3,
          addresses: SUITE,
          provider: "bankr_v3" as never,
        }),
      "PROVIDER_NOT_DEPLOYED",
    );
    const c = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
    });
    expect(c.provider).toMatchObject({
      id: "bankr_v4",
      chain: "base",
      contractsCommit: SUITE.gitCommit,
    });
  });

  test("Base needs no addresses: the client is built on the shipped record", () => {
    const record = BANKR_V4_LAUNCH_ADDRESSES.base!;
    const c = createLaunchClient({ chain: "base" });
    expect(c.provider.addresses).toEqual(record);
    expect(c.provider.contractsCommit).toBe(record.gitCommit);
  });

  test("a publicClient on another chain and an apiKey option are refused", () => {
    const f = fixture();
    const arb = new FakeChain(arbitrum).publicClient();
    expectSync(
      () =>
        createLaunchClient({
          chain: "base",
          suite: 3,
          addresses: SUITE,
          publicClient: arb,
        }),
      "UNSUPPORTED_CHAIN",
    );
    expect(() =>
      createLaunchClient({
        chain: "base",
        suite: 3,
        addresses: SUITE,
        publicClient: f.fake.publicClient(),
        api: { apiKey: "bk_x" } as never,
      }),
    ).toThrow(TypeError);
  });
});

describe("the deployed gate", () => {
  // Robinhood has no record and is not deployed; Base is both (go-live 2026-11-07).
  const RH_SUITE = testSuite(4663);
  const rhFixture = (): SuiteFixture =>
    installSuite(new FakeChain(robinhood), RH_SUITE, {
      [getAddress(CHAINS.robinhood.quotes.WETH.address)]: { decimals: 18 },
      [getAddress(CHAINS.robinhood.quotes.USDG.address)]: { decimals: 6 },
    });
  const RH_INPUT = { ...INPUT, quote: "WETH" } as const;

  test("an override never lifts it: launch methods refuse without fork, reads still work", async () => {
    const f = rhFixture();
    const c = createLaunchClient({
      chain: "robinhood",
      suite: 3,
      addresses: RH_SUITE,
      publicClient: f.fake.publicClient(),
    });
    expect(await c.status()).toEqual({
      deployed: false,
      fork: false,
      paused: false,
      gated: false,
    });
    const refused = await expectCode(c.plan(RH_INPUT), "PROVIDER_NOT_DEPLOYED");
    expect((refused as { detail?: string }).detail).toContain("fork: true");
    const pad = await c.launchpad(1n);
    expect(pad.id).toBe(1n);
  });

  test("fork: true runs the launch methods and status reports it apart from deployed", async () => {
    const f = rhFixture();
    f.set("factory", "launchGated", true);
    const c = createLaunchClient({
      chain: "robinhood",
      suite: 3,
      addresses: RH_SUITE,
      publicClient: f.fake.publicClient(),
      fork: true,
    });
    expect(await c.status()).toEqual({
      deployed: false,
      fork: true,
      paused: false,
      gated: true,
    });
  });

  test("Base is deployed: status says so and the launch methods run without fork", async () => {
    const f = fixture();
    f.set("factory", "paused", true);
    f.set("factory", "launchGated", true);
    const c = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      publicClient: f.fake.publicClient(),
    });
    expect(await c.status()).toEqual({
      deployed: true,
      fork: false,
      paused: true,
      gated: true,
    });
    // Past the deployed gate, the factory's own switches decide.
    await expectCode(c.plan(INPUT), "PAUSED");
    f.set("factory", "paused", false);
    f.set("factory", "launchGated", false);
    const plan = await c.plan(INPUT);
    expect(plan.chain).toBe("base");
  });
});

describe("launchpad()", () => {
  test("Bankr's pad: signed, …ba3, pinned 80 % → 1.75 % over 14 s, creator holder share 0, auto-LP at its floor", async () => {
    const f = fixture();
    const c = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      publicClient: f.fake.publicClient(),
    });
    const pad = await c.launchpad();
    expect(pad.id).toBe(0n);
    expect(pad.signer).not.toBeNull();
    expect(pad.vanity).toEqual({ suffix: 0xba3, nibbles: 3 });
    expect(pad.defaults.economics.buy).toEqual({
      startPips: 800_000,
      steadyPips: 17_500,
      decaySecs: 14,
    });
    expect(pad.defaults.economics.holdersBps).toBe(0);
    expect(pad.defaults.economics.autoLpBps).toBe(3_000);
    expect(pad.defaults.holderShareBps).toBe(0);
    expect(pad.defaults.vestBps).toBe(1_500);
    // FD-24 at the 1.75 % preset: holders 0.0875 %, the creator's own take 0.665 % of volume.
    expect(pad.volumeSplit.holdersBnkrPips).toBe(875);
    expect(pad.volumeSplit.creatorPips).toBeCloseTo(6_650, 0);
    await expectCode(c.launchpad(9n), "UNKNOWN_LAUNCHPAD");
  });

  test("an open pad: no signer, no vanity, the operator's payee and its share", async () => {
    const c = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      publicClient: fixture().fake.publicClient(),
    });
    const pad = await c.launchpad(1n);
    expect(pad.signer).toBeNull();
    expect(pad.vanity).toBeNull();
    expect(pad.maxOperatorShareBps).toBe(1_000);
    expect(pad.volumeSplit.payees).toHaveLength(1);
  });
});

describe("plans from elsewhere", () => {
  test("a plan aimed at another factory, approving another spender, or carrying stray value is refused", async () => {
    const f = fixture();
    const c = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      publicClient: f.fake.publicClient(),
      fork: true,
    });
    const plan = await c.plan({
      ...INPUT,
      quote: "USDC",
      devBuy: { amount: 1_000_000n },
    });
    expect(c.buildLaunchTx(plan).to).toBe(SUITE.factory);
    expectSync(
      () => c.buildLaunchTx({ ...plan, factory: OTHER }),
      "INVALID_PARAMS",
    );
    expectSync(
      () =>
        c.buildLaunchTx({
          ...plan,
          approvals: [{ ...plan.approvals[0]!, to: WETH }],
        }),
      "INVALID_PARAMS",
    );
    expectSync(() => c.buildLaunchTx({ ...plan, value: 1n }), "INVALID_PARAMS");
    await expectCode(c.simulate({ ...plan, factory: OTHER }), "INVALID_PARAMS");
  });
});

describe("launch", () => {
  function launchClient(
    f: SuiteFixture,
    codes?: string[],
  ): LaunchClient<"base"> {
    f.fake.onSend = (tx) => launchLogs(f, tx);
    return createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      fork: true,
      publicClient: f.fake.publicClient(),
      walletClient: f.fake.walletClient(LAUNCHER),
      builderCodes: codes,
    });
  }

  /** Runs `before` ahead of the fake factory's `launch`, with its 1-based eth_call index (estimates uncounted). */
  function onLaunch(
    f: SuiteFixture,
    before: (p: LaunchParams, call: number) => void,
  ): void {
    const handler = f.fake.contracts.get(SUITE.factory.toLowerCase())!.fns
      .launch as (a: readonly unknown[], c: unknown) => unknown;
    f.set("factory", "launch", (a: readonly unknown[], c: unknown) => {
      const calls = f.fake
        .callsTo("launch")
        .filter((x) => x.method === "eth_call");
      before(a[0] as LaunchParams, calls.length);
      return handler(a, c);
    });
  }

  const sentSalts = (f: SuiteFixture): Hex[] =>
    f.fake.sent.flatMap((tx) => sentLaunch(f, tx)?.salt ?? []);

  test("WALLET_REQUIRED without a walletClient; LAUNCHER_MISMATCH for another account", async () => {
    const f = fixture();
    await expectCode(
      createLaunchClient({
        chain: "base",
        suite: 3,
        addresses: SUITE,
        fork: true,
        publicClient: f.fake.publicClient(),
      }).launch(INPUT),
      "WALLET_REQUIRED",
    );
    await expectCode(
      launchClient(f).launch({ ...INPUT, launcher: OTHER }),
      "LAUNCHER_MISMATCH",
    );
    expect(f.fake.sent).toEqual([]);
  });

  test("ERC-20 dev buy: approve the factory, simulate without assumptions, send with the suffix, parse", async () => {
    const f = fixture();
    f.fake.setErc20Balance(USDC, LAUNCHER, 5_000_000n);
    const result = await launchClient(f, ["mypad"]).launch({
      ...INPUT,
      quote: "USDC",
      devBuy: { amount: 5_000_000n },
    });
    expect(f.fake.sent).toHaveLength(2);
    const [approve, launch] = f.fake.sent;
    expect(approve!.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(launch!.to.toLowerCase()).toBe(SUITE.factory.toLowerCase());
    expect(launch!.value).toBe(0n);
    expect(launch!.gas).toBe((f.fake.gas * 12n) / 10n + 960_000n);
    expect(
      launch!.data.endsWith(encodeBuilderCodeSuffix(["mypad"]).slice(2)),
    ).toBe(true);
    const sims = f.fake
      .callsTo("launch")
      .filter((c) => c.method === "eth_call");
    expect(sims.at(-1)!.call.stateOverride).toBeUndefined();
    expect(result.chain).toBe("base");
    expect(result.launcher).toBe(LAUNCHER);
    expect(result.launchpadId).toBe(1n);
    expect(result.quote).toBe(USDC);
    expect(result.devBuyOut).toBe(5_000_000n * FAKE_TOKENS_PER_UNIT);
    expect(result.distributor).toBe(fakeDistributor(result.token));
    expect(result.escrow).toBeNull();
  });

  test("a launch with its own bands: the receipt reads back the bands it sent, and they chart as the ranges asked for", async () => {
    const f = fixture();
    setFakeCurveAllowed(f.pads.get(1n)!, ANY_CURVE, true);
    const wad = (bps: number) => BigInt(bps) * 10n ** 14n;
    const asked = [
      { marketCap: { start: 10_000, end: 20_000 }, shares: wad(304) },
      { marketCap: { start: 20_000, end: 1.2e9 }, shares: wad(9_658) },
      { marketCap: { start: 1.2e9, end: "max" as const }, shares: wad(38) },
    ];
    const result = await launchClient(f).launch({
      ...INPUT,
      curve: { marketCaps: asked },
    });
    // $10K sits 60.4 ticks above the launch's start tick, so $1.2B's grid line is 117,000 ticks up, not 116,800.
    const bands = [
      { widthTicks: 6_800, shareBps: 304 },
      { widthTicks: 110_200, shareBps: 9_658 },
      { widthTicks: 0, shareBps: 38 },
    ];
    expect(sentLaunch(f, f.fake.sent[0]!)!.curveId).toBe(encodeCurve(bands)!);
    expect(result.curve.curveId).toBeNull();
    expect(result.curve.curveTable).toBe(curveWordHex(encodeCurve(bands)!));
    expect(result.curve.startTick).toBe(result.startTick);
    expect(
      result.curve.bands.map(({ widthTicks, shareBps }) => ({
        widthTicks,
        shareBps,
      })),
    ).toEqual(bands);
    // Charted from the pool's own start: the fake factory prices $125M at its highest start tick.
    const startMarketCap =
      125_000_000 * 1.0001 ** (result.startTick - START_TICK_BOUNDS[1]);
    expect(Math.round(startMarketCap)).toBe(9_940);
    const ranges = curveMarketCaps({
      bands: result.curve.bands,
      startMarketCap,
    });
    ranges.forEach((r, n) => {
      const end = asked[n]!.marketCap.end;
      expect(r.shares).toBe(asked[n]!.shares);
      if (end === "max") return expect(r.marketCap.end).toBe("max");
      // On the pool each band ends at or under the market cap asked for, by less than one spacing.
      expect(r.marketCap.end as number).toBeLessThanOrEqual(end);
      expect((r.marketCap.end as number) * 1.0001 ** 200).toBeGreaterThan(end);
    });
  });

  test("a reverted approval stops the launch: TRANSACTION_REVERTED with its hash", async () => {
    const f = fixture();
    const c = launchClient(f);
    f.fake.setErc20Balance(USDC, LAUNCHER, 5_000_000n);
    f.fake.onSend = (tx) =>
      tx.to.toLowerCase() === USDC.toLowerCase()
        ? { logs: [], status: "0x0" }
        : launchLogs(f, tx);
    const err = await expectCode(
      c.launch({ ...INPUT, quote: "USDC", devBuy: { amount: 5_000_000n } }),
      "TRANSACTION_REVERTED",
    );
    expect(isLaunchSdkError(err) && err.transactionHash).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(f.fake.sent).toHaveLength(1);
  });

  test("re-plans once when the start tick leaves the factory's bounds between plan and send", async () => {
    const f = fixture();
    const c = launchClient(f);
    let moved = false;
    onLaunch(f, (_p, call) => {
      if (!moved && call === 2) {
        moved = true;
        throw new Revert("StartTickOutOfBounds", [-1, 1]);
      }
    });
    await c.launch(INPUT);
    expect(moved).toBe(true);
    expect(f.fake.sent).toHaveLength(1);
  });

  test("re-salts once when the predicted token is taken before sending", async () => {
    const f = fixture();
    const c = launchClient(f);
    let firstSalt: Hex | undefined;
    onLaunch(f, (p, call) => {
      firstSalt ??= p.salt;
      if (call === 2) throw new Revert("TokenSaltTaken");
    });
    const result = await c.launch(INPUT);
    expect(f.fake.sent).toHaveLength(1);
    expect(sentSalts(f)).toHaveLength(1);
    expect(sentSalts(f)[0]).not.toBe(firstSalt!);
    expect(result.token).toBeDefined();
  });

  test("a caller's salt is never re-drawn: a token taken before sending is POOL_ALREADY_INITIALIZED", async () => {
    const f = fixture();
    const c = launchClient(f);
    const planned = await c.plan(INPUT);
    onLaunch(f, (_p, call) => {
      if (call >= 3) throw new Revert("TokenSaltTaken");
    });
    await expectCode(
      c.launch({ ...INPUT, salt: planned.params.salt }),
      "POOL_ALREADY_INITIALIZED",
    );
    expect(f.fake.sent).toEqual([]);
  });

  test("a launch griefed after broadcast is replayed at its block, then relaunched with a fresh salt", async () => {
    const f = fixture();
    const c = launchClient(f);
    const taken = new Set<Hex>();
    onLaunch(f, (p) => {
      if (taken.has(p.salt)) throw new Revert("TokenSaltTaken");
    });
    let launches = 0;
    f.fake.onSend = (tx) => {
      const p = sentLaunch(f, tx);
      if (p && ++launches === 1) {
        taken.add(p.salt);
        return { logs: [], status: "0x0" };
      }
      return launchLogs(f, tx);
    };
    await c.launch(INPUT);
    const salts = sentSalts(f);
    expect(salts).toHaveLength(2);
    expect(salts[0]).not.toBe(salts[1]!);
    const replay = f.fake
      .callsTo("launch")
      .find((c) => c.method === "eth_call" && c.call.block === "0x64");
    expect(replay?.args[0]).toMatchObject({ salt: salts[0] });
  });

  test("a mined revert with no SDK code is TRANSACTION_REVERTED, naming the revert on its cause", async () => {
    const f = fixture();
    const c = launchClient(f);
    let mined = false;
    onLaunch(f, () => {
      if (mined) throw new Revert("Expired");
    });
    f.fake.onSend = () => {
      mined = true;
      return { logs: [], status: "0x0" };
    };
    const err = await expectCode(c.launch(INPUT), "TRANSACTION_REVERTED");
    expect(sdk.launchRevertName((err as Error).cause)).toBe("Expired");
    expect(f.fake.sent).toHaveLength(1);
  });

  test("a pad's terms changed between plan and send: LAUNCHPAD_TERMS_CHANGED, never re-planned", async () => {
    const f = fixture();
    const c = launchClient(f);
    onLaunch(f, (_p, call) => {
      if (call >= 2) throw new Revert("OperatorPayeesMismatch");
    });
    await expectCode(c.launch(INPUT), "LAUNCHPAD_TERMS_CHANGED");
    expect(f.fake.sent).toEqual([]);
  });
});

describe("parseLaunchReceipt", () => {
  test("reads TokenLaunched and LaunchResolved from this chain's factory only", async () => {
    const f = fixture();
    const c = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      publicClient: f.fake.publicClient(),
      fork: true,
    });
    const plan = await c.plan({ ...INPUT, vesting: { bps: 1_000 } });
    const tx = {
      from: LAUNCHER,
      to: SUITE.factory,
      data: c.buildLaunchTx(plan).data,
      value: 0n,
      gas: undefined,
    };
    const { logs } = launchLogs(f, tx);
    const receipt = {
      transactionHash: `0x${"aa".repeat(32)}`,
      blockNumber: 9n,
      logs: logs.map((l, i) => ({ ...l, logIndex: i, removed: false })),
    };
    const r = c.parseLaunchReceipt(receipt as never, plan.predictedToken);
    expect(r).toMatchObject({
      token: plan.predictedToken,
      poolId: plan.poolId,
      launcher: LAUNCHER,
      launchpadId: 1n,
      vestBps: 1_000,
      escrow: plan.escrow,
      distributor: plan.distributor,
    });
    const foreign = {
      ...receipt,
      logs: logs.map((l, i) => ({
        ...l,
        address: OTHER,
        logIndex: i,
        removed: false,
      })),
    };
    expectSync(
      () => c.parseLaunchReceipt(foreign as never),
      "RECEIPT_MISSING_LAUNCH",
    );
  });
});

describe("public surface", () => {
  // Which contract set a client is on is the SDK's business: a caller types no name that says so.
  test("no export, client method or plan field a caller types carries the word suite", () => {
    expect(Object.keys(sdk).filter((k) => /suite/i.test(k))).toEqual([]);
    const client = createLaunchClient({ chain: "base" });
    const reach = [
      ...Object.keys(client),
      ...Object.keys(client.contracts()),
      ...Object.keys(client.contracts().settings),
    ];
    expect(reach.filter((k) => /suite/i.test(k))).toEqual([]);
    expect(reach).toEqual(
      expect.arrayContaining(["contracts", "settings", "levers"]),
    );
  });

  test("the launchpad registry's exported ABI is the latest contracts'", () => {
    const names: string[] = sdk.bankrLaunchpadRegistryAbi.flatMap((e) =>
      e.type === "function" ? [e.name] : [],
    );
    expect(names).toContain("operatorOf");
    expect(names).not.toContain("setFeeBounds");
  });

  test("no B20, Launch v3 or keeper export survives", () => {
    const names = Object.keys(sdk);
    for (const gone of [
      "B20_FACTORY_ADDRESS",
      "BANKR_V3_ADDRESSES",
      "BANKR_V3_CHAIN_ADAPTERS",
      "predictB20Address",
      "B20_HARD_FORKS",
      "readB20Active",
    ]) {
      expect(names, gone).not.toContain(gone);
    }
    for (const kept of [
      "createLaunchClient",
      "BANKR_V4_EARLIER_ADDRESSES",
      "holderShareToHoldersBps",
      "remoteAuthorizer",
      "mineVanitySalt",
      "readEarlierLivePointers",
      "bankrLaunchpadRegistryAbi",
      "percentToPips",
      "pipsToPercent",
      "percentToBps",
      "bpsToPercent",
      "encodeCurve",
      "decodeCurve",
      "checkCurve",
      "curveFromMarketCaps",
      "curveMarketCaps",
      "buildSetCurveAllowed",
    ]) {
      expect(names, kept).toContain(kept);
    }
  });
});
