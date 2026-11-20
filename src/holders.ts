import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { readContract } from "viem/actions";
import { holderRewardsDistributorAbi } from "./abis/generated.js";
import { LaunchRefusedError } from "./errors.js";
import {
  HOLDER_GAS,
  buildHolderClaimAll,
  unclaimedHolderCoins,
  type HolderClaimAll,
} from "./holderClaimAll.js";
import { requireLaunch, type ReadContext } from "./lens.js";
import type { UnsignedTx } from "./providers/types.js";
import { requireAddress } from "./recipient.js";
import { buildConvertTx, type HolderConversion } from "./conversion.js";
import { readHolderConversion } from "./launch/holderPiles.js";
import { buildCallTx } from "./tx.js";

/**
 * A distributor's three legs, sharing one eligible supply: the launched token (vest-to-holders, donations), the
 * pool's quote (the creator's holder share; Bankr's holders' half where it pays in quote) and BNKR.
 */
export const HOLDER_LEGS = Object.freeze(["token", "quote", "bnkr"] as const);

export type HolderLeg = (typeof HOLDER_LEGS)[number];

const LEG_ID: Readonly<Record<HolderLeg, number>> = {
  token: 0,
  quote: 1,
  bnkr: 2,
};

/** One leg as an account sees it. */
export interface HolderLegState {
  /** The leg's asset; null for the BNKR leg on a chain whose holder leg has not named BNKR. The BNKR leg's is its open
   *  epoch's token: a BNKR swap changes it once the old token's last day of streaming ends. */
  asset: Address | null;
  /** Earned and claimable now (streams accrue each second). */
  earned: bigint;
}

/**
 * BNKR earned before a BNKR swap (Bankr swapping the token its holder rewards buy, behind 48 hours' notice): each
 * swap closes the BNKR leg's epoch, and what the account earned in it stays claimable in that epoch's token, forever.
 */
export interface PastBnkrRewards {
  /** The closed epoch: claim it with `buildClaimPastBnkr(token, account, epoch)`. */
  epoch: number;
  /** The BNKR token of that epoch (an earlier one than the leg's BNKR now). */
  token: Address;
  /** What the account can claim of it now, its first checkpoint since the swap included. */
  claimable: bigint;
}

/** An account's hold-to-earn rewards on one launch: every wallet balance earns, with nothing to stake. */
export interface HolderRewardState {
  token: Address;
  account: Address;
  /** The launch's distributor (every launch has one). */
  distributor: Address;
  /** The account's token balance: what earns. */
  balance: bigint;
  /** Excluded accounts (Bankr's launch contracts, the escrow, anyone who called `excludeSelf`) earn nothing. */
  excluded: boolean;
  legs: Record<HolderLeg, HolderLegState>;
  /** The BNKR leg's open epoch, and the token it hands over to once its old token's last day ends (null when steady). */
  bnkrEpoch: { epoch: number; next: Address | null };
  /** BNKR from closed epochs the account can still claim, oldest first; empty when there is none. */
  pastBnkr: PastBnkrRewards[];
}

/**
 * Fees to holders after launch, per leg. Every claim carries a gas limit from {@link HOLDER_GAS}, the distributor's
 * caps: a lower limit reverts `InsufficientGas`.
 */
