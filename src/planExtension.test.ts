import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  zeroAddress,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { bankrLaunchFactoryAbi } from "./abis/suite3.js";
import type { AuthorizationRequest } from "./authorizer.js";
import { CHAINS } from "./chains/index.js";
import { createLaunchClient } from "./client.js";
import { ANY_CURVE } from "./curve.js";
import { curveRevertDetail } from "./curveDetail.js";
import type { LaunchParams } from "./economics.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import type { LaunchExtensionInput } from "./extension.js";
import { padAuthorizer } from "./padSigner.js";
import type { LaunchInput } from "./providers/types.js";
import {
  NO_EXTENSION,
  launchAuthorizationTypedData,
  launchTermsHash,
} from "./terms.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import {
  fakeAddress,
  fakePresetKey,
  installSuite,
  setFakeCurveAllowed,
  testSuite,
  type SuiteFixture,
} from "./__internal__/fakeSuite.js";

const SUITE = testSuite(8453);
const WETH = getAddress(CHAINS.base.quotes.WETH.address);
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const PAYEE = getAddress("0x3333333333333333333333333333333333333333");
const U24 = { type: "uint24" } as const;
const sniperParams = (buy: number, sell: number, end: number): Hex =>
  encodeAbiParameters([U24, U24, { type: "uint32" }], [buy, sell, end]);

const SNIPER: LaunchExtensionInput = {
  preset: "sniper_tax",
  buyPips: 50_000,
  sellPips: 20_000,
  endSecs: 300,
};
// A flat 1 % launch fee leaves the preset its room from the first second.
const FLAT = { startPips: 10_000, steadyPips: 10_000, decaySecs: 0 };

const fixture = (padSigner?: `0x${string}`): SuiteFixture =>
  installSuite(
    new FakeChain(base),
    SUITE,
    { [WETH]: { decimals: 18 } },
    { padSigner },
  );

