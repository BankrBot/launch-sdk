import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
} from "viem";
import { arc, base } from "viem/chains";
import type { AuthorizationRequest } from "./authorizer.js";
import { CHAINS } from "./chains/index.js";
import { createLaunchClient } from "./client.js";
import {
  ANY_CURVE,
  decodeCurve,
  encodeCurve,
  type CurveBand,
} from "./curve.js";
import { curveRevertDetail } from "./curveDetail.js";
import { curveFromMarketCaps } from "./curveMarketCaps.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { padTermsHash } from "./launchpad.js";
import { poolIdOf } from "./plan.js";
import { HOLDER_LEG_REFERENCES_ABI } from "./recipient.js";
import type { LaunchInput } from "./providers/types.js";
import { launchTermsHash } from "./terms.js";
import { FakeChain, Revert } from "./__internal__/fakeRpc.js";
import {
  FAKE_TOKENS_PER_UNIT,
  PAD_PAYEE,
  START_TICK_BOUNDS,
  fakeAddress,
  fakeDistributor,
  installSuite,
  openPad,
  setFakeCurveAllowed,
  testSuite,
  type SuiteFixture,
} from "./__internal__/fakeSuite.js";
import { MAX_UNLISTED_START_TICK, type LaunchParams } from "./economics.js";

const SUITE = testSuite(8453);
const WETH = getAddress(CHAINS.base.quotes.WETH.address);
const USDC = getAddress(CHAINS.base.quotes.USDC.address);
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");

function fixture(): SuiteFixture {
  return installSuite(new FakeChain(base), SUITE, {
    [WETH]: { decimals: 18 },
    [USDC]: { decimals: 6 },
  });
}

const client = (
  f: SuiteFixture,
  o: {
    authorizer?: Parameters<typeof createLaunchClient>[0]["authorizer"];
  } = {},
) =>
  createLaunchClient({
    chain: "base",
    publicClient: f.fake.publicClient(),
    addresses: SUITE,
    fork: true,
    ...o,
  });

const input = (
  over: Partial<LaunchInput<"base">> = {},
): LaunchInput<"base"> => ({
  name: "Launch SDK Test",
  symbol: "LSDK",
  metadataUri: "ipfs://bafy-test",
  launcher: LAUNCHER,
  launchpadId: 1n,
  ...over,
});

async function expectCode(p: Promise<unknown>, code: LaunchSdkErrorCode) {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(
    isLaunchSdkError(thrown, code),
    `${code}, got ${String((thrown as Error)?.message ?? thrown)}`,
  ).toBe(true);
  return thrown as { detail?: string };
}

