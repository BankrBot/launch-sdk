import { describe, expect, test } from "bun:test";
import {
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  encodeErrorResult,
  getAddress,
  type Abi,
} from "viem";
import { base } from "viem/chains";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
} from "./abis/suite3.js";
import { CHAINS } from "./chains/index.js";
import { createLaunchClient } from "./client.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { callLaunch, launchCallError, launchRevertName } from "./simulate.js";
import { HOOK_EXTENSION_ERRORS } from "./unvendoredErrors.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import { installSuite, testSuite } from "./__internal__/fakeSuite.js";

// A revert as viem reports it from a simulated launch, decoded against the contract that declares the error.
function reverted(abi: Abi, errorName: string, args: unknown[] = []) {
  return new ContractFunctionRevertedError({
    abi,
    data: encodeErrorResult({ abi, errorName, args }),
    functionName: "launch",
  });
}

// Every error the fee recipient list, the metadata admin and the scheduled start added to a launch's path.
const ROWS: [Abi, string, unknown[], LaunchSdkErrorCode, string][] = [
  [
    bankrLaunchFactoryAbi,
    "InvalidFeeRecipients",
    [],
    "INVALID_PARAMS",
    "fee recipients",
  ],
  [
    bankrLaunchFactoryAbi,
    "OpenContractFeeRecipient",
    ["0x2222222222222222222222222222222222222222"],
    "FEE_RECIPIENT_CANNOT_CLAIM",
    "allowOpenCodeFeeRecipients",
  ],
  [
    bankrLaunchFactoryAbi,
    "ExtensionPayeeUnnamed",
    [],
    "INVALID_PARAMS",
    "extension's payee",
  ],
  [bankrFeeLedgerAbi, "TooManyCreators", [], "INVALID_PARAMS", "at most 10"],
  // The ledger refuses a pool's own currencies when it binds a launch's buckets: a recipient or a pad's payee.
  [
    bankrFeeLedgerAbi,
    "InvalidBeneficiary",
    [],
    "FEE_RECIPIENT_CANNOT_CLAIM",
    "is the launch's quote token",
  ],
  [bankrLaunchTokenAbi, "MetadataTooLong", [], "INVALID_PARAMS", "2,048"],
  [bankrLaunchFactoryAbi, "StartPassed", [], "INVALID_PARAMS", "later"],
  [bankrLaunchFactoryAbi, "StartTooFar", [], "INVALID_PARAMS", "7 days"],
  [
    bankrLaunchpadRegistryAbi,
    "StartDelayAboveLaunchpadMax",
    [],
    "INVALID_PARAMS",
    "launchpad allows",
  ],
  [
    bankrLaunchFactoryAbi,
    "DevBuyerExcluded",
    [],
    "DEV_BUY_UNAVAILABLE",
    "scheduled start",
  ],
  [
    bankrLaunchTokenAbi,
    "TradingNotStarted",
    [],
    "SIMULATION_REVERTED",
    "trading start",
  ],
  // Extensions always on: the binding's gas budgets, and a buy the extension turns away.
  [
    HOOK_EXTENSION_ERRORS,
    "ExtensionGasBudget",
    [],
    "INVALID_PARAMS",
    "50,000 to 250,000",
  ],
  [
    bankrLaunchFactoryAbi,
    "AmbiguousExtension",
    [],
    "INVALID_PARAMS",
    "at its floor as 0",
  ],
  [
    HOOK_EXTENSION_ERRORS,
    "ExtensionRefusedBuy",
    [],
    "SIMULATION_REVERTED",
    "never refuse a sell",
  ],
];

describe("launchCallError: the three features' and the extension's reverts", () => {
  test("each maps to a code and the SDK's own sentence, with the revert kept on cause", () => {
    for (const [abi, name, args, code, says] of ROWS) {
      const cause = reverted(abi, name, args);
      const err = launchCallError(cause, "base");
      expect(isLaunchSdkError(err, code), name).toBe(true);
      const sdk = err as { detail?: string; cause?: unknown };
      expect(sdk.detail, name).toContain(says);
      expect(launchRevertName(sdk.cause)).toBe(name);
    }
  });

  test("a revert with no sentence of its own keeps its code and carries no detail", () => {
    const err = launchCallError(
      reverted(bankrLaunchFactoryAbi, "Paused"),
      "base",
    );
    expect(isLaunchSdkError(err, "PAUSED")).toBe(true);
    expect((err as { detail?: string }).detail).toBeUndefined();
  });
});

describe("a node that gives no gas estimate for a launch, as one does for a launch over its per-transaction cap", () => {
  const SUITE = testSuite(8453);
  const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");

  // eth_call answers and eth_estimateGas fails with `refusal`; the plan is the SDK's own, allocations the caller's.
  async function unestimated(refusal: string) {
    const f = installSuite(new FakeChain(base), SUITE, {
      [CHAINS.base.quotes.WETH.address]: { decimals: 18 },
    });
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
      suite: 3,
      addresses: SUITE,
      fork: true,
    });
    const plan = await sdk.plan({
      name: "Launch SDK Test",
      symbol: "LSDK",
      metadataUri: "ipfs://bafy-test",
      launcher: LAUNCHER,
      launchpadId: 1n,
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
