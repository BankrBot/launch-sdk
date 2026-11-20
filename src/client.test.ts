import { describe, expect, test } from "bun:test";
import { getAddress, type Abi, type Address, type Hex } from "viem";
import { arbitrum, base, robinhood } from "viem/chains";
import { BANKR_V4_LAUNCH_ADDRESSES, mergeAddresses } from "./addresses.js";
import { bankrLaunchFactoryAbi } from "./abis/generated.js";
import type { FetchLike, RegisterResult } from "./api.js";
import { CHAINS } from "./chains/index.js";
import {
  createLaunchClient,
  type LaunchApiOptions,
  type LaunchClient,
} from "./client.js";
import { curveWordHex, encodeCurve } from "./curve.js";
import { curveMarketCaps } from "./curveMarketCaps.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import * as sdk from "./index.js";
import type { LaunchInput, LaunchParams } from "./providers/types.js";
import { launchPinsOf } from "./launch/options.js";
import { KNOB } from "./launch/settings.js";
import { encodeBuilderCodeSuffix } from "./tx.js";
import { FakeChain, Revert } from "./__internal__/fakeRpc.js";
import { fakeDistributor, testRecord } from "./__internal__/fakeRecord.js";
import {
  FAKE_TOKENS_PER_UNIT,
  installContracts,
  type ContractsFixture,
} from "./__internal__/fakeContracts.js";
import { launchLogs, sentLaunch } from "./__internal__/fakeLaunchReceipt.js";
import {
  FRESH_PAD_ID,
  freshContractsState,
} from "./__internal__/fakeContractsState.js";

const USDC = getAddress(CHAINS.base.quotes.USDC.address);
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");

/** Fake contracts on Base with one open launchpad, pairing with the fixture's WETH (a native dev buy). */
const fixture = (): ContractsFixture => installContracts(new FakeChain(base));

/** The same with USDC as the quote, an ERC-20 the factory pulls a dev buy of; the pad takes a dev buy of 2 %. */
function usdcFixture(): ContractsFixture {
  const state = freshContractsState();
  // A dollar a unit, six decimals, and compound amounts of $50 and $100 in its own units.
  state.quote = {
    ...state.quote,
    terms: {
      ...state.quote.terms,
      decimals: 6,
      compoundFloor: 50_000_000n,
      compoundCap: 100_000_000n,
      quoteActivation: 1_000_000n,
    },
    feedPriceUsdE18: 10n ** 18n,
    totalSupply: 10n ** 15n,
  };
  const ranges = [...state.pad!.ranges];
  ranges[KNOB.devBuyMaxBps] = { min: 0n, max: 200n, dflt: 200n };
  state.pad = { ...state.pad!, ranges };
  return installContracts(new FakeChain(base), {
    state,
    padId: FRESH_PAD_ID,
    quote: USDC,
    weth: getAddress(CHAINS.base.quotes.WETH.address),
  });
}

