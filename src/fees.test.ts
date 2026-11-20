import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { bankrFeeLedgerAbi } from "./abis/generated.js";
import type { FetchLike } from "./api.js";
import { CHAINS } from "./chains/index.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { bucketIds } from "./lens.js";
import {
  CLAIM_ALL_GAS,
  CLAIM_ALL_MAX_GAS_PER_TX,
  CLAIM_PUSH_CHECK_GAS,
} from "./planClaimAll.js";
import {
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  installLaunch,
  postLaunchFixture,
  setLedgerBalance,
} from "./__internal__/fakeLaunch.js";

const USDC = getAddress(CHAINS.base.quotes.USDC.address);

async function expectCode(p: Promise<unknown>, code: LaunchSdkErrorCode) {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
}

const decode = (data: `0x${string}`) =>
  decodeFunctionData({ abi: bankrFeeLedgerAbi, data });

describe("fees", () => {
  test("get: the fee recipient's shares and claimable by side, creator and decay buckets", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      decayShares: [{ account: LAUNCHER, sharesWad: 10n ** 17n }],
    });
    const creator = bucketIds.creator(l.poolId);
    l.claimable.set(
      `${creator}:${LAUNCHER.toLowerCase()}`,
      l.tokenIsCurrency0 ? [0n, 70n] : [70n, 0n],
    );
    const s = await client.fees.get(l.token);
    expect(s.account).toBe(LAUNCHER);
    expect(s.creator).toMatchObject({
      sharesWad: 10n ** 18n,
      role: "creator",
      claimableQuote: 70n,
      claimableToken: 0n,
    });
    expect(s.decay).toMatchObject({ sharesWad: 10n ** 17n });
    expect(s.claimableQuote).toBe(70n);
  });

  test("buildClaim: collectFees, collectFeesMany across buckets, collectFeesSide per bucket; never for a stranger", async () => {
    const { f, client } = postLaunchFixture();
    const one = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const [single] = await client.fees.buildClaim(one.token, LAUNCHER);
    expect(single!.to).toBe(SUITE.ledger);
    expect(decode(single!.data)).toEqual({
      functionName: "collectFees",
      args: [bucketIds.creator(one.poolId)],
    });
    const two = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      salt: `0x${"77".repeat(32)}`,
      decayShares: [{ account: LAUNCHER, sharesWad: 1n }],
    });
    const [many] = await client.fees.buildClaim(two.token, LAUNCHER);
    expect(decode(many!.data).functionName).toBe("collectFeesMany");
    const sides = await client.fees.buildClaim(two.token, LAUNCHER, {
      side: "quote",
    });
    expect(sides).toHaveLength(2);
    expect(decode(sides[0]!.data)).toEqual({
      functionName: "collectFeesSide",
      args: [bucketIds.creator(two.poolId), !two.tokenIsCurrency0],
    });
    await expectCode(
      client.fees.buildClaim(one.token, OTHER),
      "NOT_A_BENEFICIARY",
    );
    await expectCode(client.fees.buildClaim(OTHER, LAUNCHER), "NOT_A_LAUNCH");
  });

  test("buildSetFeeRecipient moves the share; a recipient that cannot claim or already holds one is refused", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const tx = await client.fees.buildSetFeeRecipient(l.token, LAUNCHER, OTHER);
    expect(decode(tx.data)).toEqual({
      functionName: "updateBeneficiary",
      args: [bucketIds.creator(l.poolId), OTHER],
    });
    expect(tx.from).toBe(LAUNCHER);
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, LAUNCHER, SUITE.ledger),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, LAUNCHER, l.distributor),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, LAUNCHER, LAUNCHER),
      "INVALID_PARAMS",
    );
    f.fake.setCode(OTHER, "0x6080");
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, LAUNCHER, OTHER),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    // Round 9 RSEC-1: allowContractFeeRecipient admits a contract only once it restricted its claim policy.
    const allow = { allowContractFeeRecipient: true };
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, LAUNCHER, OTHER, allow),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
    f.fake.contract(SUITE.ledger, bankrFeeLedgerAbi, {
      claimRestricted: ([a]: readonly unknown[]) =>
        String(a).toLowerCase() === OTHER.toLowerCase(),
    });
    expect(
      decode(
        (
          await client.fees.buildSetFeeRecipient(
            l.token,
            LAUNCHER,
            OTHER,
            allow,
          )
        ).data,
      ),
    ).toEqual({
      functionName: "updateBeneficiary",
      args: [bucketIds.creator(l.poolId), OTHER],
    });
    await expectCode(
      client.fees.buildSetFeeRecipient(l.token, OTHER, LAUNCHER),
      "NOT_A_BENEFICIARY",
    );
    // The suite's CREATE3 factory could never collect, and the factory's isSuite does not hold it.
    f.fake.setCode(SUITE.create3Factory, "0x6080");
    f.fake.contract(SUITE.ledger, bankrFeeLedgerAbi, { claimRestricted: true });
    await expectCode(
      client.fees.buildSetFeeRecipient(
        l.token,
        LAUNCHER,
        SUITE.create3Factory,
        allow,
      ),
      "FEE_RECIPIENT_CANNOT_CLAIM",
    );
  });

  test("several fee recipients: each claims and moves its own entry, and none can move onto another's", async () => {
    const { f, client } = postLaunchFixture();
    const B = getAddress("0x000000000000000000000000000000000000fee2");
    const NEXT = getAddress("0x000000000000000000000000000000000000fee3");
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      creatorShares: [
        { account: LAUNCHER, sharesWad: 7n * 10n ** 17n },
        { account: B, sharesWad: 3n * 10n ** 17n },
      ],
      creators: [LAUNCHER, B],
    });
    const creator = bucketIds.creator(l.poolId);
    l.claimable.set(`${creator}:${B.toLowerCase()}`, [30n, 30n]);
    const mine = await client.fees.get(l.token, B);
    expect(mine.creator).toMatchObject({
      sharesWad: 3n * 10n ** 17n,
      creatorShareWad: 3n * 10n ** 17n,
      role: "creator",
      claimableQuote: 30n,
    });
    // The first recipient's own read owes it nothing of the second's.
    expect((await client.fees.get(l.token)).claimableQuote).toBe(0n);
    const [claim] = await client.fees.buildClaim(l.token, B);
    expect(claim!.from).toBe(B);
    expect(decode(claim!.data)).toEqual({
      functionName: "collectFees",
      args: [creator],
    });
    const move = await client.fees.buildSetFeeRecipient(l.token, B, NEXT);
    expect(move.from).toBe(B);
    expect(decode(move.data)).toEqual({
      functionName: "updateBeneficiary",
      args: [creator, NEXT],
    });
    let thrown: unknown;
    try {
      await client.fees.buildSetFeeRecipient(l.token, B, LAUNCHER);
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    expect((thrown as { detail?: string }).detail).toContain("never merges");
  });

  // Live-fork finding 11-07: another launch's token got the open-contract advice, though no launch contract can
  // ever restrict itself or claim (the factory's isSuite refuses it).
  test("a fee recipient that is a Bankr launch contract is refused as one, not told to restrict itself", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const other = installLaunch(f, {
      launcher: OTHER,
      quote: WETH,
      salt: keccak256(toHex("another launch")),
    });
    f.fake.setCode(other.token, "0x6080");
    f.set(
      "factory",
      "isSuite",
      ([a]: readonly unknown[]) =>
        String(a).toLowerCase() === other.token.toLowerCase(),
    );
    let thrown: unknown;
    try {
      await client.fees.buildSetFeeRecipient(l.token, LAUNCHER, other.token, {
        allowContractFeeRecipient: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "FEE_RECIPIENT_CANNOT_CLAIM")).toBe(true);
    const detail = (thrown as { detail?: string }).detail ?? "";
    expect(detail).toContain("Bankr launch contract");
    expect(detail).not.toContain("restrict it first");
  });

  test("balances: the pull balance per quote, withdraw, the claim policy and operator, and get()'s balances", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    setLedgerBalance(f, OTHER, WETH, 12n);
    expect(await client.fees.getBalances(OTHER, [WETH])).toEqual([
      { quote: WETH, balance: 12n },
    ]);
    const tx = client.fees.buildWithdraw(OTHER, [WETH]);
    expect(tx).toMatchObject({ from: OTHER, to: SUITE.ledger, value: 0n });
    expect(decode(tx.data)).toEqual({
      functionName: "withdraw",
      args: [[], [WETH]],
    });
    const creator = bucketIds.creator(l.poolId);
    expect(
      decode(client.fees.buildWithdraw(LAUNCHER, [WETH], [creator]).data),
    ).toEqual({ functionName: "withdraw", args: [[creator], [WETH]] });
    expect(() => client.fees.buildWithdraw(OTHER, [])).toThrow();
    for (const restricted of [true, false]) {
      const policy = client.fees.buildSetClaimRestricted(OTHER, restricted);
      expect(policy).toMatchObject({
        from: OTHER,
        to: SUITE.ledger,
        value: 0n,
      });
      expect(decode(policy.data)).toEqual({
        functionName: "setClaimRestricted",
        args: [restricted],
      });
    }
    for (const bad of [
      () => client.fees.buildSetClaimRestricted(OTHER, "yes" as never),
      () => client.fees.buildSetClaimRestricted("0x1234" as never, true),
    ]) {
      let thrown: unknown;
      try {
        bad();
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    }
    const op = client.fees.buildSetClaimOperator(OTHER, LAUNCHER, true);
    expect(op).toMatchObject({ from: OTHER, to: SUITE.ledger });
    expect(decode(op.data)).toEqual({
      functionName: "setClaimOperator",
      args: [LAUNCHER, true],
    });
    // A public forwarder (Multicall3, Multicall2, Multicall) calls for anyone: naming one is naming everyone (FF2/RSEC-2).
    for (const bad of [
      OTHER,
      zeroAddress,
      "0xcA11bde05977b3631167028862bE2a173976CA11",
      "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696",
      "0xeefBa1e63905eF1D7ACbA5a8513c70307C1cE441",
    ] as const) {
      let thrown: unknown;
      try {
        client.fees.buildSetClaimOperator(OTHER, bad, true);
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    }
    // Removing one an account named earlier stays possible.
    expect(
      decode(
        client.fees.buildSetClaimOperator(
          OTHER,
          "0xcA11bde05977b3631167028862bE2a173976CA11",
          false,
        ).data,
      ),
    ).toEqual({
      functionName: "setClaimOperator",
      args: ["0xcA11bde05977b3631167028862bE2a173976CA11", false],
    });
    setLedgerBalance(f, LAUNCHER, WETH, 4n);
    setLedgerBalance(f, LAUNCHER, l.token, 3n);
    expect((await client.fees.get(l.token)).balances).toEqual({
      quote: 4n,
      token: 3n,
    });
  });
});

