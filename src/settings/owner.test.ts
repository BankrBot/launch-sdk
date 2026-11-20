import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, zeroAddress, zeroHash } from "viem";
import {
  FakeSettings,
  OWNER,
  REGISTRY_OWNER,
  SUITE,
  TEMPLATE_ID,
  at,
} from "../__internal__/fakeSettings.js";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrLaunchpadRegistryAbi,
} from "../abis/settings.js";
import { isLaunchSdkError } from "../errors.js";
import { knobId, switchWord } from "./names.js";
import { createOwnerSettingsAdmin } from "./owner.js";
import { createOwnerLeversAdmin } from "./ownerSuite.js";
import { createSettingsReads } from "./reads.js";
import { WAD, type ChainPadTerms } from "./rules.js";

const refuses = async (
  run: Promise<unknown>,
  code: string,
  detail?: string,
) => {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isLaunchSdkError(err), `expected ${code}`).toBe(true);
  const e = err as { code: string; detail?: string };
  expect(e.code).toBe(code);
  if (detail) expect(e.detail).toContain(detail);
};
const RULE = "INVALID_SETTINGS";
const payees = (n: number, each: bigint): ChainPadTerms => ({
  payees: Array.from({ length: n }, (_, i) => at(0x700 + i)),
  steadySharesWad: Array.from({ length: n }, () => each),
  decay: { on: false, autoLpBps: 0, sharesWad: [] },
});

const setup = () => {
  const suite = new FakeSettings();
  return {
    suite,
    owner: createOwnerSettingsAdmin(suite.context()),
    levers: createOwnerLeversAdmin(suite.context()),
    settings: createSettingsReads(suite.context()),
  };
};

describe("the owner's terms", () => {
  test("a change is laid over the terms in force and sent whole, from the factory's owner", async () => {
    const { suite, owner } = setup();
    const { tx, stoppedPads } = await owner.setProtocolTerms({
      ctoNotice: 3_600,
      bankrFeeBps: 900,
    });
    expect(tx).toMatchObject({ from: OWNER, to: SUITE.settings, value: 0n });
    expect(
      decodeFunctionData({ abi: bankrLaunchSettingsAbi, data: tx.data }),
    ).toEqual({
      functionName: "setProtocolTerms",
      args: [{ ...suite.protocol, ctoNotice: 3_600, bankrFeeBps: 900 }],
    });
    // the payee count did not move: nothing is read and nothing is stopped
    expect(stoppedPads).toEqual([]);
    expect(suite.chain.callsTo("payeesOf")).toHaveLength(0);
  });

  test("a lower payee count lists the pads it would stop, Bankr's own among them", async () => {
    const { suite, owner } = setup();
    const two = suite.addPad(payees(2, 1n));
    suite.addPad(payees(1, 1n));
    const three = suite.addPad(payees(3, 1n));
    const { tx, stoppedPads } = await owner.setProtocolTerms({
      maxPadPayees: 1,
    });
    expect(stoppedPads).toEqual([
      { id: 0n, reason: "payeeCount", payees: 2, alreadyStopped: false },
      { id: two, reason: "payeeCount", payees: 2, alreadyStopped: false },
      { id: three, reason: "payeeCount", payees: 3, alreadyStopped: false },
    ]);
    suite.apply(tx);
    // a pad that was over the limit before the change is marked so
    const again = await owner.setProtocolTerms({ maxPadPayees: 2 });
    expect(again.stoppedPads).toEqual([
      { id: three, reason: "payeeCount", payees: 3, alreadyStopped: true },
    ]);
    expect(
      (await owner.setProtocolTerms({ maxPadPayees: 4 })).stoppedPads,
    ).toEqual([]);
  });

  test("a cut that fits no fee, or not the template's or Bankr's pad's, is refused when it is set", async () => {
    const { suite, owner } = setup();
    await refuses(
      owner.setProtocolTerms({ bankrFeeBps: 10_001 }),
      RULE,
      "10,000",
    );
    await refuses(owner.setProtocolTerms({ ctoNotice: 3_599 }), RULE, "3600");
    await refuses(owner.setProtocolTerms({ maxPadPayees: 17 }), RULE, "16");
    // the template's lowest fee is 500 pips: a floor of 501 pips of volume does not fit it
    await refuses(
      owner.setProtocolTerms({ bankrMinPips: 501 }),
      RULE,
      "template",
    );
    suite.template.ranges[knobId("steadyPips")!] = {
      min: 17_500n,
      max: 100_000n,
      dflt: 17_500n,
    };
    await refuses(
      owner.setProtocolTerms({ bankrMinPips: 17_501 }),
      RULE,
      "template",
    );
    suite.template.ranges[knobId("steadyPips")!] = {
      min: 20_000n,
      max: 100_000n,
      dflt: 20_000n,
    };
    await refuses(
      owner.setProtocolTerms({ bankrMinPips: 17_501 }),
      RULE,
      "pad 0",
    );
    await refuses(
      owner.setProtocolTerms({ nope: 1 } as never),
      "INVALID_PARAMS",
      "not one of",
    );
    await refuses(
      owner.setProtocolTerms({ bankrFeeBps: 65_536 }),
      "INVALID_PARAMS",
    );
  });

  test("the guards are merged and held to their floors", async () => {
    const { suite, owner } = setup();
    const tx = await owner.setGuardTerms({ maxCompoundUsd: 25_000 });
    suite.apply(tx);
    expect(suite.guards.maxCompoundUsd).toBe(25_000);
    expect(suite.guards.refTauSecs).toBe(1_800);
    await refuses(
      owner.setGuardTerms({ fillTravelTicks: 101 }),
      RULE,
      "minRoundTripPips",
    );
  });
});

