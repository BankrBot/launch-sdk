import type { Address, Hex } from "viem";
import { LaunchRefusedError } from "./errors.js";

/** What a planned claim-all transaction may need at worst: EIP-7825's 2^24 less about 10 %. */
export const CLAIM_ALL_MAX_GAS_PER_TX = 15_000_000n;

/**
 * The worst-case gas of the ledger's claim-all path, per piece, calldata included. Bankr's API and keeper plan with
 * the same model, so a planned transaction cannot run out of gas whatever a token does.
 */
export interface ClaimAllGasModel {
  /** Per transaction: intrinsic gas and the ledger's per-account checks (the claim policy, the puller exclusion). */
  base: bigint;
  /** Per bucket credited on one side whose checkpoint for the account is still 0 (written 0 → non-zero). */
  bucketFirst: bigint;
  /** Per bucket credited on one side, checkpoint already non-zero. */
  bucketSteady: bigint;
  /** Per bucket ever credited on both sides: both checkpoints and both balances written, first touch included. */
  bucketBoth: bigint;
  /** Per (account, currency) balance written 0 → non-zero. */
  newBalance: bigint;
  /** Per currency a transaction first writes whose balance is already non-zero: one cold read and write. */
  openBalance: bigint;
  /** Per currency paid: a payout gets exactly PAYOUT_GAS (1,000,000), all of which a hostile token may burn. */
  quote: bigint;
}

/** Measured in the contracts' test/claimall (cold state, a factory as costly as the real one), rounded up. */
export const CLAIM_ALL_GAS: Readonly<ClaimAllGasModel> = Object.freeze({
  base: 85_000n,
  bucketFirst: 37_000n,
  bucketSteady: 20_000n,
  bucketBoth: 62_000n,
  newBalance: 22_000n,
  openBalance: 5_000n,
  quote: 1_060_000n,
});

/** A push's extra check per transaction: the ledger's `_mayPush` runs factory `isSuite`, which calls the account's
 *  `poolId()`, capped at its SUITE_CHECK_GAS; an account's own claim skips it. Outside the model core shares. */
export const CLAIM_PUSH_CHECK_GAS = 100_000n;

/** An amount of one currency: a launch's quote, or a launched token when a bucket pays that side. */
export interface QuoteAmount {
  quote: Address;
  amount: bigint;
}

/** One bucket share the account holds (`fees.getOwed` lists them). */
export interface ClaimAllBucket {
  bucketId: Hex;
  quote: Address;
  /** The launched token: what the bucket's other side pays in. */
  token: Address;
  claimableQuote: bigint;
  claimableToken: bigint;
  /** The account's checkpoint on a credited side is still 0. */
  firstTouch: boolean;
  /** The bucket was ever credited on both sides. */
  bothSides: boolean;
}

export interface ClaimAllInput {
  buckets: readonly ClaimAllBucket[];
  /** The account's pull balances now (referral slices, earlier settles). */
  balances?: readonly QuoteAmount[];
  /** Per currency: a bucket owing less on every side is left for later, and a currency totalling less is not paid. */
  dust?: (quote: Address) => bigint;
  /** Default {@link CLAIM_ALL_MAX_GAS_PER_TX}. */
  maxGasPerTx?: bigint;
  /** Settle chunks only, no withdraw: the shares move into the account's balance for a later withdraw. */
  settleOnly?: boolean;
  /** A third party's push: `withdrawFor` takes no bucket ids, so the last settle chunk stays a transaction of its own. */
  push?: boolean;
  /**
   * Currencies Bankr does not list: a quote the chain does not list that is not a launched token either (any-quote
   * pairing). None is withdrawn and a bucket owing only them waits (round 9 F4: anyone can make an account owe in a
   * gas-burning one); `includeUnlisted` pays them last, in withdraws of their own (ISO-4).
   */
  unlisted?: (currency: Address) => boolean;
  includeUnlisted?: boolean;
}

/** One transaction: `settle(bucketIds, [account])`, or `withdraw(bucketIds, quotes)` from the account (on a push,
 *  `withdrawFor(account, quotes)`, never carrying bucket ids). */
