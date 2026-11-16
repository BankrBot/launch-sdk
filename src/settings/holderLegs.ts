import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress,
  zeroHash,
  type Address,
  type ContractFunctionReturnType,
} from "viem";
import { getBlock, readContract } from "viem/actions";
import { bankrFeeLedgerAbi, bnkrHolderLegAbi } from "../abis/settings.js";
import { LaunchRefusedError } from "../errors.js";
import { bucketIds } from "../lens.js";
import type { UnsignedTx } from "../providers/types.js";
import {
  settingsKit,
  type SettingsContext,
  type SettingsKit,
} from "./context.js";
import {
  PAYOUT_BNKR,
  holderPileDue,
  type CoinHolderLeg,
  type HolderPile,
  type HolderPileReads,
} from "./holderPile.js";

// Holder legs come in generations: the factory names one for every launch from now on, and a coin keeps the leg of
// its launch for life. So a pile is asked about, poked and converted at the coin's own leg, never at "the" leg.

type LegView<N extends "legTerms" | "routes"> = ContractFunctionReturnType<
  typeof bnkrHolderLegAbi,
  "view",
  N
>;

/** One constructor route of a leg: a quote's hops to BNKR and the pile a pool needs to join its line. */
export type HolderLegRoute = LegView<"routes">[number] & {
  /** The quote's piles convert to BNKR now (a cleared route converts nothing). */
  converts: boolean;
  /** Built with a floor and no route: the quote's piles reach holders in quote at once. */
  paidInQuote: boolean;
};

/** One holder leg generation, read by its views. */
export interface HolderLegInfo {
  leg: Address;
  /** The ledger's id for the leg, from 1; 0: not a leg of this suite. */
  legId: number;
  /** The factory names this leg for launches from now on. */
  current: boolean;
  payoutMode: "bnkr" | "quote";
  /** The BNKR this generation buys; null on a chain where it pays in quote. */
  bnkr: Address | null;
  /** Fixed at construction but `maxImpactBps`, which only falls. */
  terms: LegView<"legTerms">;
  routes: HolderLegRoute[];
  /** The leg's price references. */
  references: Address;
}

export interface HolderLegs {
  /** The leg launches take from now on. */
  current(): Promise<HolderLegInfo>;
  /** One generation: its terms, its routes and whether each still converts. `INVALID_PARAMS` for an address the
   *  ledger never registered as a leg. */
  get(leg: Address): Promise<HolderLegInfo>;
  /** The leg a coin keeps for life; `NOT_A_LAUNCH` for a stranger. */
  ofCoin(token: Address): Promise<CoinHolderLeg>;
  /** `tokens` grouped by their own leg, in the order given: what a claim or a keeper walks leg by leg. */
  byLeg(
    tokens: readonly Address[],
  ): Promise<{ leg: Address; legId: number; coins: CoinHolderLeg[] }[]>;
  /** A coin's holders' pile at its own leg, at the chain's clock (or `now`, unix seconds). */
  pile(token: Address, now?: number): Promise<HolderPile>;
  /** `poke(poolId)` on the coin's own leg, from `from`: anyone may send it. It stages, forwards or converts. */
  buildPoke(token: Address, from: Address): Promise<UnsignedTx>;
  /** `convert(quote)` on `leg`, from `from`: the first pools of the quote's line, inside the shared window. */
  buildConvert(
    leg: Address,
    quote: Address,
    from: Address,
  ): Promise<UnsignedTx>;
}

const legAt = (wake: bigint): Address =>
  getAddress(
    `0x${(wake & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`,
  );