describe("limits", () => {
  test("each named side moves inside the knob's hard range, read from the chain", async () => {
    const { suite, owner, settings } = setup();
    const { tx, stoppedPads } = await owner.setLimits({
      decaySecs: { max: 3_600 },
      vestBps: { min: 0, max: 5_000 },
    });
    expect(tx.from).toBe(OWNER);
    expect(stoppedPads).toEqual([]);
    expect(
      decodeFunctionData({ abi: bankrLaunchSettingsAbi, data: tx.data }),
    ).toEqual({
      functionName: "setLimits",
      args: [
        [knobId("decaySecs")!, knobId("vestBps")!],
        [
          { min: 0n, max: 3_600n },
          { min: 0n, max: 5_000n },
        ],
      ],
    });
    suite.apply(tx);
    expect((await settings.limits()).decaySecs).toEqual({
      min: 0n,
      max: 3_600n,
    });
    await refuses(
      owner.setLimits({ vestBps: { max: 10_000 } }),
      RULE,
      "hard range 0 to 9999",
    );
    await refuses(owner.setLimits({ vestBps: { min: 6_000 } }), RULE);
    await refuses(owner.setLimits({}), "INVALID_PARAMS", "no knob");
    await refuses(
      owner.setLimits({ nope: { max: 1 } } as never),
      "INVALID_PARAMS",
      "not a knob",
    );
    // a fee limit under Bankr's floor leaves the cut no fee to fit in
    await refuses(
      owner.setLimits({ steadyPips: { min: 0, max: 249 } }),
      RULE,
      "limits",
    );
  });

  test("a lower pad-share limit lists the pads whose payees take more, steady or decay", async () => {
    const { suite, owner } = setup();
    const heavy = suite.addPad(payees(2, WAD / 4n));
    const decay = suite.addPad({
      ...payees(1, 1n),
      decay: { on: true, autoLpBps: 0, sharesWad: [(WAD * 45n) / 100n] },
    });
    suite.addPad(payees(1, WAD / 4n));
    const { stoppedPads } = await owner.setLimits({
      padShareBps: { max: 4_000 },
    });
    // Bankr's own pad takes 69.8 % of the decay surplus: over 40 % too
    expect(stoppedPads.map((p) => [p.id, p.reason])).toEqual([
      [0n, "payeeShare"],
      [heavy, "payeeShare"],
      [decay, "payeeShare"],
    ]);
    expect(
      (await owner.setLimits({ padShareBps: { max: 7_000 } })).stoppedPads,
    ).toEqual([]);
  });
});

