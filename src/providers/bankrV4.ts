import { isAddressEqual, type Hex } from "viem";
import { readContract } from "viem/actions";
import { bankrLaunchFactoryAbi } from "../abis/suite3.js";
import {
  isShippedSuite4,
  requireCapExclusions,
  type ProviderAddresses,
} from "../addresses.js";
import type { BankrApi, Preparer } from "../api.js";
import { planWithPreparer } from "../apiPlan.js";
import type { Authorizer } from "../authorizer.js";
import type { ChainCapabilities, LaunchChain } from "../chains/index.js";
import { LaunchConfigError, LaunchRefusedError } from "../errors.js";
import { previewExtension } from "../extensionPreview.js";
import { createFees } from "../fees.js";
import { createHolders } from "../holders.js";
import { verifyTokenInvariants } from "../invariants.js";
import { BANKR_LAUNCHPAD_ID, launchpadInfo, readPad } from "../launchpad.js";
import { createLaunchpads, type LaunchpadOperations } from "../launchpads.js";
import { readLaunchInfo, type SuiteReadContext } from "../lens.js";
import { planLaunch, type PlanContext } from "../plan.js";
import { previewSuite4Extension } from "../suite4/extension.js";
import { verifySuite4TokenInvariants } from "../suite4/invariants.js";
import { planSuite4Launch } from "../suite4/plan.js";
import { readQuotes } from "../quotes.js";
import { parseLaunchReceipt } from "../receipt.js";
import { requireAddress } from "../recipient.js";
import { simulateLaunch } from "../simulate.js";
import { createLaunchContracts } from "../settings/index.js";
import { createMetadataAdmin, readTradingStatus } from "../token.js";
import { buildApproveTx, buildLaunchTx } from "../tx.js";
import { createVesting } from "../vesting.js";
import type {
  LaunchPlan,
  LaunchProviderAdapter,
  ReadClient,
  UnsignedTx,
} from "./types.js";

export interface BankrV4AdapterOptions<C extends LaunchChain> {
  chain: ChainCapabilities<C>;
  addresses: ProviderAddresses;
  client: ReadClient;
  dataSuffix: Hex | undefined;
  /** Launch on a fork or test suite even though the chain is not `deployed` in this SDK version. */
  fork: boolean;
  /** Salts this client has broadcast; a plan never reuses one. */
  usedSalts: ReadonlySet<string>;
  /** API mode: Bankr's prepare endpoint builds each launch. */
  preparer?: Preparer;
  /** Signs launches on a third-party pad with a signer. */
  authorizer?: Authorizer;
  /** Bankr's public API: `fees.getOwed` and `fees.buildClaimAll` read its account index. */
  index: BankrApi;
}

const sameTx = (a: UnsignedTx, b: UnsignedTx): boolean =>
  a.chainId === b.chainId &&
  isAddressEqual(a.from, b.from) &&
  isAddressEqual(a.to, b.to) &&
  a.data.toLowerCase() === b.data.toLowerCase() &&
  a.value === b.value;

/** Suite 3's pad builders on a suite 4 client: each refuses by name, a builder by rejecting as its own reads do. */
function refusedLaunchpads(
  ops: LaunchpadOperations,
  refusal: (what: string) => Error,
): LaunchpadOperations {
  return new Proxy(ops, {
    get(target, key, receiver) {
      if (typeof key !== "string" || !Object.hasOwn(target, key))
        return Reflect.get(target, key, receiver);
      const what = `client.launchpads.${key}()`;
      return key === "launchpadIdFromReceipt"
        ? () => {
            throw refusal(what);
          }
        : async () => {
            throw refusal(what);
          };
    },
  });
}