export interface LaunchHolders {
  get(token: Address, account: Address): Promise<HolderRewardState>;
  /** `claim()` (every leg, each payout handed 1M gas) or `claimLeg(leg)`, paid to `account`, which sends it;
   *  `options.gas` replaces `HOLDER_GAS.claim` (README, "Claim everything at once", says when to raise it). It never
   *  converts or forwards Bankr's holder half: send `buildConvert` with it when `getConversion` reads `convertDue`. */
  buildClaim(
    token: Address,
    account: Address,
    options?: { leg?: HolderLeg; gas?: bigint },
  ): Promise<UnsignedTx>;
  /** Every coin of `tokens` with rewards for `account`, claimed together and paid only to `account`, then a `leg.poke`
   *  for each named coin's due holders' pile, earned from yet or not (README, "Claim everything at once": batching,
   *  gas and modes). `INVALID_PARAMS` for a `maxGasPerTx` under one coin; `NOT_A_LAUNCH` for a stranger token. */
  buildClaimAll(
    account: Address,
    tokens: readonly Address[],
    options?: { maxGasPerTx?: bigint },
  ): Promise<HolderClaimAll>;
  /** The coins of a claim-all with an earned leg that no `RewardClaimed` for the account in `receipts` paid (the
   *  whole claim failed, or the leg's asset refused): retry them. An unlisted quote that refused its own payout in a
   *  claim that landed is not listed. */
  unclaimed(
    claimAll: HolderClaimAll,
    receipts: readonly TransactionReceipt[],
  ): Address[];
  /**
   * `claimFor` (one account) or `claimForMany`: pushes each account's rewards to that account, never the sender. The fee
   * ledger's claim policy rules every distributor: anyone may push to an open account (the default, contract or not); a
   * restricted one only takes it from itself or a claim operator it named on the ledger (`client.fees`), and
   * `claimForMany` skips it. `INVALID_PARAMS` for more accounts than the chain's per-transaction gas ceiling holds (8
   * on Base).
   */
  buildClaimFor(
    token: Address,
    sender: Address,
    accounts: readonly Address[],
  ): Promise<UnsignedTx>;
  /** `claimPastBnkr(account, epoch)`: one closed epoch's BNKR (`get` lists them), paid to `account` in that epoch's
   *  token. Sent by `account`, or by `options.sender` under `buildClaimFor`'s rule; refused for an epoch not closed. */
  buildClaimPastBnkr(
    token: Address,
    account: Address,
    epoch: number,
    options?: { sender?: Address },
  ): Promise<UnsignedTx>;
  /**
   * Whether the launch's holders' pile is due (Q4): the quote's conversion to BNKR is open, or the pile forwards in
   * quote. `options.now` is the chain's time in Unix seconds (default the latest block's). The pile is read at the
   * holder leg of the coin's own launch. Only a swap whose hookData asks for the wake and that carries its gas runs
   * it; {@link LaunchHolders.buildConvert} runs it for anyone.
   */
  getConversion(
    token: Address,
    options?: { now?: number },
  ): Promise<HolderConversion>;
  /**
   * The convert action: `leg.poke(poolId)` from `sender`, anyone, at `CONVERT_GAS` (2.1M). It stages the pile, then
   * forwards it or converts its quote's batch when due; never a loss when it is not (the pile stays staged).
   */
  buildConvert(token: Address, sender: Address): Promise<UnsignedTx>;
}

