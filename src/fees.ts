import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  holderRewardsDeployerAbi,
} from "./abis/suite3.js";
import type { BankrApi } from "./api.js";
import {
  LaunchConfigError,
  LaunchRefusedError,
  type CodeOfKind,
} from "./errors.js";
import {
  readQuoteListed,
  requireLaunch,
  type BeneficiaryRole,
  type LaunchInfo,
  type SuiteReadContext,
} from "./lens.js";
import { EARLIER_HOLDER_LEG_WAKE_ABI } from "./conversion.js";
import { PUBLIC_FORWARDERS } from "./normalize.js";
import { readOwed, type OwedState } from "./owed.js";
import {
  CLAIM_ALL_MAX_GAS_PER_TX,
  planClaimAll,
  type ClaimAllPlan,
} from "./planClaimAll.js";
import type { UnsignedTx } from "./providers/types.js";
import {
  readLegReferences,
  refuseUnclaimableRecipient,
  requireAddress,
  suiteContracts,
} from "./recipient.js";
import { readEarlierLivePointers, readLivePointers } from "./predict.js";
import { buildCallTx } from "./tx.js";

/** One account's share of one of a launch's fee buckets. */
export interface FeeShare {
  bucket: "creator" | "decay";
  bucketId: Hex;
  /** WAD share of the bucket; 0 = not a beneficiary. */
  sharesWad: bigint;
  /** The part of `sharesWad` held as one of the launch's fee recipients; 0 for a pad payee or any other entry. */
  creatorShareWad: bigint;
  role: BeneficiaryRole | null;
  /** Claimable now, by side (the launched token, then its quote). */
  claimableToken: bigint;
  claimableQuote: bigint;
}

/**
 * What `account` is owed on a launch's fee buckets. Shares are fixed at launch, per launch: read, never assumed. A
 * launch with several fee recipients has one entry per recipient, and each reads and claims its own.
 */
export interface FeeState {
  token: Address;
  account: Address;
  quote: Address;
  poolId: Hex;
  creator: FeeShare;
  /** Null when the launch's pad had no decay split at launch (Bankr's pad has one; any operator can turn one on). */
  decay: FeeShare | null;
  claimableToken: bigint;
  claimableQuote: bigint;
  /** The account's pull balance in the launch's quote and token: referral slices and settled shares, every launch's. */
  balances: { quote: bigint; token: bigint };
}

/** {@link LaunchFees.getClaimPolicy}: `mayClaim` is null when no caller was asked about. */
export interface ClaimPolicy {
  restricted: boolean;
  mayClaim: boolean | null;
}

/** {@link LaunchFees.buildClaimAll}'s options: the plan's dust floor, gas cap, unlisted currencies and sender. */
export interface ClaimAllOptions {
  /** Per currency: a share owing less on every side waits, and a currency totalling less is not withdrawn. */
  dust?: (quote: Address) => bigint;
  /** Default 15,000,000; at most the chain's per-transaction ceiling. */
  maxGasPerTx?: bigint;
  /**
   * Also withdraw currencies the factory does not list that are not launched tokens either (any-quote pairing), last
   * and in withdraws of their own. Off by default (round 9 F4): anyone can make an account owe in a gas-burning one, as
   * a launch's fee recipient or a swap's referrer, and its payout burns up to 1,000,000 gas every claim-all.
   */
  includeUnlisted?: boolean;
  /**
   * Who sends the transactions; default `account`. Another wallet pushes the account its fees (decision 5): `settle`
   * for it, then `withdrawFor`, paid only to `account`. `CLAIM_NOT_ALLOWED` while the account's claim policy bars it.
   */
  sender?: Address;
}

