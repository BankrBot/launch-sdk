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
import { BANKR_V4_ADDRESSES } from "./addresses.js";
import type { FetchLike } from "./api.js";
import { createLaunchClient } from "./client.js";
import { HOLDER_LEG_WAKE_ABI } from "./conversion.js";
import { isLaunchSdkError } from "./errors.js";
import { bucketIds } from "./lens.js";
import { FakeChain, eventLog } from "./__internal__/fakeRpc.js";
import {
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  installLaunch,
  postLaunchFixture,
  setLedgerBalance,
} from "./__internal__/fakeLaunch.js";

// Audit REG-1: the ledger log scan (fork clients, and every client when Bankr's index cannot answer) reads the
// balance in every currency the account earned in, named major or not: a settled share's and a referrer's.

/** A live non-major Base quote (the shared list's BNKR): not one of the chain's named majors (WETH, USDC). The factory
 *  does not list it, but it is the holder leg's BNKR, so claim all pays it by default. */
const BNKR = getAddress("0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b");
const REF = getAddress("0x4444444444444444444444444444444444444444");
/** A quote neither the factory lists nor Bankr's: any-quote pairing. */
const MEME = getAddress("0x0000000000000000000000000000000000003e3e");

function fixture() {
  const t = postLaunchFixture({ fork: true });
  t.f.fake.contract(SUITE.holderLeg, HOLDER_LEG_WAKE_ABI, { bnkr: BNKR });
  return t;
}

describe("getOwed's ledger scan: balances in every currency the account earned in (audit REG-1)", () => {
  test("a share already settled (claimable 0) on a non-major quote: its balance is read and withdrawn", async () => {
    const { f, client } = fixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: BNKR });
    const creator = bucketIds.creator(l.poolId);
    const side = (v: bigint) =>
      (l.tokenIsCurrency0 ? [0n, v] : [v, 0n]) as [bigint, bigint];
    l.cumulated.set(creator, side(30n));
    l.checkpoints.set(`${creator}:${LAUNCHER.toLowerCase()}`, side(30n));
    setLedgerBalance(f, LAUNCHER, BNKR, 50n); // a settle sent on its behalf moved it
    const owed = await client.fees.getOwed(LAUNCHER);
    expect(owed.source).toBe("chain");
    expect(owed.buckets).toEqual([]);
    expect(owed.balances).toEqual([{ quote: BNKR, amount: 50n }]);
    const { txs, plan } = await client.fees.buildClaimAll(LAUNCHER);
    expect(plan.totals).toEqual([{ quote: BNKR, amount: 50n }]);
    expect(txs).toHaveLength(1);
    const w = decodeFunctionData({
      abi: bankrFeeLedgerAbi,
      data: txs[0]!.data,
    });
    expect(w.functionName).toBe("withdraw");
    expect(w.args).toEqual([[], [BNKR]]);
  });

  test("a referrer with no shares at all: its SwapFee referrals name the pools, their quotes' balances are read", async () => {
    const { f, client } = fixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: BNKR });
    f.fake.addLog(
      eventLog(
        bankrFeeLedgerAbi,
        "SwapFee",
        {
          poolId: l.poolId as Hex,
          sender: LAUNCHER,
          feePips: 10_000,
          fee: 1_000n,
          bankr: 500n,
          holders: 100n,
          referrer: REF,
          referral: 7n,
          remainder: 393n,
        },
        SUITE.ledger,
      ),
    );
    setLedgerBalance(f, REF, BNKR, 7n);
    const owed = await client.fees.getOwed(REF);
    expect(owed.balances).toEqual([{ quote: BNKR, amount: 7n }]);
    const { txs } = await client.fees.buildClaimAll(REF);
    expect(txs).toHaveLength(1);
    // Another account's referrals never widen this account's reads.
    expect((await client.fees.getOwed(LAUNCHER)).balances).toEqual([]);
  });

  test("round 9 ISO-4 / ISO-5: a referral slice in an unlisted quote is found, left by default, and paid last on includeUnlisted", async () => {
    const { f, client } = fixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: MEME });
    f.fake.addLog(
      eventLog(
        bankrFeeLedgerAbi,
        "SwapFee",
        {
          poolId: l.poolId as Hex,
          sender: LAUNCHER,
          feePips: 10_000,
          fee: 1_000n,
          bankr: 500n,
          holders: 100n,
          referrer: REF,
          referral: 7n,
          remainder: 393n,
        },
        SUITE.ledger,
      ),
    );
    setLedgerBalance(f, REF, MEME, 7n);
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

// A2's review, 1 (Departure 122): two suites live on one chain keep two ledgers, and a ledger skips another's bucket
// ids silently. Bankr's account route answers one ledger a call (the one named, else the chain's oldest suite's).

