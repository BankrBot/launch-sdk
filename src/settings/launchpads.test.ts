import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  getAddress,
  zeroAddress,
  type TransactionReceipt,
} from "viem";
import { eventLog } from "../__internal__/fakeRpc.js";
import {
  FakeSettings,
  OPERATOR,
  OWNER,
  REGISTRY_OWNER,
  SUITE,
  at,
} from "../__internal__/fakeSettings.js";
import {
  bankrLaunchSettingsAbi,
  bankrLaunchpadRegistryAbi,
} from "../abis/settings.js";
import { isLaunchSdkError } from "../errors.js";
import { PAD_TREASURY_MARKER } from "../launchpad.js";
import type { UnsignedTx } from "../providers/types.js";
import { createLaunchpadAdmin } from "./launchpads.js";
import { knobId, switchWord } from "./names.js";
import { createSettingsReads } from "./reads.js";
import { WAD } from "./rules.js";

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
const PAD = "INVALID_LAUNCHPAD_CONFIG";

const setup = () => {
  const fakeSettings = new FakeSettings();
  const id = fakeSettings.addPad();
  return {
    fakeSettings,
    id,
    pads: createLaunchpadAdmin(fakeSettings.context()),
    settings: createSettingsReads(fakeSettings.context()),
  };
};
const settingsCall = (tx: UnsignedTx) =>
  decodeFunctionData({ abi: bankrLaunchSettingsAbi, data: tx.data });

describe("register", () => {
  test("from the operator, paying the live bond, with the payees as WAD shares", async () => {
    const { fakeSettings, pads } = setup();
    const tx = await pads.register({
      operator: at(0xb2),
      payees: [{ address: at(0x71), shareBps: 2_500 }],
      metadataUri: "ipfs://pad",
    });
    expect(tx).toMatchObject({
      chainId: 8453,
      from: at(0xb2),
      to: SUITE.launchpadRegistry,
      value: 10n ** 16n,
    });
    expect(
      decodeFunctionData({ abi: bankrLaunchpadRegistryAbi, data: tx.data }),
    ).toEqual({
      functionName: "register",
      args: [zeroAddress, [at(0x71)], [WAD / 4n], "ipfs://pad"],
    });
    fakeSettings.apply(tx);
    const pad = await createSettingsReads(fakeSettings.context()).pad(2n);
    expect(pad.operator).toBe(at(0xb2));
    expect(pad.switches.takeover).toBe(false);
    expect(pad.payees).toEqual([
      { address: at(0x71), steadyShareWad: WAD / 4n, decayShareWad: 0n },
    ]);
  });

  test("held to the owner's payee count and share limit, the link's byte limit, and a pad with no decay split", async () => {
    const { fakeSettings, pads } = setup();
    const one = [{ address: at(0x71), shareBps: 6_000 }];
    fakeSettings.protocol = { ...fakeSettings.protocol, maxPadPayees: 0 };
    await refuses(
      pads.register({ operator: at(0xb2), payees: one }),
      PAD,
      "at most 0",
    );
    fakeSettings.protocol = { ...fakeSettings.protocol, maxPadPayees: 4 };
    fakeSettings.limits[knobId("padShareBps")!] = { min: 0n, max: 5_999n };
    await refuses(
      pads.register({ operator: at(0xb2), payees: one }),
      PAD,
      "5999 bps",
    );
    fakeSettings.limits[knobId("padShareBps")!] = { min: 0n, max: 6_000n };
    fakeSettings.maxUri = 3;
    await refuses(
      pads.register({ operator: at(0xb2), payees: one, metadataUri: "abcd" }),
      PAD,
      "3 bytes",
    );
    await refuses(
      pads.register({
        operator: at(0xb2),
        payees: [{ address: at(0x71), shareBps: 1, decayShareBps: 1 }],
      }),
      "INVALID_PARAMS",
      "decay split",
    );
    await refuses(
      pads.register({ operator: at(0xb2), payees: [{ address: at(0x71) }] }),
      "INVALID_PARAMS",
      "shareBps or shareWad",
    );
  });

  test("a suite contract is refused as a payee: no launch on the pad would go through", async () => {
    const { pads } = setup();
    await refuses(
      pads.register({
        operator: at(0xb2),
        payees: [{ address: SUITE.ledger, shareBps: 1 }],
      }),
      PAD,
      "cannot be a payee",
    );
  });

  test("the new id is read from the registry's own event in the receipt", () => {
    const { pads } = setup();
    const log = (address: `0x${string}`, id: bigint) => ({
      ...eventLog(
        bankrLaunchpadRegistryAbi,
        "LaunchpadRegistered",
        { id, operator: OPERATOR, signer: zeroAddress, metadataUri: "" },
        address,
      ),
      removed: false,
    });
    const receipt = (logs: unknown[]) =>
      ({
        logs,
        transactionHash: `0x${"00".repeat(32)}`,
      }) as unknown as TransactionReceipt;
    expect(
      pads.launchpadIdFromReceipt(receipt([log(SUITE.launchpadRegistry, 7n)])),
    ).toBe(7n);
    // the same event from another address is not this registry's
    expect(() =>
      pads.launchpadIdFromReceipt(receipt([log(at(0x99), 7n)])),
    ).toThrow();
  });
});