export interface ClaimAllStep {
  kind: "settle" | "withdraw";
  bucketIds: Hex[];
  /** The currencies a withdraw pays, largest first; empty for a settle. */
  quotes: Address[];
  /** A trailing withdraw of unlisted currencies only (`includeUnlisted`), never carrying a settle. */
  unlisted?: true;
  /** The model's worst case: the transaction's gas limit. */
  gas: bigint;
}

export interface ClaimAllPlan {
  /** In order: every settle chunk, then the withdraw carrying the last buckets, then any withdraw of more currencies. */
  steps: ClaimAllStep[];
  /** What the withdraws pay per currency unless a currency is withheld: its balance plus the planned claimable. */
  totals: QuoteAmount[];
  /** Buckets planned. */
  buckets: number;
  /** Buckets left out: nothing, or only dust, owed. */
  belowDust: number;
  /** What the account owes in unlisted currencies that the plan leaves (no `includeUnlisted`), largest first. */
  unlisted: QuoteAmount[];
  gas: bigint;
}

const lower = (a: string) => a.toLowerCase();
const byAmount = (a: QuoteAmount, b: QuoteAmount) =>
  a.amount === b.amount
    ? lower(a.quote) < lower(b.quote)
      ? -1
      : 1
    : a.amount > b.amount
      ? -1
      : 1;

/**
 * The fewest claim-all transactions for one account, each within `maxGasPerTx` at the model's worst case: settle
 * chunks first (accounting only, nothing a token can fail), then one withdraw paying every currency, which also
 * settles the last chunk when it fits (never on a push, whose `withdrawFor` takes no bucket ids). More than 14 currencies at 15M take further withdraws. Pure.
 */
