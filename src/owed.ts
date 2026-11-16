import {
  getAddress,
  isAddress,
  isAddressEqual,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { getBlockNumber, getLogs, readContract } from "viem/actions";
import { bankrFeeLedgerAbi } from "./abis/suite3.js";
import { BANKR_V4_ADDRESSES } from "./addresses.js";
import type { AccountFeesResponse, BankrApi } from "./api.js";
import type { LaunchChain } from "./chains/index.js";
import { LaunchApiError, LaunchRefusedError } from "./errors.js";
import { bucketIds, type SuiteReadContext } from "./lens.js";
import type { ClaimAllBucket, QuoteAmount } from "./planClaimAll.js";
import { requireAddress } from "./recipient.js";

/** One fee-bucket share with something claimable: a launch's creator or decay bucket. */
export interface OwedBucket extends ClaimAllBucket {
  poolId: Hex;
  kind: "creator" | "decay";
}

/** What an account is owed on one chain's ledger: Σ claimable plus its pull balances. */
export interface OwedState {
  account: Address;
  /** Pull balances (referral slices, settled shares), non-zero only. */
  balances: QuoteAmount[];
  buckets: OwedBucket[];
  /** Balances plus claimable, per currency, largest first. */
  totalByQuote: QuoteAmount[];
  /** `api`: Bankr's account index; `chain`: a scan of the ledger's logs. */
  source: "api" | "chain";
}

export interface OwedOptions {
  /** Default `auto`: Bankr's index, then a ledger scan if it cannot answer (a fork client always scans). */
  source?: "auto" | "api" | "chain";
  /** A chain scan also reads the balance in these (the chain's named majors and the account's quotes always). */
  quotes?: readonly Address[];
  /** A chain scan's block range; default the suite's deploy block to the head. */
  fromBlock?: bigint;
  toBlock?: bigint;
}

/** A chain scan reads at most this many shares ("small accounts"); a larger one needs Bankr's index. */
export const MAX_SCAN_BUCKETS = 500;
/** And scans at most this many windows of the chain's `maxLogRange` (two `eth_getLogs` each: shares, referrals). */
export const MAX_SCAN_WINDOWS = 2_000;
const SCAN_CONCURRENCY = 4;
// Every way an account becomes a bucket's beneficiary: registration, a beneficiary move, a takeover (one
// CtoExecuted per old fee recipient, each naming the one new recipient).
const SCAN_EVENTS = bankrFeeLedgerAbi.filter(
  (x): x is Extract<(typeof bankrFeeLedgerAbi)[number], AbiEvent> =>
    x.type === "event" &&
    ["BucketRegistered", "UpdateBeneficiary", "CtoExecuted"].includes(x.name),
);
// A referral slice lands in the referrer's balance in the pool's quote; `referrer` is indexed.
const SWAP_FEE = bankrFeeLedgerAbi.find(
  (x): x is Extract<(typeof bankrFeeLedgerAbi)[number], AbiEvent> =>
    x.type === "event" && x.name === "SwapFee",
)!;

const DECIMAL = /^\d{1,78}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const lower = (a: string) => a.toLowerCase();

/** The scan would be too large for a fallback: the account needs Bankr's index, or a narrower block range. */
class ScanRefused extends Error {}

function totalsOf(balances: QuoteAmount[], buckets: OwedBucket[]) {
  const m = new Map<string, QuoteAmount>();
  const add = (quote: Address, amount: bigint) => {
    if (amount === 0n) return;
    const t = m.get(lower(quote)) ?? { quote, amount: 0n };
    t.amount += amount;
    m.set(lower(quote), t);
  };
  for (const b of balances) add(b.quote, b.amount);
  for (const b of buckets) {
    add(b.quote, b.claimableQuote);
    add(b.token, b.claimableToken);
  }
  return [...m.values()].sort((a, b) =>
    a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1,
  );
}

/** The index's reply as bigints and checksummed addresses; throws on anything malformed or not `ledger`'s. */
function fromApi(
  r: AccountFeesResponse,
  chain: LaunchChain,
  chainId: number,
  account: Address,
  ledger: Address,
): OwedState {
  const big = (v: unknown) => {
    if (typeof v !== "string" || !DECIMAL.test(v))
      throw new TypeError("amount");
    return BigInt(v);
  };
  const bool = (v: unknown) => {
    if (typeof v !== "boolean") throw new TypeError("flag");
    return v;
  };
  if (r.chainId !== chainId || !isAddressEqual(r.account, account))
    throw new TypeError("another account or chain");
  // Each suite has its own ledger and a ledger skips another's buckets, so an answer for another is refused. One
  // that names none is from an API that serves the chain's shipped suite 3 record alone: it is that ledger's.
  const answered = r.ledger ?? BANKR_V4_ADDRESSES[chain]?.ledger;
  if (!answered || !isAddress(answered) || !isAddressEqual(answered, ledger))
    throw new TypeError("another ledger");
  const balances = r.balances
    .map((b) => ({ quote: getAddress(b.quote), amount: big(b.amount) }))
    .filter((b) => b.amount > 0n);
  const id = (v: unknown) => {
    if (typeof v !== "string" || !BYTES32.test(v)) throw new TypeError("id");
    return lower(v) as Hex;
  };
  const buckets = r.buckets.map((b): OwedBucket => {
    if (b.kind !== "creator" && b.kind !== "decay") throw new TypeError("kind");
    return {
      bucketId: id(b.bucketId),
      poolId: id(b.poolId),
      token: getAddress(b.token),
      quote: getAddress(b.quote),
      kind: b.kind,
      claimableQuote: big(b.claimableQuote),
      claimableToken: big(b.claimableToken),
      firstTouch: bool(b.firstTouch),
      bothSides: bool(b.bothSides),
    };
  });
  return {
    account,
    balances,
    buckets,
    totalByQuote: totalsOf(balances, buckets),
    source: "api",
  };
}

/** Every bucket the ledger's logs ever made `account` a beneficiary of, oldest first, and every pool whose swaps
 *  named it the referrer. */
async function scanCandidates(
  ctx: SuiteReadContext,
  account: Address,
  o: OwedOptions,
): Promise<{ ids: Hex[]; referralPools: Hex[] }> {
  const { client } = ctx;
  const to = o.toBlock ?? (await getBlockNumber(client));
  const from = o.fromBlock ?? BigInt(ctx.addresses.blockNumber);
  const range = BigInt(ctx.chain.maxLogRange);
  if ((to - from) / range + 1n > BigInt(MAX_SCAN_WINDOWS)) {
    throw new ScanRefused("the ledger's history is too long to scan");
  }
  const windows: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += range)
    windows.push([s, s + range - 1n < to ? s + range - 1n : to]);
  const found = new Set<string>();
  const ids: Hex[] = [];
  const referralPools = new Map<string, Hex>();
  for (let i = 0; i < windows.length; i += SCAN_CONCURRENCY) {
    const part = windows.slice(i, i + SCAN_CONCURRENCY);
    const [batches, referrals] = await Promise.all([
      Promise.all(
        part.map(([fromBlock, toBlock]) =>
          getLogs(client, {
            address: ctx.addresses.ledger,
            events: SCAN_EVENTS,
            fromBlock,
            toBlock,
          }),
        ),
      ),
      Promise.all(
        part.map(([fromBlock, toBlock]) =>
          getLogs(client, {
            address: ctx.addresses.ledger,
            event: SWAP_FEE,
            args: { referrer: account },
            fromBlock,
            toBlock,
          }),
        ),
      ),
    ]);
    for (const log of referrals.flat()) {
      const poolId = (log.args as { poolId?: Hex }).poolId;
      if (poolId) referralPools.set(lower(poolId), poolId);
    }
    for (const log of batches.flat()) {
      const a = log.args as Record<string, unknown>;
      const id = (
        log.eventName === "UpdateBeneficiary" ? a.poolId : a.bucketId
      ) as Hex;
      const mine =
        log.eventName === "BucketRegistered"
          ? (a.beneficiaries as Address[]).some((b) =>
              isAddressEqual(b, account),
            )
          : isAddressEqual(
              (log.eventName === "CtoExecuted"
                ? a.newRecipient
                : a.newBeneficiary) as Address,
              account,
            );
      if (!mine || found.has(lower(id))) continue;
      found.add(lower(id));
      ids.push(id);
    }
  }
  if (ids.length + referralPools.size > MAX_SCAN_BUCKETS) {
    throw new ScanRefused("too many fee shares to read without Bankr's index");
  }
  return { ids, referralPools: [...referralPools.values()] };
}

