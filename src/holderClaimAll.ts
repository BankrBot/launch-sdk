import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  multicall3Abi,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { getCode, readContract } from "viem/actions";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  holderRewardsDeployerAbi,
  holderRewardsDistributorAbi,
} from "./abis/generated.js";
import { bnkrHolderLegAbi } from "./abis/settings.js";
import { CONVERT_GAS } from "./conversion.js";
import { LaunchRefusedError } from "./errors.js";
import type { HolderLeg } from "./holders.js";
import type { ReadContext } from "./lens.js";
import { CLAIM_ALL_MAX_GAS_PER_TX } from "./planClaimAll.js";
import type { UnsignedTx } from "./providers/types.js";
import { hasCode, isDelegatedEoa, requireAddress } from "./recipient.js";
import { readHolderPiles } from "./launch/holderPiles.js";
import { buildCallTx } from "./tx.js";

/**
 * Holder-rewards gas limits, sized from the distributor's caps, never a bare estimate: a claim pulls the creator's
 * holder share from the fee ledger itself when its balance falls short (300,000 for the pull) and each payout of a
 * full claim gets 1,000,000, or the call reverts `InsufficientGas`.
 */
export const HOLDER_GAS = Object.freeze({
  /** `claim` and `claimLeg`: a claim that pulls, every payout capped, and under the claim's lowest use plus the holder
   *  leg's poke gate, so it never pays for a BNKR conversion. A coin quoted in another Bankr launch whose holder sat
   *  through BNKR swaps can need more: `claimFor`'s limit (`buildClaimFor`) or `options.gas` lands it. */
  claim: 1_750_000n,
  /** `claimFor`, and a `claimForMany`'s first account: the distributor's 2.4M claim floor (its worst claim, its pull
   *  and its last payout capped). */
  claimFor: 2_450_000n,
  /** Each further account of a `claimForMany`: the worst claim with its BNKR burning a payout's whole 1,000,000, so
   *  the next account still starts at the 2.4M floor. */
  perClaim: 1_900_000n,
});

/**
 * A holder claim-all's gas: Multicall3's own work per transaction plus the last coin's reserve (the 2.4M claim floor
 * less one coin), then the worst claim's own use per coin, its pull included: 14 coins in 15M with no poke, 10 with
 * a forward-only poke each, 4 with a converting one each.
 */
export const HOLDER_CLAIM_ALL_GAS = Object.freeze({
  base: 1_560_000n,
  perCoin: 900_000n,
  /** A coin on a quote the factory does not list: a claim whose quote burns its pull and a payout's whole 1,000,000
   *  (1.45M measured), so the next coin of that quote still lands. */
  perUnlistedCoin: 1_900_000n,
  /** A poke that only pays a pile on in quote (a quote with no floor, or the leg's forward rule): 270,000 measured,
   *  its floor sync included. */
  perPoke: 400_000n,
  /** A poke that may convert its quote's batch to BNKR: what the in-swap wake and a claim's own poke hand the leg. */
  perConvertPoke: 2_000_000n,
});

/** The distributor's QUOTE leg (`claimLeg(1)`). */
const LEG_QUOTE = 1;

/** Multicall3's address on every chain the SDK targets. */
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** One coin a holder claim-all touches: what each leg had earned when it was built. */
export interface HolderClaimCoin {
  token: Address;
  distributor: Address;
  quote: Address;
  poolId: Hex;
  /** The factory lists the quote. An unlisted one's coins are claimed last, in their quote's own transactions. */
  listed: boolean;
  /** The claim-all pokes the leg for the coin: its holders' pile is due at its quote's floor, or waits on a quote
   *  with no floor. Only a swap that asks wakes a pile, and `claimFor` never does. */
  poke: boolean;
  /** All zero for a coin that is only poked: named, nothing earned yet, its pile due. */
  earned: Record<HolderLeg, bigint>;
}

/** The account has something to claim on the coin; a coin without is in the plan for its poke alone. */
const earns = ({ earned }: Pick<HolderClaimCoin, "earned">) =>
  earned.token + earned.quote + earned.bnkr > 0n;

/** Every coin's hold-to-earn rewards for one account, claimed together. */
export interface HolderClaimAll {
  account: Address;
  /** `multicall`: an EOA or 7702 wallet Multicall3 may claim for (open, the default), pushed to by `claimFor`.
   *  `direct`: a contract account, or one that turned "anyone can claim" off (Multicall3's `claimFor` would claim
   *  nothing): one `claim()` per coin from the account itself, then one `leg.poke` per due pile at `CONVERT_GAS`. */
  mode: "multicall" | "direct";
  /** Listed-quote coins first, then each unlisted quote's coins together; in each, the coins that are claimed
   *  before the ones that are only poked. */
  coins: HolderClaimCoin[];
  /** The listed coins' transactions first: a hostile unlisted quote only ever shares a transaction with its own
   *  coins. Each transaction's pokes follow its claims, so a poke starves no claim. */
  txs: UnsignedTx[];
}

