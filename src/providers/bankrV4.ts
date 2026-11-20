import { isAddressEqual, type Hex } from "viem";
import { readContract } from "viem/actions";
import { bankrLaunchFactoryAbi } from "../abis/generated.js";
import { isShippedRecord, type ProviderAddresses } from "../addresses.js";
import type { BankrApi } from "../api.js";
import type { Authorizer } from "../authorizer.js";
import type { ChainCapabilities, LaunchChain } from "../chains/index.js";
import { LaunchConfigError, LaunchRefusedError } from "../errors.js";
import { createFees } from "../fees.js";
import { createHolders } from "../holders.js";
import { readLaunchInfo, type ReadContext } from "../lens.js";
import type { PlanContext } from "../plan.js";
import { previewLaunchExtension } from "../launch/extension.js";
import { verifyCoinInvariants } from "../launch/invariants.js";
import { planLaunch } from "../launch/plan.js";
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
  /** Launch on a fork or test deployment even though its record is not the one this SDK version ships. */
  fork: boolean;
  /** Salts this client has broadcast; a plan never reuses one. */
  usedSalts: ReadonlySet<string>;
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

/** Bankr's launch contracts on one chain: the factory, its pads, and every launch's fee buckets and distributor. */
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
  // Post-launch reads and builders act on launched tokens, so they work whether or not launches are open here.
  const reads: ReadContext = { chain, addresses: a, client, fork: o.fork };
  // A chain is live when the record the client is on is the one this SDK version ships for it.
  const live = isShippedRecord(chain.chain, a);
  const requireLaunchable = (): void => {
    if (!live && !o.fork)
      throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
        chain: chain.chain,
        detail: `Launches on ${chain.chain} with these addresses are not open in this SDK version; reads work now. On a local fork, set \`fork: true\`.`,
      });
  };
  const contracts = createLaunchContracts({
    chain,
    client,
    addresses: {
      factory: a.factory,
      launchpadRegistry: a.launchpadRegistry,
      settings: a.settings,
      ledger: a.ledger,
      termsLens: a.termsLens,
      blockNumber: a.blockNumber,
    },
  });
  // A plan may come from another process or client: everything that moves funds must be this client's contracts'.
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
    async plan(input) {
      requireLaunchable();
      return planLaunch(ctx, input);
    },
    // Async, so a malformed extension rejects like the reads behind it.
    async previewExtension(extension, options) {
      return previewLaunchExtension(ctx, extension, options);
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
      return readLaunchInfo(reads, requireAddress(token, chain.chain));
    },
    tradingStatus: (token) => readTradingStatus(reads, token),
    fees: createFees(reads, o.index),
    holders: createHolders(reads),
    vesting: createVesting(reads),
    metadataAdmin: createMetadataAdmin(reads),
    contracts: () => contracts,
    verifyTokenInvariants: (token, receipt) =>
      verifyCoinInvariants({ chain, addresses: a, client }, token, receipt),
  };
}