/** A launch's fee buckets after launch: read, claim one launch or everything owed, balances, and moving a share. */
export interface LaunchFees {
  /**
   * `account`'s shares and claimable fees on `token`. Default: the launch's first fee recipient (`launchInfo`'s
   * `feeRecipients[0]`), or the launcher when the creators take nothing; with several recipients, pass each wallet.
   * `NOT_A_LAUNCH` for a token this chain's factory never launched.
   */
  get(token: Address, account?: Address): Promise<FeeState>;
  /**
   * Claims `account`'s fees from every bucket it holds a share of (`collectFees`, or `collectFeesMany`), paid to
   * `account`, which sends it: one of the fee recipients, a pad operator's payee. `side` claims one currency only
   * (`collectFeesSide`, one transaction per bucket), so a frozen quote cannot hold the other. `NOT_A_BENEFICIARY`
   * when `account` holds no share.
   */
  buildClaim(
    token: Address,
    account: Address,
    options?: { side?: "token" | "quote" },
  ): Promise<UnsignedTx[]>;
  /**
   * Everything `account` is owed on this chain's ledger: its pull balances and every launch's bucket share with
   * something claimable, from Bankr's account index (`API_ERROR` when it cannot answer). A fork client is refused
   * (`INDEX_UNAVAILABLE`): read and claim one launch with `get` and `buildClaim`.
   */
  getOwed(account: Address): Promise<OwedState>;
  /**
   * Claims everything `account` is owed on this chain, as `getOwed` reads it, referral slices included:
   * `settle(ids, [account])` chunks, then `withdraw(lastIds, quotes)`, one transaction when it all fits. Send them in
   * order from `account`, or from `options.sender`, which pushes (settles, then `withdrawFor`: never one transaction);
   * each carries the gas limit. A quote that refuses its payout is `Withheld` and stays in the balance. Currencies
   * the factory does not list are left (`plan.unlisted`) unless `includeUnlisted`, then paid in trailing withdraws.
   */
  buildClaimAll(
    account: Address,
    options?: ClaimAllOptions,
  ): Promise<{ txs: UnsignedTx[]; plan: ClaimAllPlan }>;
  /** `account`'s pull balance in each of `quotes` (referral slices, settled shares); default the chain's named majors. */
  getBalances(
    account: Address,
    quotes?: readonly Address[],
  ): Promise<{ quote: Address; balance: bigint }[]>;
  /** `withdraw(bucketIds, quotes)`: settles `account`'s listed buckets, then pays it its balance in each quote. */
  buildWithdraw(
    account: Address,
    quotes: readonly Address[],
    bucketIds?: readonly Hex[],
  ): UnsignedTx;
  /**
   * `setClaimRestricted(restricted)`: `account`'s one claim policy, on the ledger and every holder distributor. Open
   * (the default) lets anyone settle and push its fees and claim its holder rewards, always paid to `account`;
   * restricted, only `account` and the claim operators it names. A contract that prices itself by its balance (a
   * vault, a pool) restricts itself so a stranger's push cannot land at a moment of the stranger's choosing.
   */
  buildSetClaimRestricted(account: Address, restricted: boolean): UnsignedTx;
  /**
   * `account`'s claim policy (`claimRestricted`), and with `caller` whether the ledger and every distributor let
   * `caller` settle, push and claim for it (`mayClaimFor`: the account itself, anyone while it is open, else its
   * operators). Read it before pushing to an account you do not control.
   */
  getClaimPolicy(account: Address, caller?: Address): Promise<ClaimPolicy>;
  /**
   * `setClaimOperator(operator, allowed)`: names a wallet allowed to claim for `account` (settle its shares, push it its
   * balance and claim its holder rewards), paid only to `account`; `allowed: false` removes it. It matters only while
   * `account` is restricted (`buildSetClaimRestricted`); an open account needs none. A public forwarder (Multicall3,
   * Multicall2, Multicall) is refused (`INVALID_PARAMS`): it calls for anyone, so naming it reopens the account to
   * everyone. A restricted account's holder claim-all is one `claim()` per coin from itself (`buildClaimAll`).
   */
  buildSetClaimOperator(
    account: Address,
    operator: Address,
    allowed: boolean,
  ): UnsignedTx;
  /**
   * Moves `account`'s own entry in the launch's buckets to `newRecipient` (`updateBeneficiary`): the ledger pays both
   * sides to `account` first, the entry keeps its share, and the launch's other fee recipients are untouched. Refuses
   * (`FEE_RECIPIENT_CANNOT_CLAIM`) a recipient that could never claim, and (`INVALID_PARAMS`) one that already holds an
   * entry, another fee recipient included: the ledger never merges two.
   */
  buildSetFeeRecipient(
    token: Address,
    account: Address,
    newRecipient: Address,
    options?: { allowContractFeeRecipient?: boolean },
  ): Promise<UnsignedTx>;
}