/** Holder legs per generation and per coin, for one chain's suite. */
export function createHolderLegs(ctx: SettingsContext): HolderLegs {
  const kit: SettingsKit = settingsKit(ctx);
  const { client, factory, addresses: a, chain } = kit;
  const ledger = { address: a.ledger, abi: bankrFeeLedgerAbi } as const;
  const at = (leg: Address) =>
    ({ address: leg, abi: bnkrHolderLegAbi }) as const;

  const legIdOf = (leg: Address) =>
    readContract(client, { ...ledger, functionName: "legIdOf", args: [leg] });

  /** A leg the ledger registered. Asked first: an address that is no leg has none of a leg's views to read. */
  async function registered(value: unknown): Promise<HolderLegInfo> {
    const leg = kit.address(value, "The leg");
    const legId = await legIdOf(leg);
    if (legId === 0)
      kit.invalid("This address is not a holder leg of this suite's ledger.");
    return info(leg, legId);
  }

  async function info(leg: Address, id?: number): Promise<HolderLegInfo> {
    const l = at(leg);
    const [legId, current, mode, bnkr, terms, routes, references] =
      await Promise.all([
        id ?? legIdOf(leg),
        readContract(client, { ...factory, functionName: "holderLeg" }),
        readContract(client, { ...l, functionName: "payoutMode" }),
        readContract(client, { ...l, functionName: "bnkr" }),
        readContract(client, { ...l, functionName: "legTerms" }),
        readContract(client, { ...l, functionName: "routes" }),
        readContract(client, { ...l, functionName: "references" }),
      ]);
    const live = await Promise.all(
      routes.map((route) =>
        Promise.all([
          readContract(client, {
            ...l,
            functionName: "converts",
            args: [route.quote],
          }),
          readContract(client, {
            ...l,
            functionName: "paidInQuote",
            args: [route.quote],
          }),
        ]),
      ),
    );
    return {
      leg,
      legId,
      current: isAddressEqual(current, leg),
      payoutMode: mode === PAYOUT_BNKR ? "bnkr" : "quote",
      bnkr: isAddressEqual(bnkr, zeroAddress) ? null : bnkr,
      terms,
      routes: routes.map((route, i) => ({
        ...route,
        converts: live[i]![0],
        paidInQuote: live[i]![1],
      })),
      references,
    };
  }

  async function ofCoin(value: unknown): Promise<CoinHolderLeg> {
    const token = kit.address(value, "The token");
    const [hash, [poolId, key]] = await Promise.all([
      readContract(client, {
        ...factory,
        functionName: "termsHashOf",
        args: [token],
      }),
      readContract(client, {
        ...factory,
        functionName: "poolOf",
        args: [token],
      }),
    ]);
    if (hash === zeroHash)
      throw new LaunchRefusedError("NOT_A_LAUNCH", { chain });
    // The holders' bucket has one beneficiary, locked for life: the leg of the coin's launch.
    const [terms, payees] = await Promise.all([
      readContract(client, {
        ...ledger,
        functionName: "poolTerms",
        args: [poolId],
      }),
      readContract(client, {
        ...ledger,
        functionName: "beneficiariesOf",
        args: [bucketIds.holders(poolId)],
      }),
    ]);
    const leg = payees[0];
    if (!leg) throw new LaunchRefusedError("NOT_A_LAUNCH", { chain });
    return {
      token,
      poolId,
      quote: isAddressEqual(key.currency0, token)
        ? key.currency1
        : key.currency0,
      leg,
      legId: terms.legId,
    };
  }

  async function pileReads(c: CoinHolderLeg): Promise<HolderPileReads> {
    const l = at(c.leg);
    const [
      wake,
      paused,
      claimable,
      payoutMode,
      bnkr,
      legFloor,
      paidInQuote,
      terms,
      [windowUntil, windowLeft],
      pending,
      pendingSince,
      route,
    ] = await Promise.all([
      readContract(client, {
        ...ledger,
        functionName: "holdersWake",
        args: [c.legId, c.quote],
      }),
      readContract(client, { ...factory, functionName: "paused" }),
      readContract(client, {
        ...ledger,
        functionName: "claimable",
        args: [bucketIds.holders(c.poolId), c.leg],
      }),
      readContract(client, { ...l, functionName: "payoutMode" }),
      readContract(client, { ...l, functionName: "bnkr" }),
      readContract(client, { ...l, functionName: "minPile", args: [c.quote] }),
      readContract(client, {
        ...l,
        functionName: "paidInQuote",
        args: [c.quote],
      }),
      readContract(client, { ...l, functionName: "legTerms" }),
      readContract(client, {
        ...ledger,
        functionName: "windowOf",
        args: [c.quote],
      }),
      readContract(client, { ...l, functionName: "pending", args: [c.poolId] }),
      readContract(client, {
        ...l,
        functionName: "pendingSince",
        args: [c.poolId],
      }),
      readContract(client, { ...l, functionName: "routeOf", args: [c.quote] }),
    ]);
    return {
      wake,
      paused,
      pile: claimable[0] + claimable[1],
      quote: c.quote,
      payoutMode,
      bnkr,
      legFloor,
      paidInQuote,
      routed: route.length > 0,
      windowUntil,
      windowLeft,
      pending,
      pendingSince,
      staleAfter: BigInt(terms.staleAfter),
    };
  }

  return {
    current: async () =>
      info(
        await readContract(client, { ...factory, functionName: "holderLeg" }),
      ),

    get: registered,

    ofCoin,

    async byLeg(tokens) {
      if (!Array.isArray(tokens)) kit.invalid("tokens is a list of addresses.");
      const coins = await Promise.all(tokens.map((t: unknown) => ofCoin(t)));
      const groups: { leg: Address; legId: number; coins: CoinHolderLeg[] }[] =
        [];
      for (const coin of coins) {
        const group = groups.find((g) => isAddressEqual(g.leg, coin.leg));
        if (group) group.coins.push(coin);
        else groups.push({ leg: coin.leg, legId: coin.legId, coins: [coin] });
      }
      return groups;
    },

    async pile(token, now) {
      const coin = await ofCoin(token);
      const [reads, at_] = await Promise.all([
        pileReads(coin),
        now === undefined
          ? getBlock(client, { blockTag: "latest" }).then((b) => b.timestamp)
          : kit.uint(now, 2n ** 64n - 1n, "now"),
      ]);
      // An armed word names the leg it wakes: it is the coin's own, by the ledger's key.
      if (reads.wake !== 0n && !isAddressEqual(legAt(reads.wake), coin.leg))
        throw new LaunchRefusedError("NOT_A_LAUNCH", { chain });
      return {
        ...coin,
        ...holderPileDue(reads, at_),
        pile: reads.pile,
        staged: reads.pending,
        paused: reads.paused,
      };
    },

    async buildPoke(token, from) {
      const sender = kit.address(from, "The sender");
      const coin = await ofCoin(token);
      return kit.call(
        sender,
        coin.leg,
        encodeFunctionData({
          abi: bnkrHolderLegAbi,
          functionName: "poke",
          args: [coin.poolId],
        }),
      );
    },

    async buildConvert(leg, quote, from) {
      const sender = kit.address(from, "The sender");
      const q = kit.address(quote, "The quote");
      const state = await registered(leg);
      if (!state.routes.some((r) => isAddressEqual(r.quote, q) && r.converts))
        kit.invalid(
          "This leg does not convert this quote: its piles forward in quote.",
        );
      return kit.call(
        sender,
        state.leg,
        encodeFunctionData({
          abi: bnkrHolderLegAbi,
          functionName: "convert",
          args: [q],
        }),
      );
    },
  };
}
