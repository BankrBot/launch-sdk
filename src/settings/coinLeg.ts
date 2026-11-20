import { getAddress, type Address, type Hex } from "viem";
import { readContract } from "viem/actions";
import { bankrFeeLedgerAbi, bnkrHolderLegAbi } from "../abis/settings.js";
import { bucketIds } from "../lens.js";
import type { ReadClient } from "../providers/types.js";
import type { HolderPileReads } from "./holderPile.js";

// A coin keeps the holder leg of its launch for life, so its pile is read at that leg, never at the one the
// factory names for launches from now on. The one place the leg and its pile are read from the chain.

/** The leg an armed wake word names: its low 160 bits. */
export const legOfWake = (wake: bigint): Address =>
  getAddress(
    `0x${(wake & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`,
  );

/** The leg of a pool's coin: its holders' bucket has that one beneficiary, locked for life. Undefined for a pool
 *  the ledger holds no holders' bucket of. Both suites' ledgers answer it alike. */
export async function readCoinLeg(
  client: ReadClient,
  ledger: Address,
  poolId: Hex,
): Promise<Address | undefined> {
  const [leg] = await readContract(client, {
    address: ledger,
    abi: bankrFeeLedgerAbi,
    functionName: "beneficiariesOf",
    args: [bucketIds.holders(poolId)],
  });
  return leg;
}

/** One read per key, for the reads coins share: a leg, a quote, the ledger's window. */
export type Once = <T>(key: string, read: () => Promise<T>) => Promise<T>;

export function once(): Once {
  const seen = new Map<string, Promise<unknown>>();
  return <T>(key: string, read: () => Promise<T>) => {
    const hit = seen.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const made = read();
    seen.set(key, made);
    return made;
  };
}

/** What a suite 4 leg's rule reads for one pool, the ledger's wake word and the factory's pause aside. */
export async function readLegPile(
  client: ReadClient,
  ledger: Address,
  p: { poolId: Hex; quote: Address; leg: Address },
  shared: Once = once(),
): Promise<Omit<HolderPileReads, "wake" | "paused">> {
  const book = { address: ledger, abi: bankrFeeLedgerAbi } as const;
  const l = { address: p.leg, abi: bnkrHolderLegAbi } as const;
  const leg = p.leg.toLowerCase();
  const at = `${leg}:${p.quote.toLowerCase()}`;
  const [
    claimable,
    pending,
    pendingSince,
    legFloor,
    paidInQuote,
    route,
    [windowUntil, windowLeft],
    payoutMode,
    bnkr,
    terms,
  ] = await Promise.all([
    readContract(client, {
      ...book,
      functionName: "claimable",
      args: [bucketIds.holders(p.poolId), p.leg],
    }),
    readContract(client, { ...l, functionName: "pending", args: [p.poolId] }),
    readContract(client, {
      ...l,
      functionName: "pendingSince",
      args: [p.poolId],
    }),
    shared(`floor:${at}`, () =>
      readContract(client, { ...l, functionName: "minPile", args: [p.quote] }),
    ),
    shared(`paid:${at}`, () =>
      readContract(client, {
        ...l,
        functionName: "paidInQuote",
        args: [p.quote],
      }),
    ),
    shared(`route:${at}`, () =>
      readContract(client, { ...l, functionName: "routeOf", args: [p.quote] }),
    ),
    shared(`window:${p.quote.toLowerCase()}`, () =>
      readContract(client, {
        ...book,
        functionName: "windowOf",
        args: [p.quote],
      }),
    ),
    shared(`mode:${leg}`, () =>
      readContract(client, { ...l, functionName: "payoutMode" }),
    ),
    shared(`bnkr:${leg}`, () =>
      readContract(client, { ...l, functionName: "bnkr" }),
    ),
    shared(`terms:${leg}`, () =>
      readContract(client, { ...l, functionName: "legTerms" }),
    ),
  ]);
  return {
    pile: claimable[0] + claimable[1],
    quote: p.quote,
    payoutMode,
    bnkr,
    legFloor,
    paidInQuote,
    routed: route.length > 0,
    windowUntil: BigInt(windowUntil),
    windowLeft,
    pending,
    pendingSince: BigInt(pendingSince),
    staleAfter: BigInt(terms.staleAfter),
  };
}