const input = (
  f: ContractsFixture,
  o: Partial<LaunchInput<"base">> = {},
): LaunchInput<"base"> => ({
  name: "Launch SDK Test",
  symbol: "LSDK",
  metadataUri: "ipfs://bafy-test",
  launcher: LAUNCHER,
  launchpadId: f.padId,
  quote: f.quote,
  ...o,
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
  const detailOf = (fn: () => unknown) =>
    (expectSync(fn, "PROVIDER_NOT_DEPLOYED") as { detail?: string }).detail;

  test("a client is on the chain's one record, on every chain", () => {
    for (const chain of sdk.LAUNCH_CHAINS) {
      const record = BANKR_V4_LAUNCH_ADDRESSES[chain];
      // Arc has no usable public RPC, so every client names one.
      const c = createLaunchClient({ chain, rpcUrl: "http://127.0.0.1:1" });
      expect(c.provider.addresses, chain).toEqual(record);
      expect(Object.keys(c.contracts()).sort()).toEqual([
        "coinTerms",
        "holderLegs",
        "launchpads",
        "owner",
        "settings",
      ]);
    }
  });

  test("the SDK knows one contract set per chain: no option, export or record names another", () => {
    const client = createLaunchClient({ chain: "base" });
    for (const gone of ["launchpad", "launchpads", "quotes"])
      expect(gone in client, gone).toBe(false);
    for (const gone of [
      "BANKR_V4_EARLIER_ADDRESSES",
      "DEFAULT_SUITE",
      "hasSettingsContract",
      "readEarlierLivePointers",
      "EARLIER_HOLDER_LEG_WAKE_ABI",
    ])
      expect(gone in sdk, gone).toBe(false);
    // A record names its settings contract, always: there is no record without one.
    for (const chain of sdk.LAUNCH_CHAINS)
      expect(BANKR_V4_LAUNCH_ADDRESSES[chain].settings, chain).toMatch(
        /^0x[0-9a-fA-F]{40}$/,
      );
  });

  test("an override is merged over the chain's record, and stands alone where it names another factory", () => {
    const shipped = BANKR_V4_LAUNCH_ADDRESSES.base;
    expect(mergeAddresses("base", undefined)).toEqual(shipped);
    const hook = at(0x77);
    expect(mergeAddresses("base", { hook })).toEqual({ ...shipped, hook });
    // Another factory's contracts are its own, all of them: nothing of the shipped record is left beside it.
    const other = { factory: at(0x5f), settings: at(0x99), hook };
    expect(mergeAddresses("base", other)).toEqual(other);
    const own = { ...shipped, settings: at(0x99) };
    expect(mergeAddresses("base", own)).toEqual(own);
  });

  test("an override that brings its own factory is a whole record by itself: nothing shipped is left beside it", () => {
    const shipped = BANKR_V4_LAUNCH_ADDRESSES.base;
    const fork = testRecord(8453);
    // Its factory and settings alone are not a record: the ledger, hook and registry would be the shipped ones.
    const partial = detailOf(() =>
      createLaunchClient({
        chain: "base",
        addresses: { factory: fork.factory, settings: at(0x45) },
      }),
    );
    expect(partial).toContain("addresses.ledger");
    expect(partial).toContain("addresses.hook");
    // A record that names no settings contract is no record: every one has it.
    const { settings: _, ...withoutSettings } = fork;
    expect(
      detailOf(() =>
        createLaunchClient({ chain: "base", addresses: withoutSettings }),
      ),
    ).toContain("addresses.settings");
    // The record's own factory, or a pointer beside it, moves nothing.
    const hook = at(0x77);
    const c = createLaunchClient({
      chain: "base",
      addresses: { factory: shipped.factory, hook },
    });
    expect(c.provider.addresses).toEqual({ ...shipped, hook });
    // A fork's whole record is taken as it is.
    expect(
      createLaunchClient({ chain: "base", addresses: fork }).provider.addresses,
    ).toEqual(fork);
  });
});

describe("createLaunchClient", () => {
  test("UNSUPPORTED_CHAIN for a chain outside CHAINS; RPC_REQUIRED on Arc without an RPC", () => {
    expectSync(
      () => createLaunchClient({ chain: "solana" as never }),
      "UNSUPPORTED_CHAIN",
    );
    expectSync(() => createLaunchClient({ chain: "arc" }), "RPC_REQUIRED");
  });

  test("PROVIDER_NOT_DEPLOYED with an incomplete override, a foreign chain id or another provider", () => {
    const fork = testRecord(8453);
    // Each refusal says what to pass. Every chain has a record, so a client with no addresses is refused nowhere.
    const detail = (fn: () => unknown) =>
      (expectSync(fn, "PROVIDER_NOT_DEPLOYED") as { detail?: string }).detail;
    expect(
      detail(() =>
        createLaunchClient({
          chain: "robinhood",
          addresses: { factory: fork.factory, settings: fork.factory },
        }),
      ),
    ).toContain("addresses.weth,");
    expect(
      detail(() =>
        createLaunchClient({ chain: "base", addresses: testRecord(42161) }),
      ),
    ).toContain("42161");
    expectSync(
      () =>
        createLaunchClient({
          chain: "base",
          addresses: fork,
          provider: "bankr_v3" as never,
        }),
      "PROVIDER_NOT_DEPLOYED",
    );
    const c = createLaunchClient({ chain: "base", addresses: fork });
    expect(c.provider).toMatchObject({
      id: "bankr_v4",
      chain: "base",
      contractsCommit: fork.gitCommit,
    });
  });

  test("Base needs no addresses: the client is built on the shipped record", () => {
    const record = BANKR_V4_LAUNCH_ADDRESSES.base;
    const c = createLaunchClient({ chain: "base" });
    expect(c.provider.addresses).toEqual(record);
    expect(c.provider.contractsCommit).toBe(record.gitCommit);
  });

  test("a publicClient on another chain is refused", () => {
    const f = fixture();
    const arb = new FakeChain(arbitrum).publicClient();
    expectSync(
      () =>
        createLaunchClient({
          chain: "base",
          addresses: f.deployment,
          publicClient: arb,
        }),
      "UNSUPPORTED_CHAIN",
    );
  });
});