describe("pure-mode plan on an open launchpad", () => {
  test("pins the pad's terms, takes its defaults, predicts the token and simulates", async () => {
    const f = fixture();
    const plan = await client(f).plan(input());
    const p = plan.params;
    expect(plan.provider).toBe("bankr_v4");
    expect(plan.factory).toBe(SUITE.factory);
    expect(plan.launchpadId).toBe(1n);
    expect(p.quote).toBe(WETH);
    expect(p.econ.buy).toEqual({
      startPips: 500,
      steadyPips: 500,
      decaySecs: 0,
    });
    expect(p.econ.holdersBps).toBe(1_167);
    expect(p.econ.autoLpBps).toBe(3_000);
    expect(p.maxOperatorShareBps).toBe(1_000);
    expect(p.operatorPayeesHash).toBe(padTermsHash(openPad().terms));
    expect(p.capExclusions).toHaveLength(7);
    expect(p.feeRecipients).toEqual([
      { recipient: LAUNCHER, shareBps: 10_000 },
    ]);
    expect(p.allowOpenCodeFeeRecipients).toBe(false);
    expect(p.metadataAdmin).toBe(zeroAddress);
    expect(p.startTime).toBe(0n);
    expect(p.vestingRecipient).toBe(LAUNCHER);
    expect(p.vestBps).toBe(0);
    expect(p.authorization.signature).toBe("0x");
    expect(plan.predictedToken.toLowerCase().endsWith("ba3")).toBe(false);
    expect({
      poolId: plan.poolId,
      tokenIsCurrency0: plan.tokenIsCurrency0,
    }).toEqual(poolIdOf(plan.predictedToken, WETH, SUITE.hook));
    expect(plan.distributor).toBe(fakeDistributor(plan.predictedToken));
    expect(plan.escrow).toBeNull();
    expect(plan.approvals).toEqual([]);
    expect(plan.holderShareBps).toBe(1_668);
    expect(plan.volumeSplit.feePips).toBe(500);
    expect(p.expectedStartTick).toBeGreaterThan(START_TICK_BOUNDS[0]);
    expect(Math.abs(p.expectedStartTick % 200)).toBe(0);
    const sim = await client(f).simulate(plan);
    expect(sim.token).toBe(plan.predictedToken);
  });

  test("holderShareBps is bps of the creator's own take, converted to the contract's creator-side bps", async () => {
    // A buyback share needs a 1 % round trip the pad's payees and the referrer do not take back.
    const schedule = { startPips: 10_000, steadyPips: 10_000, decaySecs: 0 };
    const plan = await client(fixture()).plan(
      input({
        holderShareBps: 5_000,
        autoLpBps: 3_000,
        buybackBps: 1_000,
        schedule,
      }),
    );
    expect(plan.params.econ.holdersBps).toBe(3_000);
    expect(plan.params.econ.buybackBps).toBe(1_000);
    expect(plan.holderShareBps).toBe(5_000);
  });

  test("a buyback share under the pad's round-trip floor or above its max is refused", async () => {
    const c = client(fixture());
    const err = await expectCode(
      c.plan(input({ buybackBps: 1_000 })),
      "FEE_OUT_OF_BOUNDS",
    );
    expect(err.detail).toContain("buyback");
    const f = fixture();
    f.pads.get(1n)!.pad.policy.maxBuybackBps = 0;
    await expectCode(
      client(f).plan(input({ buybackBps: 1_000 })),
      "SPLIT_OUT_OF_BOUNDS",
    );
  });

  test("custom schedules and referrer inside the bounds bind; outside them refuse with a detail", async () => {
    const c = client(fixture());
    const schedule = { startPips: 300_000, steadyPips: 20_000, decaySecs: 60 };
    const plan = await c.plan(input({ schedule, referrerBps: 100 }));
    expect(plan.params.econ.buy).toEqual(schedule);
    expect(plan.params.econ.sell).toEqual(schedule);
    expect(plan.params.econ.referrerBps).toBe(100);
    const err = await expectCode(
      c.plan(
        input({
          schedule: { startPips: 900_000, steadyPips: 20_000, decaySecs: 60 },
        }),
      ),
      "FEE_OUT_OF_BOUNDS",
    );
    expect(err.detail).toContain("80%");
    await expectCode(
      c.plan(input({ referrerBps: 600 })),
      "SPLIT_OUT_OF_BOUNDS",
    );
    await expectCode(
      c.plan(input({ autoLpBps: 8_000, buybackBps: 3_000 })),
      "SPLIT_OUT_OF_BOUNDS",
    );
    await expectCode(
      c.plan(input({ vesting: { bps: 6_000 } })),
      "VESTING_OUT_OF_BOUNDS",
    );
    await expectCode(
      c.plan(input({ fees: { buy: schedule, sell: schedule }, schedule })),
      "INVALID_PARAMS",
    );
  });

  test("vesting and vest-to-holders bind an escrow; a contract vesting recipient needs the opt-in", async () => {
    const f = fixture();
    const plan = await client(f).plan(
      input({
        vesting: { bps: 1_000 },
        vestToHolders: { bps: 500, cliffSeconds: 0, durationSeconds: 86_400 },
      }),
    );
    expect(plan.params.vestBps).toBe(1_000);
    expect(plan.params.econ.vestToHoldersBps).toBe(500);
    expect(plan.escrow).not.toBeNull();
    f.fake.setCode(OTHER, "0x6080");
    await expectCode(
      client(f).plan(input({ vesting: { bps: 1_000, recipient: OTHER } })),
      "INVALID_PARAMS",
    );
    const allowed = await client(f).plan(
      input({
        vesting: { bps: 1_000, recipient: OTHER, allowContractRecipient: true },
      }),
    );
    expect(allowed.params.allowCodeVestingRecipient).toBe(true);
    // Another launch's token (the factory's isSuite): refused as a launch contract, opt-in or not.
    f.set(
      "factory",
      "isSuite",
      ([a]: readonly unknown[]) =>
        String(a).toLowerCase() === OTHER.toLowerCase(),
    );
    let thrown: unknown;
    try {
      await client(f).plan(
        input({
          vesting: {
            bps: 1_000,
            recipient: OTHER,
            allowContractRecipient: true,
          },
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    expect((thrown as { detail?: string }).detail).toContain(
      "Bankr launch contract",
    );
  });

  test("a fee recipient that cannot claim is refused", async () => {
    const f = fixture();
    f.fake.setCode(OTHER, "0x6080");
    await expectCode(
      client(f).plan(input({ feeRecipient: OTHER })),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    await expectCode(
      client(f).plan(input({ feeRecipient: SUITE.ledger })),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    await expectCode(
      client(f).plan(
        input({ feeRecipient: "0x968b0c1e896Fb1DdB2042957FC0614c67AB7ffC3" }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    // Round 9 RSEC-1 (rewritten: allowContractFeeRecipient once admitted any contract): an open contract is refused,
    // since a stranger's settle moves its share where collectFees never returns it; restricted, it is admitted.
    const open = await expectCode(
      client(f).plan(
        input({ feeRecipient: OTHER, allowContractFeeRecipient: true }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    expect(open.detail).toContain("setClaimRestricted(true)");
    f.fake.contract(SUITE.ledger, [], {
      claimRestricted: ([a]: readonly unknown[]) =>
        String(a).toLowerCase() === OTHER.toLowerCase(),
    });
    const ok = await client(f).plan(
      input({ feeRecipient: OTHER, allowContractFeeRecipient: true }),
    );
    expect(ok.params.feeRecipients[0]!.recipient).toBe(OTHER);
    // A 7702 wallet needs neither the flag nor the restriction.
    f.fake.setCode(OTHER, `0xef0100${"ab".repeat(20)}`);
    f.fake.contract(SUITE.ledger, [], { claimRestricted: false });
    expect(
      (await client(f).plan(input({ feeRecipient: OTHER }))).params
        .feeRecipients,
    ).toEqual([{ recipient: OTHER, shareBps: 10_000 }]);
  });

  test("the launch's quote token is refused as a fee recipient, with the open-code waiver or without", async () => {
    const f = fixture();
    const waived = {
      allowContractFeeRecipient: true,
      allowOpenCodeFeeRecipients: true,
    };
    for (const flags of [{}, waived]) {
      const err = await expectCode(
        client(f).plan(input({ quote: "USDC", feeRecipient: USDC, ...flags })),
        "FEE_RECIPIENT_CANNOT_CLAIM",
      );
      expect(err.detail).toContain("this launch's quote token");
      expect(err.detail).not.toContain("allowOpenCodeFeeRecipients, which");
    }
    // The default quote, in any position of a list: the refusal names its entry.
    const listed = await expectCode(
      client(f).plan(
        input({
          feeRecipients: [
            { recipient: LAUNCHER, shareBps: 6_000 },
            { recipient: WETH, shareBps: 4_000 },
          ],
          ...waived,
        }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    expect(listed.detail).toStartWith(`feeRecipients[1] (${WETH}): `);
    expect(listed.detail).toContain("this launch's quote token");
    // Another quote's token is not this launch's: only the claim rules apply to it.
    const ok = await client(f).plan(input({ feeRecipient: USDC, ...waived }));
    expect(ok.params.feeRecipients[0]!.recipient).toBe(USDC);
  });

  test("a launchpad that pays the launch's quote token cannot launch against it", async () => {
    const f = fixture();
    f.pads.get(1n)!.terms.payees = [USDC];
    const err = await expectCode(
      client(f).plan(input({ quote: "USDC" })),
      "QUOTE_NOT_ALLOWED",
    );
    expect(err.detail).toContain("launchpad pays a share of its fees");
    const ok = await client(f).plan(input());
    expect(ok.params.quote).toBe(WETH);
    // The ledger's own revert, bubbled through factory.launch, decodes to the SDK's sentence.
    f.set("factory", "launch", () => {
      throw new Revert("InvalidBeneficiary");
    });
    const reverted = await expectCode(
      client(f).plan(input()),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    expect(reverted.detail).toContain("is the launch's quote token");
  });

  test("a launchpad payee equal to the quote token is refused only when it holds a share of a split the launch binds", async () => {
    // LaunchRegistry._put omits a zero share, so the ledger never binds that payee: the launch lands.
    const WAD = 10n ** 18n;
    const decayOff = { on: false, autoLpBps: 0, sharesWad: [] as bigint[] };
    const decayOn = (sharesWad: bigint[]) => ({
      on: true,
      autoLpBps: 5_000,
      sharesWad,
    });
    const planOn = (
      steadySharesWad: bigint[],
      decay: typeof decayOff,
      quote: "USDC" | "WETH" = "USDC",
    ) => {
      const f = fixture();
      f.pads.get(1n)!.terms = {
        payees: [PAD_PAYEE, USDC],
        steadySharesWad,
        decay,
      };
      return client(f).plan(input({ quote }));
    };
    // No share of the steady split, and none of the decay split (off, or on at zero): nothing is bound.
    for (const [steady, decay] of [
      [[WAD / 4n, 0n], decayOff],
      [[WAD / 4n, 0n], decayOn([WAD / 10n, 0n])],
      [[0n, 0n], decayOff],
    ] as const) {
      const ok = await planOn([...steady], decay);
      expect(ok.params.quote).toBe(USDC);
      // The plan pins the pad's terms as they stand, the unpaid payee among them, and pays it nothing.
      expect(ok.params.operatorPayeesHash).toBe(
        padTermsHash({
          payees: [PAD_PAYEE, USDC],
          steadySharesWad: [...steady],
          decay,
        }),
      );
      expect(ok.volumeSplit.payees[1]).toEqual({ address: USDC, pips: 0 });
    }
    // Any share of either split the launch binds: the creator bucket's, or the decay bucket's while it is on.
    for (const [steady, decay] of [
      [[WAD / 4n, 1n], decayOff],
      [[0n, WAD / 4n], decayOn([WAD / 10n, 0n])],
      [[WAD / 4n, 0n], decayOn([WAD / 10n, 1n])],
      [[0n, 0n], decayOn([0n, WAD / 10n])],
    ] as const) {
      const err = await expectCode(
        planOn([...steady], decay),
        "QUOTE_NOT_ALLOWED",
      );
      expect(err.detail).toBe(
        "This launchpad pays a share of its fees to this quote token's own contract, which could never collect it. Launch against another quote token, or on another launchpad.",
      );
    }
    // Another quote's launch on the same pad is untouched by the payee: only the pool's own quote strands a share.
    const other = await planOn([WAD / 4n, WAD / 4n], decayOff, "WETH");
    expect(other.params.quote).toBe(WETH);
  });

  test("the suite's CREATE3 factory is refused as a fee or vesting recipient, though the factory's isSuite does not hold it", async () => {
    const f = fixture();
    f.fake.setCode(SUITE.create3Factory, "0x6080");
    // Restricted claims and both flags: every other rule would let it through.
    f.fake.contract(SUITE.ledger, [], { claimRestricted: true });
    await expectCode(
      client(f).plan(
        input({
          feeRecipient: SUITE.create3Factory,
          allowContractFeeRecipient: true,
          allowOpenCodeFeeRecipients: true,
        }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    const vest = await expectCode(
      client(f).plan(
        input({
          vesting: {
            bps: 1_000,
            recipient: SUITE.create3Factory,
            allowContractRecipient: true,
          },
        }),
      ),
      "INVALID_PARAMS",
    );
    expect(vest.detail).toContain("Bankr launch contract");
  });

  test("R7-18: a fee or vesting recipient with a one-digit typo breaks its EIP-55 checksum and is refused", async () => {
    const f = fixture();
    const intended = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    const typo = `${intended.slice(0, -1)}${intended.endsWith("d") ? "e" : "E"}`;
    expect(isAddress(typo)).toBe(false);
    const err = await expectCode(
      client(f).plan(input({ feeRecipient: typo as Address })),
      "INVALID_PARAMS",
    );
    expect(err.detail).toBe(
      "feeRecipient does not match its EIP-55 checksum; check for a typo.",
    );
    const vest = await expectCode(
      client(f).plan(
        input({ vesting: { bps: 1_000, recipient: typo as Address } }),
      ),
      "INVALID_PARAMS",
    );
    expect(vest.detail).toContain("vesting.recipient does not match");
    // One-case spellings carry no checksum and are still taken.
    for (const spelling of [
      intended.toLowerCase(),
      `0x${intended.slice(2).toUpperCase()}`,
    ]) {
      const ok = await client(f).plan(
        input({ feeRecipient: spelling as Address }),
      );
      expect(ok.params.feeRecipients[0]!.recipient).toBe(intended);
    }
  });

  test("the holder leg's references are read live: after a BNKR swap the new oracle is a suite contract too", async () => {
    const f = fixture();
    const swapped = fakeAddress(0x8015);
    f.fake.contract(SUITE.holderLeg, HOLDER_LEG_REFERENCES_ABI, {
      references: swapped,
    });
    await expectCode(
      client(f).plan(
        input({ feeRecipient: swapped, allowContractFeeRecipient: true }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
  });
});

describe("dev buys", () => {
  test("native on WETH: msg.value, no approval, the floor at the slippage", async () => {
    const plan = await client(fixture()).plan(
      input({ devBuy: { amount: 10n ** 15n, slippageBps: 500 } }),
    );
    expect(plan.value).toBe(10n ** 15n);
    expect(plan.params.devBuyAmountIn).toBe(0n);
    expect(plan.devBuyOut).toBe(10n ** 15n * FAKE_TOKENS_PER_UNIT);
    expect(plan.params.devBuyMinOut).toBe((plan.devBuyOut * 9_500n) / 10_000n);
    expect(plan.approvals).toEqual([]);
  });

  test("ERC-20 on USDC: approve the factory for exactly the amount; simulated through the slot override", async () => {
    const f = fixture();
    const plan = await client(f).plan(
      input({ quote: "USDC", devBuy: { amount: 5_000_000n } }),
    );
    expect(plan.value).toBe(0n);
    expect(plan.params.devBuyAmountIn).toBe(5_000_000n);
    expect(plan.approvals).toHaveLength(1);
    const a = plan.approvals[0]!;
    expect(a.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: a.data }).args).toEqual([
      SUITE.factory,
      5_000_000n,
    ]);
    // simulate() runs from the launcher's real balance, assuming only the pending approval.
    f.fake.setErc20Balance(USDC, LAUNCHER, 5_000_000n);
    const sim = await client(f).simulate(plan);
    expect(sim.assumedApprovals).toBe(true);
  });

  test("a dev buy over 2 % of supply is refused", async () => {
    await expectCode(
      client(fixture()).plan(input({ devBuy: { amount: 10n ** 27n } })),
      "CREATOR_CAP_EXCEEDED",
    );
  });
});

describe("launchpads, gates and quotes", () => {
  test("Bankr's pad (id 0) needs API mode; a signed pad needs an authorizer", async () => {
    await expectCode(
      client(fixture()).plan(input({ launchpadId: 0n })),
      "AUTHORIZATION_REQUIRED",
    );
    await expectCode(
      client(fixture()).plan(input({ launchpadId: undefined })),
      "AUTHORIZATION_REQUIRED",
    );
    await expectCode(
      client(fixture()).plan(input({ launchpadId: 2n })),
      "AUTHORIZATION_REQUIRED",
    );
  });

  test("a signed pad's authorizer signs the final terms; the salt carries the pad's vanity", async () => {
    const seen: AuthorizationRequest[] = [];
    const plan = await client(fixture(), {
      authorizer: async (r) => {
        seen.push(r);
        return {
          nonce: `0x${"11".repeat(32)}`,
          deadline: 2_000_000_000n,
          signature: `0x${"22".repeat(65)}`,
        };
      },
    }).plan(input({ launchpadId: 2n }));
    expect(seen).toHaveLength(1);
    const r = seen[0]!;
    expect(r.launchpadId).toBe(2n);
    expect(r.signer).toBe(fakeAddress(0x5161));
    expect(r.registry).toBe(SUITE.launchpadRegistry);
    expect(r.paramsHash).toBe(launchTermsHash(r.params, LAUNCHER, 0n));
    expect(plan.params.authorization.nonce).toBe(`0x${"11".repeat(32)}`);
    expect(plan.predictedToken.toLowerCase().endsWith("a")).toBe(true);
  });

  test("a malformed authorization is AUTHORIZATION_INVALID", async () => {
    const c = client(fixture(), {
      authorizer: async () =>
        ({ nonce: "0x12", deadline: 1n, signature: "0x" }) as never,
    });
    await expectCode(
      c.plan(input({ launchpadId: 2n })),
      "AUTHORIZATION_INVALID",
    );
  });

  test("an unknown or paused pad, a paused or gated factory", async () => {
    await expectCode(
      client(fixture()).plan(input({ launchpadId: 9n })),
      "UNKNOWN_LAUNCHPAD",
    );
    const f = fixture();
    f.pads.get(1n)!.pad.paused = true;
    await expectCode(client(f).plan(input()), "LAUNCHPAD_PAUSED");
    const g = fixture();
    g.set("factory", "launchGated", true);
    await expectCode(client(g).plan(input()), "LAUNCHPAD_GATED");
    const h = fixture();
    h.set("factory", "paused", true);
    await expectCode(client(h).plan(input()), "PAUSED");
  });

  test("a pad without the builder lane cannot launch where the chain has cap exclusions", async () => {
    const f = fixture();
    f.pads.get(1n)!.pad.policy.allowBuilderLane = false;
    await expectCode(client(f).plan(input()), "BUILDER_LANE_NOT_ALLOWED");
  });

  test("any allowed quote by address; SIGNED quotes need API mode; an unreadable one is refused", async () => {
    const other = fakeAddress(0x7777);
    const signed = fakeAddress(0x7778);
    const f = installSuite(new FakeChain(base), SUITE, {
      [WETH]: { decimals: 18 },
      [other]: { decimals: 18 },
      [signed]: { decimals: 18, pricing: 2 },
    });
    const plan = await client(f).plan(input({ quote: other }));
    expect(plan.quote).toMatchObject({
      symbol: null,
      address: other,
      devBuy: "erc20",
      pricing: "chainlink",
    });
    await expectCode(
      client(f).plan(input({ quote: signed })),
      "PRICE_ATTESTATION_REQUIRED",
    );
    // Any address is a quote now (any-quote pairing): one with no code has no decimals() to read.
    await expectCode(
      client(f).plan(
        input({ quote: fakeAddress(0x7779), startFdv: 10n ** 24n }),
      ),
      "INVALID_PARAMS",
    );
    await expectCode(
      client(f).plan(input({ quote: "USDG" as never })),
      "QUOTE_NOT_ALLOWED",
    );
    const quotes = await client(f).quotes(1n);
    expect(quotes.map((q) => q.address)).toEqual([WETH, other, signed]);
  });

  // Live-fork finding 11-07: an id past launchpadCount listed every quote, so a typo'd pad id looked valid.
  test("quotes(id) refuses a launchpad the registry never registered, as launchpad(id) and plan() do", async () => {
    const f = fixture();
    await expectCode(client(f).quotes(3n), "UNKNOWN_LAUNCHPAD");
    await expectCode(client(f).launchpad(3n), "UNKNOWN_LAUNCHPAD");
    expect((await client(f).quotes(2n)).length).toBeGreaterThan(0);
  });

  test("a caller's salt must carry the pad's vanity, and a taken token is POOL_ALREADY_INITIALIZED", async () => {
    const f = fixture();
    const authorizer = async () => ({
      nonce: `0x${"11".repeat(32)}` as const,
      deadline: 2_000_000_000n,
      signature: `0x${"22".repeat(65)}` as const,
    });
    const first = await client(f, { authorizer }).plan(
      input({ launchpadId: 2n }),
    );
    const again = await client(f, { authorizer }).plan(
      input({ launchpadId: 2n, salt: first.params.salt }),
    );
    expect(again.predictedToken).toBe(first.predictedToken);
    let bad = 0n;
    for (; ; bad++) {
      const salt = `0x${bad.toString(16).padStart(64, "0")}` as const;
      try {
        await client(f, { authorizer }).plan(input({ launchpadId: 2n, salt }));
      } catch (err) {
        if (isLaunchSdkError(err, "INVALID_PARAMS")) break;
        throw err;
      }
    }
    f.fake.setCode(first.predictedToken, "0x6080");
    await expectCode(
      client(f, { authorizer }).plan(
        input({ launchpadId: 2n, salt: first.params.salt }),
      ),
      "POOL_ALREADY_INITIALIZED",
    );
  });
});

describe("Arc's suite config", () => {
  test("Arc plans on a fork with a record; its config lists no cap exclusions", async () => {
    const arcSuite = {
      ...testSuite(5042),
      weth: fakeAddress(0x9999) as Address,
    };
    const f = installSuite(new FakeChain(arc), arcSuite, {
      [CHAINS.arc.quotes.USDC.address]: { decimals: 6 },
    });
    const c = createLaunchClient({
      chain: "arc",
      publicClient: f.fake.publicClient(),
      addresses: arcSuite,
      fork: true,
    });
    const plan = await c.plan({
      ...input(),
      quote: "USDC",
    } as LaunchInput<"arc">);
    expect(plan.params.capExclusions).toEqual([]);
    expect((await c.status()).deployed).toBe(false);
  });
});

describe("any-quote pairing (founder 2026-11-07): a pad pairs with any ERC-20", () => {
  const MEME = fakeAddress(0x3e3e);
  const ONE_MEME = 10n ** 18n;
  const FDV = 1_000_000n * ONE_MEME; // 1e6 MEME over 100B tokens: tick -115,200
  const anyFixture = () =>
    installSuite(new FakeChain(base), SUITE, {
      [WETH]: { decimals: 18 },
      [USDC]: { decimals: 6 },
      [MEME]: { decimals: 18, listed: false },
    });

  test("pure mode prices it from startFdv, takes no auto-LP and funds the dev buy by ERC-20", async () => {
    const f = anyFixture();
    const amount = 1_000n * ONE_MEME;
    f.fake.setErc20Balance(MEME, LAUNCHER, amount);
    f.fake.setErc20Allowance(MEME, LAUNCHER, SUITE.factory, amount);
    const plan = await client(f).plan(
      input({ quote: MEME, startFdv: FDV, devBuy: { amount } }),
    );
    expect(plan.params.quote).toBe(MEME);
    expect(plan.params.expectedStartTick).toBe(-115_200);
    expect(plan.params.econ.autoLpBps).toBe(0);
    expect(plan.params.priceAttestation.signature).toBe("0x");
    expect(plan.quote).toMatchObject({
      symbol: null,
      address: MEME,
      decimals: 18,
      listed: false,
      pricing: "unpriced",
      devBuy: "erc20",
    });
    expect(plan.params.devBuyAmountIn).toBe(amount);
    expect(plan.value).toBe(0n);
    expect(plan.devBuyOut).toBe(amount * FAKE_TOKENS_PER_UNIT);
    // A listed quote may pass startFdv too, inside its USD window: $1M of WETH at the fake's bounds is too much.
    await expectCode(
      client(f).plan(input({ startFdv: FDV })),
      "INVALID_PARAMS",
    );
  });

  test("Bankr's pad, API mode and a pad that refuses it are QUOTE_NOT_ALLOWED", async () => {
    const f = anyFixture();
    f.pads.get(1n)!.refusedQuotes = [MEME.toLowerCase()];
    await expectCode(
      client(f).plan(input({ quote: MEME, startFdv: FDV })),
      "QUOTE_NOT_ALLOWED",
    );
    const api = createLaunchClient({
      chain: "base",
      publicClient: f.fake.publicClient(),
      addresses: SUITE,
      fork: true,
      api: {
        preparer: async () => {
          throw new Error("never called");
        },
      },
    });
    for (const launchpadId of [0n, 2n]) {
      const err = await expectCode(
        api.plan(input({ quote: MEME, startFdv: FDV, launchpadId })),
        "QUOTE_NOT_ALLOWED",
      );
      if (launchpadId === 2n) expect(err.detail).toMatch(/pure mode/);
    }
  });

  test("it needs a startFdv inside the protocol's tick range, and a readable decimals()", async () => {
    const f = anyFixture();
    const c = client(f);
    await expectCode(c.plan(input({ quote: MEME })), "INVALID_PARAMS");
    for (const startFdv of [0n, -1n, 1n, 10n ** 70n])
      await expectCode(
        c.plan(input({ quote: MEME, startFdv })),
        "INVALID_PARAMS",
      );
    // Round 9 F5: past +200,000 a curve cannot place the sale (v4's per-tick liquidity cap), so it is refused here,
    // never a bare SIMULATION_REVERTED; +200,000 itself plans.
    const high = await expectCode(
      c.plan(input({ quote: MEME, startFdv: 10n ** 42n })),
      "INVALID_PARAMS",
    );
    expect(high.detail).toMatch(/200000/);
    expect(
      (
        await c.plan(
          input({
            quote: MEME,
            startFdv: 48_955_117_831_431_455_591_990_103_639_961_492_027n,
          }),
        )
      ).params.expectedStartTick,
    ).toBe(MAX_UNLISTED_START_TICK);
    const noCode = fakeAddress(0x3e3f);
    const err = await expectCode(
      c.plan(input({ quote: noCode, startFdv: FDV })),
      "INVALID_PARAMS",
    );
    expect(err.detail).toMatch(/decimals/);
  });

  test("decimals() above 36 is refused before planning (round 9 F1: formatting a huge one is quadratic)", async () => {
    for (const decimals of [37, 300, 1_000_000]) {
      const bomb = fakeAddress(0x3e40 + (decimals % 7));
      const f = installSuite(new FakeChain(base), SUITE, {
        [WETH]: { decimals: 18 },
        [bomb]: { decimals, listed: false },
      });
      const err = await expectCode(
        client(f).plan(input({ quote: bomb, startFdv: FDV })),
        "INVALID_PARAMS",
      );
      expect(err.detail).toMatch(/decimals/);
    }
    const f = installSuite(new FakeChain(base), SUITE, {
      [WETH]: { decimals: 18 },
      [MEME]: { decimals: 36, listed: false },
    });
    expect(
      (await client(f).plan(input({ quote: MEME, startFdv: 10n ** 36n }))).quote
        .decimals,
    ).toBe(36);
  });

  test("no auto-LP: the launch's own, a pad minimum or a pad decay split's is SPLIT_OUT_OF_BOUNDS, and so is the revert", async () => {
    let f = anyFixture();
    await expectCode(
      client(f).plan(input({ quote: MEME, startFdv: FDV, autoLpBps: 1 })),
      "SPLIT_OUT_OF_BOUNDS",
    );
    f.pads.get(1n)!.pad.policy.minAutoLpBps = 1_000;
    await expectCode(
      client(f).plan(input({ quote: MEME, startFdv: FDV })),
      "SPLIT_OUT_OF_BOUNDS",
    );
    f = anyFixture();
    f.pads.get(1n)!.terms.decay = {
      on: true,
      autoLpBps: 5_000,
      sharesWad: [10n ** 17n],
    };
    await expectCode(
      client(f).plan(input({ quote: MEME, startFdv: FDV })),
      "SPLIT_OUT_OF_BOUNDS",
    );
    f = anyFixture();
    const launch = f.fake.contracts.get(SUITE.factory.toLowerCase())!.fns
      .launch as (a: readonly unknown[], c: unknown) => unknown;
    f.set("factory", "launch", (a: readonly unknown[], c: unknown) => {
      if ((a[0] as LaunchParams).quote === MEME)
        throw new Revert("UnlistedQuoteAutoLp");
      return launch(a, c);
    });
    await expectCode(
      client(f).plan(input({ quote: MEME, startFdv: FDV })),
      "SPLIT_OUT_OF_BOUNDS",
    );
  });
});

describe("extensions always on: a plan whose caller named an extension", () => {
  const custom = (plan: { params: LaunchParams }, budgets: object) => ({
    ...plan.params.extension,
    ext: fakeAddress(0xe47),
    codehash: `0x${"ab".repeat(32)}` as const,
    maxBuyPips: 50_000,
    ...budgets,
  });

  test("the hook's budget revert and the factory's one-encoding revert are INVALID_PARAMS with a detail", async () => {
    const f = fixture();
    const c = client(f);
    const plan = await c.plan(input());
    for (const [name, says] of [
      ["ExtensionGasBudget", "50,000 to 250,000"],
      ["AmbiguousExtension", "at its floor as 0"],
    ] as const) {
      f.set("factory", "launch", () => {
        throw new Revert(name);
      });
      const err = await expectCode(c.simulate(plan), "INVALID_PARAMS");
      expect(err.detail).toContain(says);
    }
    // A buy the extension turns away has no code of its own; the detail says what happened.
    f.set("factory", "launch", () => {
      throw new Revert("ExtensionRefusedBuy");
    });
    const refused = await expectCode(c.simulate(plan), "SIMULATION_REVERTED");
    expect(refused.detail).toContain("refused this buy");
  });

  test("budgets outside the floor and the ceiling are refused before the transaction is built", async () => {
    const c = client(fixture());
    const plan = await c.plan(input());
    expect(plan.params.extension).toMatchObject({ quoteGas: 0, afterGas: 0 });
    const withBudgets = (budgets: object) => ({
      ...plan,
      params: { ...plan.params, extension: custom(plan, budgets) },
    });
    for (const budgets of [{ quoteGas: 250_001 }, { afterGas: 149_999 }]) {
      let thrown: unknown;
      try {
        c.buildLaunchTx(withBudgets(budgets));
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
      expect((thrown as { detail?: string }).detail).toContain(
        "must be between",
      );
    }
    const tx = c.buildLaunchTx(
      withBudgets({ quoteGas: 250_000, afterGas: 1_000_000 }),
    );
    expect(tx.to).toBe(SUITE.factory);
  });
});

describe("the launch curve", () => {
  const bands = (...r: [number, number][]): CurveBand[] =>
    r.map(([widthTicks, shareBps]) => ({ widthTicks, shareBps }));
  // The suite rehearsal's table: a 3.04 % pocket, a backbone to $1.2B, a 0.38 % tail. It meets the step rule.
  const POCKET = bands([6_800, 304], [110_000, 9_658], [0, 38]);
  const RUNNER_ROWS = bands([6_800, 300], [110_000, 9_500], [0, 200]);
  const share = (bps: number) => BigInt(bps) * 10n ** 14n;
  const POCKET_CAPS = [
    { marketCap: { start: 10_000, end: 20_000 }, shares: share(304) },
    { marketCap: { start: 20_000, end: 1_200_000_000 }, shares: share(9_658) },
    {
      marketCap: { start: 1_200_000_000, end: "max" as const },
      shares: share(38),
    },
  ];
  // The fake factory prices $125M at its highest tick, so $10K sits at -214,400 and $2,500 at -228,400.
  const TICK_10K = -214_400;
  const open = (f: SuiteFixture, key: bigint = ANY_CURVE) =>
    setFakeCurveAllowed(f.pads.get(1n)!, key, true);
  const launched = (f: SuiteFixture) => {
    let calls = 0;
    const real = f.fake.contracts.get(SUITE.factory.toLowerCase())!.fns.launch;
    f.set("factory", "launch", (...a: unknown[]) => {
      calls += 1;
      return (real as (...x: unknown[]) => unknown)(...a);
    });
    return () => calls;
  };

  test("no curve named is the default curve (id 0) from $10K; a built-in by name or id carries its id", async () => {
    const f = fixture();
    const c = client(f);
    const plain = await c.plan(input());
    expect(plain.params.curveId).toBe(0n);
    expect(plain.params.expectedStartTick).toBe(TICK_10K);
    const degen = await c.plan(input({ curve: "degen" }));
    expect(degen.params.curveId).toBe(1n);
    expect(degen.params.expectedStartTick).toBe(-228_400);
    const thin = await c.plan(input({ curve: 2 }));
    expect(thin.params.curveId).toBe(2n);
    expect(thin.params.expectedStartTick).toBe(TICK_10K);
    expect((await c.plan(input({ curve: "runner_v1" }))).params.curveId).toBe(
      0n,
    );
    const err = await expectCode(
      c.plan(input({ curve: "runner" as "degen" })),
      "INVALID_PARAMS",
    );
    expect(err.detail).toContain("runner_v1, degen, thin_topside");
  });

  test("own bands on a launchpad that opened them: the launch carries their word and simulates", async () => {
    const f = fixture();
    open(f);
    const c = client(f);
    const plan = await c.plan(
      input({ curve: { bands: POCKET, startFdvUsd: 10_000 } }),
    );
    expect(plan.params.curveId).toBe(encodeCurve(POCKET)!);
    expect(plan.params.curveId.toString(16)).toBe(
      `220130022625ba00000026${"0".repeat(40)}`,
    );
    expect(plan.params.expectedStartTick).toBe(TICK_10K);
    expect((await c.simulate(plan)).token).toBe(plan.predictedToken);
  });

  // The fake factory's USD value of the whole supply at a start tick: $125M at its highest.
  const usdAt = (tick: number) =>
    125_000_000 * 1.0001 ** (tick - START_TICK_BOUNDS[1]);
  const scaled = (k: number) =>
    POCKET_CAPS.map((r) => ({
      ...r,
      marketCap: {
        start: r.marketCap.start * k,
        end: r.marketCap.end === "max" ? r.marketCap.end : r.marketCap.end * k,
      },
    }));
  // $10K is 60.4 ticks above its start tick, so $1.2B's grid line is one spacing further out than from $10K itself.
  const POCKET_AT_10K = bands([6_800, 304], [110_200, 9_658], [0, 38]);
  const POCKET_AT_7K = bands([7_000, 304], [110_000, 9_658], [0, 38]);

  test("market-cap ranges: the first range's start is the start FDV in USD, and each band ends on the pool within one tick spacing under its market cap", async () => {
    const f = fixture();
    open(f);
    const c = client(f);
    for (const [k, tick, placed, over] of [
      [1, TICK_10K, POCKET_AT_10K, {}],
      // $25K is 23.8 ticks above its start tick: the same grid lines as the bands' own widths.
      [2.5, -205_200, POCKET, {}],
      // $7K is 93 ticks above its start tick, so $14K's grid line is 7,000 ticks up: past the step rule's 6,800,
      // which a pool that buys nothing of its own is not held to.
      [0.7, -218_000, POCKET_AT_7K, { autoLpBps: 0 }],
    ] as const) {
      const asked = scaled(k);
      const plan = await c.plan(
        input({ ...over, curve: { marketCaps: asked } }),
      );
      expect(plan.params.expectedStartTick).toBe(tick);
      expect(decodeCurve(plan.params.curveId)).toEqual([...placed]);
      // The launch starts at its tick's own market cap, at or under the one asked for.
      expect(usdAt(tick)).toBeLessThanOrEqual(asked[0]!.marketCap.start);
      let end = tick;
      placed.slice(0, -1).forEach((b, n) => {
        end += b.widthTicks;
        const cap = asked[n]!.marketCap.end as number;
        expect(usdAt(end), `band ${n + 1} at ${k}`).toBeLessThanOrEqual(cap);
        expect(usdAt(end + 200), `band ${n + 1} at ${k}`).toBeGreaterThan(cap);
      });
      expect((await c.simulate(plan)).token).toBe(plan.predictedToken);
    }
  });

  test("forty starts from $3K to $365K: every band of every launch ends on the pool under its market cap by less than one tick spacing", async () => {
    const f = fixture();
    open(f);
    const c = client(f);
    const offsets = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const asked = scaled(0.31 * 1.13 ** i);
      // No own buys: the step rule is not what this test is about.
      const plan = await c.plan(
        input({ autoLpBps: 0, curve: { marketCaps: asked } }),
      );
      const tick = plan.params.expectedStartTick;
      const under = (cap: number, at: number) =>
        Math.log(cap / usdAt(at)) / Math.log(1.0001);
      const start = under(asked[0]!.marketCap.start, tick);
      expect(start >= 0 && start < 200, `start ${i}`).toBe(true);
      offsets.add(Math.floor(start / 50));
      let end = tick;
      decodeCurve(plan.params.curveId)!
        .slice(0, -1)
        .forEach((b, n) => {
          end += b.widthTicks;
          const by = under(asked[n]!.marketCap.end as number, end);
          expect(by >= -1e-6 && by < 200, `band ${n + 1} of ${i}`).toBe(true);
        });
    }
    // The starts fall in every quarter of a tick spacing.
    expect([...offsets].sort()).toEqual([0, 1, 2, 3]);
  });

  test("a range that ends at twice the start can put the next band past the step rule's 6,800 ticks: the refusal says where to end it", async () => {
    const f = fixture();
    open(f);
    const calls = launched(f);
    const c = client(f);
    // The pad's default auto-liquidity: from $7K the pocket to $14K is 7,000 ticks, and band 2 holds more than it.
    const step = await expectCode(
      c.plan(input({ curve: { marketCaps: scaled(0.7) } })),
      "INVALID_PARAMS",
    );
    expect(step.detail).toBe(
      `${curveRevertDetail("CurveStep", 1)} Market-cap ranges are placed from the launch's start tick, so the band after a range begins within those 6,800 ticks for certain only when the range ends under 1.97 times the start market cap. End that range lower, or convert the ranges once with curveFromMarketCaps and launch with its bands.`,
    );
    expect(calls()).toBe(0);
    // Both ways through. A pocket that ends at 1.95 times the start (6,678.6 ticks up) is 6,600 or 6,800 ticks
    // wherever the start sits: 6,600 from these three.
    for (const k of [0.7, 1, 2.5]) {
      const lower = scaled(k).map((r, n) => ({
        ...r,
        marketCap: {
          start: n === 1 ? 19_500 * k : r.marketCap.start,
          end: n === 0 ? 19_500 * k : r.marketCap.end,
        },
      }));
      const plan = await c.plan(input({ curve: { marketCaps: lower } }));
      expect(decodeCurve(plan.params.curveId)![0]!.widthTicks).toBe(6_600);
    }
    // The ranges' bands from a start on the grid are the same table at any start: a 6,800-tick pocket.
    const pinned = await c.plan(
      input({
        curve: {
          bands: curveFromMarketCaps({ ranges: scaled(0.7) }).bands,
          startFdvUsd: 7_000,
        },
      }),
    );
    expect(pinned.params.curveId).toBe(encodeCurve(POCKET)!);
    expect(pinned.params.expectedStartTick).toBe(-218_000);
    // Bands given as bands get the rule's own sentence.
    const rows = await expectCode(
      c.plan(input({ curve: { bands: POCKET_AT_7K, startFdvUsd: 7_000 } })),
      "INVALID_PARAMS",
    );
    expect(rows.detail).toBe(curveRevertDetail("CurveStep", 1));
  });

  test("market-cap ranges on a launchpad that lists exact bands: the key is read for the word the start tick gives them", async () => {
    const f = fixture();
    const calls = launched(f);
    const c = client(f);
    const own = input({ curve: { marketCaps: POCKET_CAPS } });
    const closed = await expectCode(c.plan(own), "CURVE_NOT_ALLOWED");
    expect(closed.detail).toStartWith(
      "This launchpad is closed to these liquidity bands. Its operator must open it first",
    );
    // The ranges' bands from a start on the grid are not what this launch carries: listing them opens nothing.
    open(f, encodeCurve(POCKET)!);
    await expectCode(c.plan(own), "CURVE_NOT_ALLOWED");
    expect(calls()).toBe(0);
    open(f, encodeCurve(POCKET_AT_10K)!);
    expect((await c.plan(own)).params.curveId).toBe(
      encodeCurve(POCKET_AT_10K)!,
    );
    // From $25K the same ranges are the listed bands themselves.
    expect(
      (await c.plan(input({ curve: { marketCaps: scaled(2.5) } }))).params
        .curveId,
    ).toBe(encodeCurve(POCKET)!);
  });

  test("a closed launchpad is refused before anything is mined or simulated: its operator must open it", async () => {
    const f = fixture();
    const calls = launched(f);
    const c = client(f);
    const own = input({ curve: { bands: POCKET, startFdvUsd: 10_000 } });
    const err = await expectCode(c.plan(own), "CURVE_NOT_ALLOWED");
    expect(err.detail).toBe(
      "This launchpad is closed to these liquidity bands. Its operator must open it first: list these bands, or open the launchpad to launcher-defined bands, with setCurveAllowed. Until then, launch on a curve it allows.",
    );
    expect(calls()).toBe(0);
    // Listing these exact bands opens the pad to them and to no others.
    open(f, encodeCurve(POCKET)!);
    expect((await c.plan(own)).params.curveId).toBe(encodeCurve(POCKET)!);
    const other = bands([6_800, 305], [110_000, 9_657], [0, 38]);
    await expectCode(
      c.plan(input({ curve: { bands: other, startFdvUsd: 10_000 } })),
      "CURVE_NOT_ALLOWED",
    );
  });

  test("a built-in curve the launchpad switched off is refused, and the any key does not bring it back", async () => {
    const f = fixture();
    setFakeCurveAllowed(f.pads.get(1n)!, 0n, false);
    open(f);
    const c = client(f);
    const err = await expectCode(c.plan(input()), "CURVE_NOT_ALLOWED");
    expect(err.detail).toContain("switched this launch curve off");
    expect((await c.plan(input({ curve: "degen" }))).params.curveId).toBe(1n);
  });

  test("bands that break a rule are INVALID_PARAMS naming the band, before a salt is mined", async () => {
    const f = fixture();
    open(f);
    const calls = launched(f);
    const c = client(f);
    // The pad's default auto-liquidity makes the pool buy its own token: runner_v1's own rows rise again at band 3.
    const own = { curve: { bands: RUNNER_ROWS, startFdvUsd: 10_000 } };
    const step = await expectCode(c.plan(input(own)), "INVALID_PARAMS");
    expect(step.detail).toBe(curveRevertDetail("CurveStep", 2));
    expect(step.detail).toStartWith("Liquidity band 3 holds more liquidity");
    expect(calls()).toBe(0);
    // With no own buys the same rows launch.
    const flat = await c.plan(input({ ...own, autoLpBps: 0 }));
    expect(flat.params.curveId).toBe(encodeCurve(RUNNER_ROWS)!);
    const thin = await expectCode(
      c.plan(
        input({
          autoLpBps: 0,
          curve: {
            bands: bands([6_800, 250], [0, 9_750]),
            startFdvUsd: 10_000,
          },
        }),
      ),
      "INVALID_PARAMS",
    );
    expect(thin.detail).toBe(curveRevertDetail("CurveTooThin", 0));
    const form = await expectCode(
      c.plan(
        input({
          curve: {
            bands: bands([6_900, 304], [0, 9_696]),
            startFdvUsd: 10_000,
          },
        }),
      ),
      "INVALID_PARAMS",
    );
    expect(form.detail).toStartWith(
      "Liquidity band 1: widthTicks must be a multiple of 200",
    );
  });

  test("own bands have no default start price, and one start at a time", async () => {
    const f = fixture();
    open(f);
    const c = client(f);
    const none = await expectCode(
      c.plan(input({ curve: { bands: POCKET } })),
      "INVALID_PARAMS",
    );
    expect(none.detail).toBe(
      "A launch with its own liquidity bands has no default start price: set curve.startFdvUsd, the whole supply's value in USD at the start (or startFdv, in the quote's base units).",
    );
    const both = await expectCode(
      c.plan(
        input({
          startFdv: 4n * 10n ** 18n,
          curve: { bands: POCKET, startFdvUsd: 10_000 },
        }),
      ),
      "INVALID_PARAMS",
    );
    expect(both.detail).toBe("Set startFdv or curve.startFdvUsd, not both.");
    for (const startFdvUsd of [10, 200_000_000]) {
      const out = await expectCode(
        c.plan(input({ curve: { bands: POCKET, startFdvUsd } })),
        "INVALID_PARAMS",
      );
      expect(out.detail).toBe(
        "The curve's start market cap is outside the factory's USD window for this quote.",
      );
    }
  });

  test("on a quote the factory does not list, startFdv places the bands and market caps are in its unit", async () => {
    const MEME = fakeAddress(0x3e3e);
    const FDV = 1_000_000n * 10n ** 18n;
    const f = installSuite(new FakeChain(base), SUITE, {
      [WETH]: { decimals: 18 },
      [MEME]: { decimals: 18, listed: false },
    });
    open(f);
    const c = client(f);
    const at = { quote: MEME, startFdv: FDV };
    const plan = await c.plan(input({ ...at, curve: { bands: RUNNER_ROWS } }));
    expect(plan.params.curveId).toBe(encodeCurve(RUNNER_ROWS)!);
    expect(plan.params.expectedStartTick).toBe(-115_200);
    const inQuote = POCKET_CAPS.map((r) => ({
      ...r,
      marketCap: {
        start: r.marketCap.start * 1e20,
        end:
          r.marketCap.end === "max" ? r.marketCap.end : r.marketCap.end * 1e20,
      },
    }));
    const ranged = await c.plan(
      input({ ...at, curve: { marketCaps: inQuote } }),
    );
    // startFdv's own tick is -115,135.0, 65 ticks above the start tick: $1.2B's grid line is at 117,000, not 116,800.
    expect(decodeCurve(ranged.params.curveId)).toEqual(POCKET_AT_10K);
    expect(ranged.params.expectedStartTick).toBe(-115_200);
    const quoteFdvAt = (ticksUp: number) =>
      1.0001 ** (-115_200 + ticksUp) * 1e29;
    for (const [ticksUp, cap] of [
      [6_800, 20_000e20],
      [117_000, 1_200_000_000e20],
    ] as const) {
      expect(quoteFdvAt(ticksUp)).toBeLessThanOrEqual(cap);
      expect(quoteFdvAt(ticksUp + 200)).toBeGreaterThan(cap);
    }
    const off = await expectCode(
      c.plan(input({ ...at, curve: { marketCaps: POCKET_CAPS } })),
      "INVALID_PARAMS",
    );
    expect(off.detail).toBe(
      "With startFdv set, market caps are in the quote's base units and the first range must start at startFdv.",
    );
    const usd = await expectCode(
      c.plan(
        input({ quote: MEME, curve: { bands: POCKET, startFdvUsd: 10_000 } }),
      ),
      "INVALID_PARAMS",
    );
    expect(usd.detail).toContain("has no USD price: set startFdv");
  });

  test("the chain's own curve reverts are worded the same way, by band", async () => {
    const f = fixture();
    const c = client(f);
    const plan = await c.plan(input());
    for (const [name, args, code, says] of [
      ["CurveStep", [2n], "INVALID_PARAMS", curveRevertDetail("CurveStep", 2)],
      [
        "CurveTooThin",
        [0n],
        "INVALID_PARAMS",
        curveRevertDetail("CurveTooThin", 0),
      ],
      [
        "CurveTooDense",
        [1n],
        "INVALID_PARAMS",
        curveRevertDetail("CurveTooDense", 1),
      ],
      [
        "CurveLiquidity",
        [7n],
        "INVALID_PARAMS",
        curveRevertDetail("CurveLiquidity", 7),
      ],
      [
        "CurvePlacement",
        [],
        "INVALID_PARAMS",
        curveRevertDetail("CurvePlacement"),
      ],
      ["CurveDust", [123n], "INVALID_PARAMS", curveRevertDetail("CurveDust")],
      ["InvalidCurve", [], "INVALID_PARAMS", curveRevertDetail("InvalidCurve")],
      [
        "CurveNotAllowedByLaunchpad",
        [],
        "CURVE_NOT_ALLOWED",
        "This launchpad does not allow this launch's curve. Its operator must open it first: list these bands, open the launchpad to launcher-defined bands, or switch the built-in curve back on, with setCurveAllowed.",
      ],
    ] as const) {
      f.set("factory", "launch", () => {
        throw new Revert(name, args);
      });
      const err = await expectCode(c.simulate(plan), code);
      expect(err.detail, name).toBe(says);
    }
  });
});
