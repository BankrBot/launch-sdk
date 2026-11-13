import { isAddressEqual, type Hex } from "viem";
import { readContract } from "viem/actions";
import { bankrLaunchFactoryAbi } from "../abis/generated.js";
import { requireCapExclusions, type ProviderAddresses } from "../addresses.js";
import type { BankrApi, Preparer } from "../api.js";
import { planWithPreparer } from "../apiPlan.js";
import type { Authorizer } from "../authorizer.js";
import type { ChainCapabilities, LaunchChain } from "../chains/index.js";
import { LaunchConfigError, LaunchRefusedError } from "../errors.js";
import { createFees } from "../fees.js";
import { createHolders } from "../holders.js";
import { verifyTokenInvariants } from "../invariants.js";
import { BANKR_LAUNCHPAD_ID, launchpadInfo, readPad } from "../launchpad.js";
import { createLaunchpads } from "../launchpads.js";
import { readLaunchInfo, type SuiteReadContext } from "../lens.js";
import { planLaunch, type PlanContext } from "../plan.js";
import { readQuotes } from "../quotes.js";
import { parseLaunchReceipt } from "../receipt.js";
import { requireAddress } from "../recipient.js";
import { simulateLaunch } from "../simulate.js";
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
  /** Bankr's public API: `fees.getOwed` reads its account index. */
  index?: BankrApi;
}

const sameTx = (a: UnsignedTx, b: UnsignedTx): boolean =>
  a.chainId === b.chainId &&
  isAddressEqual(a.from, b.from) &&
  isAddressEqual(a.to, b.to) &&
  a.data.toLowerCase() === b.data.toLowerCase() &&
  a.value === b.value;

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
  const requireLaunchable = (): void => {
    if (!chain.deployed && !o.fork)
      throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
        chain: chain.chain,
        detail: `Launches on ${chain.chain} open in the SDK release that ships its go-live; reads work now. On a local fork of the suite, set \`fork: true\`.`,
      });
    requireCapExclusions(chain.chain);
  };
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
      return { deployed: chain.deployed, fork: o.fork, paused, gated };
    },
    async launchpad(id = BANKR_LAUNCHPAD_ID) {
      return launchpadInfo(
        await readPad(client, a.launchpadRegistry, id, chain.chain),
      );
    },
    readQuotes: (launchpadId = BANKR_LAUNCHPAD_ID) =>
      readQuotes(client, chain, {
        factory: a.factory,
        registry: a.launchpadRegistry,
        weth: a.weth,
        launchpadId,
      }),
    async plan(input) {
      requireLaunchable();
      return o.preparer
        ? planWithPreparer(ctx, o.preparer, input)
        : planLaunch(ctx, input);
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
    launchpads: createLaunchpads(suite),
    verifyTokenInvariants: (token, receipt) =>
      verifyTokenInvariants(suite, token, receipt),
  };
}