describe("the deployed gate: a chain is live by its record alone", () => {
  test("a fork's own record never lifts it: launch methods refuse without fork, reads still work", async () => {
    const f = installContracts(new FakeChain(robinhood));
    const c = createLaunchClient({
      chain: "robinhood",
      addresses: f.deployment,
      publicClient: f.fake.publicClient(),
    });
    expect(await c.status()).toEqual({
      deployed: false,
      fork: false,
      paused: false,
      gated: false,
    });
    const refused = await expectCode(
      c.plan({ ...input(f), quote: f.quote }),
      "PROVIDER_NOT_DEPLOYED",
    );
    expect((refused as { detail?: string }).detail).toContain("fork: true");
  });

  test("fork: true runs the launch methods and status reports it apart from deployed", async () => {
    const f = fixture();
    f.fake.contract(f.deployment.factory, bankrLaunchFactoryAbi as Abi, {
      launchGated: true,
    });
    const c = createLaunchClient({
      chain: "base",
      addresses: f.deployment,
      publicClient: f.fake.publicClient(),
      fork: true,
    });
    expect(await c.status()).toEqual({
      deployed: false,
      fork: true,
      paused: false,
      gated: true,
    });
    await expectCode(c.plan(input(f)), "LAUNCHPAD_GATED");
  });

  test("the shipped record is live: status says so and the launch methods run without fork", async () => {
    const record = BANKR_V4_LAUNCH_ADDRESSES.base;
    const fake = new FakeChain(base);
    fake.contract(record.factory, bankrLaunchFactoryAbi as Abi, {
      paused: true,
      launchGated: true,
    });
    const c = createLaunchClient({
      chain: "base",
      publicClient: fake.publicClient(),
    });
    expect(await c.status()).toEqual({
      deployed: true,
      fork: false,
      paused: true,
      gated: true,
    });
    // Past the gate a plan is judged on its own: Bankr's pad, which a launch names by default, is Bankr's to sign.
    await expectCode(
      c.plan({ name: "Coin", symbol: "COIN", launcher: LAUNCHER }),
      "AUTHORIZATION_REQUIRED",
    );
  });
});

describe("plans from elsewhere", () => {
  test("a plan aimed at another factory, approving another spender, or carrying stray value is refused", async () => {
    const f = usdcFixture();
    const c = createLaunchClient({
      chain: "base",
      addresses: f.deployment,
      publicClient: f.fake.publicClient(),
      fork: true,
    });
    const plan = await c.plan(input(f, { devBuy: { amount: 1_000_000n } }));
    expect(plan.quote.devBuy).toBe("erc20");
    expect(plan.approvals).toHaveLength(1);
    expect(c.buildLaunchTx(plan).to).toBe(f.deployment.factory);
    expectSync(
      () => c.buildLaunchTx({ ...plan, factory: OTHER }),
      "INVALID_PARAMS",
    );
    expectSync(
      () =>
        c.buildLaunchTx({
          ...plan,
          approvals: [{ ...plan.approvals[0]!, to: f.deployment.weth }],
        }),
      "INVALID_PARAMS",
    );
    expectSync(() => c.buildLaunchTx({ ...plan, value: 1n }), "INVALID_PARAMS");
    await expectCode(c.simulate({ ...plan, factory: OTHER }), "INVALID_PARAMS");
  });
});

