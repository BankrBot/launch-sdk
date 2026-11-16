import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { creatorVestingEscrowAbi } from "./abis/suite3.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import {
  LAUNCHER,
  OTHER,
  WETH,
  installLaunch,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";

async function expectCode(p: Promise<unknown>, code: LaunchSdkErrorCode) {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
}

const decode = (data: `0x${string}`) =>
  decodeFunctionData({ abi: creatorVestingEscrowAbi, data });

describe("vesting", () => {
  const schedule = {
    beneficiary: LAUNCHER,
    total: 1_000n,
    released: 100n,
    cliff: 30n,
    duration: 365n,
    push: false,
    available: 300n,
  };

  test("get: every schedule with what release (pull) or releaseFor (push) would move now", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      schedules: [schedule],
      holderVest: { total: 500n, available: 40n },
    });
    const s = await client.vesting.get(l.token);
    expect(s.escrow).toBe(l.escrow);
    expect(s.vestingStart).toBe(1_000n);
    expect(s.schedules).toHaveLength(2);
    expect(s.schedules[0]).toMatchObject({
      role: "creator",
      push: false,
      total: 1_000n,
      releasable: 300n,
    });
    expect(s.schedules[1]).toMatchObject({
      role: "holders",
      push: true,
      beneficiary: l.distributor,
      releasable: 40n,
    });
  });

  test("release for the creator, releaseFor the distributor from anyone; NO_VESTING otherwise", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      schedules: [schedule],
      holderVest: { total: 500n, available: 40n },
    });
    const release = await client.vesting.buildRelease(l.token, LAUNCHER);
    expect(release).toMatchObject({ from: LAUNCHER, to: l.escrow!, value: 0n });
    expect(decode(release.data)).toEqual({
      functionName: "release",
      args: [0n],
    });
    const push = await client.vesting.buildReleaseToHolders(l.token, OTHER);
    expect(decode(push.data)).toEqual({
      functionName: "releaseFor",
      args: [l.distributor],
    });
    await expectCode(client.vesting.buildRelease(l.token, OTHER), "NO_VESTING");
    const none = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      salt: `0x${"99".repeat(32)}`,
    });
    expect((await client.vesting.get(none.token)).escrow).toBeNull();
    await expectCode(
      client.vesting.buildReleaseToHolders(none.token, OTHER),
      "NO_VESTING",
    );
  });
});
