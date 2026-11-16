import type { Address, Hex } from "viem";
import { getBlock, readContract } from "viem/actions";
import { bankrFeeLedgerAbi, bankrLaunchFactoryAbi } from "./abis/suite3.js";
import {
  HOLDER_LEG_WAKE_ABI,
  UNLISTED_FLOOR,
  holderPileFloor,
  holdersWakeDue,
  routeEndsAt,
} from "./conversion.js";
import { bucketIds, type SuiteReadContext } from "./lens.js";

// Always-on: only a swap that asks (hook-data flag 8) wakes a pool's holders' pile, and `claimFor` never does, so a
// holder claim-all pokes the leg for every pile that is due. Bankr's API decides with this same rule.

/** What a poke of one pool's pile would do now: nothing worth its gas, pay the pile on in quote, or (at most)
 *  convert its quote's batch to BNKR. */
export type HolderPoke = "none" | "forward" | "convert";

export interface HolderPile {
  /** The factory lists the pool's quote. */
  listed: boolean;
  poke: HolderPoke;
}

/** Per pool, in order: what the leg's `poke(poolId)` would do at the chain's own clock. A pile is what the poke
 *  would stage (the ledger's and the one already staged); a quote with no floor forwards any of it. */
export async function readHolderPiles(
  ctx: SuiteReadContext,
  pools: readonly { poolId: Hex; quote: Address }[],
): Promise<HolderPile[]> {
  const { client, addresses: a } = ctx;
  const leg = { address: a.holderLeg, abi: HOLDER_LEG_WAKE_ABI } as const;
  const quotes = [
    ...new Map(pools.map((p) => [p.quote.toLowerCase(), p.quote])).values(),
  ];
  const [entries, piles] = await Promise.all([
    Promise.all(
      quotes.map(async (q) => {
        const [entry, wake] = await Promise.all([
          readContract(client, {
            address: a.factory,
            abi: bankrLaunchFactoryAbi,
            functionName: "quoteEntry",
            args: [q],
          }),
          readContract(client, {
            address: a.ledger,
            abi: bankrFeeLedgerAbi,
            functionName: "holdersWake",
            args: [q],
          }),
        ]);
        // Unarmed: the poke's own first stage arms the quote at the floor its sync sets.
        const floor = holderPileFloor(wake, entry.minCompoundQuote);
        return { quote: q, listed: entry.allowed, floor };
      }),
    ),
    Promise.all(
      pools.map(async (p) => {
        const [[side0, side1], staged, stagedSince] = await Promise.all([
          readContract(client, {
            address: a.ledger,
            abi: bankrFeeLedgerAbi,
            functionName: "claimable",
            args: [bucketIds.holders(p.poolId), a.holderLeg],
          }),
          readContract(client, {
            ...leg,
            functionName: "pending",
            args: [p.poolId],
          }),
          readContract(client, {
            ...leg,
            functionName: "pendingSince",
            args: [p.poolId],
          }),
        ]);
        // A poke stages the ledger's pile onto the staged one before the leg's floor check (BnkrHolderLeg._stage).
        return { pile: side0 + side1 + staged, staged, stagedSince };
      }),
    ),
  ]);
  const entryOf = new Map(entries.map((e) => [e.quote.toLowerCase(), e]));
  const rows = pools.map((p, i) => ({
    ...entryOf.get(p.quote.toLowerCase())!,
    ...piles[i]!,
  }));
  const reached = (r: (typeof rows)[number]) =>
    r.floor !== UNLISTED_FLOOR && r.pile >= r.floor;
  // The leg's conversion state, read only for a quote with a pile at its floor: under it nothing is due.
  const due = quotes.filter((q) =>
    rows.some((r) => r.quote === q && reached(r)),
  );
  const [legState, quoteStates] =
    due.length === 0
      ? [null, []]
      : await Promise.all([
          Promise.all([
            readContract(client, { ...leg, functionName: "payoutMode" }),
            readContract(client, { ...leg, functionName: "bnkr" }),
            readContract(client, {
              ...leg,
              functionName: "MIN_CONVERT_INTERVAL",
            }),
            readContract(client, { ...leg, functionName: "STALE_AFTER" }),
            readContract(client, { ...leg, functionName: "bnkrExecuteAfter" }),
            getBlock(client, { blockTag: "latest" }),
          ]),
          Promise.all(
            due.map((q) =>
              Promise.all([
                readContract(client, {
                  ...leg,
                  functionName: "retiredBnkr",
                  args: [q],
                }),
                readContract(client, {
                  ...leg,
                  functionName: "lastConvertAt",
                  args: [q],
                }),
                readContract(client, {
                  ...leg,
                  functionName: "routeExecuteAfter",
                  args: [q],
                }),
                readContract(client, {
                  ...leg,
                  functionName: "pendingRouteOf",
                  args: [q],
                }),
                readContract(client, {
                  ...leg,
                  functionName: "routeOf",
                  args: [q],
                }),
              ]),
            ),
          ),
        ]);
  return rows.map((r): HolderPile => {
    const { listed } = r;
    if (r.floor === UNLISTED_FLOOR)
      return { listed, poke: r.pile > 0n ? "forward" : "none" };
    if (legState === null || !reached(r)) return { listed, poke: "none" };
    const [payoutMode, bnkr, minConvertInterval, staleAfter, bnkrAt, block] =
      legState;
    const [retired, lastConvertAt, routeAt, queued, live] =
      quoteStates[due.indexOf(r.quote)]!;
    const w = holdersWakeDue(
      {
        ...r,
        payoutMode,
        bnkr,
        retired,
        lastConvertAt,
        minConvertInterval,
        staleAfter,
        bnkrExecuteAfter: bnkrAt,
        routeExecuteAfter: routeAt,
        pendingRouteToBnkr: routeEndsAt(queued, bnkr),
        routeToBnkr: routeEndsAt(live, bnkr),
      },
      Number(block.timestamp),
    );
    return {
      listed,
      poke: !w.due ? "none" : w.forwardsNow ? "forward" : "convert",
    };
  });
}
