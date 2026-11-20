import { describe, expect, test } from "bun:test";
import { createPublicClient, custom, getAddress } from "viem";
import { base } from "viem/chains";
import { createLaunchClient } from "./client.js";
import { isLaunchSdkError } from "./errors.js";
import { callLaunch } from "./simulate.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import { installContracts } from "./__internal__/fakeContracts.js";

describe("a node that gives no gas estimate for a launch, as one does for a launch over its per-transaction cap", () => {
  const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");

  // eth_call answers and eth_estimateGas fails with `refusal`; the plan is the SDK's own, allocations the caller's.
  async function unestimated(refusal: string) {
    const f = installContracts(new FakeChain(base));
    const node = f.fake.publicClient();
    const publicClient = createPublicClient({
      chain: base,
      transport: custom(
        {
          request: async (r: { method: string; params?: unknown }) => {
            if (r.method === "eth_estimateGas") throw new Error(refusal);
            return node.request(r as never);
          },
        },
        { retryCount: 0 },
      ),
    });
    const sdk = createLaunchClient({
      chain: "base",
      publicClient,
      addresses: f.deployment,
      fork: true,
    });
    const plan = await sdk.plan({
      name: "Launch SDK Test",
      symbol: "LSDK",
      metadataUri: "ipfs://bafy-test",
      launcher: LAUNCHER,
      launchpadId: f.padId,
      quote: f.quote,
      // The altered launches below are not the ones the plan pinned: send them unpinned.
      pin: false,
    });
    expect(plan.gasEstimate).toBeNull();
    const withAllocations = async (count: number) => {
      const params = {
        ...plan.params,
        extraAllocations: Array.from({ length: count }, (_, i) => ({
          recipient: getAddress(
            `0x${(0xa110 + i).toString(16).padStart(40, "0")}`,
          ),
          amount: 10n ** 21n,
          cliff: 2_592_000n,
          duration: 31_536_000n,
          push: false,
        })),
      };
      const sim = await callLaunch(publicClient, {
        chain: "base",
        factory: plan.factory,
        launcher: plan.launcher,
        params,
        value: plan.value,
        dataSuffix: plan.dataSuffix,
      });
      expect(sim.gas).toBeNull();
      return { ...plan, params, gasEstimate: sim.gas };
    };
    return { sdk, withAllocations };
  }

  test("the estimate is null, and the launch's builder allocations are held to the heaviest launch's figure", async () => {
    // As a node's estimate fails once the call needs more than one transaction holds.
    const { sdk, withAllocations } = await unestimated(
      "gas required exceeds allowance (16777216)",
    );
    expect(sdk.buildLaunchTx(await withAllocations(12)).gas).toBe(16_777_216n);
    const over = await withAllocations(13);
    let refused: unknown;
    try {
      sdk.buildLaunchTx(over);
    } catch (err) {
      refused = err;
    }
    expect(isLaunchSdkError(refused, "INVALID_PARAMS"), String(refused)).toBe(
      true,
    );
    expect((refused as { detail?: string }).detail).toContain(
      "the heaviest launch on Bankr's launchpad stands in for it: a gas limit of about 16,856,954 with its 13 builder allocations",
    );
    expect((refused as { detail?: string }).detail).toContain(
      "at that figure 12 of the 13 fit",
    );
  });

  test("an RPC that estimates nothing gives the same null: a light launch with 24 allocations is built on the caller's own gas", async () => {
    const { sdk, withAllocations } = await unestimated(
      "the method eth_estimateGas is not available",
    );
    // Nothing in the null says the launch is over the cap: about 10.4M here, which the chain takes.
    const light = await withAllocations(24);
    expect(sdk.buildLaunchTx(light, { gas: 12_537_120n }).gas).toBe(
      12_537_120n,
    );
    expect(sdk.buildLaunchTx({ ...light, gasEstimate: 10_447_600n }).gas).toBe(
      12_537_120n,
    );
  });
});