describe("the template and the allowed switches", () => {
  test("a template change reaches pads registered from now on, restating its switches and cap controller", async () => {
    const { suite, owner } = setup();
    const before = suite.addPad();
    suite.template.capController = at(0xcc);
    const tx = await owner.setTemplate({
      knobs: { vestBps: { max: 5_000, default: 1_500 } },
      switches: { unlistedQuotes: false },
    });
    expect(tx.from).toBe(OWNER);
    suite.apply(tx);
    expect(suite.template.flags).toBe(
      switchWord({ unlistedQuotes: false }, suite.template.flags),
    );
    expect(suite.template.capController).toBe(at(0xcc));
    expect(suite.template.ranges[knobId("vestBps")!]).toEqual({
      min: 0n,
      max: 5_000n,
      dflt: 1_500n,
    });
    expect(suite.pad(before).ranges[knobId("vestBps")!]!.max).toBe(9_999n);
    expect(suite.pad(suite.addPad()).ranges[knobId("vestBps")!]!.max).toBe(
      5_000n,
    );
    await refuses(
      owner.setTemplate({ switches: { takeover: true } }),
      RULE,
      "never part of the template",
    );
    await refuses(
      owner.setTemplate({ knobs: { steadyPips: { min: 499 } } }),
      RULE,
      "limit",
    );
    await refuses(
      owner.setTemplate({ knobs: { referrerBps: { max: 6_000 } } }),
      RULE,
      "Bankr's cut",
    );
  });

  test("the template's paused switch is never cleared in silence either", async () => {
    const { suite, owner } = setup();
    const held = suite.template.flags;
    suite.apply(await owner.setAllowedSwitches({ devBuy: false }));
    const knob = { knobs: { vestBps: { default: 1_500 } } };
    await refuses(owner.setTemplate(knob), RULE, "stopped allowing devBuy");
    expect(suite.template.flags).toBe(held);
    suite.apply(
      await owner.setTemplate({ ...knob, switches: { devBuy: false } }),
    );
    expect(suite.template.flags).toBe(switchWord({ devBuy: false }, held));
  });

  test("template preset limits and the allowed switches", async () => {
    const { suite, owner } = setup();
    suite.apply(
      await owner.setTemplatePresetLimits("sniperTax", { allowed: false }),
    );
    expect(suite.template.presetLimits.get(1)).toMatchObject({
      allowed: false,
      maxWindowSecs: 3_600,
    });
    await refuses(
      owner.setTemplatePresetLimits("raffleRun", { minAnchorTau: 1 }),
      RULE,
    );
    const tx = await owner.setAllowedSwitches({
      extCallsOut: false,
      unlistedQuotes: false,
    });
    suite.apply(tx);
    expect(suite.allowedFlags).toBe(
      switchWord({ extCallsOut: false, unlistedQuotes: false }, 2_047n),
    );
    // the owner may allow anything again: no switch is refused to the owner
    suite.apply(await owner.setAllowedSwitches({ extCallsOut: true }));
    expect(suite.allowedFlags).toBe(
      switchWord({ unlistedQuotes: false }, 2_047n),
    );
    await refuses(
      owner.setAllowedSwitches({ nope: true } as never),
      "INVALID_PARAMS",
    );
  });
});

