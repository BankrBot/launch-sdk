import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  multicall3Abi,
  toHex,
  zeroAddress,
  type TransactionReceipt,
} from "viem";
import {
  bankrFeeLedgerAbi,
  holderRewardsDistributorAbi,
} from "./abis/generated.js";
import { bnkrHolderLegAbi } from "./abis/settings.js";
import { isLaunchSdkError } from "./errors.js";
import { EIP_7825_MAX_TX_GAS } from "./chains/index.js";
import { HOLDER_CLAIM_ALL_GAS, HOLDER_GAS } from "./index.js";
import { CONVERT_GAS } from "./conversion.js";
import { bucketIds } from "./lens.js";
import {
  COIN_LEG,
  FAKE_BNKR,
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  installLaunch,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";
import { eventLog } from "./__internal__/fakeRpc.js";
import { fakeAddress } from "./__internal__/fakeRecord.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** `n` launches on one chain; the first `earning` pay OTHER rewards on some leg. */
function coins(n: number, earning: number) {
  const fixture = postLaunchFixture();
  const launches = Array.from({ length: n }, (_, i) =>
    installLaunch(fixture.f, {
      launcher: LAUNCHER,
      quote: WETH,
      salt: keccak256(toHex(`holder-coin-${i}`)),
    }),
  );
  launches.slice(0, earning).forEach((l, i) => {
    l.earned.set(`${i % 3}:${OTHER.toLowerCase()}`, 5n + BigInt(i));
  });
  return { ...fixture, launches };
}

const claimFor = encodeFunctionData({
  abi: holderRewardsDistributorAbi,
  functionName: "claimFor",
  args: [OTHER],
});

const decode = (data: `0x${string}`) =>
  decodeFunctionData({ abi: holderRewardsDistributorAbi, data });

/** Coins on WETH (listed) and on two quotes Bankr does not list, all earning for OTHER; the MEME coins' holder
 *  piles wait in the ledger (no swap wakes an unlisted quote's), the first with a pile, the second without, and
 *  HOSTILE's first has one staged in the leg. `memeFloor`: the leg's floor for MEME (default: never floored). */
function anyQuoteCoins(o: { memeFloor?: bigint; mode?: number } = {}) {
  const fixture = postLaunchFixture();
  const { f, leg } = fixture;
  const MEME = fakeAddress(0x3e3e);
  const HOSTILE = fakeAddress(0x3e3f);
  const mk = (quote: `0x${string}`, i: number) => {
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote,
      salt: keccak256(toHex(`any-quote-coin-${i}`)),
    });
    l.earned.set(`1:${OTHER.toLowerCase()}`, 7n);
    return l;
  };
  const meme0 = mk(MEME, 0);
  const hostile0 = mk(HOSTILE, 1);
  const weth0 = mk(WETH, 2);
  const meme1 = mk(MEME, 3);
  const weth1 = mk(WETH, 4);
  leg.payoutMode = o.mode ?? 0;
  const memeFloor = o.memeFloor ?? 0n;
  const isMeme = (q: unknown) => String(q).toLowerCase() === MEME.toLowerCase();
  // A quote the leg was never floored for has no floor at all (MEME by default, HOSTILE always).
  f.fake.contract(COIN_LEG, bnkrHolderLegAbi, {
    minPile: ([q]: readonly unknown[]) => (isMeme(q) ? memeFloor : 0n),
  });
  f.fake.contract(SUITE.ledger, bankrFeeLedgerAbi, {
    holdersWake: ([, q]: readonly unknown[]) =>
      isMeme(q) && memeFloor !== 0n
        ? (memeFloor << 160n) | BigInt(COIN_LEG)
        : 0n,
  });
  meme0.claimable.set(
    `${bucketIds.holders(meme0.poolId)}:${COIN_LEG.toLowerCase()}`,
    meme0.tokenIsCurrency0 ? [0n, 40n] : [40n, 0n],
  );
  leg.pending.set(hostile0.poolId, [3n, 0n]);
  return { ...fixture, MEME, HOSTILE, meme0, meme1, hostile0, weth0, weth1 };
}

const aggregate = (data: `0x${string}`) =>
  (
    decodeFunctionData({ abi: multicall3Abi, data }).args![0] as readonly {
      target: string;
      callData: `0x${string}`;
    }[]
  ).map((c) => ({ target: c.target, callData: c.callData }));