/** The holder claim-all for `account` over `tokens`: every coin with rewards, and a poke of each named coin's due
 *  pile, earned from yet or not. A coin that excludes the account, or with nothing earned and no poke, is left out. */
export async function buildHolderClaimAll(
  ctx: ReadContext,
  account: Address,
  tokens: readonly Address[],
  options: { maxGasPerTx?: bigint } = {},
): Promise<HolderClaimAll> {
  const chain = ctx.chain.chain;
  const { client } = ctx;
  const who = requireAddress(account, chain);
  const list = tokens.map((t) => requireAddress(t, chain));
  const budget = options.maxGasPerTx ?? CLAIM_ALL_MAX_GAS_PER_TX;
  const { base, perCoin, perUnlistedCoin, perPoke, perConvertPoke } =
    HOLDER_CLAIM_ALL_GAS;
  if (
    typeof budget !== "bigint" ||
    budget > ctx.chain.maxTxGas ||
    budget < base + perCoin
  )
    throw new LaunchRefusedError("INVALID_PARAMS", { chain });
  const multicall3 =
    ctx.chain.viemChain.contracts?.multicall3?.address ?? MULTICALL3;
  const [code, viaMulticall, read] = await Promise.all([
    getCode(client, { address: who }),
    readContract(client, {
      address: ctx.addresses.ledger,
      abi: bankrFeeLedgerAbi,
      functionName: "mayClaimFor",
      args: [who, multicall3],
    }),
    Promise.all(list.map((token) => readCoin(ctx, who, token))),
  ]);
  // Every named coin the account may earn from, earning yet or not: a waiting pile pays its holders nothing.
  const mine = read.filter((c): c is HolderClaimCoin => c !== null);
  // What a poke of each coin's pile would do now: nothing, forward it in quote, or convert its quote's batch.
  const piles = await readHolderPiles(ctx, mine);
  const pokeOf = new Map(
    mine.map((c, i) => [c.token.toLowerCase(), piles[i]!.poke]),
  );
  const legOf = new Map(
    mine.map((c, i) => [c.token.toLowerCase(), piles[i]!.leg]),
  );
  const leg = (c: HolderClaimCoin) => legOf.get(c.token.toLowerCase())!;
  const all = mine
    .map((c, i) => ({
      ...c,
      listed: piles[i]!.listed,
      poke: piles[i]!.poke !== "none",
    }))
    .filter((c) => earns(c) || c.poke);
  // A group's claims ahead of its poke-only coins, so the account's own rewards land in the first transactions.
  const groups = groupByQuote([
    ...all.filter(earns),
    ...all.filter((c) => !earns(c)),
  ]);
  const coins = groups.flat();
  const poke = (c: HolderClaimCoin) =>
    encodeFunctionData({
      abi: bnkrHolderLegAbi,
      functionName: "poke",
      args: [c.poolId],
    });
  // A restricted account refuses Multicall3 as msg.sender: it claims each coin itself.
  if ((hasCode(code) && !isDelegatedEoa(code)) || !viaMulticall) {
    const claim = encodeFunctionData({
      abi: holderRewardsDistributorAbi,
      functionName: "claim",
    });
    const call = (to: Address, data: Hex, gas: bigint) => ({
      ...buildCallTx(ctx.chain.chainId, who, to, data),
      gas,
    });
    return {
      account: who,
      mode: "direct",
      coins,
      txs: [
        ...coins
          .filter(earns)
          .map((c) => call(c.distributor, claim, HOLDER_GAS.claim)),
        ...coins
          .filter((c) => c.poke)
          .map((c) => call(leg(c), poke(c), CONVERT_GAS)),
      ],
    };
  }
  const claimFor = encodeFunctionData({
    abi: holderRewardsDistributorAbi,
    functionName: "claimFor",
    args: [who],
  });
  const pokeGas = { none: 0n, forward: perPoke, convert: perConvertPoke };
  // A poke-only coin is budgeted its poke alone: no claim runs for it.
  const gasOf = (c: HolderClaimCoin) =>
    (!earns(c) ? 0n : c.listed ? perCoin : perUnlistedCoin) +
    pokeGas[pokeOf.get(c.token.toLowerCase()) ?? "none"];
  // A budget that holds a coin's claim but not its poke cannot plan that coin: refused, never a short limit.
  const most = coins.map(gasOf).reduce((m, g) => (g > m ? g : m), 0n);
  if (base + most > budget)
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail: `maxGasPerTx is under the ${(base + most).toLocaleString("en-US")} gas one of these coins needs: its claim where it has rewards, and the poke of its holders' pile where one is due.`,
    });
  const txs: UnsignedTx[] = [];
  // Each group (the listed coins, then each unlisted quote's) in transactions of its own, claims then pokes.
  for (const group of groups) {
    let batch: HolderClaimCoin[] = [];
    let gas = base;
    const flush = () => {
      if (batch.length === 0) return;
      const calls = [
        ...batch.filter(earns).map((c) => ({
          target: c.distributor,
          allowFailure: true,
          callData: claimFor,
        })),
        ...batch
          .filter((c) => c.poke)
          .map((c) => ({
            target: leg(c),
            allowFailure: true,
            callData: poke(c),
          })),
      ];
      txs.push({
        ...buildCallTx(
          ctx.chain.chainId,
          who,
          multicall3,
          encodeFunctionData({
            abi: multicall3Abi,
            functionName: "aggregate3",
            args: [calls],
          }),
        ),
        gas,
      });
      batch = [];
      gas = base;
    };
    for (const c of group) {
      if (gas + gasOf(c) > budget) flush();
      batch.push(c);
      gas += gasOf(c);
    }
    flush();
  }
  return { account: who, mode: "multicall", coins, txs };
}