const API = "https://api.test";
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
) => ({
  chainId: 8453,
  account,
  ledger,
  balances: [],
  buckets,
  totalByQuote: [],
  bucketCount: buckets.length,
});

const withdrawOf = (tx: { to: Address; data: Hex }) => ({
  to: tx.to,
  ...decodeFunctionData({ abi: bankrFeeLedgerAbi, data: tx.data }),
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
    expect([owed3.source, owed4.source]).toEqual(["api", "api"]);
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
    test(`an answer that names ${what} is never shown or planned: the client scans its own ledger`, async () => {
      const { fetch } = accountRoute(() => ({
        body: accountBody(LAUNCHER, named, [apiShare("suite4", 970_000n)]),
      }));
      const { f, client } = postLaunchFixture({ api: { url: API, fetch } });
      const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
      const creator = bucketIds.creator(l.poolId);
      const side = (v: bigint) =>
        (l.tokenIsCurrency0 ? [0n, v] : [v, 0n]) as [bigint, bigint];
      l.claimable.set(`${creator}:${LAUNCHER.toLowerCase()}`, side(105n));
      l.cumulated.set(creator, side(105n));

      const owed = await client.fees.getOwed(LAUNCHER);
      expect(owed.source).toBe("chain");
      expect(owed.buckets.map((b) => b.bucketId)).toEqual([creator]);
      expect(owed.totalByQuote).toEqual([{ quote: WETH, amount: 105n }]);
      const { txs, plan } = await client.fees.buildClaimAll(LAUNCHER);
      expect(plan.totals).toEqual([{ quote: WETH, amount: 105n }]);
      expect(txs.map(withdrawOf)).toEqual([
        {
          to: SUITE.ledger,
          functionName: "withdraw",
          args: [[creator], [WETH]],
        },
      ]);
      // Asked for the index alone, it refuses rather than show another ledger's amount.
      let thrown: unknown;
      try {
        await client.fees.getOwed(LAUNCHER, { source: "api" });
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, "API_ERROR")).toBe(true);
    });
  }
});

// The API live before A2's review names no ledger and ignores the query. It serves one suite a chain, the SDK's
// shipped suite 3 record, so its answer is that ledger's and no other's.
describe("an API that names no ledger (production before A2's review) answers for the chain's shipped suite 3 ledger alone", () => {
  const SHIPPED = getAddress(BANKR_V4_ADDRESSES.base!.ledger);
  const unnamed = (account: Address) =>
    accountRoute(() => ({
      body: accountBody(account, undefined, [apiShare("suite3", 105n)]),
    }));
  const refused = async (read: Promise<unknown>) => {
    let thrown: unknown;
    try {
      await read;
    } catch (err) {
      thrown = err;
    }
    return isLaunchSdkError(thrown, "API_ERROR");
  };

  test("a suite 3 client on the shipped record still reads the index, past the head its log scan stops at", async () => {
    const { fetch, asked } = unnamed(OTHER);
    const fake = new FakeChain(base);
    // Base: 2,000 windows of 2,000 blocks from block 56,657,447 end at 60,657,447; the scan is refused after it.
    fake.blockNumber = 60_700_000n;
    const client = createLaunchClient({
      chain: "base",
      publicClient: fake.publicClient(),
      api: { url: API, fetch },
    });
    for (const source of ["auto", "api"] as const) {
      const owed = await client.fees.getOwed(OTHER, { source });
      expect(owed.source).toBe("api");
      expect(owed.totalByQuote).toEqual([{ quote: WETH, amount: 105n }]);
    }
    expect(asked).toEqual([SHIPPED, SHIPPED]);
    const { txs } = await client.fees.buildClaimAll(OTHER);
    expect(txs.map((tx) => tx.to)).toEqual([SHIPPED]);
  });

  test("the shipped record's client still refuses an answer that names another ledger", async () => {
    const { fetch } = accountRoute(() => ({
      body: accountBody(OTHER, LEDGER4, [apiShare("suite4", 970_000n)]),
    }));
    const client = createLaunchClient({
      chain: "base",
      publicClient: new FakeChain(base).publicClient(),
      api: { url: API, fetch },
    });
    expect(await refused(client.fees.getOwed(OTHER, { source: "api" }))).toBe(
      true,
    );
  });

  test("a suite 4 client never takes it: the answer is suite 3's", async () => {
    const { fetch, asked } = unnamed(OTHER);
    const client = createLaunchClient({
      chain: "base",
      suite: 4,
      addresses: { ...SUITE, ledger: LEDGER4, settings: SETTINGS4 },
      publicClient: new FakeChain(base).publicClient(),
      api: { url: API, fetch },
    });
    expect(await refused(client.fees.getOwed(OTHER, { source: "api" }))).toBe(
      true,
    );
    expect(asked).toEqual([LEDGER4]);
  });
});
