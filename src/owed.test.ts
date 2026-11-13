import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { bankrFeeLedgerAbi } from "./abis/generated.js";
import { HOLDER_LEG_WAKE_ABI } from "./conversion.js";
import { bucketIds } from "./lens.js";
import { eventLog } from "./__internal__/fakeRpc.js";
import {
  LAUNCHER,
  SUITE,
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