/** The fee namespace for one chain's suite; `index` is Bankr's API, which `getOwed` and `buildClaimAll` read. */
export function createFees(ctx: SuiteReadContext, index: BankrApi): LaunchFees {
  const { addresses: a, client } = ctx;
  const chain = ctx.chain.chain;
  const refuse = (code: CodeOfKind<"refused">): never => {
    throw new LaunchRefusedError(code, { chain });
  };
  // A fork's state is not the live chain the index reads, so its answer would be another chain's.
  const requireIndex = () => {
    if (ctx.fork) throw new LaunchConfigError("INDEX_UNAVAILABLE", { chain });
  };
  const call = (from: Address, data: Hex) =>
    buildCallTx(ctx.chain.chainId, from, a.ledger, data);
  const ledger = { address: a.ledger, abi: bankrFeeLedgerAbi } as const;

  async function share(
    info: LaunchInfo,
    bucket: "creator" | "decay",
    account: Address,
  ): Promise<FeeShare> {
    const bucketId =
      bucket === "creator" ? info.buckets.creator : info.buckets.decay!;
    const [[fees0, fees1], sharesWad] = await Promise.all([
      readContract(client, {
        ...ledger,
        functionName: "claimable",
        args: [bucketId, account],
      }),
      readContract(client, {
        ...ledger,
        functionName: "getShares",
        args: [bucketId, account],
      }),
    ]);
    const list = bucket === "creator" ? info.creatorShares : info.decayShares;
    const entry = list.find((s) => isAddressEqual(s.account, account));
    return {
      bucket,
      bucketId,
      sharesWad,
      creatorShareWad: entry?.creatorShareWad ?? 0n,
      role: entry?.role ?? null,
      claimableToken: info.tokenIsCurrency0 ? fees0 : fees1,
      claimableQuote: info.tokenIsCurrency0 ? fees1 : fees0,
    };
  }

  async function get(token: Address, account?: Address): Promise<FeeState> {
    const info = await requireLaunch(ctx, token);
    const who =
      account === undefined
        ? (info.feeRecipients[0]?.recipient ?? info.launcher)
        : requireAddress(account, chain);
    const balance = (q: Address) =>
      readContract(client, {
        ...ledger,
        functionName: "balances",
        args: [who, q],
      });
    const [creator, decay, quoteBalance, tokenBalance] = await Promise.all([
      share(info, "creator", who),
      info.buckets.decay === null ? null : share(info, "decay", who),
      balance(info.quote),
      balance(info.token),
    ]);
    return {
      token: info.token,
      account: who,
      quote: info.quote,
      poolId: info.poolId,
      creator,
      decay,
      claimableToken: creator.claimableToken + (decay?.claimableToken ?? 0n),
      claimableQuote: creator.claimableQuote + (decay?.claimableQuote ?? 0n),
      balances: { quote: quoteBalance, token: tokenBalance },
    };
  }

  const held = (s: FeeState) =>
    [s.creator, s.decay].filter(
      (x): x is FeeShare => x !== null && x.sharesWad > 0n,
    );

  const publicForwarders = () => [
    ...PUBLIC_FORWARDERS,
    ctx.chain.viemChain.contracts?.multicall3?.address ?? zeroAddress,
  ];

  /** BankrFeeLedger._mayPush for `sender`: true, or why not. A puller (claims collector, protocol sink or suite
   *  contract) collects its own share and is never pushed, whatever its policy. */
  async function readPushable(
    account: Address,
    sender: Address,
  ): Promise<true | string> {
    const [mayClaim, collector, sink, suite] = await Promise.all([
      readContract(client, {
        ...ledger,
        functionName: "mayClaimFor",
        args: [account, sender],
      }),
      readContract(client, {
        ...ledger,
        functionName: "isClaimsCollector",
        args: [account],
      }),
      readContract(client, {
        ...ledger,
        functionName: "isProtocolSink",
        args: [account],
      }),
      readContract(client, {
        address: a.factory,
        abi: bankrLaunchFactoryAbi,
        functionName: "isSuite",
        args: [account],
      }),
    ]);
    if (collector || sink || suite)
      return "The account is a Bankr puller: it collects its own share and is never pushed.";
    if (!mayClaim)
      return "The account restricts who may claim for it, and the sender is not one of its claim operators.";
    return true;
  }

  /** The owed currencies that are none of a named major, a quote the factory lists, the holder leg's BNKR or a
   *  launched token. */
  async function unlistedOf(owed: OwedState): Promise<Set<string>> {
    const known = new Set([
      ...Object.values(ctx.chain.quotes).map((q) => q.address.toLowerCase()),
      ...owed.buckets.map((b) => b.token.toLowerCase()),
    ]);
    const unknown = [
      ...new Set(
        [
          ...owed.buckets.map((b) => b.quote),
          ...owed.balances.map((b) => b.quote),
        ]
          .map((q) => q.toLowerCase())
          .filter((q) => !known.has(q)),
      ),
    ];
    if (unknown.length === 0) return new Set();
    const bnkr = await readContract(client, {
      address: a.holderLeg,
      abi: EARLIER_HOLDER_LEG_WAKE_ABI,
      functionName: "bnkr",
    }).catch(() => zeroAddress);
    const others = unknown.filter((q) => q !== bnkr.toLowerCase());
    const flags = await Promise.all(
      others.map(async (q) => {
        if (await readQuoteListed(ctx, getAddress(q))) return false;
        const distributor = await readContract(client, {
          address: a.holderRewardsDeployer,
          abi: holderRewardsDeployerAbi,
          functionName: "distributorOfToken",
          args: [getAddress(q)],
        });
        return isAddressEqual(distributor, zeroAddress);
      }),
    );
    return new Set(others.filter((_, i) => flags[i]));
  }

  return {
    get,

    async buildClaim(token, account, options = {}) {
      const state = await get(token, requireAddress(account, chain));
      const buckets = held(state);
      if (buckets.length === 0) refuse("NOT_A_BENEFICIARY");
      const ids = buckets.map((b) => b.bucketId);
      if (options.side === undefined) {
        return [
          call(
            state.account,
            ids.length === 1
              ? encodeFunctionData({
                  abi: bankrFeeLedgerAbi,
                  functionName: "collectFees",
                  args: [ids[0]!],
                })
              : encodeFunctionData({
                  abi: bankrFeeLedgerAbi,
                  functionName: "collectFeesMany",
                  args: [ids],
                }),
          ),
        ];
      }
      if (options.side !== "token" && options.side !== "quote")
        refuse("INVALID_PARAMS");
      const info = await requireLaunch(ctx, token);
      const isCurrency0 = (options.side === "token") === info.tokenIsCurrency0;
      return ids.map((id) =>
        call(
          state.account,
          encodeFunctionData({
            abi: bankrFeeLedgerAbi,
            functionName: "collectFeesSide",
            args: [id, isCurrency0],
          }),
        ),
      );
    },

    async getOwed(account) {
      const who = requireAddress(account, chain);
      requireIndex();
      return readOwed(ctx, index, who);
    },

    async buildClaimAll(account, options = {}) {
      const who = requireAddress(account, chain);
      requireIndex();
      const from =
        options.sender === undefined
          ? who
          : requireAddress(options.sender, chain, "The sender");
      const push = !isAddressEqual(from, who);
      // A public forwarder calls for anyone, so a push "from" it is one nobody can sign (as buildSetClaimOperator).
      if (push && publicForwarders().some((f) => isAddressEqual(f, from)))
        throw new LaunchRefusedError("INVALID_PARAMS", {
          chain,
          detail: "The sender cannot be a public forwarder.",
        });
      const maxGasPerTx = options.maxGasPerTx ?? CLAIM_ALL_MAX_GAS_PER_TX;
      if (typeof maxGasPerTx !== "bigint" || maxGasPerTx > ctx.chain.maxTxGas)
        refuse("INVALID_PARAMS");
      const [owed, pushable] = await Promise.all([
        readOwed(ctx, index, who),
        push ? readPushable(who, from) : null,
      ]);
      const unlisted = await unlistedOf(owed);
      const plan = planClaimAll({
        buckets: owed.buckets,
        balances: owed.balances,
        dust: options.dust,
        maxGasPerTx,
        unlisted: (q) => unlisted.has(q.toLowerCase()),
        includeUnlisted: options.includeUnlisted === true,
        push,
      });
      // The ledger's settle skips an account it may not push; its withdrawFor reverts NotPushable for one that
      // restricts the sender, and pays a puller only the balance it already holds.
      // The SDK still builds no push to a puller: it collects its own share.
      if (pushable !== null && pushable !== true && plan.steps.length > 0)
        throw new LaunchRefusedError("CLAIM_NOT_ALLOWED", {
          chain,
          detail: pushable,
        });
      const txs = plan.steps.map((s) => ({
        ...call(
          from,
          s.kind === "settle"
            ? encodeFunctionData({
                abi: bankrFeeLedgerAbi,
                functionName: "settle",
                args: [s.bucketIds, [who]],
              })
            : push
              ? encodeFunctionData({
                  abi: bankrFeeLedgerAbi,
                  functionName: "withdrawFor",
                  args: [who, s.quotes],
                })
              : encodeFunctionData({
                  abi: bankrFeeLedgerAbi,
                  functionName: "withdraw",
                  args: [s.bucketIds, s.quotes],
                }),
        ),
        gas: s.gas,
      }));
      return { txs, plan };
    },

    async getBalances(account, quotes) {
      const who = requireAddress(account, chain);
      const list = (
        quotes ?? Object.values(ctx.chain.quotes).map((q) => q.address)
      ).map((q) => requireAddress(q, chain));
      const balances = await Promise.all(
        list.map((q) =>
          readContract(client, {
            ...ledger,
            functionName: "balances",
            args: [who, q],
          }),
        ),
      );
      return list.map((quote, i) => ({ quote, balance: balances[i]! }));
    },

    buildWithdraw(account, quotes, bucketIds = []) {
      const who = requireAddress(account, chain);
      if (quotes.length === 0) refuse("INVALID_PARAMS");
      const list = quotes.map((q) => requireAddress(q, chain));
      return call(
        who,
        encodeFunctionData({
          abi: bankrFeeLedgerAbi,
          functionName: "withdraw",
          args: [[...bucketIds], list],
        }),
      );
    },

    buildSetClaimRestricted(account, restricted) {
      const who = requireAddress(account, chain);
      if (typeof restricted !== "boolean") refuse("INVALID_PARAMS");
      return call(
        who,
        encodeFunctionData({
          abi: bankrFeeLedgerAbi,
          functionName: "setClaimRestricted",
          args: [restricted],
        }),
      );
    },

    async getClaimPolicy(account, caller) {
      const who = requireAddress(account, chain);
      const by = caller === undefined ? null : requireAddress(caller, chain);
      const [restricted, mayClaim] = await Promise.all([
        readContract(client, {
          ...ledger,
          functionName: "claimRestricted",
          args: [who],
        }),
        by === null
          ? null
          : readContract(client, {
              ...ledger,
              functionName: "mayClaimFor",
              args: [who, by],
            }),
      ]);
      return { restricted, mayClaim };
    },

    buildSetClaimOperator(account, operator, allowed) {
      const who = requireAddress(account, chain);
      const op = requireAddress(operator, chain);
      // Naming yourself changes nothing (an account always claims for itself), so it is refused as a mistake.
      if (isAddressEqual(who, op) || typeof allowed !== "boolean")
        refuse("INVALID_PARAMS");
      // A public forwarder is msg.sender for every caller: naming it would let anyone claim (round 9 FF2/RSEC-2).
      if (allowed && publicForwarders().some((f) => isAddressEqual(f, op)))
        throw new LaunchRefusedError("INVALID_PARAMS", {
          chain,
          detail:
            "A public forwarder (Multicall3, Multicall2, Multicall) calls for anyone: naming it lets anyone claim for the account.",
        });
      return call(
        who,
        encodeFunctionData({
          abi: bankrFeeLedgerAbi,
          functionName: "setClaimOperator",
          args: [op, allowed],
        }),
      );
    },

    async buildSetFeeRecipient(token, account, newRecipient, options = {}) {
      const state = await get(token, requireAddress(account, chain));
      const next = requireAddress(newRecipient, chain);
      const buckets = held(state);
      if (buckets.length === 0) refuse("NOT_A_BENEFICIARY");
      const info = await requireLaunch(ctx, token);
      // A suite 4 factory holds no cap controller, so its pointers are read by its own list.
      const [live, references] = await Promise.all([
        a.settings === undefined
          ? readEarlierLivePointers(client, a.factory)
          : readLivePointers(client, a.factory),
        readLegReferences(client, a.holderLeg),
      ]);
      // The ledger refuses an existing beneficiary; the factory's payee rules apply to the new one.
      const existing = [...info.creatorShares, ...info.decayShares].map(
        (s) => s.account,
      );
      if (existing.some((x) => isAddressEqual(x, next)))
        throw new LaunchRefusedError("INVALID_PARAMS", {
          chain,
          detail:
            "The new recipient already holds a share of this launch's fees, and the ledger never merges two entries.",
        });
      await refuseUnclaimableRecipient(
        client,
        chain,
        next,
        [
          ...suiteContracts(a, live, references),
          info.token,
          info.distributor,
          info.quote,
          ...(info.escrow === null ? [] : [info.escrow]),
        ],
        options.allowContractFeeRecipient === true,
        live.ledger,
        a.factory,
      );
      const ids = buckets.map((b) => b.bucketId);
      return call(
        state.account,
        ids.length === 1
          ? encodeFunctionData({
              abi: bankrFeeLedgerAbi,
              functionName: "updateBeneficiary",
              args: [ids[0]!, next],
            })
          : encodeFunctionData({
              abi: bankrFeeLedgerAbi,
              functionName: "updateBeneficiaryMany",
              args: [ids, getAddress(next)],
            }),
      );
    },
  };
}
