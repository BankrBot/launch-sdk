import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";

// What a holder leg does with one coin's pile, as a pure rule over what the chain answers.

/** The leg's floor for a quote it was built without: such a pile never converts. */
export const UNFLOORED = (1n << 96n) - 1n;
/** `IBnkrHolderLeg.PayoutMode.BNKR`. */
export const PAYOUT_BNKR = 0;

/** The leg a coin keeps for life. */
export interface CoinHolderLeg {
  token: Address;
  poolId: Hex;
  quote: Address;
  leg: Address;
  legId: number;
}

/** What the wake rule reads for one pool at its own leg. */
export interface HolderPileReads {
  /** `ledger.holdersWake(legId, quote)`: the leg low, the pile the wake fires at above it; 0: unarmed. */
  wake: bigint;
  paused: boolean;
  /** The pool's holders' pile waiting in the ledger. */
  pile: bigint;
  quote: Address;
  payoutMode: number;
  bnkr: Address;
  /** `leg.minPile(quote)`. */
  legFloor: bigint;
  paidInQuote: boolean;
  /** `leg.routeOf(quote)` is not empty. */
  routed: boolean;
  /** `ledger.windowOf(quote)`: every leg's conversion window. */
  windowUntil: bigint;
  windowLeft: bigint;
  /** The pile already staged in the leg, and since when (unix seconds; 0 with none). */
  pending: bigint;
  pendingSince: bigint;
  staleAfter: bigint;
}

/** What a swap's wake, or a poke, would do with a coin's holders' pile now. */
export interface HolderPileDue {
  armed: boolean;
  /** The pile the wake fires at. */
  floor: bigint;
  /** The quote's piles convert to BNKR; otherwise they forward in quote, with no interval. */
  converts: boolean;
  /** Unix seconds from which the quote's next conversion may run (0: now). */
  nextConvertAt: bigint;
  /** A swap through the pool reaches the wake: armed, unpaused, and the pile at the floor. */
  wakes: boolean;
  /** The leg's forward rule holds now: a pile that does not convert, or one staged past the leg's stale period. */
  forwardsNow: boolean;
  /** The wake would forward or convert the pile, or (route cleared) stage it to start its stale clock. */
  due: boolean;
}

/** A coin's holders' pile at its own leg. */
export interface HolderPile extends CoinHolderLeg, HolderPileDue {
  pile: bigint;
  staged: bigint;
  /** A factory pause skips the wake; conversions by `poke` go on. */
  paused: boolean;
}

/**
 * BnkrHolderLeg's wake at `now` (unix seconds), as a swap would run it: stage, then forward where the forward rule
 * opens, else convert while the shared window has a floor pile left. Core's `bankrV4Suite4HoldersWakeDue`;
 * `__internal__/settingsParity.test.ts` holds the two equal.
 */
export function holderPileDue(
  r: HolderPileReads,
  now: bigint,
  holdersIn = 0n,
): HolderPileDue {
  const armed = r.wake !== 0n;
  const floor = r.wake >> 160n;
  const converts =
    r.payoutMode === PAYOUT_BNKR &&
    !isAddressEqual(r.bnkr, zeroAddress) &&
    !isAddressEqual(r.quote, r.bnkr) &&
    r.legFloor !== 0n &&
    r.legFloor !== UNFLOORED &&
    !r.paidInQuote;
  // The leg's TooSoon: an open window with under a floor pile left of its cap.
  const waits = now < r.windowUntil && r.windowLeft < r.legFloor;
  const wakes = armed && !r.paused && r.pile + holdersIn >= floor;
  const forwardsNow =
    !converts ||
    r.staleAfter === 0n ||
    (r.pending !== 0n && now >= r.pendingSince + r.staleAfter);
  // With its route cleared a conversion reverts; the one stage that starts the stale clock is then the work due.
  const due = wakes && (forwardsNow || (r.routed ? !waits : r.pending === 0n));
  return {
    armed,
    floor,
    converts,
    nextConvertAt: waits ? r.windowUntil : 0n,
    wakes,
    forwardsNow,
    due,
  };
}