/** One candidate's share, read live (null when the account no longer holds it, owes nothing or it is not a launch
 *  bucket), and the currencies a settle of it may have moved into the account's balance. */
async function readShare(
  ctx: SuiteReadContext,
  account: Address,
  id: Hex,
  quoteIs0: (poolId: Hex) => Promise<boolean>,
): Promise<{ bucket: OwedBucket | null; currencies: Address[] }> {
  const { client } = ctx;
  const l = { address: ctx.addresses.ledger, abi: bankrFeeLedgerAbi } as const;
  const mine = [id, account] as const;
  const [shares, [poolId, currency0, currency1, exists]] = await Promise.all([
    readContract(client, { ...l, functionName: "getShares", args: mine }),
    readContract(client, { ...l, functionName: "bucketOf", args: [id] }),
  ]);
  const kind =
    id === bucketIds.creator(poolId)
      ? "creator"
      : id === bucketIds.decay(poolId)
        ? "decay"
        : null;
  if (!exists || kind === null) return { bucket: null, currencies: [] };
  const [[fees0, fees1], cum0, cum1, last0, last1, q0] = await Promise.all([
    readContract(client, { ...l, functionName: "claimable", args: mine }),
    readContract(client, {
      ...l,
      functionName: "getCumulatedFees0",
      args: [id],
    }),
    readContract(client, {
      ...l,
      functionName: "getCumulatedFees1",
      args: [id],
    }),
    readContract(client, {
      ...l,
      functionName: "getLastCumulatedFees0",
      args: mine,
    }),
    readContract(client, {
      ...l,
      functionName: "getLastCumulatedFees1",
      args: mine,
    }),
    quoteIs0(poolId),
  ]);
  const quote = getAddress(q0 ? currency0 : currency1);
  const token = getAddress(q0 ? currency1 : currency0);
  // A settle (its own, or one sent on its behalf) moved what the share owed into the balance, even
  // when the share owes nothing now or has moved on: the quote always, the token once its side was credited.
  const currencies = (q0 ? cum1 : cum0) !== 0n ? [quote, token] : [quote];
  if (shares === 0n || (fees0 === 0n && fees1 === 0n))
    return { bucket: null, currencies };
  return {
    bucket: {
      bucketId: id,
      poolId,
      token,
      quote,
      kind,
      claimableQuote: q0 ? fees0 : fees1,
      claimableToken: q0 ? fees1 : fees0,
      firstTouch:
        (cum0 !== 0n && last0 === 0n) || (cum1 !== 0n && last1 === 0n),
      bothSides: cum0 !== 0n && cum1 !== 0n,
    },
    currencies,
  };
}

