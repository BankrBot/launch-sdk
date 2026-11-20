import { describe, expect, test } from "bun:test";
import { getAddress, zeroAddress, type Address } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { AuthorizationRequest } from "./authorizer.js";
import { CHAINS } from "./chains/index.js";
import { createLaunchClient } from "./client.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import type { LaunchInput } from "./providers/types.js";
import { launchTermsHash } from "./terms.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import {
  installSuite,
  openPad,
  testSuite,
  type SuiteFixture,
} from "./__internal__/fakeSuite.js";

// A launch's fee recipient list, metadata admin and scheduled start in pure mode, on the fake suite.

const SUITE = testSuite(8453);
const WETH = getAddress(CHAINS.base.quotes.WETH.address);
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const A = getAddress("0x2222222222222222222222222222222222222222");
const B = getAddress("0x3333333333333333333333333333333333333333");
const ADMIN = getAddress("0x4444444444444444444444444444444444444444");
const SAFE_ABI = [
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const fixture = (): SuiteFixture =>
  installSuite(new FakeChain(base), SUITE, { [WETH]: { decimals: 18 } });

const client = (
  f: SuiteFixture,
  o: {
    authorizer?: Parameters<typeof createLaunchClient>[0]["authorizer"];
  } = {},
) =>
  createLaunchClient({
    chain: "base",
    publicClient: f.fake.publicClient(),
    suite: 3,
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

async function refusal(p: Promise<unknown>, code: LaunchSdkErrorCode) {
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
  return (thrown as { detail?: string }).detail;
}

const SPLIT = [
  { recipient: A, shareBps: 5_000 },
  { recipient: LAUNCHER, shareBps: 3_000 },
  { recipient: B, shareBps: 2_000 },
];

describe("fee recipient lists", () => {
  test("the list binds in its order, simulates, and is what a signed pad's authorizer signs", async () => {
    const f = fixture();
    const plan = await client(f).plan(input({ feeRecipients: SPLIT }));
    expect(plan.params.feeRecipients).toEqual(SPLIT);
    expect(plan.params.allowOpenCodeFeeRecipients).toBe(false);
    expect((await client(f).simulate(plan)).token).toBe(plan.predictedToken);
    // The recipients are not in the token's address; their order is in the signed terms.
    const one = await client(f).plan(input({ salt: plan.params.salt }));
    expect(one.predictedToken).toBe(plan.predictedToken);
    const requests: AuthorizationRequest[] = [];
    const signer = privateKeyToAccount(`0x${"42".repeat(32)}`);
    const signed = installSuite(
      new FakeChain(base),
      SUITE,
      { [WETH]: { decimals: 18 } },
      { padSigner: signer.address },
    );
    await client(signed, {
      authorizer: async (request) => {
        requests.push(request);
        return {
          nonce: `0x${"01".repeat(32)}`,
          deadline: 2_000_000_000n,
          signature: `0x${"5b".repeat(65)}`,
        };
      },
    }).plan(input({ launchpadId: 2n, feeRecipients: SPLIT }));
    const asked = requests[0]!;
    expect(asked.params.feeRecipients).toEqual(SPLIT);
    expect(asked.paramsHash).toBe(launchTermsHash(asked.params, LAUNCHER, 0n));
    expect(asked.paramsHash).not.toBe(
      launchTermsHash(
        { ...asked.params, feeRecipients: [...SPLIT].reverse() },
        LAUNCHER,
        0n,
      ),
    );
  });

  test("a malformed list is INVALID_PARAMS with the rule it breaks", async () => {
    const c = client(fixture());
    const r = (n: number, shareBps: number) => ({
      recipient: getAddress(`0x${(0xa000 + n).toString(16).padStart(40, "0")}`),
      shareBps,
    });
    const cases: [LaunchInput<"base">["feeRecipients"], string][] = [
      [[], "Name at least one fee recipient."],
      [
        Array.from({ length: 11 }, (_, n) => r(n, n === 0 ? 910 : 909)),
        "A launch can name at most 10 fee recipients.",
      ],
      [[r(0, 10_000), r(1, 0)], "Each fee recipient needs a share above 0%"],
      [[r(0, 5_000), r(0, 5_000)], "Each fee recipient can be listed once."],
      [[r(0, 5_000), r(1, 4_999)], "Fee recipient shares must add up to 100%."],
      [
        [{ recipient: zeroAddress, shareBps: 10_000 }],
        "feeRecipients[0].recipient is the zero address.",
      ],
    ];
    for (const [feeRecipients, detail] of cases) {
      expect(
        await refusal(c.plan(input({ feeRecipients })), "INVALID_PARAMS"),
      ).toContain(detail);
    }
    expect(
      await refusal(
        c.plan(input({ feeRecipient: A, feeRecipients: SPLIT })),
        "INVALID_PARAMS",
      ),
    ).toBe("Set feeRecipient or feeRecipients, not both.");
    // Ten recipients is the most a launch takes.
    const ten = Array.from({ length: 10 }, (_, n) => r(n, 1_000));
    expect(
      (await c.plan(input({ feeRecipients: ten }))).params.feeRecipients,
    ).toEqual(ten);
  });

  test("every entry is held to the claim rules: a suite contract or an open contract anywhere in the list is refused", async () => {
    const f = fixture();
    const c = client(f);
    const suite = [
      { recipient: LAUNCHER, shareBps: 5_000 },
      { recipient: SUITE.ledger, shareBps: 5_000 },
    ];
    expect(
      await refusal(
        c.plan(input({ feeRecipients: suite })),
        "FEE_RECIPIENT_CANNOT_CLAIM",
      ),
    ).toContain(`feeRecipients[1] (${SUITE.ledger})`);

    f.fake.setCode(B, "0x6080");
    await refusal(
      c.plan(input({ feeRecipients: SPLIT })),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    const open = input({
      feeRecipients: SPLIT,
      allowContractFeeRecipient: true,
    });
    const detail = await refusal(c.plan(open), "FEE_RECIPIENT_CANNOT_CLAIM");
    expect(detail).toContain(`feeRecipients[2] (${B})`);
    expect(detail).toContain("setClaimRestricted(true)");
    expect(detail).toContain("allowOpenCodeFeeRecipients");
    // The launch's own waiver admits it, and is part of the terms; so does the contract restricting its claims.
    const waived = await c.plan({ ...open, allowOpenCodeFeeRecipients: true });
    expect(waived.params.allowOpenCodeFeeRecipients).toBe(true);
    expect(waived.params.feeRecipients).toEqual(SPLIT);
    f.fake.contract(SUITE.ledger, [], {
      claimRestricted: ([a]: readonly unknown[]) =>
        String(a).toLowerCase() === B.toLowerCase(),
    });
    const restricted = await c.plan(open);
    expect(restricted.params.allowOpenCodeFeeRecipients).toBe(false);
  });

  test("a Safe still needs the waiver or restricted claims: the factory reverts any open contract recipient", async () => {
    const f = fixture();
    const c = client(f);
    f.fake.contract(A, SAFE_ABI, { getThreshold: 2n });
    const detail = await refusal(
      c.plan(input({ feeRecipient: A })),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    expect(detail).toContain("allowOpenCodeFeeRecipients");
    // A Safe launcher is its own default recipient, so the same holds with no recipient named.
    f.fake.contract(LAUNCHER, SAFE_ABI, { getThreshold: 1n });
    await refusal(c.plan(input()), "FEE_RECIPIENT_CANNOT_CLAIM");
    const waived = await c.plan(
      input({ feeRecipient: A, allowOpenCodeFeeRecipients: true }),
    );
    expect(waived.params.feeRecipients).toEqual([
      { recipient: A, shareBps: 10_000 },
    ]);
    // Without the SDK's check the factory itself reverts the launch, and the revert reads as the same refusal.
    expect(
      await refusal(
        c.simulate({
          ...waived,
          params: { ...waived.params, allowOpenCodeFeeRecipients: false },
        }),
        "FEE_RECIPIENT_CANNOT_CLAIM",
      ),
    ).toContain("allowOpenCodeFeeRecipients");
    f.fake.contract(SUITE.ledger, [], { claimRestricted: true });
    const restricted = await c.plan(input({ feeRecipient: A }));
    expect(restricted.params.allowOpenCodeFeeRecipients).toBe(false);
  });
});

describe("the metadata admin", () => {
  test("it is a term of the launch and part of the token's address; the link is at most 2,048 bytes", async () => {
    const f = fixture();
    const c = client(f);
    const none = await c.plan(input());
    const salt = none.params.salt;
    const admin = await c.plan(input({ metadataAdmin: ADMIN, salt }));
    expect(none.params.metadataAdmin).toBe(zeroAddress);
    expect(admin.params.metadataAdmin).toBe(ADMIN);
    expect(admin.predictedToken).not.toBe(none.predictedToken);
    expect((await c.simulate(admin)).token).toBe(admin.predictedToken);
    expect(
      await refusal(
        c.plan(input({ metadataAdmin: "0x1234" as Address })),
        "INVALID_PARAMS",
      ),
    ).toBe("metadataAdmin is not an address.");
    // Bytes, not characters: 1,025 two-byte letters are over.
    expect(
      await refusal(
        c.plan(input({ metadataUri: "é".repeat(1_025) })),
        "INVALID_PARAMS",
      ),
    ).toBe("The metadata link can be at most 2,048 bytes.");
    await c.plan(input({ metadataUri: "é".repeat(1_024) }));
  });
});

describe("a scheduled start", () => {
  const now = () => Math.floor(Date.now() / 1000);

  test("a Date or unix seconds binds as startTime; it changes neither the token nor the default of trading at launch", async () => {
    const f = fixture();
    const c = client(f);
    const at = now() + 3_600;
    const plan = await c.plan(input({ startTime: new Date(at * 1_000 + 500) }));
    expect(plan.params.startTime).toBe(BigInt(at));
    expect((await c.simulate(plan)).token).toBe(plan.predictedToken);
    const same = await c.plan(input({ startTime: at, salt: plan.params.salt }));
    expect(same.params.startTime).toBe(BigInt(at));
    const open = await c.plan(input({ startTime: 0 }));
    expect(open.params.startTime).toBe(0n);
    const unscheduled = await c.plan(input({ salt: plan.params.salt }));
    expect(unscheduled.predictedToken).toBe(plan.predictedToken);
  });

  test("the past, more than 7 days ahead, or more than the pad allows is refused before anything is signed", async () => {
    const f = fixture();
    const c = client(f);
    const plan = (startTime: LaunchInput["startTime"]) =>
      refusal(c.plan(input({ startTime })), "INVALID_PARAMS");
    expect(await plan(now() - 60)).toBe(
      "The trading start must be in the future.",
    );
    expect(await plan(now() + 8 * 86_400)).toBe(
      "Trading can start at most 7 days after the launch.",
    );
    expect(await plan(Date.now() + 3_600_000)).toBe(
      "startTime is unix seconds, not milliseconds.",
    );
    for (const bad of [1.5, -1, new Date(Number.NaN), "soon"]) {
      expect(await plan(bad as LaunchInput["startTime"])).toContain(
        "startTime is a Date or whole unix seconds",
      );
    }
    const pad = openPad();
    const withMax = (maxStartDelay: number) =>
      f.pads.set(1n, {
        ...pad,
        pad: { ...pad.pad, policy: { ...pad.pad.policy, maxStartDelay } },
      });
    withMax(3_600);
    expect(await plan(now() + 7_200)).toBe(
      "Trading can start at most 1 hour after the launch on this launchpad.",
    );
    const inside = await c.plan(input({ startTime: now() + 1_800 }));
    // The pad's own bound is the registry's to enforce: past it, the launch itself reverts, each rule by name.
    const reverted = (startTime: number) =>
      refusal(
        c.simulate({
          ...inside,
          params: { ...inside.params, startTime: BigInt(startTime) },
        }),
        "INVALID_PARAMS",
      );
    expect(await reverted(now() + 7_200)).toBe(
      "The trading start is later than this launchpad allows.",
    );
    expect(await reverted(now() - 60)).toContain("plan again with a later");
    expect(await reverted(now() + 8 * 86_400)).toBe(
      "Trading can start at most 7 days after the launch.",
    );
    withMax(0);
    expect(await plan(now() + 60)).toBe(
      "This launchpad does not allow a scheduled trading start.",
    );
  });
});
