import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { bankrFeeLedgerAbi } from "./abis/generated.js";
import { bnkrHolderLegAbi } from "./abis/settings.js";
import type { FetchLike } from "./api.js";
import { CHAINS } from "./chains/index.js";
import { createLaunchClient } from "./client.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import {
  LAUNCHER,
  OTHER,
  SUITE,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";

// Fees owed and claim all come from Bankr's account index alone: its failures are the SDK's API errors, and the
// chain is never searched for an account's shares.

const API = "https://api.test";
/** Base's WETH, one of the chain's named majors: claim all pays it without asking the chain whether it is listed. */
const WETH = getAddress(CHAINS.base.quotes.WETH.address);
/** A live non-major Base quote (the shared list's BNKR): not one of the chain's named majors (WETH, USDC). The factory
 *  does not list it, but it is the holder leg's BNKR, so claim all pays it by default. */
const BNKR = getAddress("0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b");
const REF = getAddress("0x4444444444444444444444444444444444444444");
/** A quote neither the factory lists nor Bankr's: any-quote pairing. */
const MEME = getAddress("0x0000000000000000000000000000000000003e3e");
/** Another deployment's ledger beside `SUITE`'s on the same chain (a fork's own, or a later generation's). */
const OTHER_LEDGER = getAddress("0x00000000000000000000000000000000000084e2");

/** One coin's creator share as the account route lists it. */
const apiShare = (coin: string, claimable: bigint) => ({
  bucketId: keccak256(toHex(`bucket-${coin}`)),
  poolId: keccak256(toHex(`pool-${coin}`)),
  token: getAddress(keccak256(toHex(`token-${coin}`)).slice(0, 42)),
  quote: WETH,
  kind: "creator",
  claimableQuote: String(claimable),
  claimableToken: "0",
  firstTouch: true,
  bothSides: false,
});

/** A fetch standing in for the account route: `answer` sees the `ledger` the client named (null when none). */
function accountRoute(
  answer: (ledger: string | null) => { status?: number; body: unknown },
) {
  const asked: (string | null)[] = [];
  const fetch: FetchLike = async (input) => {
    const ledger = new URL(input).searchParams.get("ledger");
    asked.push(ledger);
    const { status = 200, body } = answer(ledger);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, asked };
}

const accountBody = (
  account: Address,
  ledger: Address | undefined,
  buckets: unknown[],
  balances: { quote: Address; amount: string }[] = [],
) => ({
  chainId: 8453,
  account,
  ledger,
  balances,
  buckets,
  totalByQuote: [],
  bucketCount: buckets.length,
});

const withdrawOf = (tx: { to: Address; data: Hex }) => ({
  to: tx.to,
  ...decodeFunctionData({ abi: bankrFeeLedgerAbi, data: tx.data }),
});

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return null;
}

const is = (err: unknown, code: LaunchSdkErrorCode) =>
  isLaunchSdkError(err, code);

/** A client whose index answers `answer`, the holder leg's BNKR set. */
function apiFixture(answer: Parameters<typeof accountRoute>[0]) {
  const route = accountRoute(answer);
  const t = postLaunchFixture({ api: { url: API, fetch: route.fetch } });
  t.f.fake.contract(SUITE.holderLeg, bnkrHolderLegAbi, { bnkr: BNKR });
  return { ...t, asked: route.asked };
}

describe("fees owed and claim all read Bankr's index alone", () => {
  for (const [what, status, code] of [
    ["is down", 503, "API_ERROR"],
    ["is behind on the chain", 503, "INDEX_UNAVAILABLE"],
    ["has not indexed the account's chain", 404, "API_ERROR"],
    ["rate-limits the caller", 429, "RATE_LIMITED"],
  ] as const) {
    test(`an index that ${what} is ${code}: no ledger log is read`, async () => {
      const { f, client } = apiFixture(() => ({
        status,
        body: {
          error: "no",
          ...(code === "INDEX_UNAVAILABLE" ? { code } : {}),
        },
      }));
      expect(is(await codeOf(client.fees.getOwed(LAUNCHER)), code)).toBe(true);
      expect(is(await codeOf(client.fees.buildClaimAll(LAUNCHER)), code)).toBe(
        true,
      );
      expect(f.fake.logRequests).toEqual([]);
    });
  }

  test("a fork client is refused INDEX_NOT_ON_FORK before it asks the index or the chain", async () => {
    const { fetch, asked } = accountRoute(() => ({
      body: accountBody(OTHER, SUITE.ledger, []),
    }));
    const { f, client } = postLaunchFixture({
      api: { url: API, fetch },
      fork: true,
    });
    for (const read of [
      client.fees.getOwed(OTHER),
      client.fees.buildClaimAll(OTHER),
    ]) {
      expect(is(await codeOf(read), "INDEX_NOT_ON_FORK")).toBe(true);
    }
    expect(asked).toEqual([]);
    expect(f.fake.calls).toEqual([]);
  });

  test("a settled share's balance on a non-major quote, as the index lists it, is withdrawn", async () => {
    const { client } = apiFixture(() => ({
      body: accountBody(
        LAUNCHER,
        SUITE.ledger,
        [],
        [{ quote: BNKR, amount: "50" }],
      ),
    }));
    const owed = await client.fees.getOwed(LAUNCHER);
    expect(owed.buckets).toEqual([]);
    expect(owed.balances).toEqual([{ quote: BNKR, amount: 50n }]);
    const { txs, plan } = await client.fees.buildClaimAll(LAUNCHER);
    expect(plan.totals).toEqual([{ quote: BNKR, amount: 50n }]);
    expect(txs.map(withdrawOf)).toEqual([
      { to: SUITE.ledger, functionName: "withdraw", args: [[], [BNKR]] },
    ]);
  });

  test("a referral slice in an unlisted quote is left by default and paid last on includeUnlisted", async () => {
    const { client } = apiFixture(() => ({
      body: accountBody(REF, SUITE.ledger, [], [{ quote: MEME, amount: "7" }]),
    }));
    expect((await client.fees.getOwed(REF)).balances).toEqual([
      { quote: MEME, amount: 7n },
    ]);
    const left = await client.fees.buildClaimAll(REF);
    expect(left.txs).toEqual([]);
    expect(left.plan.unlisted).toEqual([{ quote: MEME, amount: 7n }]);
    const paid = await client.fees.buildClaimAll(REF, {
      includeUnlisted: true,
    });
    expect(paid.plan.steps).toEqual([
      {
        kind: "withdraw",
        bucketIds: [],
        quotes: [MEME],
        gas: paid.plan.steps[0]!.gas,
        unlisted: true,
      },
    ]);
  });
});

