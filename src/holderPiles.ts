import type { Address } from "viem";

// Always-on: only a swap that asks (hook-data flag 8) wakes a pool's holders' pile, and `claimFor` never does, so a
// holder claim-all pokes the leg for every pile that is due. Bankr's API decides with this same rule.

/** What a poke of one pool's pile would do now: nothing worth its gas, pay the pile on in quote, or (at most)
 *  convert its quote's batch to BNKR. */
export type HolderPoke = "none" | "forward" | "convert";

export interface HolderPile {
  /** The leg the pile is poked at: the leg of the coin's own launch. */
  leg: Address;
  /** The chain lists the pool's quote. */
  listed: boolean;
  poke: HolderPoke;
}