/** The listed coins, then each unlisted quote's coins, in first-seen order. */
function groupByQuote(coins: HolderClaimCoin[]): HolderClaimCoin[][] {
  const groups = new Map<string, HolderClaimCoin[]>([["listed", []]]);
  for (const c of coins) {
    const key = c.listed ? "listed" : c.quote.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].filter((g) => g.length > 0);
}

async function readCoin(
  ctx: ReadContext,
  who: Address,
  token: Address,
): Promise<HolderClaimCoin | null> {
  const [distributor, [poolId, key]] = await Promise.all([
    readContract(ctx.client, {
      address: ctx.addresses.holderRewardsDeployer,
      abi: holderRewardsDeployerAbi,
      functionName: "distributorOfToken",
      args: [token],
    }),
    readContract(ctx.client, {
      address: ctx.addresses.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "poolOf",
      args: [token],
    }),
  ]);
  if (isAddressEqual(distributor, zeroAddress))
    throw new LaunchRefusedError("NOT_A_LAUNCH", { chain: ctx.chain.chain });
  const d = { address: distributor, abi: holderRewardsDistributorAbi } as const;
  const [excluded, ...earned] = await Promise.all([
    readContract(ctx.client, {
      ...d,
      functionName: "rewardExcluded",
      args: [who],
    }),
    ...[0, 1, 2].map((leg) =>
      readContract(ctx.client, {
        ...d,
        functionName: "earned",
        args: [leg, who],
      }),
    ),
  ]);
  const [t, q, b] = earned as bigint[];
  // As Bankr's API over its own list: only exclusion drops a named coin before its pile is read.
  if (excluded) return null;
  return {
    token,
    distributor: getAddress(distributor),
    quote: getAddress(
      isAddressEqual(key.currency0, token) ? key.currency1 : key.currency0,
    ),
    poolId,
    listed: true,
    poke: false,
    earned: { token: t!, quote: q!, bnkr: b! },
  };
}

/** The coins with an earned leg (as built) that no `RewardClaimed` for the account in `receipts` paid: claim them again.
 *  A distributor pays each leg on its own, so a refused leg (a frozen quote) logs 0 beside the legs that paid; a coin on
 *  an unlisted quote whose claim landed with only that quote refused is not retried (it is the token's
 *  own refusal, and retrying it forever spends the claimer's gas). */
export function unclaimedHolderCoins(
  claimAll: HolderClaimAll,
  receipts: readonly TransactionReceipt[],
): Address[] {
  const paid = new Map<string, [boolean, boolean, boolean]>();
  for (const r of receipts) {
    if (r.status !== "success") continue;
    for (const log of parseEventLogs({
      abi: holderRewardsDistributorAbi,
      eventName: "RewardClaimed",
      logs: r.logs,
    })) {
      if (!isAddressEqual(log.args.account, claimAll.account)) continue;
      const key = log.address.toLowerCase();
      const legs = paid.get(key) ?? [false, false, false];
      log.args.amounts.forEach((amount, i) => {
        if (amount > 0n) legs[i] = true;
      });
      paid.set(key, legs);
    }
  }
  return claimAll.coins
    .filter((c) => {
      const legs = paid.get(c.distributor.toLowerCase());
      // A poke-only coin had no claim to land.
      if (!legs) return earns(c);
      const earned = [c.earned.token, c.earned.quote, c.earned.bnkr];
      return earned.some(
        (e, i) => e > 0n && !legs[i] && (c.listed || i !== LEG_QUOTE),
      );
    })
    .map((c) => c.token);
}