const poke = (poolId: `0x${string}`) =>
  encodeFunctionData({
    abi: bnkrHolderLegAbi,
    functionName: "poke",
    args: [poolId],
  });

describe("holders", () => {
  test("get: the balance and each leg's asset and earnings", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    l.balances.set(OTHER.toLowerCase(), 5n);
    l.earned.set(`1:${OTHER.toLowerCase()}`, 7n);
    l.earned.set(`2:${OTHER.toLowerCase()}`, 9n);
    const s = await client.holders.get(l.token, OTHER);
    expect(s).toMatchObject({
      distributor: l.distributor,
      balance: 5n,
      excluded: false,
    });
    expect(s.legs.token).toEqual({ asset: l.token, earned: 0n });
    expect(s.legs.quote).toEqual({ asset: WETH, earned: 7n });
    expect(s.legs.bnkr).toEqual({ asset: FAKE_BNKR, earned: 9n });
    expect(s.bnkrEpoch).toEqual({ epoch: 0, next: null });
    expect(s.pastBnkr).toEqual([]);
  });

  test("get: after BNKR swaps, each closed epoch's BNKR the account can still claim, in its own token", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const [OLD, OLDER] = [fakeAddress(0xb401), fakeAddress(0xb400)];
    // Two swaps: epoch 0 in OLDER (claimed), epoch 1 in OLD; the leg's BNKR now streams in epoch 2.
    l.bnkrEpoch = [2n, zeroAddress];
    l.pastBnkr.set(`0:${OTHER.toLowerCase()}`, [OLDER, 50n, 0n]);
    l.pastBnkr.set(`1:${OTHER.toLowerCase()}`, [OLD, 80n, 11n]);
    const s = await client.holders.get(l.token, OTHER);
    expect(s.bnkrEpoch).toEqual({ epoch: 2, next: null });
    expect(s.pastBnkr).toEqual([{ epoch: 1, token: OLD, claimable: 11n }]);
    // Mid-swap: the open epoch's old token still drains into the leg's new one.
    l.bnkrEpoch = [2n, FAKE_BNKR];
    expect((await client.holders.get(l.token, OTHER)).bnkrEpoch).toEqual({
      epoch: 2,
      next: FAKE_BNKR,
    });
  });

  test("buildClaimPastBnkr: claimPastBnkr(account, epoch) to the distributor, a closed epoch only", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    l.bnkrEpoch = [1n, zeroAddress];
    const own = await client.holders.buildClaimPastBnkr(l.token, OTHER, 0);
    expect(own).toMatchObject({ from: OTHER, to: l.distributor, value: 0n });
    expect(decode(own.data)).toEqual({
      functionName: "claimPastBnkr",
      args: [OTHER, 0n],
    });
    const pushed = await client.holders.buildClaimPastBnkr(l.token, OTHER, 0, {
      sender: LAUNCHER,
    });
    expect(pushed.from).toBe(LAUNCHER);
    expect(decode(pushed.data).args).toEqual([OTHER, 0n]);
    for (const epoch of [1, -1, 0.5]) {
      let thrown: unknown;
      try {
        await client.holders.buildClaimPastBnkr(l.token, OTHER, epoch);
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    }
  });

  test("claim, claimLeg, claimFor and claimForMany, all to the distributor; the claim policy is the ledger's", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const all = await client.holders.buildClaim(l.token, OTHER);
    expect(all).toMatchObject({ from: OTHER, to: l.distributor, value: 0n });
    expect(decode(all.data).functionName).toBe("claim");
    expect(
      decode(
        (await client.holders.buildClaim(l.token, OTHER, { leg: "bnkr" })).data,
      ),
    ).toEqual({
      functionName: "claimLeg",
      args: [2],
    });
    expect(
      decode(
        (await client.holders.buildClaimFor(l.token, LAUNCHER, [OTHER])).data,
      ),
    ).toEqual({
      functionName: "claimFor",
      args: [OTHER],
    });
    expect(
      decode(
        (
          await client.holders.buildClaimFor(l.token, LAUNCHER, [
            OTHER,
            LAUNCHER,
          ])
        ).data,
      ).functionName,
    ).toBe("claimForMany");
    // Decision 1: holder rewards accrue in every swap and a claim pulls them, so there is no keeper call to build.
    expect("buildDistribute" in client.holders).toBe(false);
    // Q9: the distributor has no operator surface; the fee ledger's one policy covers it (client.fees).
    expect("buildSetClaimOperator" in client.holders).toBe(false);
  });

  test("HOLDER_GAS models claim(), claimFor and each further claimForMany account, the lazy pull included (R8-GAS-4)", () => {
    expect(HOLDER_GAS).toEqual({
      claim: 1_750_000n,
      claimFor: 2_450_000n,
      perClaim: 1_900_000n,
    });
  });

  test("claim, claimLeg, claimFor and claimForMany carry the modelled gas; claimLeg's can be raised, to the chain's ceiling (R8REV-2)", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    const gasOf = async (tx: Promise<{ gas?: bigint }>) => (await tx).gas;
    expect(await gasOf(client.holders.buildClaim(l.token, OTHER))).toBe(
      HOLDER_GAS.claim,
    );
    expect(
      await gasOf(client.holders.buildClaim(l.token, OTHER, { leg: "bnkr" })),
    ).toBe(HOLDER_GAS.claim);
    // claimLeg hands the asset all the gas: the escape hatch for a transfer that needs more than a payout's cap.
    expect(
      await gasOf(
        client.holders.buildClaim(l.token, OTHER, {
          leg: "quote",
          gas: 6_000_000n,
        }),
      ),
    ).toBe(6_000_000n);
    expect(
      await gasOf(
        client.holders.buildClaim(l.token, OTHER, { gas: 10n ** 9n }),
      ),
    ).toBe(EIP_7825_MAX_TX_GAS);
    expect(
      await gasOf(client.holders.buildClaimFor(l.token, LAUNCHER, [OTHER])),
    ).toBe(HOLDER_GAS.claimFor);
    const accounts = (n: number) =>
      Array.from({ length: n }, (_, i) => fakeAddress(0xacc0 + i));
    expect(
      await gasOf(client.holders.buildClaimFor(l.token, LAUNCHER, accounts(3))),
    ).toBe(HOLDER_GAS.claimFor + 2n * HOLDER_GAS.perClaim);
    // Each further account carries a BNKR payout's whole cap: 8 fit Base's 2^24 ceiling, 9 would not.
    expect(
      await gasOf(client.holders.buildClaimFor(l.token, LAUNCHER, accounts(8))),
    ).toBe(HOLDER_GAS.claimFor + 7n * HOLDER_GAS.perClaim);
    for (const refused of [
      () => client.holders.buildClaimFor(l.token, LAUNCHER, accounts(9)),
      () => client.holders.buildClaim(l.token, OTHER, { gas: 0n }),
      () =>
        client.holders.buildClaim(l.token, OTHER, {
          gas: 1_000_000 as unknown as bigint,
        }),
    ]) {
      let thrown: unknown;
      try {
        await refused();
      } catch (err) {
        thrown = err;
      }
      expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    }
  });

  test("buildClaimAll: an EOA's coins with rewards, claimFor(account) batched through Multicall3, 14 a transaction in 15M (R8-GAS-4)", async () => {
    const { client, launches } = coins(30, 26);
    launches[3]!.excluded.add(OTHER.toLowerCase());
    const all = await client.holders.buildClaimAll(
      OTHER,
      launches.map((l) => l.token),
    );
    const paying = launches.slice(0, 26).filter((_, i) => i !== 3);
    expect(all.mode).toBe("multicall");
    expect(all.coins.map((c) => c.token)).toEqual(paying.map((l) => l.token));
    expect(all.coins[1]).toEqual({
      token: paying[1]!.token,
      distributor: paying[1]!.distributor,
      quote: WETH,
      poolId: paying[1]!.poolId,
      listed: true,
      poke: false,
      earned: { token: 0n, quote: 6n, bnkr: 0n },
    });
    expect(all.txs).toHaveLength(2);
    // Multicall3 and the last coin's reserve (the 2.4M claim floor less one coin), then 900k a coin.
    const { base, perCoin } = HOLDER_CLAIM_ALL_GAS;
    expect(all.txs[0]).toMatchObject({
      from: OTHER,
      to: MULTICALL3,
      value: 0n,
      gas: base + 14n * perCoin,
    });
    expect(all.txs[0]!.gas!).toBeLessThanOrEqual(15_000_000n);
    expect(all.txs[1]!.gas).toBe(base + 11n * perCoin);
    const calls = all.txs.flatMap((t) => {
      const { functionName, args } = decodeFunctionData({
        abi: multicall3Abi,
        data: t.data,
      });
      expect(functionName).toBe("aggregate3");
      return [...(args![0] as readonly { target: string }[])];
    });
    expect(calls).toEqual(
      paying.map((l) => ({
        target: l.distributor,
        allowFailure: true,
        callData: claimFor,
      })),
    );
  });

  test("buildClaimAll: an EOA or 7702 wallet whose claim policy refuses Multicall3 (Q9, round 9 FF2/RSEC-2) gets one claim() per coin from itself", async () => {
    const { f, client, launches } = coins(3, 2);
    const tokens = launches.map((l) => l.token);
    const asked: string[] = [];
    f.fake.contract(SUITE.ledger, bankrFeeLedgerAbi, {
      mayClaimFor: ([a, c]: readonly unknown[]) => {
        asked.push(`${String(a).toLowerCase()}:${String(c).toLowerCase()}`);
        return String(c).toLowerCase() !== MULTICALL3.toLowerCase();
      },
    });
    for (const code of [undefined, `0xef0100${"ab".repeat(20)}`] as const) {
      if (code) f.fake.setCode(OTHER, code);
      const all = await client.holders.buildClaimAll(OTHER, tokens);
      // A restricted account's claimFor through Multicall3 lands, pays gas and claims nothing (ClaimerNotAllowed).
      expect(all.mode).toBe("direct");
      expect(all.txs.map((t) => [t.from, t.to])).toEqual([
        [OTHER, launches[0]!.distributor],
        [OTHER, launches[1]!.distributor],
      ]);
      expect(all.txs.map((t) => decode(t.data).functionName)).toEqual([
        "claim",
        "claim",
      ]);
      expect(all.txs.map((t) => t.gas)).toEqual([
        HOLDER_GAS.claim,
        HOLDER_GAS.claim,
      ]);
    }
    expect(asked).toContain(
      `${OTHER.toLowerCase()}:${MULTICALL3.toLowerCase()}`,
    );
  });

  test("buildClaimAll: a 7702 wallet batches the same way; a contract account (a Safe) gets one claim() per coin", async () => {
    const { f, client, launches } = coins(3, 2);
    const tokens = launches.map((l) => l.token);
    f.fake.setCode(OTHER, `0xef0100${"ab".repeat(20)}`);
    expect((await client.holders.buildClaimAll(OTHER, tokens)).mode).toBe(
      "multicall",
    );
    f.fake.setCode(OTHER, "0x6080");
    const safe = await client.holders.buildClaimAll(OTHER, tokens);
    expect(safe.mode).toBe("direct");
    expect(safe.txs.map((t) => [t.from, t.to])).toEqual([
      [OTHER, launches[0]!.distributor],
      [OTHER, launches[1]!.distributor],
    ]);
    expect(safe.txs.map((t) => decode(t.data).functionName)).toEqual([
      "claim",
      "claim",
    ]);
    expect(safe.txs.map((t) => t.gas)).toEqual([
      HOLDER_GAS.claim,
      HOLDER_GAS.claim,
    ]);
    expect(
      await client.holders.buildClaimAll(OTHER, [launches[2]!.token]),
    ).toMatchObject({
      coins: [],
      txs: [],
    });
    let thrown: unknown;
    try {
      await client.holders.buildClaimAll(OTHER, [fakeAddress(0xdead)]);
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "NOT_A_LAUNCH")).toBe(true);
  });

  test("buildClaimAll with any-quote pairing (round 9 ISO-1, ISO-3): listed coins first, each unlisted quote's coins in their own transaction at the hostile budget, a poke per pile no swap wakes", async () => {
    const t = anyQuoteCoins();
    const all = await t.client.holders.buildClaimAll(
      OTHER,
      [t.meme0, t.hostile0, t.weth0, t.meme1, t.weth1].map((l) => l.token),
    );
    expect(HOLDER_CLAIM_ALL_GAS).toEqual({
      base: 1_560_000n,
      perCoin: 900_000n,
      perUnlistedCoin: 1_900_000n,
      perPoke: 400_000n,
      perConvertPoke: 2_000_000n,
    });
    const { base, perCoin, perUnlistedCoin, perPoke } = HOLDER_CLAIM_ALL_GAS;
    expect(all.mode).toBe("multicall");
    expect(all.coins.map((c) => [c.token, c.listed, c.poke])).toEqual([
      [t.weth0.token, true, false],
      [t.weth1.token, true, false],
      [t.meme0.token, false, true],
      [t.meme1.token, false, false],
      [t.hostile0.token, false, true],
    ]);
    expect(all.txs.map((x) => x.gas)).toEqual([
      base + 2n * perCoin,
      base + 2n * perUnlistedCoin + perPoke,
      base + perUnlistedCoin + perPoke,
    ]);
    const call = (target: string) => ({ target, callData: claimFor });
    expect(all.txs.map((x) => aggregate(x.data))).toEqual([
      [call(t.weth0.distributor), call(t.weth1.distributor)],
      // the claims, then the forward-only poke: a poke that burns can starve nothing after it
      [
        call(t.meme0.distributor),
        call(t.meme1.distributor),
        { target: COIN_LEG, callData: poke(t.meme0.poolId) },
      ],
      [
        call(t.hostile0.distributor),
        { target: COIN_LEG, callData: poke(t.hostile0.poolId) },
      ],
    ]);
    // A budget that holds a listed coin (3M) but not an unlisted coin and its poke is refused, never a short limit.
    const listedOnly = await t.client.holders.buildClaimAll(
      OTHER,
      [t.weth0.token],
      { maxGasPerTx: 3_000_000n },
    );
    expect(listedOnly.txs).toHaveLength(1);
    let refused: unknown;
    try {
      await t.client.holders.buildClaimAll(OTHER, [t.meme0.token], {
        maxGasPerTx: 3_000_000n,
      });
    } catch (err) {
      refused = err;
    }
    expect(isLaunchSdkError(refused, "INVALID_PARAMS")).toBe(true);
    // A quote the leg holds a real floor for: a pile under it waits. One at it is poked too, since only a swap that
    // asks wakes it (always-on; holderClaimAll.test.ts walks that rule).
    const under = anyQuoteCoins({ memeFloor: 41n });
    const b = await under.client.holders.buildClaimAll(OTHER, [
      under.meme0.token,
    ]);
    expect(b.coins[0]!.poke).toBe(false);
    // The leg pays in quote (QUOTE mode): the forward rule, so the forward-only budget.
    const armed = anyQuoteCoins({ memeFloor: 40n, mode: 1 });
    const c = await armed.client.holders.buildClaimAll(OTHER, [
      armed.meme0.token,
    ]);
    expect(c.coins[0]!.poke).toBe(true);
    expect(c.txs.map((x) => x.gas)).toEqual([base + perUnlistedCoin + perPoke]);
  });

  test("buildClaimAll with any-quote pairing, direct mode: claim() per coin, listed first, then a poke per pile at CONVERT_GAS", async () => {
    const t = anyQuoteCoins();
    t.f.fake.setCode(OTHER, "0x6080");
    const all = await t.client.holders.buildClaimAll(
      OTHER,
      [t.hostile0, t.meme0, t.weth0].map((l) => l.token),
    );
    expect(all.mode).toBe("direct");
    expect(all.txs.map((x) => [x.to, x.gas])).toEqual([
      [t.weth0.distributor, HOLDER_GAS.claim],
      [t.hostile0.distributor, HOLDER_GAS.claim],
      [t.meme0.distributor, HOLDER_GAS.claim],
      [COIN_LEG, CONVERT_GAS],
      [COIN_LEG, CONVERT_GAS],
    ]);
    expect(all.txs.slice(3).map((x) => x.data)).toEqual([
      poke(t.hostile0.poolId),
      poke(t.meme0.poolId),
    ]);
  });

  test("buildClaimAll with any-quote pairing: a held coin on an unlisted quote with nothing earned gets its poke alone, in its quote's own transaction at the forward budget", async () => {
    const t = anyQuoteCoins();
    t.meme0.earned.clear();
    t.meme0.balances.set(OTHER.toLowerCase(), 1n);
    const all = await t.client.holders.buildClaimAll(OTHER, [
      t.meme0.token,
      t.weth0.token,
    ]);
    const { base, perCoin, perPoke } = HOLDER_CLAIM_ALL_GAS;
    expect(all.coins.map((c) => [c.token, c.listed, c.poke])).toEqual([
      [t.weth0.token, true, false],
      [t.meme0.token, false, true],
    ]);
    expect(all.txs.map((x) => x.gas)).toEqual([base + perCoin, base + perPoke]);
    expect(aggregate(all.txs[1]!.data)).toEqual([
      { target: COIN_LEG, callData: poke(t.meme0.poolId) },
    ]);
  });

  test("unclaimed (round 9 ISO-1): an unlisted coin whose claim landed with its quote refused is not retried; a listed one is (REG-5)", async () => {
    const t = anyQuoteCoins();
    t.meme0.earned.set(`0:${OTHER.toLowerCase()}`, 5n);
    t.weth0.earned.set(`0:${OTHER.toLowerCase()}`, 5n);
    const all = await t.client.holders.buildClaimAll(OTHER, [
      t.meme0.token,
      t.weth0.token,
    ]);
    const receipt = {
      status: "success",
      logs: [t.meme0, t.weth0].map((l, i) => ({
        ...eventLog(
          holderRewardsDistributorAbi,
          "RewardClaimed",
          { account: OTHER, operator: MULTICALL3, amounts: [5n, 0n, 0n] },
          l.distributor,
        ),
        logIndex: i,
        blockNumber: 1n,
      })),
    } as unknown as TransactionReceipt;
    expect(t.client.holders.unclaimed(all, [receipt])).toEqual([t.weth0.token]);
  });

  test("unclaimed: the coins whose distributor logged no RewardClaimed for the account, to retry", async () => {
    const { client, launches } = coins(3, 3);
    const all = await client.holders.buildClaimAll(
      OTHER,
      launches.map((l) => l.token),
    );
    const claimed = (distributor: `0x${string}`, account = OTHER) =>
      eventLog(
        holderRewardsDistributorAbi,
        "RewardClaimed",
        { account, operator: MULTICALL3, amounts: [1n, 0n, 0n] },
        distributor,
      );
    const receipt = {
      status: "success",
      logs: [
        claimed(launches[0]!.distributor),
        claimed(launches[1]!.distributor, LAUNCHER),
      ].map((log, i) => ({ ...log, logIndex: i, blockNumber: 1n })),
    } as unknown as TransactionReceipt;
    expect(client.holders.unclaimed(all, [receipt])).toEqual([
      launches[1]!.token,
      launches[2]!.token,
    ]);
  });

  test("unclaimed: a coin whose claim paid some legs but not an earned one (a refused quote) is listed to retry (audit REG-5)", async () => {
    const { f, client } = postLaunchFixture();
    const l = installLaunch(f, { launcher: LAUNCHER, quote: WETH });
    l.earned.set(`0:${OTHER.toLowerCase()}`, 5n); // the token leg
    l.earned.set(`1:${OTHER.toLowerCase()}`, 9n); // the quote leg, a frozen USDG say
    const all = await client.holders.buildClaimAll(OTHER, [l.token]);
    expect(all.coins[0]!.earned).toEqual({ token: 5n, quote: 9n, bnkr: 0n });
    // _claim untakes a refused leg, zeroes it in `amounts`, and still logs RewardClaimed for the legs that paid.
    const receiptOf = (amounts: bigint[]) =>
      ({
        status: "success",
        logs: [
          {
            ...eventLog(
              holderRewardsDistributorAbi,
              "RewardClaimed",
              { account: OTHER, operator: MULTICALL3, amounts },
              l.distributor,
            ),
            logIndex: 0,
            blockNumber: 1n,
          },
        ],
      }) as unknown as TransactionReceipt;
    expect(client.holders.unclaimed(all, [receiptOf([5n, 0n, 0n])])).toEqual([
      l.token,
    ]);
    // A retry that pays the quote leg completes it, across both receipts.
    expect(
      client.holders.unclaimed(all, [
        receiptOf([5n, 0n, 0n]),
        receiptOf([0n, 9n, 0n]),
      ]),
    ).toEqual([]);
  });
});