const client = (
  f: SuiteFixture,
  o: Partial<Parameters<typeof createLaunchClient>[0]> = {},
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
  schedule: FLAT,
  extension: SNIPER,
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

describe("a launch with a preset is one option", () => {
  test("Sniper Tax: the plan names the preset as the factory takes it, shows what it does, and simulates", async () => {
    const f = fixture();
    const c = client(f);
    const plan = await c.plan(input());
    expect(plan.params.extension).toEqual({
      ...NO_EXTENSION,
      id: 1,
      params: sniperParams(50_000, 20_000, 300),
    });
    expect(plan.extension).toMatchObject({
      kind: "preset",
      preset: {
        id: 1,
        key: "sniper_tax",
        name: "Sniper Tax",
        reference: false,
      },
      label: "Sniper Tax · Bankr preset",
      description:
        "Sniper Tax: buys +5%, sells +2% until 300s after launch, then 0",
      terms: {
        maxBuyPips: 50_000,
        maxSellPips: 20_000,
        quoteOnly: true,
        sunsetSecs: 300,
      },
      gas: { quoteGas: 50_000, afterGas: 0 },
      // The lens's figure for a quote-only binding at the floor: what every swap of the pool adds to its gas limit.
      swapGasHeadroom: 287_737n,
      // No payee named: the launch's first fee recipient is paid.
      payee: LAUNCHER,
      payeeShareBps: 7_143,
      treasuryShareBps: 2_857,
      allowlistKey: fakePresetKey(1),
      allowlisted: true,
      launchpadAllows: true,
      refusal: null,
      warnings: [],
    });
    const sim = await c.simulate(plan);
    expect(sim.token).toBe(plan.predictedToken);
    const { args } = decodeFunctionData({
      abi: bankrLaunchFactoryAbi,
      data: c.buildLaunchTx(plan).data,
    });
    expect((args[0] as LaunchParams).extension).toEqual(plan.params.extension);
    // A launch that names none is unchanged.
    const plain = await c.plan(input({ extension: undefined }));
    expect(plain.params.extension).toEqual({ ...NO_EXTENSION });
    expect(plain.extension).toBeNull();
  });

  test("an out-of-range parameter is refused with its bound before any chain read", async () => {
    const f = fixture();
    const c = client(f);
    const err = await expectCode(
      c.plan(input({ extension: { ...SNIPER, endSecs: 60 } })),
      "EXTENSION_OUT_OF_BOUNDS",
    );
    expect(err.detail).toBe(
      "Sniper Tax end (seconds) must be between 121 and 3600.",
    );
    expect(f.fake.calls).toHaveLength(0);
  });

  test("the same values written into a plan by hand revert in the preset's constructor, and that is named too", async () => {
    const f = fixture();
    const c = client(f);
    const plan = await c.plan(input());
    const edited = (params: Hex, id = 1) => ({
      ...plan,
      params: {
        ...plan.params,
        extension: { ...plan.params.extension, id, params },
      },
    });
    const cases: [Hex, number, LaunchSdkErrorCode, string][] = [
      [
        sniperParams(50_000, 20_000, 60),
        1,
        "EXTENSION_OUT_OF_BOUNDS",
        "more than 120 seconds",
      ],
      [
        sniperParams(50_000, 20_000, 3_601),
        1,
        "EXTENSION_OUT_OF_BOUNDS",
        "3,600",
      ],
      [
        sniperParams(0, 20_000, 300),
        1,
        "EXTENSION_OUT_OF_BOUNDS",
        "at least 1",
      ],
      [
        sniperParams(100_001, 0, 300),
        1,
        "EXTENSION_OUT_OF_BOUNDS",
        "100,000 pips",
      ],
      [
        sniperParams(0, 0, 600),
        2,
        "EXTENSION_OUT_OF_BOUNDS",
        "Decay Tax needs",
      ],
      [sniperParams(1, 0, 604_801), 2, "EXTENSION_OUT_OF_BOUNDS", "7 days"],
      [
        sniperParams(1, 1, 300),
        3,
        "EXTENSION_OUT_OF_BOUNDS",
        "exact ABI encoding",
      ],
      [
        encodeAbiParameters([U24, { type: "int24" }], [30_000, 6_931]),
        3,
        "EXTENSION_OUT_OF_BOUNDS",
        "6,932 to 887,272",
      ],
    ];
    for (const [params, id, code, says] of cases) {
      const err = await expectCode(c.simulate(edited(params, id)), code);
      expect(err.detail, `${id} ${params}`).toContain(says);
    }
    // The edges themselves pass the constructor.
    for (const end of [121, 3_600])
      await c.simulate(edited(sniperParams(1, 100_000, end)));
    // An id the deployer does not know has no key on the allowlist; with one, the deployer itself refuses it.
    const unknown = edited(sniperParams(1, 1, 300), 9);
    await expectCode(c.simulate(unknown), "EXTENSION_NOT_ALLOWED");
    f.allowedExtensions.add(fakePresetKey(9));
    const err = await expectCode(c.simulate(unknown), "INVALID_PARAMS");
    expect(err.detail).toContain("no preset with this id");
  });
});

describe("the pre-flight read: the registry's allowlist and the launchpad's policy", () => {
  test("a key the allowlist does not hold is EXTENSION_NOT_ALLOWED before a salt is mined or a signature asked", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const f = fixture(signer.address);
    f.allowedExtensions.delete(fakePresetKey(1));
    let asked = 0;
    const c = client(f, {
      authorizer: async () => {
        asked++;
        throw new Error("never asked");
      },
    });
    const err = await expectCode(
      c.plan(input({ launchpadId: 2n })),
      "EXTENSION_NOT_ALLOWED",
    );
    expect(err.detail).toContain("allowlist");
    expect(err.detail).toContain(fakePresetKey(1));
    expect(asked).toBe(0);
    expect(f.fake.calls.some((x) => x.functionName === "launch")).toBe(false);
    // Another preset's key is still held.
    f.allowedExtensions.add(fakePresetKey(1));
    f.allowedExtensions.delete(fakePresetKey(2));
    await client(f).plan(input());
  });

  test("a launchpad whose policy switches presets off, and a chain whose presets are off", async () => {
    const f = fixture();
    f.pads.get(1n)!.pad.policy.allowedExtensions = 6;
    const off = await expectCode(
      client(f).plan(input()),
      "EXTENSION_NOT_ALLOWED",
    );
    expect(off.detail).toContain("policy.allowedExtensions");
    expect(off.detail).toContain("Bankr's presets");
    const g = fixture();
    g.set("factory", "presetDeployer", zeroAddress);
    const none = await expectCode(
      client(g).plan(input()),
      "EXTENSION_NOT_ALLOWED",
    );
    expect(none.detail).toContain("switched off");
  });

  test("the registry's own reverts carry the same code, for a plan edited by hand", async () => {
    const f = fixture();
    const c = client(f);
    const plan = await c.plan(input());
    f.allowedExtensions.delete(fakePresetKey(1));
    const listed = await expectCode(c.simulate(plan), "EXTENSION_NOT_ALLOWED");
    expect(listed.detail).toContain("allowlist");
    f.allowedExtensions.add(fakePresetKey(1));
    f.pads.get(1n)!.pad.policy.allowedExtensions = 0;
    const policy = await expectCode(c.simulate(plan), "EXTENSION_NOT_ALLOWED");
    expect(policy.detail).toContain("policy");
  });

  test("previewExtension reads the same answers without planning, and reports a refusal instead of throwing", async () => {
    const f = fixture();
    const c = client(f);
    const ok = await c.previewExtension(SNIPER, { launchpadId: 1n });
    expect(ok).toMatchObject({
      label: "Sniper Tax · Bankr preset",
      allowlisted: true,
      launchpadAllows: true,
      refusal: null,
      // Nobody named and no launch yet: the launch's first fee recipient.
      payee: null,
    });
    // On the pad's default fee (flat 0.05 %) the preset has all its room from the first second.
    expect(ok.feeTable[0]).toEqual({
      secsSinceLaunch: 0,
      buyFeePips: 500,
      sellFeePips: 500,
      buy: { extPips: 50_000, totalPips: 50_500 },
      sell: { extPips: 20_000, totalPips: 20_500 },
    });
    f.allowedExtensions.clear();
    f.pads.get(1n)!.pad.policy.allowedExtensions = 0;
    const no = await c.previewExtension(SNIPER, { launchpadId: 1n });
    expect(no).toMatchObject({ allowlisted: false, launchpadAllows: false });
    expect(no.refusal).toContain("policy.allowedExtensions");
    await expectCode(
      c.previewExtension({ ...SNIPER, buyPips: 0 }, { launchpadId: 1n }),
      "EXTENSION_OUT_OF_BOUNDS",
    );
    await expectCode(
      c.previewExtension(SNIPER, { launchpadId: 99n }),
      "UNKNOWN_LAUNCHPAD",
    );
  });
});