describe("configure", () => {
  test("built from the pad's live row: only the named knobs move, and the rest is restated as it stands", async () => {
    const { fakeSettings, id, pads, settings } = setup();
    fakeSettings.pad(id).capController = at(0xcc);
    fakeSettings.pad(id).terms = {
      payees: [at(0x71)],
      steadySharesWad: [WAD / 10n],
      decay: { on: false, autoLpBps: 0, sharesWad: [] },
    };
    const before = await settings.pad(id);
    const tx = await pads.configure(id, {
      knobs: {
        steadyPips: { default: 20_000 },
        vestBps: { min: 100n, max: 200n, default: 150n },
      },
      switches: { devBuy: false },
    });
    expect(tx.from).toBe(OPERATOR);
    expect(tx.to).toBe(SUITE.settings);
    const call = settingsCall(tx);
    if (call.functionName !== "configure") throw new Error(call.functionName);
    const config = call.args[1];
    expect(config.knobs).toEqual([knobId("steadyPips")!, knobId("vestBps")!]);
    expect(config.flags).toBe(
      switchWord({ devBuy: false }, fakeSettings.pad(id).flags),
    );
    expect(config.capController).toBe(at(0xcc));
    expect(config.terms.payees).toEqual([at(0x71)]);
    fakeSettings.apply(tx);
    const after = await settings.pad(id);
    expect(after.knobs.steadyPips).toEqual({
      min: 500n,
      max: 100_000n,
      default: 20_000n,
    });
    expect(after.knobs.vestBps).toEqual({
      min: 100n,
      max: 200n,
      default: 150n,
    });
    expect(after.switches).toEqual({ ...before.switches, devBuy: false });
    expect(after.payees).toEqual(before.payees);
    expect(after.capController).toBe(at(0xcc));
    expect({ ...after.knobs, steadyPips: 0, vestBps: 0 }).toEqual({
      ...before.knobs,
      steadyPips: 0,
      vestBps: 0,
    });
  });

  test("an empty configure restates the pad and changes nothing", async () => {
    const { fakeSettings, id, pads, settings } = setup();
    const before = await settings.pad(id);
    fakeSettings.apply(await pads.configure(id, {}));
    expect(await settings.pad(id)).toEqual(before);
  });

  test("a switch the owner stopped allowing is never cleared in silence: the call is refused until it is named off", async () => {
    const { fakeSettings, id, pads } = setup();
    fakeSettings.apply(await pads.setTakeover(id, true));
    const held = fakeSettings.pad(id).flags;
    const everything = fakeSettings.allowedFlags;
    fakeSettings.allowedFlags = switchWord(
      { takeover: false, devBuy: false },
      everything,
    );
    const knob = { knobs: { capSecs: { default: 60 } } };
    // the detail names each paused switch and how to go on
    await refuses(pads.configure(id, knob), PAD, "devBuy, takeover");
    await refuses(
      pads.configure(id, knob),
      PAD,
      "switches: { devBuy: false, takeover: false }",
    );
    // naming one of two is not naming both, and naming one on is refused as ever
    await refuses(
      pads.configure(id, { ...knob, switches: { devBuy: false } }),
      PAD,
      "stopped allowing takeover",
    );
    await refuses(
      pads.configure(id, {
        ...knob,
        switches: { devBuy: false, takeover: true },
      }),
      PAD,
      "does not allow takeover",
    );
    await refuses(pads.setSwitches(id, { extPresets: false }), PAD, "devBuy");
    await refuses(
      pads.setSwitches(id, { extPresets: false }),
      PAD,
      "setSwitches: { devBuy: false, takeover: false }",
    );
    // setTakeover names takeover alone: the other paused switch still stops it
    await refuses(pads.setTakeover(id, false), PAD, "stopped allowing devBuy");
    // a knob change that writes no switch goes through, and nothing was written meanwhile
    fakeSettings.apply(await pads.setKnobs(id, { capSecs: { default: 60 } }));
    expect(fakeSettings.pad(id).flags).toBe(held);

    // named off, the call is built and carries exactly what was asked
    const tx = await pads.configure(id, {
      ...knob,
      switches: { devBuy: false, takeover: false },
    });
    const call = settingsCall(tx);
    if (call.functionName !== "configure") throw new Error(call.functionName);
    expect(call.args[1].flags).toBe(
      switchWord({ devBuy: false, takeover: false }, held),
    );
    // the owner allows them again before anything was sent: the pad still holds both, and every call builds
    fakeSettings.allowedFlags = everything;
    fakeSettings.apply(await pads.configure(id, knob));
    expect(fakeSettings.pad(id).flags).toBe(held);
    // a paused switch the pad does not hold stops nothing
    fakeSettings.apply(await pads.setSwitches(id, { devBuy: false }));
    fakeSettings.allowedFlags = switchWord({ devBuy: false }, everything);
    fakeSettings.apply(await pads.setSwitches(id, { extPresets: false }));
    expect(fakeSettings.pad(id).flags).toBe(
      switchWord({ devBuy: false, extPresets: false }, held),
    );
  });

  test("each rule of the row is refused before anyone signs", async () => {
    const { fakeSettings, id, pads } = setup();
    await refuses(
      pads.configure(id, { knobs: { steadyPips: { min: 499 } } }),
      PAD,
      "owner's limit",
    );
    await refuses(
      pads.configure(id, { knobs: { steadyPips: { default: 100_001 } } }),
      PAD,
      "default",
    );
    await refuses(
      pads.configure(id, { knobs: { nope: { min: 1 } } as never }),
      "INVALID_PARAMS",
      "not a knob",
    );
    await refuses(
      pads.configure(id, { knobs: { vestBps: { min: 1.5 } } }),
      "INVALID_PARAMS",
    );
    await refuses(
      pads.configure(id, { switches: { nope: true } as never }),
      "INVALID_PARAMS",
      "not a switch",
    );
    await refuses(
      pads.configure(id, { decayAutoLpBps: 1 }),
      "INVALID_PARAMS",
      "payees",
    );
    // 60 % of the fee to a referrer leaves no room for Bankr's 250 pips inside a 500-pip fee
    await refuses(
      pads.configure(id, { knobs: { referrerBps: { max: 6_000 } } }),
      PAD,
      "Bankr's cut",
    );
    fakeSettings.limits[knobId("feeRecipients")!] = { min: 1n, max: 255n };
    await refuses(
      pads.configure(id, {
        knobs: { feeRecipients: { max: 65 } },
        switches: { takeover: true },
      }),
      PAD,
      "64",
    );
    fakeSettings.allowedFlags = switchWord({ devBuy: true });
    await refuses(
      pads.configure(id, { switches: { takeover: true } }),
      PAD,
      "takeover",
    );
  });

  test("a pad over the owner's payee limits must set its payees in the same call", async () => {
    const { fakeSettings, id, pads } = setup();
    fakeSettings.pad(id).terms = {
      payees: [at(0x71), at(0x72)],
      steadySharesWad: [1n, 1n],
      decay: { on: false, autoLpBps: 0, sharesWad: [] },
    };
    fakeSettings.protocol = { ...fakeSettings.protocol, maxPadPayees: 1 };
    await refuses(
      pads.configure(id, { switches: { devBuy: false } }),
      PAD,
      "stored payees are over",
    );
    const tx = await pads.configure(id, {
      payees: [{ address: at(0x71), shareBps: 100, decayShareBps: 200 }],
      decayAutoLpBps: 5_000,
    });
    fakeSettings.apply(tx);
    expect(fakeSettings.pad(id).terms).toEqual({
      payees: [at(0x71)],
      steadySharesWad: [WAD / 100n],
      decay: { on: true, autoLpBps: 5_000, sharesWad: [WAD / 50n] },
    });
  });

  test("a contract payee that lets anyone claim for it is refused when it is newly named, not when its share moves", async () => {
    const { fakeSettings, id, pads } = setup();
    const open = at(0x7c);
    fakeSettings.chain.setCode(open, "0x6001");
    await refuses(
      pads.setPayees(id, [{ address: open, shareBps: 100 }]),
      PAD,
      "restrict it first",
    );
    await refuses(
      pads.configure(id, { payees: [{ address: open, shareBps: 100 }] }),
      PAD,
      "restrict it first",
    );
    // the pad already pays it: a new share for it names nobody new
    fakeSettings.pad(id).terms = {
      payees: [open],
      steadySharesWad: [1n],
      decay: { on: false, autoLpBps: 0, sharesWad: [] },
    };
    fakeSettings.apply(
      await pads.setPayees(id, [{ address: open, shareBps: 200 }]),
    );
    fakeSettings.apply(
      await pads.configure(id, { payees: [{ address: open, shareBps: 300 }] }),
    );
    expect(fakeSettings.pad(id).terms.steadySharesWad).toEqual([
      (WAD * 3n) / 100n,
    ]);
    await refuses(
      pads.configure(id, {
        payees: [
          { address: open, shareBps: 300 },
          { address: SUITE.factory, shareBps: 1 },
        ],
      }),
      PAD,
      "cannot be a payee",
    );
  });

  test("Bankr's pad is the owner's: its fee knobs and payees move in one configure", async () => {
    const { fakeSettings, pads, settings } = setup();
    const tx = await pads.configure(0n, {
      knobs: { steadyPips: { min: 20_000, max: 20_000, default: 20_000 } },
      payees: [{ address: at(0x71), shareWad: 123n }],
    });
    expect(tx.from).toBe(OWNER);
    fakeSettings.apply(tx);
    const pad = await settings.pad(0n);
    expect(pad.knobs.steadyPips.default).toBe(20_000n);
    expect(pad.payees).toEqual([
      { address: at(0x71), steadyShareWad: 123n, decayShareWad: 0n },
    ]);
    expect(pad.switches.takeover).toBe(true);
  });
});

