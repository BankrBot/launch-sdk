import { describe, expect, test } from "bun:test";
import {
  LAUNCHER,
  OTHER,
  WETH,
  installLaunch,
  launchReceipt,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";

describe("verifyTokenInvariants", () => {
  test("a launch of this factory passes every check; the receipt adds supply and URI, prediction needs its calldata", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const bare = await client.verifyTokenInvariants(l.token);
    expect(bare).toEqual({
      ok: true,
      failures: [],
      skipped: ["totalSupply", "metadataUri", "prediction"],
    });
    // The fake node serves no transactions, so the prediction from calldata is skipped, never failed.
    const full = await client.verifyTokenInvariants(
      l.token,
      launchReceipt(f, l),
    );
    expect(full).toEqual({ ok: true, failures: [], skipped: ["prediction"] });
  });

  test("a wrong reward hook, URI, cap or an owner surface fails its check", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const receipt = launchReceipt(f, l);
    l.setToken("rewardHook", OTHER);
    l.setToken("metadataUri", "ipfs://swapped");
    l.setToken("maxBalanceLimit", 1n);
    l.setToken("owner", OTHER);
    const report = await client.verifyTokenInvariants(l.token, receipt);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(
      expect.arrayContaining(["rewardHook", "metadataUri", "supplyCap"]),
    );
  });

  test("a launch that named a metadata admin: a replaced link is not held to the receipt", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      metadataAdmin: OTHER,
    });
    const receipt = launchReceipt(f, l);
    l.setToken("metadataUri", "ipfs://replaced-by-its-admin");
    expect(await client.verifyTokenInvariants(l.token, receipt)).toEqual({
      ok: true,
      failures: [],
      skipped: ["metadataUri", "prediction"],
    });
  });

  test("a launch with no metadata admin: an admin appearing later fails the link's check", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const receipt = launchReceipt(f, l);
    l.setToken("metadataAdmin", OTHER);
    const report = await client.verifyTokenInvariants(l.token, receipt);
    expect(report.failures).toEqual(["metadataUri"]);
  });

  test("a stranger fails registration", async () => {
    const { client } = postLaunchFixture();
    const report = await client.verifyTokenInvariants(OTHER);
    expect(report.ok).toBe(false);
    expect(report.failures).toContain("registered");
  });
});
