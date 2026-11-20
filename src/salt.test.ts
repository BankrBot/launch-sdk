import { describe, expect, test } from "bun:test";
import { zeroAddress } from "viem";
import { isLaunchSdkError } from "./errors.js";
import { predictToken } from "./predict.js";
import {
  VANITY_MAX_TRIES,
  addressMatchesVanity,
  mineVanitySalt,
  vanityMaxTries,
  vanityRule,
  vanityUnavailable,
} from "./salt.js";
import {
  fakeAddress,
  livePointersOf,
  testRecord,
} from "./__internal__/fakeRecord.js";

const live = livePointersOf(testRecord(8453));
const identity = {
  name: "Moon",
  symbol: "MOON",
  metadataUri: "ipfs://moon",
  metadataAdmin: zeroAddress,
  capExclusions: [],
  terms: {
    totalSupply: 10n ** 29n,
    capAmount: 2n * 10n ** 27n,
    capSecs: 86_400,
    capController: fakeAddress(0xca),
  },
};
const launcher = fakeAddress(0xc1);

describe("the vanity miner stays bounded", () => {
  test("plan()'s budget: 16 x the expected tries, never past 2^20", () => {
    expect(vanityMaxTries(vanityRule(0n, { suffix: 0xba3, nibbles: 3 }))).toBe(
      16 * 16 ** 3,
    );
    expect(
      vanityMaxTries(vanityRule(7n, { suffix: 0xabcdef, nibbles: 6 })),
    ).toBe(VANITY_MAX_TRIES);
  });

  test("a caller's own budget must be a positive whole number", async () => {
    const rule = vanityRule(7n, { suffix: 0xabcd, nibbles: 4 });
    for (const maxTries of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        mineVanitySalt({ live, identity, launcher, rule, maxTries }),
      ).rejects.toThrow(RangeError);
    }
  });

  test("a mined salt carries the rule, and a spent budget is null", async () => {
    const rule = vanityRule(7n, { suffix: 0xa, nibbles: 1 });
    const mined = await mineVanitySalt({
      live,
      identity,
      launcher,
      rule,
      maxTries: 4_096,
    });
    expect(mined).not.toBeNull();
    expect(
      predictToken(live, identity, launcher, mined!.salt).toLowerCase(),
    ).toBe(mined!.token.toLowerCase());
    expect(addressMatchesVanity(mined!.token, rule)).toBe(true);
    const sixDigits = vanityRule(7n, { suffix: 0xabcdef, nibbles: 6 });
    expect(
      await mineVanitySalt({
        live,
        identity,
        launcher,
        rule: sixDigits,
        maxTries: 4,
      }),
    ).toBeNull();
  });
});

describe("VANITY_UNAVAILABLE says how to supply a salt", () => {
  test("names the pad's suffix, plan()'s budget and the `salt` route", () => {
    const err = vanityUnavailable(
      "base",
      7n,
      vanityRule(7n, { suffix: 0x0bcdef, nibbles: 6 }),
    );
    expect(isLaunchSdkError(err, "VANITY_UNAVAILABLE")).toBe(true);
    expect(err.message).toContain("mineVanitySalt");
    expect(err.message).toContain("`salt`");
    expect(err.detail).toContain("Launchpad 7's tokens must end in …0bcdef");
    expect(err.detail).toContain(`${VANITY_MAX_TRIES} tries`);
    expect(err.detail).toContain("pass it as `salt`");
  });
});