const API = "https://api.test";

/** A fetch that answers Bankr's account route with `body` (or `status`), recording each URL. */
function accountApi(answer: { status?: number; body?: unknown }) {
  const urls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    urls.push(new URL(input));
    return new Response(JSON.stringify(answer.body ?? { error: "down" }), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, urls };
}

const apiBucket = (i: number, o: { firstTouch?: boolean } = {}) => ({
  bucketId: keccak256(toHex(`bucket-${i}`)),
  poolId: keccak256(toHex(`pool-${i}`)),
  token: getAddress(pad(toHex(0x7000_0000 + i), { size: 20 })),
  quote: WETH,
  kind: "creator",
  claimableQuote: String(1_000 + i),
  claimableToken: "0",
  firstTouch: o.firstTouch ?? true,
  bothSides: false,
});

const accountBody = (buckets: unknown[], balances: unknown[] = []) => ({
  chainId: 8453,
  account: OTHER,
  ledger: SUITE.ledger,
  balances,
  buckets,
  totalByQuote: [],
  bucketCount: buckets.length,
});

describe("claim all", () => {
  test("getOwed reads Bankr's account index, amounts exact", async () => {
    const big = "123456789012345678901234567890";
    const { fetch, urls } = accountApi({
      body: accountBody(
        [{ ...apiBucket(1), claimableQuote: big }],
        [{ quote: WETH, amount: "5" }],
      ),
    });
    const { client } = postLaunchFixture({ api: { url: API, fetch } });
    const owed = await client.fees.getOwed(OTHER);
    expect(urls.map((u) => u.href)).toEqual([
      `${API}/bankr-v4/accounts/${OTHER}/fees?chainId=8453&ledger=${SUITE.ledger}`,
    ]);
    expect(owed).toEqual({
      account: OTHER,
      balances: [{ quote: WETH, amount: 5n }],
      buckets: [
        {
          ...apiBucket(1),
          kind: "creator",
          claimableQuote: BigInt(big),
          claimableToken: 0n,
        },
      ],
      totalByQuote: [{ quote: WETH, amount: BigInt(big) + 5n }],
    });
  });

  test("buildClaimAll: one withdraw(ids, quotes) when everything fits, from the account with the model's gas", async () => {
    const { fetch } = accountApi({
      body: accountBody(
        [apiBucket(1), apiBucket(2, { firstTouch: false })],
        [{ quote: USDC, amount: "7" }],
      ),
    });
    const { client } = postLaunchFixture({ api: { url: API, fetch } });
    const { txs, plan } = await client.fees.buildClaimAll(OTHER);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      from: OTHER,
      to: SUITE.ledger,
      value: 0n,
      gas: plan.steps[0]!.gas,
    });
    expect(decode(txs[0]!.data)).toEqual({
      functionName: "withdraw",
      args: [
        [apiBucket(1).bucketId, apiBucket(2).bucketId],
        [WETH, USDC],
      ],
    });
    expect(plan.steps[0]!.gas).toBe(
      CLAIM_ALL_GAS.base +
        2n * CLAIM_ALL_GAS.quote +
        CLAIM_ALL_GAS.bucketFirst +
        CLAIM_ALL_GAS.bucketSteady +
        CLAIM_ALL_GAS.newBalance,
    );
  });

  test("buildClaimAll: a 1,000-coin creator settles in chunks first, then withdraws; each transaction within 15M", async () => {
    const all = Array.from({ length: 1_000 }, (_, i) => apiBucket(i));
    const { fetch } = accountApi({ body: accountBody(all) });
    const { client } = postLaunchFixture({ api: { url: API, fetch } });
    const { txs, plan } = await client.fees.buildClaimAll(OTHER);
    expect(txs.map((t) => decode(t.data).functionName)).toEqual([
      "settle",
      "settle",
      "withdraw",
    ]);
    const ids: Hex[] = [];
    for (const [i, t] of txs.entries()) {
      expect(t.gas).toBe(plan.steps[i]!.gas);
      expect(t.gas!).toBeLessThanOrEqual(CLAIM_ALL_MAX_GAS_PER_TX);
      const { functionName, args } = decode(t.data);
      if (functionName === "settle") {
        expect(args[1]).toEqual([OTHER]);
        ids.push(...(args[0] as Hex[]));
      } else {
        expect(args[1]).toEqual([WETH]);
        ids.push(...(args[0] as Hex[]));
      }
    }
    expect(new Set(ids).size).toBe(1_000);
  });

  test("buildClaimAll with any-quote pairing (round 9 ISO-4, F4): unlisted currencies only on includeUnlisted, then in a trailing withdraw of their own", async () => {
    const MEME = getAddress(pad("0x3e3e", { size: 20 }));
    const BOMB = getAddress(pad("0x3e3f", { size: 20 }));
    const answer: { body?: unknown } = {};
    const { fetch } = accountApi(answer);
    const { f, client } = postLaunchFixture({ api: { url: API, fetch } });
    // a launched coin's token in the balance (a former share's settle): a launch token is listed
    const former = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    answer.body = accountBody(
      [apiBucket(1), { ...apiBucket(2), quote: MEME, claimableQuote: "900" }],
      [
        { quote: BOMB, amount: "5" },
        { quote: former.token, amount: "3" },
      ],
    );
    const listed = await client.fees.buildClaimAll(OTHER);
    expect(listed.txs.map((t) => decode(t.data).args[1])).toEqual([
      [WETH, former.token],
    ]);
    expect(listed.plan.unlisted).toEqual([
      { quote: MEME, amount: 900n },
      { quote: BOMB, amount: 5n },
    ]);
    const all = await client.fees.buildClaimAll(OTHER, {
      includeUnlisted: true,
    });
    expect(all.plan.steps.map((s) => [s.quotes, s.unlisted])).toEqual([
      [[WETH, former.token], undefined],
      [[MEME, BOMB], true],
    ]);
    expect(decode(all.txs[1]!.data)).toEqual({
      functionName: "withdraw",
      args: [[], [MEME, BOMB]],
    });
    expect(all.plan.unlisted).toEqual([]);
  });

  // Live-fork finding 11-07: decision 5 lets anyone push an open account its fees, but the SDK built only the
  // account's own withdraw, so a third party could push only with raw calldata.
  test("buildClaimAll for another account: settle(ids, [account]) then withdrawFor(account, quotes), all from the sender", async () => {
    const SENDER = getAddress("0x3333333333333333333333333333333333333333");
    const { fetch } = accountApi({
      body: accountBody(
        [apiBucket(1), apiBucket(2, { firstTouch: false })],
        [{ quote: USDC, amount: "7" }],
      ),
    });
    const { f, client } = postLaunchFixture({ api: { url: API, fetch } });
    const { txs, plan } = await client.fees.buildClaimAll(OTHER, {
      sender: SENDER,
    });
    expect(txs.map((t) => t.from)).toEqual([SENDER, SENDER]);
    expect(txs.map((t) => decode(t.data))).toEqual([
      {
        functionName: "settle",
        args: [[apiBucket(1).bucketId, apiBucket(2).bucketId], [OTHER]],
      },
      { functionName: "withdrawFor", args: [OTHER, [WETH, USDC]] },
    ]);
    // Each push pays the ledger's capped isSuite probe on the account, which its own claim skips.
    expect(plan.steps.map((s) => s.gas)).toEqual([
      CLAIM_ALL_GAS.base +
        CLAIM_PUSH_CHECK_GAS +
        CLAIM_ALL_GAS.bucketFirst +
        CLAIM_ALL_GAS.bucketSteady +
        CLAIM_ALL_GAS.newBalance,
      CLAIM_ALL_GAS.base + CLAIM_PUSH_CHECK_GAS + 2n * CLAIM_ALL_GAS.quote,
    ]);
    expect(txs.map((t) => t.gas)).toEqual(plan.steps.map((s) => s.gas));
    // The account itself as the sender is its own claim-all.
    const own = await client.fees.buildClaimAll(OTHER, { sender: OTHER });
    expect(own.txs.map((t) => decode(t.data).functionName)).toEqual([
      "withdraw",
    ]);
    // A restricted account: its claim operator may push, anyone else is refused before anything is built.
    const OPERATOR = getAddress("0x4444444444444444444444444444444444444444");
    f.set(
      "ledger",
      "mayClaimFor",
      ([, by]: readonly unknown[]) =>
        String(by).toLowerCase() === OPERATOR.toLowerCase(),
    );
    expect(
      (await client.fees.buildClaimAll(OTHER, { sender: OPERATOR })).txs,
    ).toHaveLength(2);
    await expectCode(
      client.fees.buildClaimAll(OTHER, { sender: SENDER }),
      "CLAIM_NOT_ALLOWED",
    );
    // A puller (the hook's auto-LP, a protocol sink, a suite contract) is never pushed, whatever its policy.
    f.set("ledger", "mayClaimFor", true);
    f.set("ledger", "isProtocolSink", true);
    await expectCode(
      client.fees.buildClaimAll(OTHER, { sender: SENDER }),
      "CLAIM_NOT_ALLOWED",
    );
    // A public forwarder sends for anyone: a push from it is one nobody can sign.
    await expectCode(
      client.fees.buildClaimAll(OTHER, {
        sender: CHAINS.base.viemChain.contracts!.multicall3!.address,
      }),
      "INVALID_PARAMS",
    );
  });

  // The ledger's withdrawFor pays a puller the balance it already holds; the SDK builds no push to one all the same.
  test("buildClaimAll for a puller that holds a balance: no push is built, CLAIM_NOT_ALLOWED saying it collects its own share", async () => {
    const SENDER = getAddress("0x3333333333333333333333333333333333333333");
    const { fetch } = accountApi({
      body: accountBody([], [{ quote: USDC, amount: "7" }]),
    });
    const { f, client } = postLaunchFixture({ api: { url: API, fetch } });
    // An open account that is no puller is pushed that same balance: one withdrawFor.
    const open = await client.fees.buildClaimAll(OTHER, { sender: SENDER });
    expect(open.txs.map((t) => decode(t.data))).toEqual([
      { functionName: "withdrawFor", args: [OTHER, [USDC]] },
    ]);
    f.set("ledger", "isProtocolSink", true);
    let refused: unknown;
    try {
      await client.fees.buildClaimAll(OTHER, { sender: SENDER });
    } catch (err) {
      refused = err;
    }
    expect(isLaunchSdkError(refused, "CLAIM_NOT_ALLOWED")).toBe(true);
    expect((refused as { detail?: string }).detail).toBe(
      "The account is a Bankr puller: it collects its own share and is never pushed.",
    );
  });

  test("buildClaimAll: nothing owed is no transaction; a dust floor and a lower gas cap are honoured; above the chain's ceiling is refused", async () => {
    const { fetch } = accountApi({ body: accountBody([apiBucket(1)]) });
    const { client } = postLaunchFixture({ api: { url: API, fetch } });
    const none = await client.fees.buildClaimAll(OTHER, {
      dust: () => 10_000n,
    });
    expect(none.txs).toEqual([]);
    expect(none.plan.belowDust).toBe(1);
    const low = await client.fees.buildClaimAll(OTHER, {
      maxGasPerTx: 2_000_000n,
    });
    expect(low.txs[0]!.gas!).toBeLessThanOrEqual(2_000_000n);
    await expectCode(
      client.fees.buildClaimAll(OTHER, { maxGasPerTx: 16_777_217n }),
      "INVALID_PARAMS",
    );
  });
});