describe("two ledgers live on one chain: a client reads and claims its own", () => {
  test("a wallet owed on a coin of each: each client shows and plans its own ledger's, and the two claim-alls pay each amount once", async () => {
    const coinA = apiShare("ledger-a", 105n);
    const coinB = apiShare("ledger-b", 970_000n);
    const owedOn = new Map<string, unknown[]>([
      [SUITE.ledger.toLowerCase(), [coinA]],
      [OTHER_LEDGER.toLowerCase(), [coinB]],
    ]);
    const { fetch, asked } = accountRoute((ledger) => {
      const at = getAddress(ledger ?? SUITE.ledger);
      const buckets = owedOn.get(at.toLowerCase());
      return buckets
        ? { body: accountBody(OTHER, at, buckets) }
        : { status: 404, body: { error: "No fee ledger at that address." } };
    });
    const publicClient = new FakeChain(base).publicClient();
    const api = { url: API, fetch };
    const a = createLaunchClient({
      chain: "base",
      addresses: SUITE,
      publicClient,
      api,
    });
    const b = createLaunchClient({
      chain: "base",
      addresses: { ...SUITE, ledger: OTHER_LEDGER },
      publicClient,
      api,
    });

    const owedA = await a.fees.getOwed(OTHER);
    const owedB = await b.fees.getOwed(OTHER);
    expect(asked).toEqual([SUITE.ledger, OTHER_LEDGER]);
    expect(owedA.buckets.map((x) => x.bucketId)).toEqual([coinA.bucketId]);
    expect(owedA.totalByQuote).toEqual([{ quote: WETH, amount: 105n }]);
    expect(owedB.buckets.map((x) => x.bucketId)).toEqual([coinB.bucketId]);
    expect(owedB.totalByQuote).toEqual([{ quote: WETH, amount: 970_000n }]);

    const allA = await a.fees.buildClaimAll(OTHER);
    const allB = await b.fees.buildClaimAll(OTHER);
    expect(allA.plan.totals).toEqual([{ quote: WETH, amount: 105n }]);
    expect(allB.plan.totals).toEqual([{ quote: WETH, amount: 970_000n }]);
    // Each plan is one withdraw on its own ledger, naming its own bucket alone.
    expect(allA.txs.map(withdrawOf)).toEqual([
      {
        to: SUITE.ledger,
        functionName: "withdraw",
        args: [[coinA.bucketId], [WETH]],
      },
    ]);
    expect(allB.txs.map(withdrawOf)).toEqual([
      {
        to: OTHER_LEDGER,
        functionName: "withdraw",
        args: [[coinB.bucketId], [WETH]],
      },
    ]);
    // Together they cover both coins, each once: 970,105 in all, never 970,105 on one ledger.
    const both = [allA, allB];
    expect(both.reduce((n, x) => n + x.plan.buckets, 0)).toBe(2);
    expect(
      both.flatMap((x) => x.plan.totals).reduce((n, t) => n + t.amount, 0n),
    ).toBe(970_105n);
  });

  for (const [what, named] of [
    ["another ledger", OTHER_LEDGER],
    ["no ledger (an API that ignores the query)", undefined],
  ] as const) {
    test(`an answer that names ${what} is never shown or planned: API_ERROR, and no log is read`, async () => {
      const { fetch } = accountRoute(() => ({
        body: accountBody(LAUNCHER, named, [apiShare("ledger-b", 970_000n)]),
      }));
      const { f, client } = postLaunchFixture({ api: { url: API, fetch } });
      expect(is(await codeOf(client.fees.getOwed(LAUNCHER)), "API_ERROR")).toBe(
        true,
      );
      expect(
        is(await codeOf(client.fees.buildClaimAll(LAUNCHER)), "API_ERROR"),
      ).toBe(true);
      expect(f.fake.logRequests).toEqual([]);
    });
  }
});

// An account answer names the ledger it is for (the API does the same): one that names none is no answer.
describe("an answer that names no ledger is refused", () => {
  test("a default client reads no amount from it: API_ERROR", async () => {
    const { fetch, asked } = accountRoute(() => ({
      body: accountBody(OTHER, undefined, [apiShare("ledger-a", 105n)]),
    }));
    const client = createLaunchClient({
      chain: "base",
      publicClient: new FakeChain(base).publicClient(),
      api: { url: API, fetch },
    });
    expect(is(await codeOf(client.fees.getOwed(OTHER)), "API_ERROR")).toBe(
      true,
    );
    expect(
      is(await codeOf(client.fees.buildClaimAll(OTHER)), "API_ERROR"),
    ).toBe(true);
    expect(asked[0]).toBe(getAddress(client.provider.addresses.ledger));
  });
});