describe("the extension's payee", () => {
  test("several fee recipients: the payee is named, or the launch is refused before any chain read", async () => {
    const f = fixture();
    const feeRecipients = [
      { recipient: LAUNCHER, shareBps: 6_000 },
      { recipient: OTHER, shareBps: 4_000 },
    ];
    const err = await expectCode(
      client(f).plan(input({ feeRecipients })),
      "INVALID_PARAMS",
    );
    expect(err.detail).toContain("payee");
    expect(f.fake.calls).toHaveLength(0);
    const plan = await client(f).plan(
      input({ feeRecipients, extension: { ...SNIPER, payee: PAYEE } }),
    );
    expect(plan.params.extension.payee).toBe(PAYEE);
    expect(plan.extension?.payee).toBe(PAYEE);
  });

  test("a reserved address, a suite contract or the launch's own distributor is never the payee", async () => {
    const f = fixture();
    for (const payee of [SUITE.ledger, SUITE.create3Factory]) {
      const err = await expectCode(
        client(f).plan(input({ extension: { ...SNIPER, payee } })),
        "INVALID_PARAMS",
      );
      expect(err.detail).toContain("extension.payee");
    }
    // The distributor's address is known only once the token is: a second plan with the first's salt names it.
    const first = await client(f).plan(input());
    const own = await expectCode(
      client(f).plan(
        input({
          salt: first.params.salt,
          extension: { ...SNIPER, payee: first.distributor },
        }),
      ),
      "INVALID_PARAMS",
    );
    expect(own.detail).toContain("own token, escrow or distributor");
  });
});