describe("quotes, presets and the allowlist", () => {
  test("a new quote row takes the token's own decimals; a later change is laid over the row", async () => {
    const { suite, owner, settings } = setup();
    const usdc = at(0xc0);
    suite.chain.contract(usdc, erc20Abi, { decimals: 6 });
    suite.apply(
      await owner.setQuote(usdc, {
        pricing: "chainlink",
        maxPriceAge: 3_600,
        feed: at(0xfeed),
        compoundFloor: 250_000_000n,
        compoundCap: 500_000_000n,
        quoteActivation: 1_000_000n,
      }),
    );
    expect(await settings.quote(usdc)).toMatchObject({
      listed: true,
      pricing: "chainlink",
      decimals: 6,
    });
    expect(await settings.quotes()).toHaveLength(1);
    suite.apply(await owner.setQuote(usdc, { quotePaid: true }));
    expect(await settings.quote(usdc)).toMatchObject({
      quotePaid: true,
      compoundCap: 500_000_000n,
      feed: at(0xfeed),
    });
    expect(await settings.quotes()).toHaveLength(1);
    await refuses(
      owner.setQuote(usdc, { compoundCap: 1n }),
      RULE,
      "compoundCap",
    );
    await refuses(owner.setQuote(usdc, { pricing: "signed" }), RULE, "no feed");
    await refuses(
      owner.setQuote(usdc, { pricing: "twap" as never }),
      "INVALID_PARAMS",
    );
    // a key every object has is no pricing mode
    for (const name of ["constructor", "toString", "__proto__"])
      await refuses(
        owner.setQuote(usdc, { pricing: name as never }),
        "INVALID_PARAMS",
        "pricing is",
      );
    suite.apply(await owner.removeQuote(usdc));
    expect(await settings.quotes()).toEqual([]);
    await refuses(owner.removeQuote(usdc), RULE, "not listed");
  });

  test("a new row whose token does not answer decimals() is refused by name; with its decimals named it is built", async () => {
    const { suite, owner } = setup();
    const row = { pricing: "none", quoteActivation: 1n } as const;
    // no code at the address, and a contract with no decimals(), which reverts empty
    const empty = at(0xc1);
    const mute = at(0xc2);
    suite.chain.contract(mute, [], {});
    for (const quote of [empty, mute]) {
      await refuses(
        owner.setQuote(quote, row),
        "INVALID_PARAMS",
        "does not answer decimals()",
      );
      suite.apply(await owner.setQuote(quote, { ...row, decimals: 18 }));
      expect(suite.quotes.get(quote.toLowerCase())?.decimals).toBe(18);
    }
  });

  test("pricing, a preset record, an allowlist key and the BNKR-pair waiver", async () => {
    const { suite, owner } = setup();
    suite.apply(await owner.setPriceSigner(at(0x51)));
    expect(suite.priceSigner).toBe(at(0x51));
    suite.apply(await owner.setSequencerUptimeFeed(at(0x5e), 3_600));
    expect([suite.sequencerFeed, suite.sequencerGrace]).toEqual([
      at(0x5e),
      3_600,
    ]);
    suite.apply(await owner.setSequencerUptimeFeed(null, 0));
    expect(suite.sequencerFeed).toBe(zeroAddress);

    const hash = `0x${"11".repeat(32)}` as const;
    const record = {
      deployer: at(0xde),
      deployerCodeHash: hash,
      creationCodeHash: hash,
      selfPayee: false,
      active: true,
    };
    suite.apply(await owner.setPreset("decayTax", record));
    expect(suite.presets.get(2)).toEqual(record);
    suite.apply(await owner.setPreset("decayTax", null));
    expect(suite.presets.get(2)!.deployer).toBe(zeroAddress);
    await refuses(
      owner.setPreset("decayTax", { ...record, creationCodeHash: zeroHash }),
      RULE,
    );
    await refuses(
      owner.setPreset("decayTax", { ...record, deployerCodeHash: "0x12" }),
      "INVALID_PARAMS",
    );

    suite.apply(await owner.setExtensionAllowed(hash, true));
    expect(suite.extAllowed.has(hash)).toBe(true);
    await refuses(
      owner.setExtensionAllowed("0x12", true),
      "INVALID_PARAMS",
      "32 bytes",
    );

    const id = suite.addPad();
    suite.apply(await owner.setBnkrPairWaiver(id, false));
    expect(suite.pad(id).waived).toBe(false);
    const template = await owner.setBnkrPairWaiver("template", false);
    expect(
      decodeFunctionData({ abi: bankrLaunchSettingsAbi, data: template.data })
        .args,
    ).toEqual([TEMPLATE_ID, false]);
    await refuses(owner.setBnkrPairWaiver(id + 1n, true), "UNKNOWN_LAUNCHPAD");
  });

  test("Bankr's pad is configured by the owner: the fee and the payees in one call", async () => {
    const { suite, owner } = setup();
    const tx = await owner.configureBankrPad({
      knobs: { steadyPips: { min: 15_000, max: 15_000, default: 15_000 } },
      payees: [{ address: at(0x71), shareWad: 300_000_000_000_000_000n }],
    });
    expect(tx.from).toBe(OWNER);
    const { functionName, args } = decodeFunctionData({
      abi: bankrLaunchSettingsAbi,
      data: tx.data,
    });
    expect(functionName).toBe("configure");
    expect((args as readonly unknown[])[0]).toBe(0n);
    suite.apply(tx);
    expect(suite.pad(0n).ranges[knobId("steadyPips")!]!.dflt).toBe(15_000n);
    expect(suite.pad(0n).terms.payees).toEqual([at(0x71)]);
  });

  test("takeover paused by the owner stays on Bankr's pad through a configure: the call is refused, not sent without it", async () => {
    const { suite, owner, settings } = setup();
    const held = suite.pad(0n).flags;
    expect((await settings.pad()).switches.takeover).toBe(true);
    suite.apply(
      await owner.setAllowedSwitches({ takeover: false, devBuy: false }),
    );
    // pad 0's fee knobs and payees move only through configure, which writes the switches whole
    const fee = {
      knobs: { steadyPips: { min: 15_000, max: 15_000, default: 15_000 } },
      payees: [{ address: at(0x71), shareWad: 300_000_000_000_000_000n }],
    };
    await refuses(
      owner.configureBankrPad(fee),
      "INVALID_LAUNCHPAD_CONFIG",
      "switches: { devBuy: false, takeover: false }",
    );
    suite.apply(
      await owner.setAllowedSwitches({ takeover: true, devBuy: true }),
    );
    suite.apply(await owner.configureBankrPad(fee));
    expect(suite.pad(0n).flags).toBe(held);
    expect((await settings.pad()).switches).toMatchObject({
      takeover: true,
      devBuy: true,
    });
    // the owner who means it says so, and the word sent is the one asked for
    suite.apply(await owner.setAllowedSwitches({ takeover: false }));
    suite.apply(
      await owner.configureBankrPad({ switches: { takeover: false } }),
    );
    expect(suite.pad(0n).flags).toBe(switchWord({ takeover: false }, held));
  });
});