export function planClaimAll(
  input: ClaimAllInput,
  model: ClaimAllGasModel = CLAIM_ALL_GAS,
): ClaimAllPlan {
  const budget = input.maxGasPerTx ?? CLAIM_ALL_MAX_GAS_PER_TX;
  const base = model.base + (input.push ? CLAIM_PUSH_CHECK_GAS : 0n);
  const worstBucket =
    [model.bucketFirst, model.bucketSteady, model.bucketBoth].reduce((a, b) =>
      a > b ? a : b,
    ) +
    2n * model.newBalance;
  if (base + model.quote + worstBucket > budget) {
    throw new LaunchRefusedError("INVALID_PARAMS", {
      detail: "maxGasPerTx cannot hold one payout and one bucket.",
    });
  }
  const dust = (q: Address) => input.dust?.(q) ?? 0n;
  const owes = (amount: bigint, q: Address) => amount > 0n && amount >= dust(q);
  const isUnlisted = (q: Address) => input.unlisted?.(q) ?? false;
  const skips = (q: Address) => !input.includeUnlisted && isUnlisted(q);

  const totals = new Map<string, QuoteAmount>();
  const add = (quote: Address, amount: bigint) => {
    const t = totals.get(lower(quote)) ?? { quote, amount: 0n };
    t.amount += amount;
    totals.set(lower(quote), t);
  };
  const left = new Map<string, QuoteAmount>();
  const leave = (quote: Address, amount: bigint) => {
    const t = left.get(lower(quote)) ?? { quote, amount: 0n };
    t.amount += amount;
    left.set(lower(quote), t);
  };
  const credit = (quote: Address, amount: bigint) =>
    skips(quote) ? leave(quote, amount) : add(quote, amount);
  const opened = new Set<string>();
  for (const b of input.balances ?? []) {
    if (b.amount <= 0n) continue;
    opened.add(lower(b.quote));
    credit(b.quote, b.amount);
  }
  const seen = new Set<string>();
  const kept: ClaimAllBucket[] = [];
  let belowDust = 0;
  for (const b of input.buckets) {
    if (seen.has(lower(b.bucketId))) continue; // a duplicate owes nothing the second time, but costs gas
    seen.add(lower(b.bucketId));
    const quoteDue = owes(b.claimableQuote, b.quote);
    const tokenDue = owes(b.claimableToken, b.token);
    if (!(quoteDue && !skips(b.quote)) && !(tokenDue && !skips(b.token))) {
      // Owing only an unlisted currency, it waits for an opt-in; owing nothing more than dust, it waits too.
      if (quoteDue || tokenDue) {
        if (quoteDue) leave(b.quote, b.claimableQuote);
        if (tokenDue) leave(b.token, b.claimableToken);
      } else belowDust++;
      continue;
    }
    kept.push(b);
    if (b.claimableQuote > 0n) credit(b.quote, b.claimableQuote);
    if (b.claimableToken > 0n) credit(b.token, b.claimableToken);
  }
  const ranked = [...totals.values()].sort(byAmount);
  const rank = new Map(ranked.map((t, i) => [lower(t.quote), i]));
  const rankOf = (b: ClaimAllBucket) =>
    rank.get(lower(b.quote)) ?? rank.get(lower(b.token)) ?? ranked.length;
  kept.sort((a, b) => rankOf(a) - rankOf(b));
  const paid = ranked.filter((t) => owes(t.amount, t.quote));

  // Each balance a transaction touches costs one cold write there: 0 → non-zero the first time any transaction
  // pays it, a non-zero rewrite in every later one (audit CA-OFF-5).
  const cost = (b: ClaimAllBucket, touched: ReadonlySet<string>) => {
    let gas = b.bothSides
      ? model.bucketBoth
      : b.firstTouch
        ? model.bucketFirst
        : model.bucketSteady;
    for (const [q, amount] of [
      [b.quote, b.claimableQuote],
      [b.token, b.claimableToken],
    ] as const) {
      if (amount === 0n || touched.has(lower(q))) continue;
      gas += opened.has(lower(q)) ? model.openBalance : model.newBalance;
    }
    return gas;
  };
  const steps: ClaimAllStep[] = [];
  let chunk: ClaimAllStep | null = null;
  let touched = new Set<string>();
  for (const b of kept) {
    let gas = chunk === null ? 0n : cost(b, touched);
    if (chunk === null || chunk.gas + gas > budget) {
      chunk = { kind: "settle", bucketIds: [], quotes: [], gas: base };
      steps.push(chunk);
      touched = new Set();
      gas = cost(b, touched);
    }
    for (const [q, amount] of [
      [b.quote, b.claimableQuote],
      [b.token, b.claimableToken],
    ] as const) {
      if (amount === 0n) continue;
      touched.add(lower(q));
      opened.add(lower(q));
    }
    chunk.bucketIds.push(b.bucketId);
    chunk.gas += gas;
  }

  if (!input.settleOnly && paid.length > 0) {
    const per = Number((budget - base) / model.quote);
    const listed = paid.filter((t) => !isUnlisted(t.quote));
    const trailing = paid.filter((t) => isUnlisted(t.quote));
    const first = listed.length % per || per;
    const groups = listed.length === 0 ? [] : [listed.slice(0, first)];
    for (let i = first; i < listed.length; i += per)
      groups.push(listed.slice(i, i + per));
    const withdraw = (g: QuoteAmount[]): ClaimAllStep => ({
      kind: "withdraw",
      bucketIds: [],
      quotes: g.map((t) => t.quote),
      gas: base + BigInt(g.length) * model.quote,
    });
    // Unlisted currencies last, in withdraws of their own (round 9 ISO-4): one that burns its payout's gas never
    // shares a transaction with a listed currency or a settle.
    const withdraws = groups.map(withdraw);
    for (let i = 0; i < trailing.length; i += per)
      withdraws.push({
        ...withdraw(trailing.slice(i, i + per)),
        unlisted: true,
      });
    // The last chunk rides in the first withdraw when both fit: its buckets settle before any payout.
    const last = steps.at(-1);
    const w = withdraws[0]!;
    if (
      last &&
      !input.push &&
      !w.unlisted &&
      w.gas + last.gas - model.base <= budget
    ) {
      steps.pop();
      w.bucketIds = last.bucketIds;
      w.gas += last.gas - model.base;
    }
    steps.push(...withdraws);
  }
  return {
    steps,
    totals: paid,
    buckets: kept.length,
    belowDust,
    unlisted: [...left.values()].sort(byAmount),
    gas: steps.reduce((a, s) => a + s.gas, 0n),
  };
}