describe("a signed launchpad: the pad's authorization covers the extension", () => {
  test("the authorizer signs terms that carry it; any change to it after signing breaks the signature", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const f = fixture(signer.address);
    const seen: AuthorizationRequest[] = [];
    const c = client(f, {
      authorizer: padAuthorizer({
        account: signer,
        authorize: (r) => void seen.push(r),
      }),
    });
    const plan = await c.plan(input({ launchpadId: 2n }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.params.extension).toEqual(plan.params.extension);
    expect(seen[0]!.paramsHash).toBe(
      launchTermsHash(plan.params, LAUNCHER, 0n),
    );
    const { nonce, deadline, signature } = plan.params.authorization;
    const signedBy = (p: LaunchParams) =>
      recoverTypedDataAddress({
        ...launchAuthorizationTypedData({
          chainId: 8453,
          registry: SUITE.launchpadRegistry,
          launchpadId: 2n,
          launcher: LAUNCHER,
          paramsHash: launchTermsHash(p, LAUNCHER, 0n),
          nonce,
          deadline,
        }),
        signature,
      });
    expect(await signedBy(plan.params)).toBe(signer.address);
    // Every field of the extension is in the signed terms: a higher fee, another preset, a payee, or none at all.
    const e = plan.params.extension;
    for (const extension of [
      { ...e, params: sniperParams(60_000, 20_000, 300) },
      { ...e, id: 2 },
      { ...e, payee: PAYEE },
      { ...NO_EXTENSION },
    ])
      expect(await signedBy({ ...plan.params, extension })).not.toBe(
        signer.address,
      );
    // Unnamed, the payee is the first fee recipient, and the signature says so.
    expect(
      await signedBy({ ...plan.params, extension: { ...e, payee: LAUNCHER } }),
    ).toBe(signer.address);
  });
});

