import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  multicall3Abi,
  pad,
  toHex,
  type Hex,
} from "viem";
import { bankrFeeLedgerAbi } from "../abis/generated.js";
import { bnkrHolderLegAbi } from "../abis/settings.js";
import {
  bankrLaunchTokenAbi,
  creatorVestingEscrowAbi,
  holderRewardsDistributorAbi,
} from "../abis/suite3.js";
import type { FetchLike } from "../api.js";
import { CONVERT_GAS } from "../conversion.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "../errors.js";
import { HOLDER_CLAIM_ALL_GAS } from "../holderClaimAll.js";
import { bucketIds } from "../lens.js";
import { LAUNCHER, OTHER } from "../__internal__/fakeLaunch.js";
import {
  COIN_LEG,
  suite4PostLaunchFixture,
} from "../__internal__/fakeSuite4Launch.js";

// A client that names no suite reads a coin of the latest contracts: the ledger's packed pool terms, the hook
// lens's longer pool record, the token's own link limit and the leg the coin froze at launch.

const WAD = 10n ** 18n;
const FLOOR = 2n * 10n ** 15n;
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return undefined;
}

async function expectCode(p: Promise<unknown>, code: LaunchSdkErrorCode) {
  const thrown = await codeOf(p);
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
}

const ledgerCall = (data: Hex) =>
  decodeFunctionData({ abi: bankrFeeLedgerAbi, data });

describe("launchInfo and tradingStatus on the latest contracts", () => {
  test("launchInfo reads the pool's packed terms, the lens's record and the buckets by role", async () => {
    const { client, s4, launch } = suite4PostLaunchFixture();
    const l = launch({
      launcher: LAUNCHER,
      referrerBps: 250,
      creatorShares: [
        { account: s4.suite.hook, sharesWad: 3n * 10n ** 17n },
        { account: LAUNCHER, sharesWad: 7n * 10n ** 17n },
      ],
      decayShares: [{ account: LAUNCHER, sharesWad: WAD }],
    });
    l.waived = true;
    const info = (await client.launchInfo(l.token))!;
    expect(info).toMatchObject({
      token: l.token,
      poolId: l.poolId,
      quote: s4.quote,
      tokenIsCurrency0: l.tokenIsCurrency0,
      hook: s4.suite.hook,
      launcher: LAUNCHER,
      launchpadId: 1n,
      distributor: l.distributor,
      escrow: null,
      referrerBps: 250,
      waived: true,
      decaySplit: true,
      metadataAdmin: null,
      tradingStart: 1,
      buybackAt: null,
    });
    // The schedule is the three numbers a fee is read by; the pool's compound floor is not part of it.
    expect(info.fees).toEqual({
      buy: { startPips: 17_500, steadyPips: 17_500, decaySecs: 0 },
      sell: { startPips: 17_500, steadyPips: 17_500, decaySecs: 0 },
    });
    expect(info.buckets).toEqual({
      creator: bucketIds.creator(l.poolId),
      decay: bucketIds.decay(l.poolId),
      holders: bucketIds.holders(l.poolId),
      bankr: bucketIds.bankr(s4.quote),
    });
    expect(info.creatorShares.map((s) => [s.role, s.account])).toEqual([
      ["autoLp", s4.suite.hook],
      ["creator", LAUNCHER],
    ]);
    expect(info.feeRecipients).toEqual([
      { recipient: LAUNCHER, shareBps: 10_000 },
    ]);
    expect(info.curve.bands.length).toBeGreaterThan(0);
  });

  test("a coin without a decay split or a waiver reads so; a stranger is null", async () => {
    const { client, launch } = suite4PostLaunchFixture();
    const l = launch({ launcher: LAUNCHER });
    expect(await client.launchInfo(l.token)).toMatchObject({
      waived: false,
      decaySplit: false,
      decayShares: [],
      buckets: { decay: null },
    });
    expect(await client.launchInfo(OTHER)).toBeNull();
  });

  test("tradingStatus holds the token's start to the latest block", async () => {
    const { client, f, launch } = suite4PostLaunchFixture();
    const l = launch({ launcher: LAUNCHER });
    l.setToken("tradingStart", 2_000n);
    f.fake.timestamp = 1_990n;
    expect(await client.tradingStatus(l.token)).toEqual({
      token: l.token,
      startTime: 2_000,
      blockTime: 1_990,
      started: false,
      secondsUntilStart: 10,
    });
    await expectCode(client.tradingStatus(OTHER), "NOT_A_LAUNCH");
  });
});