/** The quote a pool's referral slices are paid in: its creator bucket's quote side. */
async function referralQuote(
  ctx: SuiteReadContext,
  poolId: Hex,
  quoteIs0: (poolId: Hex) => Promise<boolean>,
): Promise<Address | null> {
  const [[, currency0, currency1, exists], q0] = await Promise.all([
    readContract(ctx.client, {
      address: ctx.addresses.ledger,
      abi: bankrFeeLedgerAbi,
      functionName: "bucketOf",
      args: [bucketIds.creator(poolId)],
    }),
    quoteIs0(poolId),
  ]);
  return exists ? getAddress(q0 ? currency0 : currency1) : null;
}

async function scanOwed(
  ctx: SuiteReadContext,
  account: Address,
  o: OwedOptions,
): Promise<OwedState> {
  const { ids, referralPools } = await scanCandidates(ctx, account, o);
  const terms = new Map<string, Promise<boolean>>();
  const quoteIs0 = (poolId: Hex) => {
    let p = terms.get(poolId);
    if (!p) {
      p = readContract(ctx.client, {
        address: ctx.addresses.ledger,
        abi: bankrFeeLedgerAbi,
        functionName: "poolTerms",
        args: [poolId],
      }).then((t) => t.quoteIs0);
      terms.set(poolId, p);
    }
    return p;
  };
  const [shares, referred] = await Promise.all([
    Promise.all(ids.map((id) => readShare(ctx, account, id, quoteIs0))),
    Promise.all(referralPools.map((p) => referralQuote(ctx, p, quoteIs0))),
  ]);
  const buckets = shares.flatMap((s) => (s.bucket ? [s.bucket] : []));
  // Spec §5.1: every currency the account earned in, named or not: its shares' (settled ones too) and its referrals'.
  const quotes = new Map<string, Address>();
  for (const q of [
    ...Object.values(ctx.chain.quotes).map((x) => x.address),
    ...(o.quotes ?? []).map((q) => requireAddress(q, ctx.chain.chain)),
    ...shares.flatMap((s) => s.currencies),
    ...referred.flatMap((q) => (q ? [q] : [])),
  ])
    quotes.set(lower(q), getAddress(q));
  const list = [...quotes.values()];
  const amounts = await Promise.all(
    list.map((q) =>
      readContract(ctx.client, {
        address: ctx.addresses.ledger,
        abi: bankrFeeLedgerAbi,
        functionName: "balances",
        args: [account, q],
      }),
    ),
  );
  const balances = list
    .map((quote, i) => ({ quote, amount: amounts[i]! }))
    .filter((b) => b.amount > 0n);
  return {
    account,
    balances,
    buckets,
    totalByQuote: totalsOf(balances, buckets),
    source: "chain",
  };
}