describe("the factory's and the registry's levers", () => {
  test("pause, gate and treasury come from the factory's owner", async () => {
    const { suite, levers } = setup();
    const unpause = await levers.setPaused(false);
    expect(unpause).toMatchObject({ from: OWNER, to: SUITE.factory });
    suite.apply(unpause);
    suite.apply(await levers.setLaunchGated(false));
    expect([suite.paused, suite.launchGated]).toEqual([false, false]);
    suite.apply(await levers.setTreasury(at(0xe2)));
    expect(suite.treasury).toBe(at(0xe2));
    await refuses(levers.setTreasury(SUITE.ledger), RULE, "launch contracts");
    suite.named.set(at(0xe7).toLowerCase(), 1n);
    await refuses(levers.setTreasury(at(0xe7)), RULE, "quote ever listed");
  });

  test("a hook and a leg must hold code, and a leg is named once", async () => {
    const { suite, levers } = setup();
    await refuses(levers.setHook(at(0xc2)), RULE, "no code");
    suite.chain.setCode(at(0xc2), "0x60");
    suite.apply(await levers.setHook(at(0xc2)));
    expect(suite.hook).toBe(at(0xc2));
    suite.chain.setCode(suite.holderLeg, "0x60");
    await refuses(levers.setHolderLeg(suite.holderLeg), RULE, "named once");
    suite.chain.setCode(at(0xd2), "0x60");
    const tx = await levers.setHolderLeg(at(0xd2));
    expect(
      decodeFunctionData({ abi: bankrLaunchFactoryAbi, data: tx.data }),
    ).toEqual({
      functionName: "setHolderLeg",
      args: [at(0xd2)],
    });
  });

  test("both ownerships hand over in two steps, each accepted by its own pending owner", async () => {
    const { suite, levers } = setup();
    await refuses(levers.acceptOwnership(), RULE, "No ownership handover");
    suite.apply(await levers.transferOwnership(at(0xa9)));
    const accept = await levers.acceptOwnership();
    expect(accept).toMatchObject({ from: at(0xa9), to: SUITE.factory });
    suite.apply(accept);
    expect(suite.owner).toBe(at(0xa9));
    const transfer = await levers.transferRegistryOwnership(at(0xa8));
    expect(transfer).toMatchObject({
      from: REGISTRY_OWNER,
      to: SUITE.launchpadRegistry,
    });
    suite.apply(transfer);
    const acceptRegistry = await levers.acceptRegistryOwnership();
    expect(acceptRegistry.from).toBe(at(0xa8));
    suite.apply(acceptRegistry);
    expect(suite.registryOwner).toBe(at(0xa8));
  });

  test("a pending handover is called off with null, as Ownable2Step takes the zero address", async () => {
    const { suite, levers } = setup();
    suite.apply(await levers.transferOwnership(at(0xa9)));
    expect(suite.pendingOwner).toBe(at(0xa9));
    const cancel = await levers.transferOwnership(null);
    expect(cancel).toMatchObject({ from: OWNER, to: SUITE.factory });
    expect(
      decodeFunctionData({ abi: bankrLaunchFactoryAbi, data: cancel.data }),
    ).toEqual({ functionName: "transferOwnership", args: [zeroAddress] });
    suite.apply(cancel);
    expect(suite.pendingOwner).toBe(zeroAddress);
    await refuses(levers.acceptOwnership(), RULE, "No ownership handover");

    suite.apply(await levers.transferRegistryOwnership(at(0xa8)));
    const cancelRegistry = await levers.transferRegistryOwnership(null);
    expect(cancelRegistry.from).toBe(REGISTRY_OWNER);
    suite.apply(cancelRegistry);
    expect(suite.registryPendingOwner).toBe(zeroAddress);
    await refuses(levers.acceptRegistryOwnership(), RULE);
    // the zero address itself is still no owner to name: null is the word for calling it off
    await refuses(levers.transferOwnership(zeroAddress), "INVALID_PARAMS");
    await refuses(
      levers.transferOwnership(undefined as never),
      "INVALID_PARAMS",
    );
  });

  test("the registry's own levers come from the registry's owner", async () => {
    const { suite, levers } = setup();
    const id = suite.addPad();
    const bond = await levers.setRegistrationBond(0n);
    expect(bond).toMatchObject({
      from: REGISTRY_OWNER,
      to: SUITE.launchpadRegistry,
    });
    suite.apply(bond);
    suite.apply(await levers.setMaxPadUriBytes(4_096));
    suite.apply(await levers.setBankrSigner(at(0x51)));
    suite.apply(await levers.setVerified(id, true));
    expect([
      suite.bond,
      suite.maxUri,
      suite.pad(0n).signer,
      suite.pad(id).verified,
    ]).toEqual([0n, 4_096, at(0x51), true]);
    await refuses(levers.setVerified(id + 1n, true), "UNKNOWN_LAUNCHPAD");
    await refuses(levers.revokeVanity(id), RULE, "no vanity");
    suite.pad(id).vanity = { suffix: 0xbeef, nibbles: 4 };
    await refuses(
      levers.assignVanity({ suffix: 0xbeef, nibbles: 4 }, id),
      RULE,
      "holds",
    );
    suite.apply(await levers.revokeVanity(id));
    const assign = await levers.assignVanity(
      { suffix: 0xbeef, nibbles: 4 },
      id,
    );
    expect(
      decodeFunctionData({ abi: bankrLaunchpadRegistryAbi, data: assign.data }),
    ).toEqual({
      functionName: "assignVanity",
      args: [0xbeef, 4, id],
    });
  });

  test("Bankr's own three-digit suffix, revoked, is assigned back; a refusal carries the owner's code", async () => {
    const { suite, levers } = setup();
    const own = { suffix: 0xba3, nibbles: 3 };
    suite.pad(0n).vanity = own;
    suite.apply(await levers.revokeVanity(0n));
    const assign = await levers.assignVanity(own, 0n);
    expect(assign.from).toBe(REGISTRY_OWNER);
    expect(
      decodeFunctionData({ abi: bankrLaunchpadRegistryAbi, data: assign.data }),
    ).toEqual({ functionName: "assignVanity", args: [0xba3, 3, 0n] });
    // a suffix nobody holds is the owner's refusal, not a pad's; a shape that is no suffix is a bad value
    await refuses(levers.assignVanity({ suffix: 0xba4, nibbles: 3 }, 0n), RULE);
    await refuses(
      levers.assignVanity({ suffix: 0x1000, nibbles: 3 }, 0n),
      "INVALID_PARAMS",
    );
    await refuses(
      levers.assignVanity({ suffix: 1, nibbles: 7 }, 0n),
      "INVALID_PARAMS",
    );
    await refuses(levers.assignVanity(null as never, 0n), "INVALID_PARAMS");
  });
});
