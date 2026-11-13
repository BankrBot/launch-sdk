import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, zeroAddress } from "viem";
import { bankrLaunchTokenAbi } from "./abis/generated.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import {
  LAUNCHER,
  OTHER,
  WETH,
  installLaunch,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";

const ADMIN = getAddress("0x00000000000000000000000000000000000ad317");
const NEXT = getAddress("0x00000000000000000000000000000000000ad318");

async function refusal(p: Promise<unknown>, code: LaunchSdkErrorCode) {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
  return (thrown as { detail?: string }).detail;
}

const decode = (data: `0x${string}`) =>
  decodeFunctionData({ abi: bankrLaunchTokenAbi, data });

describe("metadataAdmin", () => {
  test("get: the link, its admin and a pending offer; null for a link fixed at launch", async () => {
    const { f, client } = postLaunchFixture();
    const fixed = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    expect(await client.metadataAdmin.get(fixed.token)).toEqual({
      token: fixed.token,
      metadataUri: "ipfs://bafy-test",
      admin: null,
      pendingAdmin: null,
    });
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      metadataAdmin: ADMIN,
    });
    l.setToken("pendingMetadataAdmin", NEXT);
    expect(await client.metadataAdmin.get(l.token)).toMatchObject({
      admin: ADMIN,
      pendingAdmin: NEXT,
    });
    await refusal(client.metadataAdmin.get(OTHER), "NOT_A_LAUNCH");
  });

  test("the admin replaces the link, offers the role, withdraws the offer and renounces, each sent to the token", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      metadataAdmin: ADMIN,
    });
    const m = client.metadataAdmin;
    const set = await m.buildSetUri(l.token, ADMIN, "ipfs://bafy-next");
    expect(set).toMatchObject({ from: ADMIN, to: l.token, value: 0n });
    expect(decode(set.data)).toEqual({
      functionName: "setMetadataUri",
      args: ["ipfs://bafy-next"],
    });
    expect(decode((await m.buildTransfer(l.token, ADMIN, NEXT)).data)).toEqual({
      functionName: "transferMetadataAdmin",
      args: [NEXT],
    });
    expect(decode((await m.buildTransfer(l.token, ADMIN, null)).data)).toEqual({
      functionName: "transferMetadataAdmin",
      args: [zeroAddress],
    });
    expect(
      decode((await m.buildRenounce(l.token, ADMIN)).data).functionName,
    ).toBe("renounceMetadataAdmin");
  });

  test("only the pending admin accepts", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      metadataAdmin: ADMIN,
    });
    const m = client.metadataAdmin;
    expect(
      await refusal(m.buildAccept(l.token, NEXT), "NOT_METADATA_ADMIN"),
    ).toContain("has not offered");
    l.setToken("pendingMetadataAdmin", NEXT);
    const tx = await m.buildAccept(l.token, NEXT);
    expect(tx).toMatchObject({ from: NEXT, to: l.token });
    expect(decode(tx.data).functionName).toBe("acceptMetadataAdmin");
    await refusal(m.buildAccept(l.token, ADMIN), "NOT_METADATA_ADMIN");
  });

  test("what the token would revert is refused first: another account, a fixed link, a link over 2,048 bytes", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      metadataAdmin: ADMIN,
    });
    const m = client.metadataAdmin;
    // The launcher and the fee recipient hold no metadata role unless the launch named them.
    for (const p of [
      m.buildSetUri(l.token, LAUNCHER, "ipfs://x"),
      m.buildTransfer(l.token, LAUNCHER, NEXT),
      m.buildRenounce(l.token, LAUNCHER),
    ]) {
      expect(await refusal(p, "NOT_METADATA_ADMIN")).toContain(
        "Another account",
      );
    }
    const fixed = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    expect(
      await refusal(
        m.buildSetUri(fixed.token, LAUNCHER, "ipfs://x"),
        "NOT_METADATA_ADMIN",
      ),
    ).toContain("fixed");
    // Bytes, not characters: 683 three-byte characters are 2,049 bytes.
    expect(
      await refusal(
        m.buildSetUri(l.token, ADMIN, "€".repeat(683)),
        "INVALID_PARAMS",
      ),
    ).toBe("The metadata link can be at most 2,048 bytes.");
    await m.buildSetUri(l.token, ADMIN, "x".repeat(2_048));
    // The zero address withdraws an offer on the token: it is never taken as a new admin by mistake.
    await refusal(
      m.buildTransfer(l.token, ADMIN, zeroAddress),
      "INVALID_PARAMS",
    );
    await refusal(m.buildRenounce(OTHER, ADMIN), "NOT_A_LAUNCH");
  });
});

describe("tradingStatus", () => {
  test("holds the token's trading start to the latest block's timestamp", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    l.setToken("tradingStart", 2_000_000_000n);
    f.fake.timestamp = 1_999_999_400n;
    expect(await client.tradingStatus(l.token)).toEqual({
      token: l.token,
      startTime: 2_000_000_000,
      blockTime: 1_999_999_400,
      started: false,
      secondsUntilStart: 600,
    });
    // The token and the hook open at the start second itself.
    f.fake.timestamp = 2_000_000_000n;
    expect(await client.tradingStatus(l.token)).toMatchObject({
      started: true,
      secondsUntilStart: 0,
    });
    await refusal(client.tradingStatus(OTHER), "NOT_A_LAUNCH");
  });
});
