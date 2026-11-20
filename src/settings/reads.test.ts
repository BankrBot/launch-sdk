import { describe, expect, test } from "bun:test";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeErrorResult,
  getAbiItem,
  getAddress,
  http,
  zeroAddress,
  type AbiParameter,
} from "viem";
import { base } from "viem/chains";
import {
  FLYWHEEL,
  FakeSettings,
  OPERATOR,
  OWNER,
  REGISTRY_OWNER,
  SUITE,
  at,
} from "../__internal__/fakeSettings.js";
import { bankrLaunchSettingsAbi } from "../abis/settings.js";
import { isLaunchSdkError } from "../errors.js";
import { PAD_TREASURY_MARKER } from "../launchpad.js";
import { readSettingsAddresses } from "./context.js";
import { createLaunchpadAdmin } from "./launchpads.js";
import { knobId, switchWord } from "./names.js";
import { createSettingsReads } from "./reads.js";

const rejects = async (run: Promise<unknown>, code: string) => {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isLaunchSdkError(err), `expected ${code}`).toBe(true);
  expect((err as { code: string }).code).toBe(code);
  return err as { detail?: string; cause?: unknown };
};

describe("settings reads", () => {
  test("a suite's addresses come from its factory alone", async () => {
    const fakeSettings = new FakeSettings();
    const read = await readSettingsAddresses(
      fakeSettings.chain.publicClient(),
      SUITE.factory,
      SUITE.termsLens,
    );
    expect(read).toEqual({
      factory: SUITE.factory,
      launchpadRegistry: SUITE.launchpadRegistry,
      settings: SUITE.settings,
      ledger: SUITE.ledger,
      termsLens: SUITE.termsLens,
    });
  });

  test("the owner's terms, guards, limits and allowed switches, by name", async () => {
    const fakeSettings = new FakeSettings();
    const settings = createSettingsReads(fakeSettings.context());
    expect((await settings.protocol()).bankrFeeBps).toBe(1_000);
    expect((await settings.guards()).curveNearStep).toBe(13);
    const limits = await settings.limits();
    expect(limits.steadyPips).toEqual({ min: 500n, max: 999_999n });
    expect(limits.feeRecipients).toEqual({ min: 1n, max: 10n });
    const allowed = await settings.allowedSwitches();
    expect(Object.values(allowed).every(Boolean)).toBe(true);
    fakeSettings.allowedFlags = 1n;
    expect(await settings.allowedSwitches()).toMatchObject({
      devBuy: true,
      takeover: false,
    });
  });

  test("Bankr's pad: the owner's rows, the registry owner's identity, its payees in WAD", async () => {
    const fakeSettings = new FakeSettings();
    fakeSettings.pad(0n).signer = at(0x51);
    fakeSettings.pad(0n).ranges[knobId("vestBps")!] = {
      min: 0n,
      max: 5_000n,
      dflt: 1_500n,
    };
    const pad = await createSettingsReads(fakeSettings.context()).pad();
    expect(pad.id).toBe(0n);
    expect(pad.operator).toBe(REGISTRY_OWNER);
    expect(pad.settingsOperator).toBe(OWNER);
    expect(pad.signer).toBe(at(0x51));
    expect(pad.knobs.steadyPips).toEqual({
      min: 17_500n,
      max: 17_500n,
      default: 17_500n,
    });
    expect(pad.knobs.decaySecs.default).toBe(14n);
    expect(pad.knobs.vestBps).toEqual({
      min: 0n,
      max: 5_000n,
      default: 1_500n,
    });
    expect(pad.switches.takeover).toBe(true);
    expect(pad.switches.unlistedQuotes).toBe(false);
    expect(pad.bnkrPairWaived).toBe(false);
    expect(pad.payees).toEqual([
      {
        address: getAddress(PAD_TREASURY_MARKER),
        steadyShareWad: 246_031_746_031_746_032n,
        decayShareWad: 447_089_947_089_947_090n,
      },
      {
        address: FLYWHEEL,
        steadyShareWad: 150_793_650_793_650_794n,
        decayShareWad: 251_322_751_322_751_323n,
      },
    ]);
    expect(pad.decay).toEqual({ on: true, autoLpBps: 10_000 });
    expect(pad.presets.raffleRun.minAnchorTau).toBe(21_600);
    expect(pad.vanity).toBeNull();
  });

  test("a registered pad starts as the template with takeover off; an id past the last is unknown", async () => {
    const fakeSettings = new FakeSettings();
    const id = fakeSettings.addPad();
    const settings = createSettingsReads(fakeSettings.context());
    const [pad, template] = await Promise.all([
      settings.pad(id),
      settings.template(),
    ]);
    expect(pad.operator).toBe(OPERATOR);
    expect(pad.settingsOperator).toBe(OPERATOR);
    expect(pad.signer).toBeNull();
    expect(pad.knobs).toEqual(template.knobs);
    expect(pad.switches).toEqual({ ...template.switches, takeover: false });
    expect(pad.capController).toBeNull();
    expect(pad.payees).toEqual([]);
    expect(pad.bnkrPairWaived).toBe(true);
    expect(template.bnkrPairWaived).toBe(true);
    await rejects(settings.pad(id + 1n), "UNKNOWN_LAUNCHPAD");
    await rejects(settings.pad(-1n), "INVALID_PARAMS");
  });

  test("quotes by their pricing's name; a pad's own word on a quote", async () => {
    const fakeSettings = new FakeSettings();
    const weth = at(0xe7);
    fakeSettings.quotes.set(weth.toLowerCase(), {
      allowed: true,
      mode: 1,
      decimals: 18,
      maxPriceAge: 3_600,
      feed: at(0xfeed),
      compoundFloor: 10n,
      compoundCap: 20n,
      quoteActivation: 1n,
      quotePaid: false,
    });
    fakeSettings.quoteList = [weth];
    const settings = createSettingsReads(fakeSettings.context());
    expect(await settings.quotes()).toEqual([
      {
        quote: weth,
        listed: true,
        pricing: "chainlink",
        decimals: 18,
        maxPriceAge: 3_600,
        feed: at(0xfeed),
        compoundFloor: 10n,
        compoundCap: 20n,
        quoteActivation: 1n,
        quotePaid: false,
      },
    ]);
    const other = await settings.quote(at(0xe8));
    expect(other).toMatchObject({ listed: false, pricing: "none", feed: null });
    const id = fakeSettings.addPad();
    // a pad that lists no quote takes every quote
    expect((await settings.padQuote(id, weth)).launches).toBe(true);
    fakeSettings.pad(id).quotes.set(at(0xe8).toLowerCase(), {
      allowed: true,
      ownAmounts: false,
      compoundFloor: 0n,
      compoundCap: 0n,
    });
    expect(await settings.padQuote(id, weth)).toMatchObject({
      allowed: false,
      launches: false,
    });
    expect(await settings.padQuote(id, at(0xe8))).toMatchObject({
      allowed: true,
      launches: true,
    });
  });

  test("presets, the allowlist, pricing and the suite's own levers", async () => {
    const fakeSettings = new FakeSettings();
    const settings = createSettingsReads(fakeSettings.context());
    const presets = await settings.presets();
    expect(Object.keys(presets)).toEqual([
      "sniperTax",
      "decayTax",
      "pumpBrake",
      "raffleRun",
    ]);
    expect(presets.sniperTax.deployer).toBe(zeroAddress);
    const key = `0x${"ab".repeat(32)}` as const;
    expect(await settings.extensionAllowed(key)).toBe(false);
    fakeSettings.extAllowed.add(key);
    expect(await settings.extensionAllowed(key)).toBe(true);
    expect(await settings.pricing()).toEqual({
      priceSigner: null,
      sequencerUptimeFeed: null,
      sequencerGraceSecs: 0,
    });
    expect(await settings.levers()).toEqual({
      owner: OWNER,
      pendingOwner: null,
      paused: true,
      launchGated: true,
      treasury: fakeSettings.treasury,
      hook: fakeSettings.hook,
      hookGenerations: [fakeSettings.hook],
      holderLeg: fakeSettings.holderLeg,
      registryOwner: REGISTRY_OWNER,
      registrationBondWei: 10n ** 16n,
      maxPadUriBytes: 2_048,
      bankrSigner: null,
    });
  });

  test("what a launch meets: each knob inside the owner's limit as it stands, and only the allowed switches", async () => {
    const fakeSettings = new FakeSettings();
    const id = fakeSettings.addPad();
    const settings = createSettingsReads(fakeSettings.context());
    const capSecs = knobId("capSecs")!;
    fakeSettings.pad(id).ranges[capSecs] = {
      min: 60n,
      max: 86_400n,
      dflt: 86_400n,
    };
    fakeSettings.apply(
      await createLaunchpadAdmin(fakeSettings.context()).setTakeover(id, true),
    );
    const before = await settings.pad(id);
    // nothing narrowed: a launch meets the rows as stored
    expect(before.atLaunch).toEqual({
      knobs: before.knobs,
      switches: before.switches,
    });
    // the owner narrows a limit and the allowed switches past the pad's rows, which the chain does not rewrite
    fakeSettings.limits[capSecs] = { min: 0n, max: 86_399n };
    fakeSettings.allowedFlags = switchWord(
      { takeover: false, devBuy: false },
      fakeSettings.allowedFlags,
    );
    const after = await settings.pad(id);
    expect(after.knobs).toEqual(before.knobs);
    expect(after.switches).toEqual(before.switches);
    expect(after.atLaunch.knobs.capSecs).toEqual({
      min: 60n,
      max: 86_399n,
      default: 86_399n,
    });
    expect({ ...after.atLaunch.knobs, capSecs: 0 }).toEqual({
      ...before.knobs,
      capSecs: 0,
    });
    expect(after.atLaunch.switches).toEqual({
      ...before.switches,
      takeover: false,
      devBuy: false,
    });
    // a limit moved wholly past the row: the nearest edge of the limit
    fakeSettings.limits[capSecs] = { min: 0n, max: 30n };
    expect((await settings.pad(id)).atLaunch.knobs.capSecs).toEqual({
      min: 30n,
      max: 30n,
      default: 30n,
    });
  });

  test("a launch the chain refuses is a simulation revert with the contract's error on cause; a failed request is not", async () => {
    const fakeSettings = new FakeSettings();
    const settings = createSettingsReads(fakeSettings.context());
    const params = zeroOf(
      getAbiItem({ abi: bankrLaunchSettingsAbi, name: "resolve" }).inputs[2],
    ) as never;
    fakeSettings.chain.contract(SUITE.settings, bankrLaunchSettingsAbi, {
      resolve: () => {
        throw Object.assign(new Error("execution reverted"), {
          code: 3,
          data: encodeErrorResult({
            abi: bankrLaunchSettingsAbi,
            errorName: "InvalidPayees",
          }),
        });
      },
    });
    const err = await rejects(
      settings.preview(params, { launcher: OWNER }),
      "SIMULATION_REVERTED",
    );
    expect(
      err.cause instanceof BaseError &&
        (
          err.cause.walk(
            (e) => e instanceof ContractFunctionRevertedError,
          ) as ContractFunctionRevertedError
        ).data?.errorName,
    ).toBe("InvalidPayees");
    await rejects(
      settings.preview(params, { launcher: "0x1" as never }),
      "INVALID_PARAMS",
    );

    // a node that does not answer is no refusal: the error comes back as it came, with no SDK code on it
    const dead = createSettingsReads({
      ...fakeSettings.context(),
      client: createPublicClient({
        chain: base,
        transport: http("http://127.0.0.1:9", { retryCount: 0 }),
      }),
    });
    const down = await dead.preview(params, { launcher: OWNER }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(down).toBeInstanceOf(BaseError);
    expect(isLaunchSdkError(down)).toBe(false);
  });
});

/** The zero value of an ABI parameter: enough to encode a call the fake then answers. */
function zeroOf(p: AbiParameter): unknown {
  if (p.type.endsWith("[]")) return [];
  if (p.type === "tuple")
    return Object.fromEntries(
      (p as { components: readonly AbiParameter[] }).components.map((c) => [
        c.name,
        zeroOf(c),
      ]),
    );
  if (p.type === "address") return zeroAddress;
  if (p.type === "bool") return false;
  if (p.type === "string") return "";
  if (p.type.startsWith("bytes"))
    return p.type === "bytes"
      ? "0x"
      : `0x${"00".repeat(Number(p.type.slice(5)))}`;
  return 0n;
}
