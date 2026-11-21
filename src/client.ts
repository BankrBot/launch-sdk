import {
  createPublicClient,
  http,
  isAddress,
  isAddressEqual,
  type Account,
  type Address,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import {
  isCompleteRecord,
  mergeAddresses,
  PROVIDER_ADDRESS_KEYS,
  type LaunchProviderId,
  type ProviderAddresses,
  type ProviderInfo,
} from "./addresses.js";
import {
  BankrApiResponseError,
  REGISTER_MIN_CONFIRMATIONS,
  createBankrApi,
  type BuilderProfile,
  type BuilderQuery,
  type FetchLike,
  type IndexedLaunch,
  type LaunchDetailQuery,
  type LaunchPage,
  type LaunchQuery,
  type LaunchpadStats,
  type LaunchpadStatsQuery,
  type RegisterResult,
} from "./api.js";
import type { Authorizer } from "./authorizer.js";
import {
  getChain,
  type ChainCapabilities,
  type LaunchChain,
} from "./chains/index.js";
import {
  LaunchConfigError,
  LaunchExecutionError,
  LaunchRefusedError,
  isLaunchSdkError,
  launchSdkError,
} from "./errors.js";
import type { LaunchExtensionInput } from "./extension.js";
import type {
  LaunchExtensionPreview,
  PreviewExtensionOptions,
} from "./extensionPreview.js";
import type { LaunchFees } from "./fees.js";
import type { LaunchHolders } from "./holders.js";
import type { LaunchIterationOptions } from "./indexPages.js";
import type { InvariantReport } from "./invariants.js";
import type { LaunchInfo } from "./lens.js";
import type { LaunchMetadataAdmin, TradingStatus } from "./token.js";
import { requireAddress } from "./recipient.js";
import type { LaunchContracts } from "./settings/index.js";
import { createBankrV4Adapter } from "./providers/bankrV4.js";
import type {
  LaunchInput,
  LaunchPlan,
  LaunchResult,
  LaunchStatus,
  ReadClient,
  SimResult,
  UnsignedTx,
} from "./providers/types.js";
import { builderCodeSuffix } from "./tx.js";
import type { LaunchVesting } from "./vesting.js";

/** Options for {@link createLaunchClient}. */
export interface LaunchClientOptions<C extends LaunchChain = LaunchChain> {
  /** Required: there is no default chain. */
  chain: C;
  /** Reads and simulations (any viem public client). Built from `rpcUrl` (or the chain's public RPC) when omitted. */
  publicClient?: ReadClient;
  /** Signs `launch()`; its account must be the launcher. Not needed to plan or build unsigned transactions. */
  walletClient?: WalletClient;
  /** Required on Arc (no verified public RPC); recommended on Robinhood, Ethereum and BNB Chain (shallow history,
   *  rate limits). */
  rpcUrl?: string;
  /** Default and only provider in this version: `bankr_v4`, Bankr's Uniswap v4 launch contracts. */
  provider?: LaunchProviderId;
  /**
   * Signs launches on a third-party launchpad that has a signer: called with the final terms, it returns the pad
   * signer's `{ nonce, deadline, signature }`. `remoteAuthorizer(url)` in a browser; on the pad's server,
   * `padAuthorizer` from `@bankr/launch-sdk/server`. Open pads need none. Bankr's own pad (id 0) is signed by Bankr,
   * and this SDK version cannot ask for that signature.
   */
  authorizer?: Authorizer;
  /** ERC-8021 builder codes appended to launch calldata (claimed, unverified). */
  builderCodes?: string[];
  /** Also append Bankr's own builder code. Default false. */
  appendBankrBuilderCode?: boolean;
  /**
   * Fork or test override of the contracts' addresses, merged over the chain's record. One that names another
   * `factory` is merged over nothing: pass that deployment's whole record. It never makes the launch methods run
   * against addresses this SDK version does not ship: that takes `fork`.
   */
  addresses?: Partial<ProviderAddresses>;
  /**
   * Forks and tests only: run the launch methods against contracts you deployed yourself, or an anvil fork of the
   * chain's record. Never set it against a live chain.
   */
  fork?: boolean;
  /**
   * Set, `launch()` registers each launch with Bankr's index once it has 5 confirmations. Omitted or `false`: the
   * indexer picks the launch up at the chain's full depth.
   */
  api?: false | LaunchApiOptions;
}

/** {@link LaunchClientOptions.api}. */
export interface LaunchApiOptions {
  /** Bankr's API for the index and registration. Default `https://api.bankr.bot`. */
  url?: string;
  /** Default the global `fetch`. */
  fetch?: FetchLike;
}

/** Bankr's public launch index, scoped to the client's chain. Works without `api` (which sets the URL). */
export interface LaunchIndex {
  /** Launches on this chain, newest first; pass `nextCursor` back as `cursor` for the next page. A page that
   *  leaves launches out, because Bankr's index of the chain is behind, says so in `incomplete`. */
  launches(query?: Omit<LaunchQuery, "chain">): Promise<LaunchPage>;
  /** Every launch on this chain matching `query`, newest first, a page at a time (`for await`). A page that leaves
   *  launches out throws `INDEX_UNAVAILABLE` (try again) unless `options.onIncomplete` takes it. */
  all(
    query?: Omit<LaunchQuery, "chain">,
    options?: LaunchIterationOptions,
  ): AsyncIterableIterator<IndexedLaunch>;
  /** One launch, hidden ones included; null when Bankr has not indexed it. */
  launch(
    token: Address,
    query?: LaunchDetailQuery,
  ): Promise<IndexedLaunch | null>;
  /** A builder's public profile and stats; null for an unknown slug. */
  builder(slug: string, query?: BuilderQuery): Promise<BuilderProfile | null>;
  /** One pad's totals on this chain; zeros for an unknown pad. */
  launchpadStats(
    id: bigint | string,
    query?: LaunchpadStatsQuery,
  ): Promise<LaunchpadStats>;
  /** Indexes a launch once it has 5 confirmations, ahead of the indexer's full depth. Idempotent. */
  register(txHash: Hex): Promise<RegisterResult>;
}

/** A launch client bound to one chain and provider. */
export interface LaunchClient<C extends LaunchChain = LaunchChain> {
  readonly chain: ChainCapabilities<C>;
  readonly provider: ProviderInfo<C>;
  readonly publicClient: ReadClient;
  /** The factory's pause and launch gate, read live. */
  status(): Promise<LaunchStatus>;
  /**
   * The contracts by name. `settings` reads what the owner and each launchpad hold a launch to (`settings.pad(id)`,
   * `settings.quotes()`, `settings.levers()`); `launchpads` and `owner` build a pad operator's and the protocol
   * owner's changes as unsigned transactions; `coinTerms` reads a coin's frozen record and holds the coin to it;
   * `holderLegs` reads the holders' legs. Nothing here sends.
   */
  contracts(): LaunchContracts;
  /** Validates and refuses, reads the pad, prices, mines the salt, predicts the token and lists approvals. Sends nothing. */
  plan(input: LaunchInput<C>): Promise<LaunchPlan<C>>;
  /**
   * What a launch's `extension` does and whether it can launch on `launchpadId` (default 0) now: its label, terms,
   * fee over time and payee split, the registry's answer for its allowlist key and the launchpad policy's, and
   * `refusal`, the reason `plan()` would throw `EXTENSION_NOT_ALLOWED`. Reads only; a parameter outside its bound
   * throws `EXTENSION_OUT_OF_BOUNDS`.
   */
  previewExtension(
    extension: LaunchExtensionInput,
    options?: PreviewExtensionOptions,
  ): Promise<LaunchExtensionPreview>;
  /**
   * The unsigned launch transaction (pure; gas clamped to the chain's ceiling) for wagmi, a Safe or a 4337 bundler.
   * Multisig signing latency risks `Expired`, an expired pad authorization and `START_TICK_CHANGED`: plan with a
   * longer `deadlineSeconds`, prefer a USDC quote, and re-plan on any of them.
   */
  buildLaunchTx(plan: LaunchPlan<C>, options?: { gas?: bigint }): UnsignedTx;
  /** Simulates the plan from the launcher, assuming its pending ERC-20 approvals. */
  simulate(plan: LaunchPlan<C>): Promise<SimResult>;
  /**
   * Plans, sends any approval, simulates, sends the launch from the wallet and parses the receipt. Re-plans (with a
   * fresh salt) when the start tick leaves the factory's bounds, the predicted token is taken or the pad's
   * authorization lapses, before sending or after the launch reverts on-chain; a broadcast salt is never reused. A
   * mined revert is read by replaying the launch at its block, and throws its mapped code (or `TRANSACTION_REVERTED`)
   * with `transactionHash`, as does a reverted approval.
   */
  launch(input: LaunchInput<C>): Promise<LaunchResult<C>>;
  /** The launch in a mined receipt from this chain's factory. */
  parseLaunchReceipt(
    receipt: TransactionReceipt,
    expectedToken?: Address,
  ): LaunchResult<C>;
  // After launch: reads, and unsigned transactions for the account that sends them. No wallet needed.
  /**
   * A launch read from the chain: pool, pad, fee schedules, buckets and their shares, fee recipients, metadata admin,
   * trading start, distributor, escrow. Null for a stranger.
   */
  launchInfo(token: Address): Promise<LaunchInfo | null>;
  /** Whether a launch trades yet: its trading start against the latest block's timestamp. */
  tradingStatus(token: Address): Promise<TradingStatus>;
  /** Fee buckets: read and claim one launch, claim everything owed, pull balances, and moving a share. */
  readonly fees: LaunchFees;
  /** Hold-to-earn rewards per leg (token, quote, BNKR): read, claim, push. */
  readonly holders: LaunchHolders;
  /** Vesting: read the escrow, release the creator's slice, push the holders' slice. */
  readonly vesting: LaunchVesting;
  /** The token's metadata link: read it and its admin, replace it, hand the role on or renounce it. */
  readonly metadataAdmin: LaunchMetadataAdmin;
  /**
   * Holds a token to what a launch through this factory guarantees. Any revert fails a check. Pass the launch
   * receipt for the full set (its supply, URI and the prediction from its calldata).
   */
  verifyTokenInvariants(
    token: Address,
    receipt?: TransactionReceipt,
  ): Promise<InvariantReport>;
  /** Bankr's launch index on this chain: reads, and registration of a mined launch. */
  readonly index: LaunchIndex;
}

const MAX_REPLANS = 2;
// launch() gives registration (confirmations, retries and Bankr's answers) this long; the indexer still catches up.
export const REGISTER_WAIT_MS = 120_000;
// Bankr's RPC can trail the client's by a few blocks: its "not yet" answers are retried after 1, 2, 4, 8, 16 s.
const REGISTER_RETRY_MS = 1_000;
const REGISTER_RETRY_MAX_MS = 16_000;

/** Bankr's RPC has not caught up with the client's: too few confirmations, or no such transaction yet. */
function bankrNotYet(err: unknown): boolean {
  const cause = isLaunchSdkError(err, "API_ERROR") ? err.cause : undefined;
  return (
    cause instanceof BankrApiResponseError &&
    (cause.code === "NOT_CONFIRMED" || cause.code === "TX_NOT_FOUND")
  );
}

/** Settles after `ms`, or rejects as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function warn(message: string): void {
  // Optional: an embedded runtime may have no `console`, and a warning must never throw.
  (globalThis as { console?: { warn?: (m: string) => void } }).console?.warn?.(
    message,
  );
}

/**
 * A launch client for one chain, on Bankr's contracts there. It needs only an RPC, and launches from the builder's
 * own wallet on an open launchpad (or a signed one with an `authorizer`). Throws `UNSUPPORTED_CHAIN` for a chain
 * outside `CHAINS`, `PROVIDER_NOT_DEPLOYED` for an `addresses` override that is incomplete or for another chain id,
 * and `RPC_REQUIRED` on Arc without an RPC. A fork's own record builds a client whose reads work and whose launch
 * methods refuse, unless the client is a `fork`.
 */
export function createLaunchClient<C extends LaunchChain>(
  o: LaunchClientOptions<C>,
): LaunchClient<C> {
  const caps = getChain(o.chain);
  const chain = caps.chain;
  const api = o.api || undefined;
  const merged = mergeAddresses(chain, o.addresses);
  const providerId = o.provider ?? "bankr_v4";
  if (providerId !== "bankr_v4") {
    throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
      chain,
      detail: `This SDK version launches on bankr_v4 only, not ${String(providerId)}.`,
    });
  }
  if (!isCompleteRecord(merged)) {
    const missing = PROVIDER_ADDRESS_KEYS.filter(
      (k) => merged[k] === undefined,
    );
    throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
      chain,
      detail: `addresses is missing ${missing.map((k) => `addresses.${k}`).join(", ")}: an override that names its own factory is the whole record.`,
    });
  }
  if (merged.chainId !== caps.chainId) {
    throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
      chain,
      detail: `addresses.chainId is ${merged.chainId}, not ${chain}'s ${caps.chainId}.`,
    });
  }
  const addresses: ProviderAddresses = Object.freeze(merged);

  if (caps.rpcRequired && !o.publicClient && !o.rpcUrl) {
    throw new LaunchConfigError("RPC_REQUIRED", { chain });
  }
  for (const client of [o.publicClient, o.walletClient]) {
    if (client?.chain && client.chain.id !== caps.chainId) {
      throw new LaunchConfigError("UNSUPPORTED_CHAIN", { chain });
    }
  }
  if (caps.rpcRecommended && !o.publicClient && !o.rpcUrl) {
    warn(
      `@bankr/launch-sdk: ${chain}'s public RPC keeps little history and rate-limits; pass an rpcUrl.`,
    );
  }
  const dataSuffix: Hex | undefined = builderCodeSuffix(o);
  const publicClient: ReadClient =
    o.publicClient ??
    createPublicClient({
      chain: caps.viemChain,
      transport: http(o.rpcUrl),
      batch: { multicall: true },
    });
  const bankrApi = createBankrApi({ url: api?.url, fetch: api?.fetch });
  // A client built with `api` registers each launch with Bankr's index.
  const registers = api !== undefined;
  const usedSalts = new Set<string>();
  const provider = createBankrV4Adapter({
    chain: caps,
    addresses,
    client: publicClient,
    dataSuffix,
    fork: o.fork === true,
    usedSalts,
    authorizer: o.authorizer,
    index: bankrApi,
  });

  async function registerWhenConfirmed(
    hash: Hex,
    signal: AbortSignal,
  ): Promise<RegisterResult> {
    await waitForTransactionReceipt(publicClient, {
      hash,
      confirmations: REGISTER_MIN_CONFIRMATIONS,
      timeout: REGISTER_WAIT_MS,
    });
    for (let wait = REGISTER_RETRY_MS; ;) {
      try {
        return await bankrApi.register(chain, hash, { signal });
      } catch (err) {
        if (!bankrNotYet(err)) throw err;
        await pause(wait, signal);
        wait = Math.min(wait * 2, REGISTER_RETRY_MAX_MS);
      }
    }
  }

  /**
   * Best effort, within REGISTER_WAIT_MS: a launch Bankr refused, or had not registered by then, is left to the
   * indexer at the chain's full confirmation depth.
   */
  async function register(
    receipt: TransactionReceipt,
  ): Promise<RegisterResult | null> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REGISTER_WAIT_MS);
    const { signal } = deadline;
    // The race holds the bound even for a custom fetch that ignores the signal.
    const expired = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    try {
      return await Promise.race([
        registerWhenConfirmed(receipt.transactionHash, signal),
        expired,
      ]);
    } catch {
      warn(
        "@bankr/launch-sdk: Bankr's index did not register the launch yet; its indexer picks it up at full depth.",
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function send(
    wallet: WalletClient,
    account: Account | Address,
    tx: UnsignedTx,
  ): Promise<TransactionReceipt> {
    const hash = await wallet.sendTransaction({
      account,
      chain: caps.viemChain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
    });
    return waitForTransactionReceipt(publicClient, { hash });
  }

  /** Why a mined launch reverted: the launch replayed at its block, mapped to an SDK code, with the hash. */
  async function minedRevert(
    plan: LaunchPlan<C>,
    receipt: TransactionReceipt,
  ): Promise<unknown> {
    const transactionHash = receipt.transactionHash;
    try {
      await provider.simulate(plan, {
        assumeApprovals: false,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      // A mapped revert keeps its code; any other leaves the decoded revert on `cause` (launchRevertName).
      if (isLaunchSdkError(err) && err.code !== "SIMULATION_REVERTED") {
        return launchSdkError(err.code, {
          chain,
          cause: err.cause,
          detail: err.detail,
          transactionHash,
        });
      }
      return new LaunchExecutionError("TRANSACTION_REVERTED", {
        chain,
        cause: isLaunchSdkError(err) ? err.cause : err,
        transactionHash,
      });
    }
    // The replay passes (e.g. the launch ran out of gas): nothing to map.
    return new LaunchExecutionError("TRANSACTION_REVERTED", {
      chain,
      transactionHash,
    });
  }

  return {
    chain: caps,
    provider: provider.info,
    publicClient,
    status: () => provider.status(),
    plan: (input) => provider.plan(input),
    previewExtension: (extension, options) =>
      provider.previewExtension(extension, options),
    buildLaunchTx: (plan, options) => provider.buildLaunchTx(plan, options),
    simulate: (plan) => provider.simulate(plan),
    parseLaunchReceipt: (receipt, expectedToken) =>
      provider.parseReceipt(receipt, expectedToken),
    launchInfo: (token) => provider.launchInfo(token),
    tradingStatus: (token) => provider.tradingStatus(token),
    fees: provider.fees,
    holders: provider.holders,
    vesting: provider.vesting,
    metadataAdmin: provider.metadataAdmin,
    contracts: () => provider.contracts(),
    verifyTokenInvariants: (token, receipt) =>
      provider.verifyTokenInvariants(token, receipt),
    index: {
      launches: (query = {}) => bankrApi.launches({ ...query, chain }),
      all: (query = {}, options) =>
        bankrApi.allLaunches({ ...query, chain }, options),
      // Async, so a malformed address rejects like the read itself.
      launch: async (token, query) =>
        bankrApi.launch(chain, requireAddress(token, chain), query),
      builder: (slug, query) => bankrApi.builder(slug, query),
      launchpadStats: (id, query) => bankrApi.launchpadStats(chain, id, query),
      register: (txHash) => bankrApi.register(chain, txHash),
    },

    async launch(input) {
      const wallet = o.walletClient;
      if (!wallet) throw new LaunchConfigError("WALLET_REQUIRED", { chain });
      const account = wallet.account ?? input.launcher;
      const sender = typeof account === "string" ? account : account.address;
      if (
        isAddress(input.launcher, { strict: false }) &&
        !isAddressEqual(sender, input.launcher)
      ) {
        throw new LaunchRefusedError("LAUNCHER_MISMATCH", { chain });
      }

      // A moved tick, a lapsed authorization, a taken token or a pin that no longer holds is fixed by a fresh plan. A broadcast salt is burned, so a caller's own salt is re-planned only before it is sent, and
      // never after a taken token.
      const replannable = (err: unknown, broadcast: boolean): boolean =>
        ((isLaunchSdkError(err, "START_TICK_CHANGED") ||
          isLaunchSdkError(err, "TERMS_CHANGED") ||
          isLaunchSdkError(err, "AUTHORIZATION_INVALID")) &&
          (!broadcast || input.salt === undefined)) ||
        (isLaunchSdkError(err, "POOL_ALREADY_INITIALIZED") &&
          input.salt === undefined);

      let plan = await provider.plan(input);
      for (let replans = 0; ; replans++) {
        for (const approval of plan.approvals) {
          const receipt = await send(wallet, account, approval);
          if (receipt.status !== "success") {
            throw new LaunchExecutionError("TRANSACTION_REVERTED", {
              chain,
              transactionHash: receipt.transactionHash,
            });
          }
        }
        let sim: SimResult;
        try {
          // Approvals are mined by now: simulate exactly what will execute.
          sim = await provider.simulate(plan, { assumeApprovals: false });
        } catch (err) {
          if (replans < MAX_REPLANS && replannable(err, false)) {
            plan = await provider.plan(input);
            continue;
          }
          throw err;
        }
        const tx = provider.buildLaunchTx({
          ...plan,
          gasEstimate: sim.gas ?? plan.gasEstimate,
        });
        // Broadcast means public: this salt can be front-run from here on, so no later plan may reuse it.
        usedSalts.add(plan.params.salt.toLowerCase());
        const receipt = await send(wallet, account, tx);
        if (receipt.status === "success") {
          const result = provider.parseReceipt(receipt, plan.predictedToken);
          return registers
            ? { ...result, registration: await register(receipt) }
            : result;
        }
        const err = await minedRevert(plan, receipt);
        if (replans < MAX_REPLANS && replannable(err, true)) {
          plan = await provider.plan(input);
          continue;
        }
        throw err;
      }
    },
  };
}