/** The holders namespace for one chain's contracts. */
export function createHolders(ctx: ReadContext): LaunchHolders {
  const chain = ctx.chain.chain;
  const { client } = ctx;
  const abi = holderRewardsDistributorAbi;
  const invalid = (): never => {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain });
  };
  const call = (from: Address, to: Address, data: Hex) =>
    buildCallTx(ctx.chain.chainId, from, to, data);
  const limit = (gas: bigint) =>
    gas > ctx.chain.maxTxGas ? ctx.chain.maxTxGas : gas;

  async function resolve(token: unknown, account: unknown) {
    const info = await requireLaunch(ctx, token);
    return { info, who: requireAddress(account, chain), d: info.distributor };
  }

  return {
    async get(token, account) {
      const { info, who, d } = await resolve(token, account);
      const dist = { address: d, abi } as const;
      const [balance, excluded, [openEpoch, next], ...legs] = await Promise.all(
        [
          readContract(client, {
            address: info.token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [who],
          }),
          readContract(client, {
            ...dist,
            functionName: "rewardExcluded",
            args: [who],
          }),
          readContract(client, { ...dist, functionName: "bnkrEpoch" }),
          ...HOLDER_LEGS.flatMap((leg) => [
            readContract(client, {
              ...dist,
              functionName: "assetOf",
              args: [LEG_ID[leg]],
            }),
            readContract(client, {
              ...dist,
              functionName: "earned",
              args: [LEG_ID[leg], who],
            }),
          ]),
        ],
      );
      const legState = (n: number): HolderLegState => {
        const asset = legs[n * 2] as Address;
        return {
          asset: isAddressEqual(asset, zeroAddress) ? null : getAddress(asset),
          earned: legs[n * 2 + 1] as bigint,
        };
      };
      // At most MAX_BNKR_EPOCHS (4) closed epochs, so a read each.
      const past = await Promise.all(
        Array.from({ length: Number(openEpoch) }, (_, e) =>
          readContract(client, {
            ...dist,
            functionName: "pastBnkr",
            args: [BigInt(e), who],
          }),
        ),
      );
      return {
        token: info.token,
        account: who,
        distributor: d,
        balance: balance as bigint,
        excluded: excluded as boolean,
        legs: { token: legState(0), quote: legState(1), bnkr: legState(2) },
        bnkrEpoch: {
          epoch: Number(openEpoch),
          next: isAddressEqual(next, zeroAddress) ? null : getAddress(next),
        },
        pastBnkr: past.flatMap(([epochToken, , claimable], e) =>
          claimable > 0n
            ? [{ epoch: e, token: getAddress(epochToken), claimable }]
            : [],
        ),
      };
    },

    async buildClaim(token, account, options = {}) {
      const { who, d } = await resolve(token, account);
      const { leg, gas = HOLDER_GAS.claim } = options;
      if (leg !== undefined && !HOLDER_LEGS.includes(leg)) invalid();
      if (typeof gas !== "bigint" || gas <= 0n) invalid();
      return {
        ...call(
          who,
          d,
          leg === undefined
            ? encodeFunctionData({ abi, functionName: "claim" })
            : encodeFunctionData({
                abi,
                functionName: "claimLeg",
                args: [LEG_ID[leg]],
              }),
        ),
        gas: limit(gas),
      };
    },

    buildClaimAll: (account, tokens, options) =>
      buildHolderClaimAll(ctx, account, tokens, options),

    unclaimed: unclaimedHolderCoins,

    async buildClaimFor(token, sender, accounts) {
      const { who, d } = await resolve(token, sender);
      if (accounts.length === 0) invalid();
      const list = accounts.map((x) => requireAddress(x, chain));
      // claimForMany reverts the batch when an element starts under its 2.4M floor, so a clamped limit never pays.
      const gas =
        HOLDER_GAS.claimFor + BigInt(list.length - 1) * HOLDER_GAS.perClaim;
      if (gas > ctx.chain.maxTxGas) invalid();
      return {
        ...call(
          who,
          d,
          list.length === 1
            ? encodeFunctionData({
                abi,
                functionName: "claimFor",
                args: [list[0]!],
              })
            : encodeFunctionData({
                abi,
                functionName: "claimForMany",
                args: [list],
              }),
        ),
        gas,
      };
    },

    getConversion: (token, options = {}) =>
      readHolderConversion(ctx, token, options.now),

    buildConvert: (token, sender) => buildConvertTx(ctx, token, sender),

    async buildClaimPastBnkr(token, account, epoch, options = {}) {
      const { who, d } = await resolve(token, account);
      const from =
        options.sender === undefined
          ? who
          : requireAddress(options.sender, chain);
      if (!Number.isSafeInteger(epoch) || epoch < 0) invalid();
      // Only a closed epoch pays (BadEpoch otherwise): the open one is the BNKR leg's claim / claimLeg.
      const [open] = await readContract(client, {
        address: d,
        abi,
        functionName: "bnkrEpoch",
      });
      if (BigInt(epoch) >= open) invalid();
      return call(
        from,
        d,
        encodeFunctionData({
          abi,
          functionName: "claimPastBnkr",
          args: [who, BigInt(epoch)],
        }),
      );
    },
  };
}
