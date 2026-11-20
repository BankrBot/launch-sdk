import { getAddress, type Address } from "viem";
import type { LaunchEconomics } from "./economics.js";

// What every launchpad shares, vendored from core's bankr-v4 launchpad.ts: Bankr's own pad's id and suffix, the
// treasury's payee marker, and the steady-state split of a swap fee.

/** Bankr's own pad: always signed by Bankr, vanity `…ba3`. */
export const BANKR_LAUNCHPAD_ID = 0n;
export const BANKR_PAD_VANITY = Object.freeze({ suffix: 0xba3, nibbles: 3 });
/** The treasury as a pad payee: a marker the ledger cuts into Bankr's own bucket, never an account. */
export const PAD_TREASURY_MARKER: Address =
  "0x32bf48defd4071cfd8c51aa815999b0e433e3b01";

/** Who takes what of the volume once the fee has decayed, in pips (fractions kept). */
export interface VolumeSplit {
  feePips: number;
  /** Bankr's own half of its slice plus the treasury's payee share on its pad. */
  bankrPips: number;
  /** The coin's holders' half of Bankr's slice, paid in BNKR (or the quote where BNKR is not listed). */
  holdersBnkrPips: number;
  referrerPips: number;
  /** Every other pad payee, in EIP-55 like the client's other addresses. */
  payees: { address: Address; pips: number }[];
  /** The creator side: the creator's holder share, auto-LP, buyback and the creator itself. */
  creatorHoldersPips: number;
  autoLpPips: number;
  buybackPips: number;
  creatorPips: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The steady-state legs of one launch on a pad (core's `bankrV4VolumeSplit`). */
export function volumeSplit(i: {
  steadyPips: number;
  /** The launchpad's payees and their WAD shares of what is left after Bankr's slice and any referrer. */
  terms: {
    readonly payees: readonly Address[];
    readonly steadySharesWad: readonly bigint[];
  };
  economics: Pick<
    LaunchEconomics,
    "referrerBps" | "holdersBps" | "autoLpBps" | "buybackBps"
  >;
  waived?: boolean;
  /** The coin's own Bankr terms (`CoinTerms`): Bankr's rate and floor, and the holders' share of its slice. */
  bankrTerms: {
    bankrFeeBps: number;
    bankrMinPips: number;
    holdersShareBps: number;
  };
}): VolumeSplit {
  const f = i.steadyPips;
  const t = i.bankrTerms;
  const b = Math.max((f * t.bankrFeeBps) / 10_000, t.bankrMinPips);
  const holders = (b * t.holdersShareBps) / 10_000;
  let bankr = i.waived ? 0 : b - holders;
  const referrer = (f * i.economics.referrerBps) / 10_000;
  const m = f - holders - bankr - referrer;
  let opTotal = 0;
  const payees: { address: Address; pips: number }[] = [];
  i.terms.payees.forEach((address, n) => {
    const share = Number(i.terms.steadySharesWad[n] ?? 0n) / 1e18;
    opTotal += share;
    if (address.toLowerCase() === PAD_TREASURY_MARKER) {
      bankr += m * share;
    } else {
      // Core lowercases (its rows key on it); the SDK hands addresses out checksummed.
      payees.push({ address: getAddress(address), pips: round2(m * share) });
    }
  });
  const c = m * (1 - opTotal);
  const creatorHolders = (c * i.economics.holdersBps) / 10_000;
  const autoLp = (c * i.economics.autoLpBps) / 10_000;
  const buyback = (c * i.economics.buybackBps) / 10_000;
  return {
    feePips: f,
    bankrPips: round2(bankr),
    holdersBnkrPips: round2(holders),
    referrerPips: round2(referrer),
    payees,
    creatorHoldersPips: round2(creatorHolders),
    autoLpPips: round2(autoLp),
    buybackPips: round2(buyback),
    creatorPips: round2(c - creatorHolders - autoLp - buyback),
  };
}