describe("custom code by address and codehash", () => {
  const EXT = fakeAddress(0xe47);
  // PUSH1 0 CALL STOP: a reachable CALL.
  const CODE: Hex = "0x6000f100";
  const custom: LaunchExtensionInput = {
    address: EXT,
    codehash: keccak256(CODE),
    maxBuyPips: 60_000,
    maxSellPips: 10_000,
    quoteOnly: false,
    sunsetSecs: 0,
  };
  const open = (): SuiteFixture => {
    const f = fixture();
    f.fake.setCode(EXT, CODE);
    Object.assign(f.pads.get(1n)!.pad.policy, {
      allowedExtensions: 7,
      maxExtensionPips: 100_000,
    });
    f.allowedExtensions.add(keccak256(CODE));
    return f;
  };

  test("binds once the allowlist holds its codehash and the launchpad's policy admits it", async () => {
    const c = client(open());
    const plan = await c.plan(input({ extension: custom }));
    expect(plan.params.extension).toEqual({
      ...NO_EXTENSION,
      ext: EXT,
      codehash: keccak256(CODE),
      maxBuyPips: 60_000,
      maxSellPips: 10_000,
    });
    expect(plan.extension).toMatchObject({
      kind: "custom",
      preset: null,
      address: EXT,
      scan: { callsOut: true, upgradeable: false, opcodes: ["CALL"] },
      label: "Calls out during your trade · DYOR",
      description: "Custom extension: buys up to +6%, sells up to +1%",
      gas: { quoteGas: 50_000, afterGas: 150_000 },
      swapGasHeadroom: 499_879n,
      allowlistKey: keccak256(CODE),
    });
    expect(plan.extension?.warnings).toContain("Buys can pay up to 6% extra.");
    await c.simulate(plan);
  });

  test("named budgets change the key: the allowlist holds code at the budgets it was reviewed at", async () => {
    const f = open();
    const budgets = { quoteGas: 250_000, afterGas: 1_000_000 };
    const err = await expectCode(
      client(f).plan(input({ extension: { ...custom, ...budgets } })),
      "EXTENSION_NOT_ALLOWED",
    );
    expect(err.detail).toContain("allowlist");
    const preview = await client(f).previewExtension(
      { ...custom, ...budgets },
      { launchpadId: 1n },
    );
    f.allowedExtensions.add(preview.allowlistKey);
    const plan = await client(f).plan(
      input({ extension: { ...custom, ...budgets } }),
    );
    expect(plan.params.extension).toMatchObject(budgets);
    expect(plan.extension?.swapGasHeadroom).toBe(1_687_316n);
  });

  test("the launchpad's policy and the hook's admission refuse it by name", async () => {
    const f = open();
    f.pads.get(1n)!.pad.policy.maxExtensionPips = 50_000;
    const cap = await expectCode(
      client(f).plan(input({ extension: custom })),
      "EXTENSION_NOT_ALLOWED",
    );
    expect(cap.detail).toContain("policy.maxExtensionPips");
    const g = open();
    const wrong = await expectCode(
      client(g).plan(
        input({ extension: { ...custom, codehash: keccak256("0x00") } }),
      ),
      "INVALID_PARAMS",
    );
    expect(wrong.detail).toContain("codehash");
    const none = await expectCode(
      client(g).plan(
        input({ extension: { ...custom, address: fakeAddress(0xe48) } }),
      ),
      "INVALID_PARAMS",
    );
    expect(none.detail).toContain("no contract code");
  });
});

describe("a launch's own liquidity bands with an extension", () => {
  test("an extension the hook calls after each swap makes the pool buy its own token, which holds the bands to the step rule", async () => {
    const f = fixture();
    setFakeCurveAllowed(f.pads.get(1n)!, ANY_CURVE, true);
    // runner_v1's rows as the launch's own bands: they pass only while the pool never buys its own token.
    const own = {
      autoLpBps: 0,
      curve: {
        startFdvUsd: 10_000,
        bands: [
          { widthTicks: 6_800, shareBps: 300 },
          { widthTicks: 110_000, shareBps: 9_500 },
          { widthTicks: 0, shareBps: 200 },
        ],
      },
    };
    // Sniper Tax only quotes a fee.
    const plan = await client(f).plan(input(own));
    expect(plan.extension?.terms.quoteOnly).toBe(true);
    // Raffle Run, the reference extension, buys back on sells.
    const raffle = encodeAbiParameters(
      [U24, U24, { type: "uint32" }, { type: "uint256" }],
      [10_000, 5_000, 86_400, 0n],
    );
    const err = await expectCode(
      client(f).plan(
        input({ ...own, extension: { presetId: 4, params: raffle } }),
      ),
      "INVALID_PARAMS",
    );
    expect(err.detail).toBe(curveRevertDetail("CurveStep", 2));
  });
});

describe("API mode", () => {
  test("Bankr's prepare endpoint takes no extension: the option is refused before it is called", async () => {
    let prepared = 0;
    const c = client(fixture(), {
      api: {
        preparer: async () => {
          prepared++;
          throw new Error("never called");
        },
      },
    });
    const err = await expectCode(c.plan(input()), "INVALID_PARAMS");
    expect(err.detail).toContain("pure mode");
    expect(prepared).toBe(0);
  });
});