describe("launch", () => {
  function launchClient(
    f: ContractsFixture,
    o: { codes?: string[]; api?: LaunchApiOptions } = {},
  ): LaunchClient<"base"> {
    f.fake.onSend = (tx) => launchLogs(f, tx);
    return createLaunchClient({
      chain: "base",
      addresses: f.deployment,
      fork: true,
      publicClient: f.fake.publicClient(),
      walletClient: f.fake.walletClient(LAUNCHER),
      builderCodes: o.codes,
      api: o.api,
    });
  }

  /** Runs `before` ahead of the fake factory's `launch`, with its 1-based eth_call index (estimates uncounted). */
  function onLaunch(
    f: ContractsFixture,
    before: (p: LaunchParams, call: number) => void,
  ): void {
    const calls = () =>
      f.fake.callsTo("launch").filter((x) => x.method === "eth_call");
    const launch = f.fake.contracts.get(f.deployment.factory.toLowerCase())!.fns
      .launch as (a: readonly unknown[], c: unknown) => unknown;
    f.fake.contracts.get(f.deployment.factory.toLowerCase())!.fns.launch = (
      a: readonly unknown[],
      c: unknown,
    ) => {
      before(a[0] as LaunchParams, calls().length);
      return launch(a, c);
    };
  }

  const sentSalts = (f: ContractsFixture): Hex[] =>
    f.fake.sent.flatMap((tx) => sentLaunch(f, tx)?.salt ?? []);

  test("WALLET_REQUIRED without a walletClient; LAUNCHER_MISMATCH for another account", async () => {
    const f = fixture();
    await expectCode(
      createLaunchClient({
        chain: "base",
        addresses: f.deployment,
        fork: true,
        publicClient: f.fake.publicClient(),
      }).launch(input(f)),
      "WALLET_REQUIRED",
    );
    await expectCode(
      launchClient(f).launch(input(f, { launcher: OTHER })),
      "LAUNCHER_MISMATCH",
    );
    expect(f.fake.sent).toEqual([]);
  });

  test("ERC-20 dev buy: approve the factory, simulate without assumptions, send with the suffix, parse", async () => {
    const f = usdcFixture();
    f.fake.setErc20Balance(USDC, LAUNCHER, 5_000_000n);
    const result = await launchClient(f, { codes: ["mypad"] }).launch(
      input(f, { devBuy: { amount: 5_000_000n } }),
    );
    expect(f.fake.sent).toHaveLength(2);
    const [approve, launch] = f.fake.sent;
    expect(approve!.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(launch!.to.toLowerCase()).toBe(f.deployment.factory.toLowerCase());
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
    expect(result.launchpadId).toBe(f.padId);
    expect(result.quote).toBe(USDC);
    expect(result.devBuyOut).toBe(5_000_000n * FAKE_TOKENS_PER_UNIT);
    expect(result.distributor).toBe(fakeDistributor(result.token));
    expect(result.metadataUri).toBe("ipfs://bafy-test");
    // No `api` on the client: nothing is registered, and the result says nothing of it.
    expect("registration" in result).toBe(false);
  });

  test("a launch with its own bands: the receipt reads back the bands it sent, and they chart as the ranges asked for", async () => {
    const f = fixture();
    f.state.anyTableAllowed = true;
    const wad = (bps: number) => BigInt(bps) * 10n ** 14n;
    // The first range ends under 1.97 times the start, so the next band begins inside the step rule's near window.
    const asked = [
      { marketCap: { start: 10_000, end: 19_000 }, shares: wad(304) },
      { marketCap: { start: 19_000, end: 1.2e9 }, shares: wad(9_658) },
      { marketCap: { start: 1.2e9, end: "max" as const }, shares: wad(38) },
    ];
    const result = await launchClient(f).launch(
      input(f, { curve: { marketCaps: asked } }),
    );
    const sent = sentLaunch(f, f.fake.sent[0]!)!;
    const bands = result.curve.bands.map(({ widthTicks, shareBps }) => ({
      widthTicks,
      shareBps,
    }));
    expect(bands.map((b) => b.shareBps)).toEqual([304, 9_658, 38]);
    expect(bands[0]!.widthTicks).toBeLessThanOrEqual(6_800);
    expect(bands[2]!.widthTicks).toBe(0);
    expect(sent.curveId).toBe(encodeCurve(bands)!);
    expect(result.curve.curveId).toBeNull();
    expect(result.curve.curveTable).toBe(curveWordHex(encodeCurve(bands)!));
    expect(result.curve.startTick).toBe(result.startTick);
    // Charted from the pool's own start: the whole supply at the start tick, at the fake feed's $2,500 a quote.
    const startMarketCap =
      Number(result.totalSupply / 10n ** 18n) *
      1.0001 ** result.startTick *
      2_500;
    expect(startMarketCap).toBeGreaterThan(9_800);
    expect(startMarketCap).toBeLessThanOrEqual(10_000);
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
    const f = usdcFixture();
    const c = launchClient(f);
    f.fake.setErc20Balance(USDC, LAUNCHER, 5_000_000n);
    f.fake.onSend = (tx) =>
      tx.to.toLowerCase() === USDC.toLowerCase()
        ? { logs: [], status: "0x0" }
        : launchLogs(f, tx);
    const err = await expectCode(
      c.launch(input(f, { devBuy: { amount: 5_000_000n } })),
      "TRANSACTION_REVERTED",
    );
    expect(isLaunchSdkError(err) && err.transactionHash).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(f.fake.sent).toHaveLength(1);
  });

  test("re-plans once when the start tick leaves the launchpad's window between plan and send", async () => {
    const f = fixture();
    const c = launchClient(f);
    let moved = false;
    onLaunch(f, (_p, call) => {
      if (!moved && call === 2) {
        moved = true;
        throw new Revert("StartTickOutOfBounds", [-1, 1]);
      }
    });
    await c.launch(input(f));
    expect(moved).toBe(true);
    expect(f.fake.sent).toHaveLength(1);
  });

  test("re-plans once when the terms move between plan and send, and the retry carries its own pins", async () => {
    const f = fixture();
    const c = launchClient(f);
    const first = launchPinsOf((await c.plan(input(f))).params.options);
    let moved = false;
    onLaunch(f, (p, call) => {
      if (!moved && launchPinsOf(p.options).expectedToken && call >= 2) {
        moved = true;
        throw new Revert("TermsChanged", [`0x${"11".repeat(32)}`]);
      }
    });
    await c.launch(input(f));
    expect(moved).toBe(true);
    expect(f.fake.sent).toHaveLength(1);
    const sent = launchPinsOf(sentLaunch(f, f.fake.sent[0]!)!.options);
    expect(sent.expectedTermsHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.expectedToken).not.toBeNull();
    expect(sent.expectedToken).not.toBe(first.expectedToken);
  });

  test("re-salts once when the predicted token is taken before sending", async () => {
    const f = fixture();
    const c = launchClient(f);
    let firstSalt: Hex | undefined;
    onLaunch(f, (p, call) => {
      firstSalt ??= p.salt;
      if (call === 2) throw new Revert("TokenSaltTaken");
    });
    const result = await c.launch(input(f));
    expect(f.fake.sent).toHaveLength(1);
    expect(sentSalts(f)).toHaveLength(1);
    expect(sentSalts(f)[0]).not.toBe(firstSalt!);
    expect(result.token).toBeDefined();
  });

  test("a caller's salt is never re-drawn: a token taken before sending is POOL_ALREADY_INITIALIZED", async () => {
    const f = fixture();
    const c = launchClient(f);
    const planned = await c.plan(input(f));
    onLaunch(f, (_p, call) => {
      if (call >= 3) throw new Revert("TokenSaltTaken");
    });
    await expectCode(
      c.launch(input(f, { salt: planned.params.salt })),
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
    await c.launch(input(f));
    const salts = sentSalts(f);
    expect(salts).toHaveLength(2);
    expect(salts[0]).not.toBe(salts[1]!);
    const replay = f.fake
      .callsTo("launch")
      .find((c) => c.method === "eth_call" && c.call.block === "0x64");
    expect(replay?.args[0]).toMatchObject({ salt: salts[0] });
  });

  test("a mined revert with no code of its own keeps the revert's sentence and the transaction's hash", async () => {
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
    const err = await expectCode(c.launch(input(f)), "TRANSACTION_REVERTED");
    expect(sdk.launchRevertName((err as Error).cause)).toBe("Expired");
    expect(isLaunchSdkError(err) && err.transactionHash).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(f.fake.sent).toHaveLength(1);
  });

  test("a pad's payees changed between plan and send: LAUNCHPAD_TERMS_CHANGED, never re-planned", async () => {
    const f = fixture();
    const c = launchClient(f);
    onLaunch(f, (_p, call) => {
      if (call >= 2) throw new Revert("OperatorPayeesMismatch");
    });
    await expectCode(c.launch(input(f)), "LAUNCHPAD_TERMS_CHANGED");
    expect(f.fake.sent).toEqual([]);
  });

  describe("with `api`: the launch is registered with Bankr's index", () => {
    const REGISTERED: RegisterResult = {
      chain: "base",
      txHash: `0x${"00".repeat(32)}`,
      confirmations: 5,
      launches: [],
    };

    /** Bankr's API: records each call and answers the index's routes. */
    function fakeApi(register?: () => Response) {
      const calls: { url: URL; body: unknown }[] = [];
      const fetch: FetchLike = async (url, init) => {
        const u = new URL(url);
        calls.push({
          url: u,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (u.pathname === "/launches/register")
          return register?.() ?? Response.json(REGISTERED);
        if (u.pathname === "/launches")
          return Response.json({ launches: [], nextCursor: null });
        return Response.json({ error: "Not found." }, { status: 404 });
      };
      return { fetch, calls };
    }

    const API_URL = "https://api.example";

    test("sends, waits for 5 confirmations and registers the launch", async () => {
      const f = fixture();
      const api = fakeApi();
      const c = launchClient(f, { api: { fetch: api.fetch, url: API_URL } });
      f.fake.onSend = (tx) => {
        f.fake.blockNumber += 10n;
        return launchLogs(f, tx);
      };
      const result = await c.launch(input(f));
      expect(f.fake.sent).toHaveLength(1);
      expect(api.calls.map((x) => x.url.pathname)).toEqual([
        "/launches/register",
      ]);
      expect(api.calls[0]!.body).toEqual({
        chain: "base",
        txHash: result.txHash,
      });
      expect(result.registration).toEqual(REGISTERED);
    });

    test("a failed registration never fails the launch: registration is null", async () => {
      const f = fixture();
      const api = fakeApi(() =>
        Response.json({ error: "No.", code: "NOT_A_LAUNCH" }, { status: 422 }),
      );
      const c = launchClient(f, { api: { fetch: api.fetch } });
      f.fake.onSend = (tx) => {
        f.fake.blockNumber += 10n;
        return launchLogs(f, tx);
      };
      const result = await c.launch(input(f));
      expect(result.registration).toBeNull();
    });

    test("the index reads and registers on the client's chain", async () => {
      const f = fixture();
      const api = fakeApi();
      const c = launchClient(f, {
        api: { fetch: api.fetch, url: `${API_URL}/` },
      });
      expect(
        await c.index.launches({ builder: "mypad", launchpad: 3n }),
      ).toEqual({ launches: [], nextCursor: null });
      const token = "0x000000000000000000000000000000000000beef" as Address;
      expect(await c.index.launch(token)).toBeNull();
      expect(Object.fromEntries(api.calls[0]!.url.searchParams)).toEqual({
        builder: "mypad",
        launchpad: "3",
        chain: "base",
      });
      expect(api.calls[1]!.url.pathname).toBe(
        `/launches/base/${getAddress(token)}`,
      );
      await expectCode(c.index.launch("0xnope" as Address), "INVALID_PARAMS");
      // The fake API serves no stats: the call is what this pins.
      await expectCode(
        c.index.launchpadStats(3n, { visibility: "listed" }),
        "API_ERROR",
      );
      expect(api.calls.at(-1)!.url.pathname).toBe("/launchpads/base/3/stats");
      const seen = [];
      for await (const l of c.index.all({ launchpad: 3n })) seen.push(l);
      expect(seen).toEqual([]);
      expect(Object.fromEntries(api.calls.at(-1)!.url.searchParams)).toEqual({
        launchpad: "3",
        chain: "base",
        limit: "100",
      });
    });
  });
});

describe("parseLaunchReceipt", () => {
  test("reads the launch from this chain's factory only", async () => {
    const f = fixture();
    const c = createLaunchClient({
      chain: "base",
      addresses: f.deployment,
      publicClient: f.fake.publicClient(),
      fork: true,
    });
    const plan = await c.plan(input(f, { vesting: { bps: 1_000 } }));
    const tx = {
      from: LAUNCHER,
      to: f.deployment.factory,
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
      launchpadId: f.padId,
      vestBps: 1_000,
      escrow: plan.escrow,
      distributor: plan.distributor,
      totalSupply: plan.resolved.terms.totalSupply,
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
  // Which contracts a client is on is the SDK's business: a caller types no name that says so.
  test("no export, client method or plan field a caller types carries the old contract-set name", () => {
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

  test("the launchpad registry's exported ABI is the chain's", () => {
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
      "BANKR_V4_LAUNCH_ADDRESSES",
      "holderShareToHoldersBps",
      "remoteAuthorizer",
      "mineVanitySalt",
      "readLivePointers",
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
      "padTermsHash",
      "maxOperatorShareBps",
      "extensionAllowlistKey",
    ]) {
      expect(names, kept).toContain(kept);
    }
  });
});
