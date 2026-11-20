// What a plan settles itself, before and beside the chain's launch check: who may be paid, how a dev buy is funded,
// a signed launchpad's signature, the salt, and the shape of what a launch names. Against the fake contracts.
import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  zeroAddress,
  type Abi,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { FakeChain } from "../__internal__/fakeRpc.js";
import { fakeAddress } from "../__internal__/fakeRecord.js";
import {
  FAKE_TOKENS_PER_UNIT,
  installContracts,
  type ContractsFixture,
} from "../__internal__/fakeContracts.js";
import {
  FRESH_PAD_ID,
  FRESH_QUOTE,
  freshContractsState,
} from "../__internal__/fakeContractsState.js";
import { bankrLaunchFactoryAbi } from "../abis/generated.js";
import type { AuthorizationRequest, Authorizer } from "../authorizer.js";
import { CHAINS } from "../chains/index.js";
import { createLaunchClient } from "../client.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "../errors.js";
import type { LaunchInput } from "../providers/types.js";
import { HOLDER_LEG_REFERENCES_ABI } from "../recipient.js";
import { launchTermsHash } from "../terms.js";
import { launchPinsOf } from "./options.js";
import { KNOB, PAD_FLAG } from "./settings.js";

const USDC = getAddress(CHAINS.base.quotes.USDC.address);
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");

/** A fresh deployment's open launchpad, taking a dev buy of up to 2 %; `usdc` pairs it with an ERC-20. */
function fixture(o: { usdc?: boolean } = {}): ContractsFixture {
  const state = freshContractsState();
  const ranges = [...state.pad!.ranges];
  ranges[KNOB.devBuyMaxBps] = { min: 0n, max: 200n, dflt: 200n };
  state.pad = { ...state.pad!, ranges };
  if (!o.usdc)
    return installContracts(new FakeChain(base), {
      state,
      padId: FRESH_PAD_ID,
      quote: FRESH_QUOTE,
    });
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
  return installContracts(new FakeChain(base), {
    state,
    padId: FRESH_PAD_ID,
    quote: USDC,
    weth: getAddress(CHAINS.base.quotes.WETH.address),
  });
}

const client = (f: ContractsFixture, o: { authorizer?: Authorizer } = {}) =>
  createLaunchClient({
    chain: "base",
    publicClient: f.fake.publicClient(),
    addresses: f.deployment,
    fork: true,
    ...o,
  });

const input = (
  f: ContractsFixture,
  over: Partial<LaunchInput<"base">> = {},
): LaunchInput<"base"> => ({
  name: "Launch SDK Test",
  symbol: "LSDK",
  metadataUri: "ipfs://bafy-test",
  launcher: LAUNCHER,
  launchpadId: f.padId,
  quote: f.quote,
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
    `${code}, got ${String((thrown as Error)?.message ?? thrown)}: ${String((thrown as { detail?: string })?.detail)}`,
  ).toBe(true);
  return thrown as { message: string; detail?: string };
}

const signature = {
  nonce: `0x${"11".repeat(32)}`,
  deadline: 2_000_000_000n,
  signature: `0x${"22".repeat(65)}`,
} as const;

