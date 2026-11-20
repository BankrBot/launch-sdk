// A launch against fake contracts whose settings contract runs the launch check over a state the test holds: the
// pad's own parameters are what the coin freezes, and nothing of a pad or of the owner is typed here.
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { base } from "viem/chains";
import { FakeChain } from "../__internal__/fakeRpc.js";
import { installContracts } from "../__internal__/fakeContracts.js";
import { createLaunchClient } from "../client.js";
import { isLaunchSdkError } from "../errors.js";
import type { LaunchInput } from "../providers/types.js";
import { launchPinsOf } from "./options.js";
import { KNOB, PAD_FLAG } from "./settings.js";

const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");

function fixture() {
  const f = installContracts(new FakeChain(base));
  const client = createLaunchClient({
    chain: "base",
    addresses: f.deployment,
    publicClient: f.fake.publicClient(),
    fork: true,
  });
  const input = (
    o: Partial<LaunchInput<"base">> = {},
  ): LaunchInput<"base"> => ({
    name: "Coin",
    symbol: "COIN",
    launcher: LAUNCHER,
    launchpadId: f.padId,
    quote: f.quote,
    ...o,
  });
  /** The pad's operator changes one of its rows. */
  const setKnob = (
    knob: keyof typeof KNOB,
    row: { min: bigint; max: bigint; dflt: bigint },
  ) => {
    const ranges = [...f.state.pad!.ranges];
    ranges[KNOB[knob]] = row;
    f.state = { ...f.state, pad: { ...f.state.pad!, ranges } };
  };
  return { f, client, input, setKnob };
}

const codeOf = async (run: Promise<unknown>) =>
  run.then(
    () => null,
    (e: unknown) => (isLaunchSdkError(e) ? e.code : String(e)),
  );

