import {
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import type { AccountFeesResponse, BankrApi } from "./api.js";
import type { LaunchChain } from "./chains/index.js";
import { LaunchApiError } from "./errors.js";
import type { SuiteReadContext } from "./lens.js";
import type { ClaimAllBucket, QuoteAmount } from "./planClaimAll.js";

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
}

const DECIMAL = /^\d{1,78}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const lower = (a: string) => a.toLowerCase();

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
  // Each suite has its own ledger and a ledger skips another's buckets, so an answer for another, or one that
  // names none, is refused.
  if (!isAddress(r.ledger) || !isAddressEqual(r.ledger, ledger))
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
  };
}

/** What `account` is owed on the client's own ledger, from Bankr's account index; its failures keep their code. */
export async function readOwed(
  ctx: SuiteReadContext,
  index: BankrApi,
  account: Address,
): Promise<OwedState> {
  const chain = ctx.chain.chain;
  const ledger = ctx.addresses.ledger;
  try {
    const reply = await index.accountFees(chain, account, ledger);
    if (reply === null) throw new TypeError("not indexed");
    return fromApi(reply, chain, ctx.chain.chainId, account, ledger);
  } catch (err) {
    // A 404 or a malformed reply is the index failing too; its own errors keep their code (RATE_LIMITED).
    throw err instanceof LaunchApiError
      ? err
      : new LaunchApiError("API_ERROR", { chain, cause: err });
  }
}