/** Bankr's v4 hook suite on one chain: the factory, its pads, and every launch's fee buckets and distributor. */
export function createBankrV4Adapter<C extends LaunchChain>(
  o: BankrV4AdapterOptions<C>,
): LaunchProviderAdapter<C> {
  const { chain, addresses: a, client } = o;
  const ctx: PlanContext<C> = {
    chain,
    addresses: a,
    provider: "bankr_v4",
    client,
    dataSuffix: o.dataSuffix,
    usedSalts: o.usedSalts,
    authorizer: o.authorizer,
  };
  // Post-launch reads and builders act on launched tokens, so they work whether or not the chain is `deployed`.
  const suite: SuiteReadContext = { chain, addresses: a, client, fork: o.fork };
  // A suite 4 record names its settings contract: launches are planned against it.
  const settings = a.settings;
  // Bankr's prepare route answers for suite 3 until its suite 4 response ships; nothing is re-checked blind. Said
  // when the client is built: a preparer it will never call is a mistake to learn of before anything is planned.
  if (settings && o.preparer)
    throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
      chain: chain.chain,
      detail:
        "Launching through Bankr's API (api.preparer) is not available on these contracts in this SDK version, and Bankr's own launchpad (id 0) launches only that way. Build the client without api.preparer and launch on your own launchpad or any open one.",
    });
  // Each suite has its own go-live: suite 3's is the chain's `deployed` flag, suite 4's its shipped record.
  const live = settings ? isShippedSuite4(chain.chain, a) : chain.deployed;
  const requireLaunchable = (): void => {
    if (!live && !o.fork)
      throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
        chain: chain.chain,
        detail: `Launches on ${chain.chain} with these addresses are not open in this SDK version; reads work now. On a local fork, set \`fork: true\`.`,
      });
    requireCapExclusions(chain.chain);
  };
  // A pad's terms and a chain's quotes live in the settings contract on suite 4; suite 3's registry reads would
  // answer for another contract. What a default client prints never names a suite.
  const suite4Reads = (what: string, instead: string) =>
    new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
      chain: chain.chain,
      detail: `${what} reads the earlier contracts' launchpad registry, and these contracts keep a launchpad's terms in the settings contract: use ${instead}.`,
    });
  const contracts = settings
    ? createLaunchContracts({
        chain,
        client,
        addresses: {
          factory: a.factory,
          launchpadRegistry: a.launchpadRegistry,
          settings,
          ledger: a.ledger,
          termsLens: a.termsLens,
          blockNumber: a.blockNumber,
        },
      })
    : null;
  // A plan may come from another process or client: everything that moves funds must be this suite's.
  const requireOwnPlan = (plan: LaunchPlan<C>): void => {
    if (plan.chain !== chain.chain)
      throw new LaunchConfigError("UNSUPPORTED_CHAIN", { chain: chain.chain });
    const p = plan.params;
    const amount = p.devBuyAmountIn;
    const approval = buildApproveTx(
      chain.chainId,
      plan.launcher,
      p.quote,
      a.factory,
      amount,
    );
    const native = plan.value > 0n;
    const ok =
      isAddressEqual(plan.factory, a.factory) &&
      isAddressEqual(plan.quote.address, p.quote) &&
      (!native ||
        (amount === 0n &&
          isAddressEqual(p.quote, a.weth) &&
          chain.nativeDevBuy)) &&
      plan.approvals.length <= (amount > 0n ? 1 : 0) &&
      plan.approvals.every((x) => sameTx(x, approval));
    if (!ok)
      throw new LaunchRefusedError("INVALID_PARAMS", { chain: chain.chain });
  };

  return {
    id: "bankr_v4",
    chain,
    info: {
      id: "bankr_v4",
      chain: chain.chain,
      addresses: a,
      contractsCommit: a.gitCommit,
    },
    async status() {
      const f = { address: a.factory, abi: bankrLaunchFactoryAbi } as const;
      const [paused, gated] = await Promise.all([
        readContract(client, { ...f, functionName: "paused" }),
        readContract(client, { ...f, functionName: "launchGated" }),
      ]);
      return { deployed: live, fork: o.fork, paused, gated };
    },
    async launchpad(id = BANKR_LAUNCHPAD_ID) {
      if (settings)
        throw suite4Reads("launchpad()", "client.contracts().settings.pad(id)");
      return launchpadInfo(
        await readPad(client, a.launchpadRegistry, id, chain.chain),
      );
    },
    async readQuotes(launchpadId = BANKR_LAUNCHPAD_ID) {
      if (settings)
        throw suite4Reads("quotes()", "client.contracts().settings.quotes()");
      return readQuotes(client, chain, {
        factory: a.factory,
        registry: a.launchpadRegistry,
        weth: a.weth,
        launchpadId,
      });
    },
    async plan(input) {
      requireLaunchable();
      if (!settings)
        return o.preparer
          ? planWithPreparer(ctx, o.preparer, input)
          : planLaunch(ctx, input);
      return planSuite4Launch({ ...ctx, addresses: { ...a, settings } }, input);
    },
    // Async, so a malformed extension rejects like the reads behind it.
    async previewExtension(extension, options) {
      return settings
        ? previewSuite4Extension(
            { ...ctx, addresses: { ...a, settings } },
            extension,
            options,
          )
        : previewExtension(ctx, extension, options);
    },
    buildLaunchTx(plan, options) {
      requireOwnPlan(plan);
      return buildLaunchTx(chain, plan, options);
    },
    async simulate(plan, options) {
      requireLaunchable();
      requireOwnPlan(plan);
      return simulateLaunch(client, plan, options);
    },
    parseReceipt: (receipt, expectedToken) =>
      parseLaunchReceipt(a, chain.chain, receipt, expectedToken),
    // Async, so a malformed address rejects like every other read instead of throwing synchronously.
    async launchInfo(token) {
      return readLaunchInfo(suite, requireAddress(token, chain.chain));
    },
    tradingStatus: (token) => readTradingStatus(suite, token),
    fees: createFees(suite, o.index),
    holders: createHolders(suite),
    vesting: createVesting(suite),
    metadataAdmin: createMetadataAdmin(suite),
    launchpads: settings
      ? refusedLaunchpads(createLaunchpads(suite), (what) =>
          suite4Reads(what, "client.contracts().launchpads"),
        )
      : createLaunchpads(suite),
    contracts() {
      if (contracts) return contracts;
      throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
        chain: chain.chain,
        detail:
          "This client is on suite 3, which has no settings contract: build it without `suite: 3`.",
      });
    },
    verifyTokenInvariants: (token, receipt) =>
      settings
        ? verifySuite4TokenInvariants(
            { chain, addresses: { ...a, settings }, client },
            token,
            receipt,
          )
        : verifyTokenInvariants(suite, token, receipt),
  };
}