describe("a launch on a launchpad of your own", () => {
  test("the newest launchpad launches, and the id after it is no launchpad: ids run 1 to launchpadCount", async () => {
    const { f, client, input } = fixture();
    // The registry's count is its last id; the fake's one pad is that pad.
    const plan = await client.plan(input());
    expect(plan.launchpadId).toBe(f.padId);
    const preset = {
      preset: "sniper_tax",
      buyPips: 10_000,
      sellPips: 0,
      endSecs: 60,
    } as const;
    expect(
      await codeOf(client.previewExtension(preset, { launchpadId: f.padId })),
    ).toBeNull();
    expect(
      await codeOf(client.plan(input({ launchpadId: f.padId + 1n }))),
    ).toBe("UNKNOWN_LAUNCHPAD");
    expect(
      await codeOf(
        client.previewExtension(preset, { launchpadId: f.padId + 1n }),
      ),
    ).toBe("UNKNOWN_LAUNCHPAD");
  });

  test("with nothing set it freezes the pad's defaults, pinned to those terms and to its token", async () => {
    const { client, input } = fixture();
    const plan = await client.plan(input());
    const { terms, resolvedHash, pinned } = plan.resolved!;
    // The template a new pad copies: a 0.05 % fee, 100 B supply, a 2 % wallet cap for a day, 15 % vested.
    expect(terms.pool.buy.steadyPips).toBe(500);
    expect(terms.totalSupply).toBe(100_000_000_000n * 10n ** 18n);
    expect(terms.capAmount).toBe(terms.totalSupply / 50n);
    expect(terms.capSecs).toBe(86_400);
    expect(terms.vestBps).toBe(1_500);
    expect([terms.vestCliffSecs, terms.vestSecs]).toEqual([
      2_592_000, 31_536_000,
    ]);
    expect([terms.holdersBps, terms.autoLpBps, terms.buybackBps]).toEqual([
      1_167, 3_000, 0,
    ]);
    // A pad other than Bankr's starts with takeover off: nobody can take its coins over.
    expect(terms.takeover).toBe(false);
    expect(pinned).toBe(true);
    expect(launchPinsOf(plan.params.options!)).toEqual({
      expectedTermsHash: resolvedHash,
      expectedToken: plan.predictedToken,
    });
    expect((await client.simulate(plan)).token).toBe(plan.predictedToken);
  });

  test("the pad's own parameters are what its launches take: a 1 % fee, a billion supply, no wallet cap", async () => {
    const { client, input, setKnob } = fixture();
    setKnob("steadyPips", { min: 5_000n, max: 20_000n, dflt: 10_000n });
    setKnob("supply", { min: 10n ** 9n, max: 10n ** 9n, dflt: 10n ** 9n });
    setKnob("capBps", { min: 0n, max: 0n, dflt: 0n });
    setKnob("capSecs", { min: 0n, max: 0n, dflt: 0n });
    const { terms } = (await client.plan(input())).resolved!;
    expect(terms.pool.buy.steadyPips).toBe(10_000);
    expect(terms.pool.sell.steadyPips).toBe(10_000);
    expect(terms.totalSupply).toBe(10n ** 27n);
    expect([terms.capAmount, terms.capSecs]).toEqual([0n, 0]);
  });

  test("a launch names its own terms inside the pad's ranges, and one outside is refused by name", async () => {
    const { client, input, setKnob } = fixture();
    setKnob("capBps", { min: 50n, max: 500n, dflt: 200n });
    setKnob("capSecs", { min: 3_600n, max: 604_800n, dflt: 86_400n });
    const named = await client.plan(
      input({
        schedule: { startPips: 20_000, steadyPips: 20_000, decaySecs: 0 },
        walletCap: { bps: 100, seconds: 3_600 },
        holderShareBps: 10_000,
        buybackBps: 0,
      }),
    );
    const { terms } = named.resolved!;
    expect(terms.pool.buy.steadyPips).toBe(20_000);
    expect(terms.capAmount).toBe(terms.totalSupply / 100n);
    expect(terms.capSecs).toBe(3_600);
    // Everything the creator keeps after auto-liquidity goes to the coin's holders.
    expect(terms.holdersBps + terms.autoLpBps).toBe(10_000);
    expect(
      await codeOf(
        client.plan(input({ walletCap: { bps: 600, seconds: 3_600 } })),
      ),
    ).toBe("OUTSIDE_LAUNCHPAD_RANGE");
    // A feature the pad has switched off is refused too.
    expect(
      await codeOf(client.plan(input({ devBuy: { amount: 10n ** 16n } }))),
    ).toBeNull();
    const { f } = fixture();
    f.state.pad!.flags &= ~PAD_FLAG.devBuy;
    const off = createLaunchClient({
      chain: "base",
      addresses: f.deployment,
      publicClient: f.fake.publicClient(),
      fork: true,
    });
    expect(
      await codeOf(
        off.plan(
          input({
            launchpadId: f.padId,
            quote: f.quote,
            devBuy: { amount: 10n ** 16n },
          }),
        ),
      ),
    ).toBe("NOT_ALLOWED_BY_LAUNCHPAD");
  });

  test("a change after the plan was shown stops the pinned launch: TERMS_CHANGED", async () => {
    const { f, client, input } = fixture();
    const plan = await client.plan(input());
    // The owner moves Bankr's cut: future launches meet it, and this one was pinned to the terms it was shown.
    f.state = {
      ...f.state,
      protocol: { ...f.state.protocol, bankrFeeBps: 1_100 },
    };
    expect(await codeOf(client.simulate(plan))).toBe("TERMS_CHANGED");
    const again = await client.plan(input());
    expect(again.resolved.terms.bankrFeeBps).toBe(1_100);
    expect(again.resolved.resolvedHash).not.toBe(plan.resolved.resolvedHash);
  });

  test("a deployment this SDK version does not ship launches only as a fork", async () => {
    const f = installContracts(new FakeChain(base));
    const client = createLaunchClient({
      chain: "base",
      addresses: f.deployment,
      publicClient: f.fake.publicClient(),
    });
    expect((await client.status()).deployed).toBe(false);
    const plan = client.plan({
      name: "Coin",
      symbol: "COIN",
      launcher: LAUNCHER,
      launchpadId: f.padId,
      quote: f.quote,
    });
    expect(await codeOf(plan)).toBe("PROVIDER_NOT_DEPLOYED");
  });

  test("the contracts by name are on the client", () => {
    const { client } = fixture();
    expect(Object.keys(client.contracts()).sort()).toEqual([
      "coinTerms",
      "holderLegs",
      "launchpads",
      "owner",
      "settings",
    ]);
  });
});