describe("one setting at a time", () => {
  test("setKnobs merges over the pad's own; Bankr's fee knobs are refused there", async () => {
    const { fakeSettings, id, pads } = setup();
    const tx = await pads.setKnobs(id, {
      capBps: { min: 0, max: 0, default: 0 },
      capSecs: { default: 60 },
    });
    expect(tx.from).toBe(OPERATOR);
    expect(settingsCall(tx).functionName).toBe("setKnobs");
    fakeSettings.apply(tx);
    expect(fakeSettings.pad(id).ranges[knobId("capBps")!]).toEqual({
      min: 0n,
      max: 0n,
      dflt: 0n,
    });
    expect(fakeSettings.pad(id).ranges[knobId("capSecs")!]!.dflt).toBe(60n);
    await refuses(
      pads.setKnobs(0n, { steadyPips: { default: 17_500 } }),
      PAD,
      "configure",
    );
    await refuses(pads.setKnobs(id, {}), "INVALID_PARAMS", "no knob");
    expect((await pads.setKnobs(0n, { capSecs: { default: 60 } })).from).toBe(
      OWNER,
    );
    await refuses(
      pads.setKnobs(9n, { capSecs: { default: 60 } }),
      "UNKNOWN_LAUNCHPAD",
    );
  });

  test("switches and the takeover switch: only the pad turns takeover on, inside what the owner allows", async () => {
    const { fakeSettings, id, pads } = setup();
    const on = await pads.setTakeover(id, true);
    expect(on.from).toBe(OPERATOR);
    expect(settingsCall(on)).toEqual({
      functionName: "setFlags",
      args: [id, switchWord({ takeover: true }, fakeSettings.pad(id).flags)],
    });
    fakeSettings.apply(on);
    fakeSettings.apply(
      await pads.setSwitches(id, { devBuy: false, extPresets: false }),
    );
    expect(fakeSettings.pad(id).flags).toBe(
      switchWord(
        { takeover: true, devBuy: false, extPresets: false },
        fakeSettings.template.flags,
      ),
    );
    fakeSettings.apply(await pads.setTakeover(id, false));
    fakeSettings.limits[knobId("feeRecipients")!] = { min: 1n, max: 255n };
    fakeSettings.pad(id).ranges[knobId("feeRecipients")!] = {
      min: 1n,
      max: 65n,
      dflt: 1n,
    };
    await refuses(pads.setTakeover(id, true), PAD, "64");
    fakeSettings.allowedFlags = switchWord(
      { takeover: false },
      fakeSettings.allowedFlags,
    );
    await refuses(
      pads.setSwitches(id, { takeover: true }),
      PAD,
      "does not allow takeover",
    );
  });

  test("payees and the decay split move together; not on Bankr's pad", async () => {
    const { fakeSettings, id, pads } = setup();
    const tx = await pads.setPayees(
      id,
      [
        { address: at(0x71), shareBps: 1_000, decayShareBps: 2_000 },
        { address: at(0x72), shareBps: 500 },
      ],
      { decayAutoLpBps: 3_000 },
    );
    expect(settingsCall(tx).functionName).toBe("setPayees");
    fakeSettings.apply(tx);
    expect(fakeSettings.pad(id).terms.decay).toEqual({
      on: true,
      autoLpBps: 3_000,
      sharesWad: [WAD / 5n, 0n],
    });
    await refuses(pads.setPayees(0n, []), PAD, "configure");
    await refuses(
      pads.setPayees(id, [
        { address: at(0x71), shareBps: 1 },
        { address: at(0x71), shareBps: 1 },
      ]),
      PAD,
      "twice",
    );
    await refuses(
      pads.setPayees(id, [{ address: at(0x71), shareBps: 1, shareWad: 1n }]),
      "INVALID_PARAMS",
      "not both",
    );
  });

  test("payees no launch on the pad would take are refused where they are named: register, setPayees, configure", async () => {
    const { fakeSettings, id, pads } = setup();
    fakeSettings.limits[knobId("padShareBps")!] = { min: 0n, max: 10_000n };
    const marker = PAD_TREASURY_MARKER;
    const whole = [{ address: marker, shareBps: 10_000 }];
    // each share exact in bps, summing to the whole: the rescale over what the marker leaves rounds past it
    const thirds = [
      { address: marker, shareBps: 3_333 },
      { address: at(0x71), shareBps: 3_333 },
      { address: at(0x72), shareBps: 3_334 },
    ];
    for (const payees of [whole, thirds]) {
      await refuses(pads.setPayees(id, payees), PAD, "No launch");
      await refuses(pads.configure(id, { payees }), PAD, "No launch");
      await refuses(
        pads.register({ operator: at(0xb2), payees }),
        PAD,
        "No launch",
      );
    }
    // the decay shares are split the same way
    await refuses(
      pads.setPayees(id, [
        { address: marker, shareBps: 1, decayShareBps: 10_000 },
      ]),
      PAD,
      "No launch",
    );
    // one bp off the marker and the same lists are built
    const fits = [{ ...thirds[0]!, shareBps: 3_332 }, thirds[1]!, thirds[2]!];
    fakeSettings.apply(await pads.setPayees(id, fits));
    expect(fakeSettings.pad(id).terms.payees).toHaveLength(3);

    // a list the pad already holds (sent raw, as the chain takes it) does not stop a configure that names no payees
    fakeSettings.pad(id).terms = {
      payees: [getAddress(marker)],
      steadySharesWad: [WAD],
      decay: { on: false, autoLpBps: 0, sharesWad: [] },
    };
    fakeSettings.apply(
      await pads.configure(id, { knobs: { capSecs: { default: 60 } } }),
    );
    expect(fakeSettings.pad(id).terms.steadySharesWad).toEqual([WAD]);
  });

  test("cap controller, a quote's terms, curves and preset limits", async () => {
    const { fakeSettings, id, pads } = setup();
    fakeSettings.apply(await pads.setCapController(id, at(0xcc)));
    expect(fakeSettings.pad(id).capController).toBe(at(0xcc));
    fakeSettings.apply(await pads.setCapController(id, null));
    expect(fakeSettings.pad(id).capController).toBe(zeroAddress);

    const quote = at(0xe7);
    fakeSettings.apply(await pads.setQuoteTerms(id, quote, { allowed: true }));
    fakeSettings.apply(
      await pads.setQuoteTerms(id, quote, {
        ownAmounts: true,
        compoundFloor: 5n,
        compoundCap: 9n,
      }),
    );
    expect(fakeSettings.pad(id).quotes.get(quote.toLowerCase())).toEqual({
      allowed: true,
      ownAmounts: true,
      compoundFloor: 5n,
      compoundCap: 9n,
    });
    await refuses(
      pads.setQuoteTerms(id, quote, { ownAmounts: false }),
      PAD,
      "ownAmounts",
    );
    await refuses(pads.setQuoteTerms(id, quote, { compoundFloor: 10n }), PAD);

    expect(await pads.isCurveAllowed(id, "degen")).toBe(true);
    fakeSettings.apply(await pads.setCurveAllowed(id, "degen", false));
    expect(await pads.isCurveAllowed(id, "degen")).toBe(false);
    expect(await pads.isCurveAllowed(id, "any")).toBe(false);
    fakeSettings.apply(await pads.setCurveAllowed(id, "any", true));
    expect(await pads.isCurveAllowed(id, "any")).toBe(true);

    fakeSettings.apply(
      await pads.setPresetLimits(id, "pumpBrake", { minBrakeTicks: 6_932 }),
    );
    expect(fakeSettings.pad(id).presetLimits.get(3)).toEqual({
      allowed: true,
      maxWindowSecs: 3_600,
      minBrakeTicks: 6_932,
      minAnchorTau: 21_600,
    });
    await refuses(
      pads.setPresetLimits(id, "raffleRun", { minAnchorTau: 21_599 }),
      PAD,
      "minAnchorTau",
    );
    await refuses(
      pads.setPresetLimits(id, "nope" as never, {}),
      "INVALID_PARAMS",
    );
  });
});