describe("who a launch may pay", () => {
  test("a fee recipient that cannot claim is refused", async () => {
    const f = fixture();
    f.fake.setCode(OTHER, "0x6080");
    await expectCode(
      client(f).plan(input(f, { feeRecipient: OTHER })),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    await expectCode(
      client(f).plan(input(f, { feeRecipient: f.deployment.ledger })),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    // The FEES_TO_HOLDERS family: routing markers nobody can claim as.
    await expectCode(
      client(f).plan(
        input(f, {
          feeRecipient: "0x968b0c1e896Fb1DdB2042957FC0614c67AB7ffC3",
        }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    // An open contract is refused, since a stranger's settle moves its share where collectFees never returns it.
    const open = await expectCode(
      client(f).plan(
        input(f, { feeRecipient: OTHER, allowContractFeeRecipient: true }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    expect(open.detail).toContain("setClaimRestricted(true)");
    // A 7702 wallet needs neither the flag nor the restriction.
    f.fake.setCode(OTHER, `0xef0100${"ab".repeat(20)}`);
    expect(
      (await client(f).plan(input(f, { feeRecipient: OTHER }))).params
        .feeRecipients,
    ).toEqual([{ recipient: OTHER, shareBps: 10_000 }]);
  });

  test("a contract that restricted its claims is admitted; on a coin that can be taken over it names its claim operator", async () => {
    const f = fixture();
    const operator = fakeAddress(0x09e7);
    f.fake.setCode(OTHER, "0x6080");
    f.restricted.add(OTHER.toLowerCase());
    const flags = { feeRecipient: OTHER, allowContractFeeRecipient: true };
    const ok = await client(f).plan(input(f, flags));
    expect(ok.params.feeRecipients[0]!.recipient).toBe(OTHER);
    // The pad switches takeover on: a takeover settles the contract's share where only it or its operator reaches.
    f.state = {
      ...f.state,
      pad: { ...f.state.pad!, flags: f.state.pad!.flags | PAD_FLAG.takeover },
    };
    await expectCode(
      client(f).plan(input(f, flags)),
      "CLAIM_OPERATOR_REQUIRED",
    );
    f.operators.add(`${OTHER.toLowerCase()}:${operator.toLowerCase()}`);
    const named = await client(f).plan(
      input(f, { ...flags, claimOperator: operator }),
    );
    expect(named.resolved.terms.takeover).toBe(true);
  });

  test("the launch's quote token is refused as a fee recipient, with the open-code waiver or without", async () => {
    const f = fixture({ usdc: true });
    const waived = {
      allowContractFeeRecipient: true,
      allowOpenCodeFeeRecipients: true,
    };
    for (const flags of [{}, waived]) {
      const err = await expectCode(
        client(f).plan(input(f, { feeRecipient: USDC, ...flags })),
        "FEE_RECIPIENT_CANNOT_CLAIM",
      );
      expect(err.detail).toContain("this launch's quote token");
      expect(err.detail).not.toContain("allowOpenCodeFeeRecipients, which");
    }
    // In any position of a list: the refusal names its entry.
    const listed = await expectCode(
      client(f).plan(
        input(f, {
          feeRecipients: [
            { recipient: LAUNCHER, shareBps: 6_000 },
            { recipient: USDC, shareBps: 4_000 },
          ],
          ...waived,
        }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    expect(listed.detail).toStartWith(`feeRecipients[1] (${USDC}): `);
    expect(listed.detail).toContain("this launch's quote token");
  });

  test("the CREATE3 factory is refused as a fee or vesting recipient, though the factory's isSuite does not hold it", async () => {
    const f = fixture();
    const create3 = f.deployment.create3Factory;
    f.fake.setCode(create3, "0x6080");
    // Restricted claims and both flags: every other rule would let it through.
    f.restricted.add(create3.toLowerCase());
    await expectCode(
      client(f).plan(
        input(f, {
          feeRecipient: create3,
          allowContractFeeRecipient: true,
          allowOpenCodeFeeRecipients: true,
        }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    const vest = await expectCode(
      client(f).plan(
        input(f, {
          vesting: {
            bps: 1_000,
            recipient: create3,
            allowContractRecipient: true,
          },
        }),
      ),
      "INVALID_PARAMS",
    );
    expect(vest.detail).toContain("Bankr launch contract");
  });

  test("a contract vesting recipient needs the opt-in, and another launch's contract is refused with it too", async () => {
    const f = fixture();
    f.fake.setCode(OTHER, "0x6080");
    await expectCode(
      client(f).plan(input(f, { vesting: { bps: 1_000, recipient: OTHER } })),
      "INVALID_PARAMS",
    );
    const vesting = {
      bps: 1_000,
      recipient: OTHER,
      allowContractRecipient: true,
    };
    const allowed = await client(f).plan(input(f, { vesting }));
    expect(allowed.params.allowCodeVestingRecipient).toBe(true);
    expect(allowed.escrow).not.toBeNull();
    // Another launch's token (the factory's isSuite): refused as a launch contract, opt-in or not.
    f.fake.contract(f.deployment.factory, bankrLaunchFactoryAbi as Abi, {
      isSuite: ([a]: readonly unknown[]) =>
        String(a).toLowerCase() === OTHER.toLowerCase(),
    });
    const refused = await expectCode(
      client(f).plan(input(f, { vesting })),
      "INVALID_PARAMS",
    );
    expect(refused.detail).toContain("Bankr launch contract");
  });

  test("a fee or vesting recipient with a one-digit typo breaks its EIP-55 checksum and is refused", async () => {
    const f = fixture();
    const intended = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    const typo = `${intended.slice(0, -1)}${intended.endsWith("d") ? "e" : "E"}`;
    expect(isAddress(typo)).toBe(false);
    const err = await expectCode(
      client(f).plan(input(f, { feeRecipient: typo as Address })),
      "INVALID_PARAMS",
    );
    expect(err.detail).toBe(
      "feeRecipient does not match its EIP-55 checksum; check for a typo.",
    );
    const vest = await expectCode(
      client(f).plan(
        input(f, { vesting: { bps: 1_000, recipient: typo as Address } }),
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
        input(f, { feeRecipient: spelling as Address }),
      );
      expect(ok.params.feeRecipients[0]!.recipient).toBe(intended);
    }
  });

  test("the holder leg's references are read live: after a BNKR swap the new oracle is one of Bankr's contracts too", async () => {
    const f = fixture();
    const swapped = fakeAddress(0x8015);
    f.fake.contract(f.deployment.holderLeg, HOLDER_LEG_REFERENCES_ABI as Abi, {
      references: swapped,
    });
    await expectCode(
      client(f).plan(
        input(f, { feeRecipient: swapped, allowContractFeeRecipient: true }),
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
  });
});

describe("fee recipient lists", () => {
  const A = getAddress("0x000000000000000000000000000000000000a001");
  const B = getAddress("0x000000000000000000000000000000000000a002");
  const SPLIT = [
    { recipient: A, shareBps: 7_000 },
    { recipient: B, shareBps: 3_000 },
  ];

  /** The pad takes up to ten recipients (the template's default is one). */
  function listFixture(): ContractsFixture {
    const f = fixture();
    const ranges = [...f.state.pad!.ranges];
    ranges[KNOB.feeRecipients] = { min: 1n, max: 10n, dflt: 10n };
    f.state = { ...f.state, pad: { ...f.state.pad!, ranges } };
    return f;
  }

  test("the list binds in its order and simulates; the recipients are not in the token's address", async () => {
    const f = listFixture();
    const plan = await client(f).plan(input(f, { feeRecipients: SPLIT }));
    expect(plan.params.feeRecipients).toEqual(SPLIT);
    expect(plan.params.allowOpenCodeFeeRecipients).toBe(false);
    expect((await client(f).simulate(plan)).token).toBe(plan.predictedToken);
    const one = await client(f).plan(input(f, { salt: plan.params.salt }));
    expect(one.predictedToken).toBe(plan.predictedToken);
  });

  test("a malformed list is INVALID_PARAMS with the rule it breaks, before the chain is asked", async () => {
    const f = listFixture();
    const c = client(f);
    const r = (n: number, shareBps: number) => ({
      recipient: getAddress(`0x${(0xa000 + n).toString(16).padStart(40, "0")}`),
      shareBps,
    });
    const cases: [LaunchInput<"base">["feeRecipients"], string][] = [
      [[], "Name at least one fee recipient."],
      [[r(0, 10_000), r(1, 0)], "Each fee recipient needs a share above 0%"],
      [[r(0, 5_000), r(0, 5_000)], "Each fee recipient can be listed once."],
      [[r(0, 5_000), r(1, 4_999)], "Fee recipient shares must add up to 100%."],
      [
        [{ recipient: zeroAddress, shareBps: 10_000 }],
        "feeRecipients[0].recipient is the zero address.",
      ],
    ];
    for (const [feeRecipients, detail] of cases) {
      const err = await expectCode(
        c.plan(input(f, { feeRecipients })),
        "INVALID_PARAMS",
      );
      expect(err.detail).toContain(detail);
    }
    const both = await expectCode(
      c.plan(input(f, { feeRecipient: A, feeRecipients: SPLIT })),
      "INVALID_PARAMS",
    );
    expect(both.detail).toBe("Set feeRecipient or feeRecipients, not both.");
    expect(f.fake.calls).toEqual([]);
    // How many a launch may name is the launchpad's own limit, judged by the chain's launch check.
    const ten = Array.from({ length: 10 }, (_, n) => r(n, 1_000));
    expect(
      (await c.plan(input(f, { feeRecipients: ten }))).params.feeRecipients,
    ).toEqual(ten);
    const eleven = Array.from({ length: 11 }, (_, n) =>
      r(n, n === 0 ? 910 : 909),
    );
    const over = await expectCode(
      c.plan(input(f, { feeRecipients: eleven })),
      "OUTSIDE_LAUNCHPAD_RANGE",
    );
    expect(over.detail).toContain("fee recipients");
  });

  test("several fee recipients: the extension's payee is named, or the launch is refused before any chain read", async () => {
    const f = listFixture();
    const sniper = {
      preset: "sniper_tax",
      buyPips: 50_000,
      sellPips: 20_000,
      endSecs: 300,
    } as const;
    const err = await expectCode(
      client(f).plan(input(f, { feeRecipients: SPLIT, extension: sniper })),
      "INVALID_PARAMS",
    );
    expect(err.detail).toContain("Name the extension's payee");
    expect(f.fake.calls).toEqual([]);
  });
});

describe("dev buys", () => {
  test("native on the chain's wrapped token: msg.value, no approval, the floor at the slippage", async () => {
    const f = fixture();
    const plan = await client(f).plan(
      input(f, { devBuy: { amount: 10n ** 15n, slippageBps: 500 } }),
    );
    expect(plan.quote.devBuy).toBe("native");
    expect(plan.value).toBe(10n ** 15n);
    expect(plan.params.devBuyAmountIn).toBe(0n);
    expect(plan.devBuyOut).toBe(10n ** 15n * FAKE_TOKENS_PER_UNIT);
    expect(plan.params.devBuyMinOut).toBe((plan.devBuyOut * 9_500n) / 10_000n);
    expect(plan.approvals).toEqual([]);
  });

  test("an ERC-20 quote: approve the factory for exactly the amount; simulated through the slot override", async () => {
    const f = fixture({ usdc: true });
    const plan = await client(f).plan(
      input(f, { devBuy: { amount: 5_000_000n } }),
    );
    expect(plan.quote).toMatchObject({ symbol: "USDC", devBuy: "erc20" });
    expect(plan.value).toBe(0n);
    expect(plan.params.devBuyAmountIn).toBe(5_000_000n);
    expect(plan.approvals).toHaveLength(1);
    const a = plan.approvals[0]!;
    expect(a.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: a.data }).args).toEqual([
      f.deployment.factory,
      5_000_000n,
    ]);
    // simulate() runs from the launcher's real balance, assuming only the pending approval.
    f.fake.setErc20Balance(USDC, LAUNCHER, 5_000_000n);
    const sim = await client(f).simulate(plan);
    expect(sim.assumedApprovals).toBe(true);
  });
});

describe("a launchpad with a signer", () => {
  const SIGNER = fakeAddress(0x5161);

  /** The pad signs its launches, and its tokens end in `…a`. */
  function signedFixture(): ContractsFixture {
    const f = fixture();
    f.pad.signer = SIGNER;
    f.pad.vanity = { suffix: 0xa, nibbles: 1 };
    return f;
  }

  test("without an authorizer it is AUTHORIZATION_REQUIRED; Bankr's own pad always is, and each says what is true of it", async () => {
    const f = signedFixture();
    const missing = await expectCode(
      client(f).plan(input(f)),
      "AUTHORIZATION_REQUIRED",
    );
    expect(missing.message).toBe(
      "This launchpad signs its launches, and this launch has no signature from it.",
    );
    expect(missing.detail).toBe("Pass the client this launchpad's authorizer.");
    // Bankr's pad: an authorizer would not help, and neither sentence says to pass one.
    const own = await expectCode(
      client(f, { authorizer: async () => signature }).plan(
        input(f, { launchpadId: 0n }),
      ),
      "AUTHORIZATION_REQUIRED",
    );
    expect(own.message).toBe(missing.message);
    expect(own.detail).toContain("launchpadId");
    expect(`${own.message} ${own.detail}`).not.toContain("authorizer");
  });

  test("the authorizer signs the final terms, pins included; the salt carries the pad's vanity", async () => {
    const f = signedFixture();
    const seen: AuthorizationRequest[] = [];
    const plan = await client(f, {
      authorizer: async (r) => {
        seen.push(r);
        return signature;
      },
    }).plan(input(f));
    expect(seen).toHaveLength(1);
    const r = seen[0]!;
    expect(r.launchpadId).toBe(f.padId);
    expect(r.signer).toBe(SIGNER);
    expect(r.registry).toBe(f.deployment.launchpadRegistry);
    expect(r.paramsHash).toBe(launchTermsHash(r.params, LAUNCHER, 0n));
    // What is signed is what is sent: the options with both pins.
    expect(r.params.options).toBe(plan.params.options);
    expect(launchPinsOf(r.params.options).expectedTermsHash).toBe(
      plan.resolved.resolvedHash,
    );
    expect(plan.params.authorization.nonce).toBe(signature.nonce);
    expect(plan.predictedToken.toLowerCase().endsWith("a")).toBe(true);
  });

  test("a malformed authorization is AUTHORIZATION_INVALID", async () => {
    const f = signedFixture();
    const c = client(f, {
      authorizer: async () =>
        ({ nonce: "0x12", deadline: 1n, signature: "0x" }) as never,
    });
    await expectCode(c.plan(input(f)), "AUTHORIZATION_INVALID");
  });

  test("a caller's salt must carry the pad's vanity, and a taken token is POOL_ALREADY_INITIALIZED", async () => {
    const f = signedFixture();
    const authorizer = async () => signature;
    const first = await client(f, { authorizer }).plan(input(f));
    const again = await client(f, { authorizer }).plan(
      input(f, { salt: first.params.salt }),
    );
    expect(again.predictedToken).toBe(first.predictedToken);
    let bad = 0n;
    for (; ; bad++) {
      const salt = `0x${bad.toString(16).padStart(64, "0")}` as const;
      try {
        await client(f, { authorizer }).plan(input(f, { salt }));
      } catch (err) {
        if (isLaunchSdkError(err, "INVALID_PARAMS")) break;
        throw err;
      }
    }
    f.fake.setCode(first.predictedToken, "0x6080");
    await expectCode(
      client(f, { authorizer }).plan(input(f, { salt: first.params.salt })),
      "POOL_ALREADY_INITIALIZED",
    );
  });
});

describe("the factory's switches and what a launch names", () => {
  test("a paused factory, a gated one and a paused launchpad refuse by name", async () => {
    const f = fixture();
    const set = (fn: string, value: boolean) =>
      f.fake.contract(f.deployment.factory, bankrLaunchFactoryAbi as Abi, {
        [fn]: value,
      });
    set("paused", true);
    await expectCode(client(f).plan(input(f)), "PAUSED");
    set("paused", false);
    set("launchGated", true);
    await expectCode(client(f).plan(input(f)), "LAUNCHPAD_GATED");
    set("launchGated", false);
    f.pad.paused = true;
    await expectCode(client(f).plan(input(f)), "LAUNCHPAD_PAUSED");
    f.pad.paused = false;
    await expectCode(
      client(f).plan(input(f, { launchpadId: f.padId + 1n })),
      "UNKNOWN_LAUNCHPAD",
    );
    expect((await client(f).plan(input(f))).launchpadId).toBe(f.padId);
  });

  test("a start time is a Date or unix seconds, never milliseconds; a salt is used once", async () => {
    const f = fixture();
    const c = client(f);
    const ms = await expectCode(
      c.plan(input(f, { startTime: Date.now() + 3_600_000 })),
      "INVALID_PARAMS",
    );
    expect(ms.detail).toBe("startTime is unix seconds, not milliseconds.");
    await expectCode(
      c.plan(input(f, { startTime: new Date(0) })),
      "INVALID_PARAMS",
    );
    await expectCode(c.plan(input(f, { salt: "0x12" })), "INVALID_PARAMS");
  });
});