describe("fees on the latest contracts", () => {
  test("get and buildClaim: the recipient's shares and claimable by side, claimed from the ledger", async () => {
    const { client, s4, launch } = suite4PostLaunchFixture();
    const l = launch({
      launcher: LAUNCHER,
      decayShares: [{ account: LAUNCHER, sharesWad: WAD }],
    });
    const creator = bucketIds.creator(l.poolId);
    const decay = bucketIds.decay(l.poolId);
    const side = (token: bigint, quote: bigint) =>
      l.tokenIsCurrency0
        ? ([token, quote] as const)
        : ([quote, token] as const);
    l.claimable.set(`${creator}:${LAUNCHER.toLowerCase()}`, side(5n, 70n));
    l.claimable.set(`${decay}:${LAUNCHER.toLowerCase()}`, side(0n, 9n));
    const state = await client.fees.get(l.token);
    expect(state).toMatchObject({
      account: LAUNCHER,
      quote: s4.quote,
      claimableToken: 5n,
      claimableQuote: 79n,
      creator: { sharesWad: WAD, role: "creator", claimableQuote: 70n },
      decay: { sharesWad: WAD, claimableQuote: 9n },
    });
    const [tx] = await client.fees.buildClaim(l.token, LAUNCHER);
    expect(tx).toMatchObject({ from: LAUNCHER, to: s4.suite.ledger });
    expect(ledgerCall(tx!.data)).toEqual({
      functionName: "collectFeesMany",
      args: [[creator, decay]],
    });
    await expectCode(
      client.fees.buildClaim(l.token, OTHER),
      "NOT_A_BENEFICIARY",
    );
  });

  test("buildSetFeeRecipient reads the factory's own pointers, which hold no cap controller", async () => {
    const { client, s4, launch } = suite4PostLaunchFixture();
    const l = launch({ launcher: LAUNCHER });
    const tx = await client.fees.buildSetFeeRecipient(l.token, LAUNCHER, OTHER);
    expect(ledgerCall(tx.data)).toEqual({
      functionName: "updateBeneficiary",
      args: [bucketIds.creator(l.poolId), OTHER],
    });
    // A contract of the launch itself could never claim.
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, LAUNCHER, s4.suite.ledger),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, LAUNCHER, l.distributor),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
  });

  test("buildClaimAll asks the settings contract which currencies are listed", async () => {
    const MEME = getAddress(pad("0x3e3e", { size: 20 }));
    const urls: URL[] = [];
    const answer: { body?: unknown } = {};
    const fetch: FetchLike = async (input) => {
      urls.push(new URL(input));
      return new Response(JSON.stringify(answer.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { client, s4, launch } = suite4PostLaunchFixture({
      api: { url: "https://api.test", fetch },
    });
    launch({ launcher: LAUNCHER });
    const bucket = (i: number, quote: string, amount: string) => ({
      bucketId: keccak256(toHex(`bucket-${i}`)),
      poolId: keccak256(toHex(`pool-${i}`)),
      token: getAddress(pad(toHex(0x7000_0000 + i), { size: 20 })),
      quote,
      kind: "creator",
      claimableQuote: amount,
      claimableToken: "0",
      firstTouch: true,
      bothSides: false,
    });
    answer.body = {
      chainId: 8453,
      account: OTHER,
      ledger: s4.suite.ledger,
      balances: [],
      buckets: [bucket(1, s4.quote, "1000"), bucket(2, MEME, "900")],
      totalByQuote: [],
      bucketCount: 2,
    };
    const all = await client.fees.buildClaimAll(OTHER);
    expect(urls[0]!.searchParams.get("ledger")).toBe(s4.suite.ledger);
    // The suite's quote is listed by its settings row; MEME has none and is left for includeUnlisted.
    expect(all.plan.unlisted).toEqual([{ quote: MEME, amount: 900n }]);
    expect(all.txs.map((t) => ledgerCall(t.data).args![1])).toEqual([
      [s4.quote],
    ]);
  });
});

describe("holders on the latest contracts", () => {
  test("get and buildClaim read and pay through the coin's distributor", async () => {
    const { client, s4, launch } = suite4PostLaunchFixture();
    const l = launch({ launcher: LAUNCHER });
    l.balances.set(OTHER.toLowerCase(), 500n);
    l.earned.set(`1:${OTHER.toLowerCase()}`, 7n);
    const state = await client.holders.get(l.token, OTHER);
    expect(state).toMatchObject({
      distributor: l.distributor,
      balance: 500n,
      excluded: false,
      legs: {
        token: { asset: l.token, earned: 0n },
        quote: { asset: s4.quote, earned: 7n },
      },
      pastBnkr: [],
    });
    const tx = await client.holders.buildClaim(l.token, OTHER);
    expect(tx.to).toBe(l.distributor);
    expect(
      decodeFunctionData({ abi: holderRewardsDistributorAbi, data: tx.data })
        .functionName,
    ).toBe("claim");
  });

  test("getConversion reads the pile at the coin's own leg: under its floor it waits, at it the wake and the poke are due", async () => {
    const { client, f, s4, launch, setPile } = suite4PostLaunchFixture();
    f.fake.timestamp = 1_000_000n;
    const l = launch({ launcher: LAUNCHER });
    setPile(l, FLOOR - 1n);
    expect(await client.holders.getConversion(l.token)).toEqual({
      token: l.token,
      poolId: l.poolId,
      quote: s4.quote,
      pile: FLOOR - 1n,
      floor: FLOOR,
      armed: true,
      paused: false,
      converts: true,
      routed: true,
      nextConvertAt: 0,
      staged: 0n,
      forwardsNow: false,
      due: false,
      convertDue: false,
    });
    setPile(l, FLOOR);
    expect(await client.holders.getConversion(l.token)).toMatchObject({
      pile: FLOOR,
      due: true,
      convertDue: true,
    });
    // Every read of the pile went to the coin's leg, none to the one the record names for new launches.
    expect(f.fake.calls.some((c) => c.to === COIN_LEG)).toBe(true);
    expect(f.fake.calls.some((c) => c.to === s4.suite.holderLeg)).toBe(false);
    // The pool's terms are read once a call: the leg's id comes with the launch's record.
    f.fake.calls.length = 0;
    await client.holders.getConversion(l.token);
    expect(f.fake.callsTo("poolTerms")).toHaveLength(1);
  });

  test("getConversion: a spent window waits until it reopens; a staged pile past the leg's stale period forwards", async () => {
    const { client, f, leg, launch, setPile } = suite4PostLaunchFixture();
    f.fake.timestamp = 1_000_000n;
    const l = launch({ launcher: LAUNCHER });
    setPile(l, FLOOR);
    leg.window = [1_000_600, FLOOR - 1n];
    expect(await client.holders.getConversion(l.token)).toMatchObject({
      nextConvertAt: 1_000_600,
      forwardsNow: false,
      due: false,
      convertDue: false,
    });
    // Staged a day ago: the leg forwards it in quote, window or not, and a poke of the staged pile alone is due.
    setPile(l, 0n);
    leg.pending.set(l.poolId, [FLOOR, 1_000_000n - 86_400n]);
    expect(await client.holders.getConversion(l.token)).toMatchObject({
      pile: 0n,
      staged: FLOOR,
      forwardsNow: true,
      due: false,
      convertDue: true,
    });
    await expectCode(client.holders.getConversion(OTHER), "NOT_A_LAUNCH");
  });

  test("buildConvert pokes the coin's own leg at the convert action's gas", async () => {
    const { client, launch } = suite4PostLaunchFixture();
    const l = launch({ launcher: LAUNCHER });
    const tx = await client.holders.buildConvert(l.token, OTHER);
    expect(tx).toMatchObject({ from: OTHER, to: COIN_LEG, gas: CONVERT_GAS });
    expect(
      decodeFunctionData({ abi: bnkrHolderLegAbi, data: tx.data }),
    ).toEqual({ functionName: "poke", args: [l.poolId] });
  });

  test("a pool whose holders' bucket names no leg is not a launch: no pile is read at the record's leg in its place", async () => {
    const { client, f, s4, launch } = suite4PostLaunchFixture();
    const l = launch({ launcher: LAUNCHER });
    l.earned.set(`1:${OTHER.toLowerCase()}`, 7n);
    l.shares.delete(`${bucketIds.holders(l.poolId)}:${COIN_LEG.toLowerCase()}`);
    await expectCode(
      client.holders.buildClaimAll(OTHER, [l.token]),
      "NOT_A_LAUNCH",
    );
    await expectCode(client.holders.getConversion(l.token), "NOT_A_LAUNCH");
    expect(f.fake.calls.some((c) => c.to === s4.suite.holderLeg)).toBe(false);
  });

  test("buildClaimAll claims each coin and pokes a due pile at the coin's own leg", async () => {
    const { client, launch, setPile } = suite4PostLaunchFixture();
    const earning = launch({
      launcher: LAUNCHER,
      salt: keccak256(toHex("earning")),
    });
    const waiting = launch({
      launcher: LAUNCHER,
      salt: keccak256(toHex("waiting")),
    });
    earning.earned.set(`1:${OTHER.toLowerCase()}`, 7n);
    setPile(earning, FLOOR);
    setPile(waiting, FLOOR - 1n);
    const all = await client.holders.buildClaimAll(OTHER, [
      earning.token,
      waiting.token,
    ]);
    expect(all.mode).toBe("multicall");
    expect(all.coins).toEqual([
      {
        token: earning.token,
        distributor: earning.distributor,
        quote: earning.quote,
        poolId: earning.poolId,
        listed: true,
        poke: true,
        earned: { token: 0n, quote: 7n, bnkr: 0n },
      },
    ]);
    const { base, perCoin, perConvertPoke } = HOLDER_CLAIM_ALL_GAS;
    expect(all.txs).toHaveLength(1);
    expect(all.txs[0]).toMatchObject({
      from: OTHER,
      to: MULTICALL3,
      gas: base + perCoin + perConvertPoke,
    });
    const calls = decodeFunctionData({
      abi: multicall3Abi,
      data: all.txs[0]!.data,
    }).args![0] as readonly { target: string }[];
    expect(calls.map((c) => c.target)).toEqual([earning.distributor, COIN_LEG]);
  });
});

describe("vesting and the metadata link on the latest contracts", () => {
  test("vesting reads the escrow's schedules and releases the creator's", async () => {
    const { client, launch } = suite4PostLaunchFixture();
    const l = launch({
      launcher: LAUNCHER,
      schedules: [
        {
          beneficiary: LAUNCHER,
          total: 100n,
          released: 10n,
          cliff: 2_592_000n,
          duration: 31_536_000n,
          push: false,
          available: 30n,
        },
      ],
    });
    const state = await client.vesting.get(l.token);
    expect(state.escrow).toBe(l.escrow);
    expect(state.schedules).toEqual([
      {
        beneficiary: LAUNCHER,
        role: "creator",
        push: false,
        total: 100n,
        released: 10n,
        cliffSeconds: 2_592_000n,
        durationSeconds: 31_536_000n,
        releasable: 30n,
      },
    ]);
    const tx = await client.vesting.buildRelease(l.token, LAUNCHER);
    expect(tx.to).toBe(l.escrow!);
    expect(
      decodeFunctionData({ abi: creatorVestingEscrowAbi, data: tx.data }),
    ).toEqual({ functionName: "release", args: [0n] });
  });

  test("the metadata link's limit is the coin's own, read from the token", async () => {
    const { client, launch } = suite4PostLaunchFixture();
    const l = launch({ launcher: LAUNCHER, metadataAdmin: LAUNCHER });
    expect(await client.metadataAdmin.get(l.token)).toEqual({
      token: l.token,
      metadataUri: "ipfs://bafy-test",
      admin: LAUNCHER,
      pendingAdmin: null,
    });
    l.setToken("metadataMaxBytes", 64);
    const tx = await client.metadataAdmin.buildSetUri(
      l.token,
      LAUNCHER,
      "x".repeat(64),
    );
    expect(
      decodeFunctionData({ abi: bankrLaunchTokenAbi, data: tx.data }),
    ).toEqual({ functionName: "setMetadataUri", args: ["x".repeat(64)] });
    const refused = await codeOf(
      client.metadataAdmin.buildSetUri(l.token, LAUNCHER, "x".repeat(65)),
    );
    expect(isLaunchSdkError(refused, "INVALID_PARAMS")).toBe(true);
    expect((refused as { detail?: string }).detail).toContain("64 bytes");
    // Something that is no string is refused as that, not as a link too long.
    const typed = (await codeOf(
      client.metadataAdmin.buildSetUri(l.token, LAUNCHER, 7 as never),
    )) as { detail?: string };
    expect(isLaunchSdkError(typed, "INVALID_PARAMS")).toBe(true);
    expect(typed.detail).toContain("string");
    expect(typed.detail).not.toContain("bytes");
    // A coin whose launchpad allowed a longer link than the earlier contracts' 2,048 bytes takes one.
    l.setToken("metadataMaxBytes", 4_096);
    const long = await client.metadataAdmin.buildSetUri(
      l.token,
      LAUNCHER,
      "x".repeat(3_000),
    );
    expect(long.to).toBe(l.token);
  });
});

describe("the calls a default client refuses say what to use, and never name a suite", () => {
  test("launchpad(), quotes() and the old pad builders point at the settings accessor", async () => {
    const { client } = suite4PostLaunchFixture();
    for (const [call, instead] of [
      [client.launchpad(1n), "client.contracts().settings.pad(id)"],
      [client.quotes(), "client.contracts().settings.quotes()"],
      [client.launchpads.setSigner(1n, OTHER), "client.contracts().launchpads"],
    ] as const) {
      const err = (await codeOf(call)) as { detail?: string };
      expect(isLaunchSdkError(err, "PROVIDER_NOT_DEPLOYED")).toBe(true);
      expect(err.detail).toContain(instead);
      expect(err.detail).not.toMatch(/suite/i);
    }
  });

  test("API mode is refused in plain words when the client is built, before anything is planned", async () => {
    const err = (await codeOf(
      Promise.resolve().then(() =>
        suite4PostLaunchFixture({
          fork: true,
          api: {
            url: "https://api.test",
            preparer: async () => {
              throw new Error("never asked");
            },
          },
        }),
      ),
    )) as { detail?: string };
    expect(isLaunchSdkError(err, "PROVIDER_NOT_DEPLOYED")).toBe(true);
    // The index alone (no preparer) still builds: registration works on these contracts.
    expect(
      suite4PostLaunchFixture({ api: { url: "https://api.test" } }).client,
    ).toBeDefined();
    expect(err.detail).toContain("api.preparer");
    expect(err.detail).not.toMatch(/suite|go-live|prepare route/i);
  });

  test("Bankr's own launchpad in pure mode: the refusal says to name another launchpad, not to use the API", async () => {
    const { client } = suite4PostLaunchFixture({ fork: true });
    const err = (await codeOf(
      client.plan({
        launcher: LAUNCHER,
        name: "Coin",
        symbol: "COIN",
        metadataUri: "ipfs://bafy-test",
      }),
    )) as { detail?: string };
    expect(isLaunchSdkError(err, "AUTHORIZATION_REQUIRED")).toBe(true);
    expect(err.detail).toContain("launchpadId");
    expect(err.detail).not.toMatch(/suite/i);
  });
});