describe("the pad's identity in the registry", () => {
  test("signer, link, pause: from the operator, and for Bankr's pad from the registry's owner", async () => {
    const { fakeSettings, id, pads } = setup();
    const signer = await pads.setSigner(id, at(0x51));
    expect(signer).toMatchObject({
      from: OPERATOR,
      to: SUITE.launchpadRegistry,
    });
    fakeSettings.apply(signer);
    expect(fakeSettings.pad(id).signer).toBe(at(0x51));
    fakeSettings.apply(await pads.setSigner(id, null));
    expect(fakeSettings.pad(id).signer).toBe(zeroAddress);
    expect((await pads.setSigner(0n, at(0x51))).from).toBe(REGISTRY_OWNER);

    fakeSettings.apply(await pads.setMetadataUri(id, "ipfs://x"));
    expect(fakeSettings.pad(id).uri).toBe("ipfs://x");
    fakeSettings.maxUri = 2;
    await refuses(pads.setMetadataUri(id, "abc"), PAD, "2 bytes");

    fakeSettings.apply(await pads.setPaused(id, true));
    expect(fakeSettings.pad(id).paused).toBe(true);
    await refuses(pads.setPaused(id, "yes" as never), "INVALID_PARAMS");
  });

  test("a vanity suffix is refused when another pad owns it or one of its tails", async () => {
    const { fakeSettings, id, pads } = setup();
    const tx = await pads.setVanity(id, { suffix: 0xbeef, nibbles: 4 });
    fakeSettings.apply(tx);
    expect(fakeSettings.pad(id).vanity).toEqual({ suffix: 0xbeef, nibbles: 4 });
    // its own suffix is no one else's: setting it again passes, and another pad is refused it
    expect(
      (await pads.setVanity(id, { suffix: 0xbeef, nibbles: 4 })).from,
    ).toBe(OPERATOR);
    const other = fakeSettings.addPad();
    await refuses(
      pads.setVanity(other, { suffix: 0xbeef, nibbles: 4 }),
      PAD,
      `launchpad ${id} owns 0xbeef`,
    );
    // Bankr's pad owns ...ba3: a suffix ending in it is taken
    await refuses(
      pads.setVanity(id, { suffix: 0x1ba3, nibbles: 4 }),
      PAD,
      "owns 0xba3",
    );
    await refuses(pads.setVanity(id, { suffix: 0xab, nibbles: 2 }), PAD);
  });

  test("the handover is two steps, and Bankr's pad moves only with the registry", async () => {
    const { fakeSettings, id, pads } = setup();
    await refuses(pads.acceptOperator(id), PAD, "No operator handover");
    fakeSettings.apply(await pads.transferOperator(id, at(0xb9)));
    const accept = await pads.acceptOperator(id);
    expect(accept.from).toBe(at(0xb9));
    fakeSettings.apply(accept);
    expect(fakeSettings.pad(id).operator).toBe(at(0xb9));
    expect((await pads.setPaused(id, true)).from).toBe(at(0xb9));
    await refuses(
      pads.transferOperator(0n, at(0xb9)),
      PAD,
      "registry's ownership",
    );
    await refuses(pads.transferOperator(id, zeroAddress), "INVALID_PARAMS");
  });
});