/**
 * What `account` is owed on the client's own ledger: Bankr's account index first, asked for that ledger, a ledger log
 * scan when the index cannot answer for it (or `source` says so). An index failure surfaces only when the scan is
 * refused too.
 */
export async function readOwed(
  ctx: SuiteReadContext,
  index: BankrApi | undefined,
  account: Address,
  o: OwedOptions = {},
): Promise<OwedState> {
  const chain = ctx.chain.chain;
  const source = o.source ?? (ctx.fork || !index ? "chain" : "auto");
  if (source !== "auto" && source !== "api" && source !== "chain")
    throw new LaunchRefusedError("INVALID_PARAMS", { chain });
  let indexError: unknown;
  if (source !== "chain") {
    try {
      const ledger = ctx.addresses.ledger;
      const reply = index
        ? await index.accountFees(chain, account, ledger)
        : null;
      if (reply === null) throw new TypeError("not indexed");
      return fromApi(reply, chain, ctx.chain.chainId, account, ledger);
    } catch (err) {
      // A 404 or a malformed reply is the index failing too; its own errors keep their code (RATE_LIMITED).
      indexError =
        err instanceof LaunchApiError
          ? err
          : new LaunchApiError("API_ERROR", { chain, cause: err });
      if (source === "api") throw indexError;
    }
  }
  try {
    return await scanOwed(ctx, account, o);
  } catch (err) {
    if (!(err instanceof ScanRefused)) throw err;
    throw (
      indexError ??
      new LaunchRefusedError("INVALID_PARAMS", {
        chain,
        cause: err,
        detail:
          "This account's fee shares need Bankr's index, or a narrower fromBlock.",
      })
    );
  }
}
