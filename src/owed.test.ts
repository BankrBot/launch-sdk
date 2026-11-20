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
import { bankrFeeLedgerAbi } from "./abis/suite3.js";
import { BANKR_V4_EARLIER_ADDRESSES } from "./addresses.js";
import type { FetchLike } from "./api.js";
import { createLaunchClient } from "./client.js";
import { EARLIER_HOLDER_LEG_WAKE_ABI } from "./conversion.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import {
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";

// Fees owed and claim all come from Bankr's account index alone: its failures are the SDK's API errors, and the
// chain is never searched for an account's shares.

const API = "https://api.test";
/** A live non-major Base quote (the shared list's BNKR): not one of the chain's named majors (WETH, USDC). The factory
 *  does not list it, but it is the holder leg's BNKR, so claim all pays it by default. */
const BNKR = getAddress("0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b");
const REF = getAddress("0x4444444444444444444444444444444444444444");
/** A quote neither the factory lists nor Bankr's: any-quote pairing. */
const MEME = getAddress("0x0000000000000000000000000000000000003e3e");
/** Suite 4's ledger and settings contract beside suite 3's `SUITE` on the same chain. */
const LEDGER4 = getAddress("0x00000000000000000000000000000000000084e2");
const SETTINGS4 = getAddress("0x00000000000000000000000000000000000084e7");

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

/** A suite 3 client whose index answers `answer`, the holder leg's BNKR set. */
function apiFixture(answer: Parameters<typeof accountRoute>[0]) {
  const route = accountRoute(answer);
  const t = postLaunchFixture({ api: { url: API, fetch: route.fetch } });
  t.f.fake.contract(SUITE.holderLeg, EARLIER_HOLDER_LEG_WAKE_ABI, {
    bnkr: BNKR,
  });
  return { ...t, asked: route.asked };
}

describe("fees owed and claim all read Bankr's index alone", () => {
  for (const [what, status, code] of [
    ["is down", 503, "API_ERROR"],
    ["has not indexed the account's chain", 404, "API_ERROR"],
    ["rate-limits the caller", 429, "RATE_LIMITED"],
  ] as const) {
    test(`an index that ${what} is ${code}: no ledger log is read`, async () => {
      const { f, client } = apiFixture(() => ({
        status,
        body: { error: "no" },
      }));
      expect(is(await codeOf(client.fees.getOwed(LAUNCHER)), code)).toBe(true);
      expect(is(await codeOf(client.fees.buildClaimAll(LAUNCHER)), code)).toBe(
        true,
      );
      expect(f.fake.logRequests).toEqual([]);
    });
  }

  test("a fork client is refused INDEX_UNAVAILABLE before it asks the index or the chain", async () => {
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
      expect(is(await codeOf(read), "INDEX_UNAVAILABLE")).toBe(true);
    }
    expect(asked).toEqual([]);
    expect(f.fake.calls).toEqual([]);
  });

  test("audit REG-1: a settled share's balance on a non-major quote, as the index lists it, is withdrawn", async () => {
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

  test("round 9 ISO-4 / ISO-5: a referral slice in an unlisted quote is left by default and paid last on includeUnlisted", async () => {
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

describe("two suites live on one chain: a client reads and claims its own ledger (A2's review, 1)", () => {
  test("a wallet owed on a suite 3 coin and a suite 4 coin: each client shows and plans its own suite's, and the two claim-alls pay each amount once", async () => {
    const coin3 = apiShare("suite3", 105n);
    const coin4 = apiShare("suite4", 970_000n);
    const owedOn = new Map<string, unknown[]>([
      [SUITE.ledger.toLowerCase(), [coin3]],
      [LEDGER4.toLowerCase(), [coin4]],
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
    const suite3 = createLaunchClient({
      chain: "base",
      suite: 3,
      addresses: SUITE,
      publicClient,
      api,
    });
    const suite4 = createLaunchClient({
      chain: "base",
      suite: 4,
      addresses: { ...SUITE, ledger: LEDGER4, settings: SETTINGS4 },
      publicClient,
      api,
    });

    const owed3 = await suite3.fees.getOwed(OTHER);
    const owed4 = await suite4.fees.getOwed(OTHER);
    expect(asked).toEqual([SUITE.ledger, LEDGER4]);
    expect(owed3.buckets.map((b) => b.bucketId)).toEqual([coin3.bucketId]);
    expect(owed3.totalByQuote).toEqual([{ quote: WETH, amount: 105n }]);
    expect(owed4.buckets.map((b) => b.bucketId)).toEqual([coin4.bucketId]);
    expect(owed4.totalByQuote).toEqual([{ quote: WETH, amount: 970_000n }]);

    const all3 = await suite3.fees.buildClaimAll(OTHER);
    const all4 = await suite4.fees.buildClaimAll(OTHER);
    expect(all3.plan.totals).toEqual([{ quote: WETH, amount: 105n }]);
    expect(all4.plan.totals).toEqual([{ quote: WETH, amount: 970_000n }]);
    // Each plan is one withdraw on its own ledger, naming its own suite's bucket alone.
    expect(all3.txs.map(withdrawOf)).toEqual([
      {
        to: SUITE.ledger,
        functionName: "withdraw",
        args: [[coin3.bucketId], [WETH]],
      },
    ]);
    expect(all4.txs.map(withdrawOf)).toEqual([
      {
        to: LEDGER4,
        functionName: "withdraw",
        args: [[coin4.bucketId], [WETH]],
      },
    ]);
    // Together they cover both coins, each once: 970,105 in all, never 970,105 on one ledger.
    const both = [all3, all4];
    expect(both.reduce((n, a) => n + a.plan.buckets, 0)).toBe(2);
    expect(
      both.flatMap((a) => a.plan.totals).reduce((n, t) => n + t.amount, 0n),
    ).toBe(970_105n);
  });

  for (const [what, named] of [
    ["the other suite's ledger", LEDGER4],
    ["no ledger (an API that ignores the query)", undefined],
  ] as const) {
    test(`an answer that names ${what} is never shown or planned: API_ERROR, and no log is read`, async () => {
      const { fetch } = accountRoute(() => ({
        body: accountBody(LAUNCHER, named, [apiShare("suite4", 970_000n)]),
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

// An account answer names the ledger it is for (the API has since #8354): one that names none is no answer.
describe("an answer that names no ledger is refused by every client", () => {
  for (const [what, options] of [
    ["the earlier record's", { suite: 3 }],
    ["a default", {}],
  ] as const) {
    test(`${what} client reads no amount from it: API_ERROR`, async () => {
      const { fetch, asked } = accountRoute(() => ({
        body: accountBody(OTHER, undefined, [apiShare("suite3", 105n)]),
      }));
      const client = createLaunchClient({
        chain: "base",
        ...options,
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
  }

  test("the earlier record's client still refuses an answer that names another ledger", async () => {
    const { fetch } = accountRoute(() => ({
      body: accountBody(OTHER, LEDGER4, [apiShare("suite4", 970_000n)]),
    }));
    const client = createLaunchClient({
      chain: "base",
      suite: 3,
      publicClient: new FakeChain(base).publicClient(),
      api: { url: API, fetch },
    });
    expect(is(await codeOf(client.fees.getOwed(OTHER)), "API_ERROR")).toBe(
      true,
    );
  });
});
