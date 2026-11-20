import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  multicall3Abi,
  toHex,
  type Address,
} from "viem";
import { holderRewardsDistributorAbi } from "./abis/generated.js";
import { bnkrHolderLegAbi } from "./abis/settings.js";
import { CONVERT_GAS } from "./conversion.js";
import { isLaunchSdkError } from "./errors.js";
import { HOLDER_CLAIM_ALL_GAS, HOLDER_GAS } from "./holderClaimAll.js";
import { bucketIds } from "./lens.js";
import {
  COIN_LEG,
  LAUNCHER,
  OTHER,
  WETH,
  installLaunch,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";

/** The chain's clock (the latest block's) and the leg's stale period. */
const NOW = 1_800_000_000n;
const STALE_AFTER = 604_800n;

/** WETH's piles by coin index and the coins' leg. Default: a floor of 5, BNKR mode, a live route, an open window,
 *  nothing staged. */
interface Piles {
  pile?: Record<number, bigint>;
  staged?: Record<number, bigint>;
  /** When each staged pile was first staged (unix seconds). */
  since?: Record<number, bigint>;
  /** The leg's floor for WETH (`minPile`); 0: a quote it was never floored for. */
  floor?: bigint;
  /** PayoutMode: 0 BNKR (the default), 1 QUOTE. */
  mode?: number;
  /** The ledger's shared conversion window for WETH: until when, and what is left of its cap. */
  window?: [until: bigint, left: bigint];
  /** false: the leg holds no route for WETH. */
  routed?: boolean;
}

/** Which coins (by index) OTHER has rewards on, default all, and which it holds a balance of, default none. */
interface Holdings {
  earning?: readonly number[];
  held?: readonly number[];
}

/** `n` coins on WETH (listed) over the piles and leg state given, earning for OTHER or held by it as `who` says. */
function setup(n: number, o: Piles = {}, who: Holdings = {}) {
  const fixture = postLaunchFixture();
  const { f, leg } = fixture;
  f.fake.timestamp = NOW;
  leg.minPile = o.floor ?? 5n;
  leg.wakeFloor = leg.minPile === 0n ? null : leg.minPile;
  leg.payoutMode = o.mode ?? 0;
  leg.routed = o.routed ?? true;
  leg.staleAfter = Number(STALE_AFTER);
  if (o.window) leg.window = [Number(o.window[0]), o.window[1]];
  const launches = Array.from({ length: n }, (_, i) => {
    const l = installLaunch(f, {
      launcher: LAUNCHER,
      quote: WETH,
      salt: keccak256(toHex(`pile-coin-${i}`)),
    });
    if (who.earning?.includes(i) ?? true)
      l.earned.set(`1:${OTHER.toLowerCase()}`, 1n);
    if (who.held?.includes(i)) l.balances.set(OTHER.toLowerCase(), 1n);
    const pile = o.pile?.[i] ?? 0n;
    l.claimable.set(
      `${bucketIds.holders(l.poolId)}:${COIN_LEG.toLowerCase()}`,
      l.tokenIsCurrency0 ? [0n, pile] : [pile, 0n],
    );
    if (o.staged?.[i] !== undefined)
      leg.pending.set(l.poolId, [o.staged[i]!, o.since?.[i] ?? 0n]);
    return l;
  });
  // The leg's poke has no pause gate: the plan must not depend on the factory's switch.
  f.set("factory", "paused", () => {
    throw new Error("paused was read");
  });
  const build = (maxGasPerTx?: bigint) =>
    fixture.client.holders.buildClaimAll(
      OTHER,
      launches.map((l) => l.token),
      maxGasPerTx === undefined ? undefined : { maxGasPerTx },
    );
  return { ...fixture, launches, build };
}

const claimFor = encodeFunctionData({
  abi: holderRewardsDistributorAbi,
  functionName: "claimFor",
  args: [OTHER],
});
const claimCall = (target: Address) => ({
  target,
  allowFailure: true,
  callData: claimFor,
});
const pokeCall = (poolId: `0x${string}`) => ({
  target: COIN_LEG,
  allowFailure: true,
  callData: encodeFunctionData({
    abi: bnkrHolderLegAbi,
    functionName: "poke",
    args: [poolId],
  }),
});
const aggregate = (data: `0x${string}`) =>
  decodeFunctionData({ abi: multicall3Abi, data }).args![0];

const { base, perCoin, perPoke, perConvertPoke } = HOLDER_CLAIM_ALL_GAS;

describe("holders.buildClaimAll under always-on: no ordinary swap wakes a pile, so the claim-all pokes every due one", () => {
  test("a listed coin whose pile reached its leg's floor is poked after the claims, at the wake's stipend; a pile under the floor waits", async () => {
    const t = setup(2, { pile: { 0: 5n, 1: 4n } });
    const all = await t.build();
    expect(all.mode).toBe("multicall");
    expect(all.coins.map((c) => [c.token, c.listed, c.poke])).toEqual([
      [t.launches[0]!.token, true, true],
      [t.launches[1]!.token, true, false],
    ]);
    expect(all.txs).toHaveLength(1);
    // A converting poke is handed what the in-swap wake and a claim's own poke hand the leg: 2,000,000.
    expect(perConvertPoke).toBe(2_000_000n);
    expect(all.txs[0]!.gas).toBe(base + 2n * perCoin + perConvertPoke);
    expect(aggregate(all.txs[0]!.data)).toEqual([
      claimCall(t.launches[0]!.distributor),
      claimCall(t.launches[1]!.distributor),
      pokeCall(t.launches[0]!.poolId),
    ]);
  });

  test("due is the leg's own rule over the pile the poke would stage: staged counts, the window and the forward rule decide what the poke does", async () => {
    /** The poke's budget for one coin; null when the coin is not poked. */
    const poked = async (o: Piles) => {
      const all = await setup(1, o).build();
      return all.coins[0]!.poke ? all.txs[0]!.gas! - base - perCoin : null;
    };
    // The ledger's pile and the staged one together reach the floor: the poke stages the first onto the second.
    expect(
      await poked({
        pile: { 0: 2n },
        staged: { 0: 3n },
        since: { 0: NOW - 60n },
      }),
    ).toBe(perConvertPoke);
    expect(await poked({ staged: { 0: 5n }, since: { 0: NOW - 60n } })).toBe(
      perConvertPoke,
    );
    expect(
      await poked({
        pile: { 0: 2n },
        staged: { 0: 2n },
        since: { 0: NOW - 60n },
      }),
    ).toBeNull();
    // While the ledger's shared window is open with under a floor pile left a conversion waits, by the chain's
    // clock; once it ends, or with a floor pile left of its cap, the pile is due.
    const spent = (until: bigint, left = 4n): Piles => ({
      pile: { 0: 9n },
      window: [until, left],
    });
    expect(await poked(spent(NOW + 1n))).toBeNull();
    expect(await poked(spent(NOW))).toBe(perConvertPoke);
    expect(await poked(spent(NOW + 1n, 5n))).toBe(perConvertPoke);
    // The forward rule (QUOTE mode, a stale staged pile) pays in quote with no interval: the forward-only budget,
    // even inside a spent window.
    expect(await poked({ ...spent(NOW + 1n), mode: 1 })).toBe(perPoke);
    expect(
      await poked({
        staged: { 0: 5n },
        since: { 0: NOW - STALE_AFTER },
        window: [NOW + 1n, 4n],
      }),
    ).toBe(perPoke);
    // Without a route the one stage that starts the stale clock is due; a pile already staged only waits.
    expect(await poked({ routed: false, pile: { 0: 5n } })).toBe(
      perConvertPoke,
    );
    expect(
      await poked({
        routed: false,
        staged: { 0: 5n },
        since: { 0: NOW - 60n },
      }),
    ).toBeNull();
    // A quote the leg was never floored for keeps the any-quote rule: any pile, forward-only.
    expect(await poked({ floor: 0n, pile: { 0: 1n } })).toBe(perPoke);
    expect(await poked({ floor: 0n })).toBeNull();
  });

  test("the batch stays inside the per-transaction budget: 4 coins with a converting poke each at 15M, 2 at 10M, claims before pokes in every transaction", async () => {
    const pile = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [i, 5n]),
    );
    const each = perCoin + perConvertPoke;
    const t = setup(10, { pile });
    const all = await t.build();
    expect(all.txs.map((x) => x.gas)).toEqual([
      base + 4n * each,
      base + 4n * each,
      base + 2n * each,
    ]);
    expect(base + 4n * each).toBe(13_160_000n);
    expect(aggregate(all.txs[0]!.data)).toEqual([
      ...t.launches.slice(0, 4).map((l) => claimCall(l.distributor)),
      ...t.launches.slice(0, 4).map((l) => pokeCall(l.poolId)),
    ]);
    expect((await t.build(10_000_000n)).txs.map((x) => x.gas)).toEqual(
      Array(5).fill(base + 2n * each),
    );
    // Forward-only pokes ride ten to a transaction.
    const forward = await setup(10, { pile, mode: 1 }).build();
    expect(forward.txs.map((x) => x.gas)).toEqual([
      base + 10n * (perCoin + perPoke),
    ]);
    // A budget that holds a coin's claim but not its converting poke plans nothing rather than a batch that cannot land.
    expect((await t.build(base + each)).txs).toHaveLength(10);
    let refused: unknown;
    try {
      await t.build(base + each - 1n);
    } catch (err) {
      refused = err;
    }
    expect(isLaunchSdkError(refused, "INVALID_PARAMS")).toBe(true);
    expect((refused as { detail?: string }).detail).toBe(
      "maxGasPerTx is under the 4,460,000 gas one of these coins needs: its claim where it has rewards, and the poke of its holders' pile where one is due.",
    );
  });

  test("a contract account, or one that turned 'anyone can claim' off: each due pile gets its own poke after the claims, at the convert action's limit", async () => {
    const t = setup(2, { pile: { 0: 5n, 1: 4n } });
    t.f.fake.setCode(OTHER, "0x6080");
    const all = await t.build();
    expect(all.mode).toBe("direct");
    expect(all.txs.map((x) => [x.to, x.gas])).toEqual([
      [t.launches[0]!.distributor, HOLDER_GAS.claim],
      [t.launches[1]!.distributor, HOLDER_GAS.claim],
      [COIN_LEG, CONVERT_GAS],
    ]);
    expect(all.txs[2]!.data).toBe(pokeCall(t.launches[0]!.poolId).callData);
    expect(CONVERT_GAS).toBe(2_100_000n);
  });
});

describe("holders.buildClaimAll pokes a named coin's due pile before the account has earned from it: a waiting pile pays its holders nothing", () => {
  const NONE: Holdings = { earning: [] };

  test("a coin with nothing earned is poked once its pile is due, with no claimFor, after the coins that are claimed, held or not; under the floor it is left out", async () => {
    // Coin 0 is held, its pile at the floor; 1 earns, its pile under it; 2 is held, under the floor; 3 is due, not held.
    const t = setup(
      4,
      { pile: { 0: 5n, 1: 4n, 2: 4n, 3: 5n } },
      { earning: [1], held: [0, 2] },
    );
    const all = await t.build();
    expect(all.mode).toBe("multicall");
    const [held, earning, , named] = t.launches;
    const pokeOnly = (l: (typeof t.launches)[number]) => ({
      token: l.token,
      distributor: l.distributor,
      quote: WETH,
      poolId: l.poolId,
      listed: true,
      poke: true,
      earned: { token: 0n, quote: 0n, bnkr: 0n },
    });
    expect(all.coins).toEqual([
      {
        token: earning!.token,
        distributor: earning!.distributor,
        quote: WETH,
        poolId: earning!.poolId,
        listed: true,
        poke: false,
        earned: { token: 0n, quote: 1n, bnkr: 0n },
      },
      pokeOnly(held!),
      pokeOnly(named!),
    ]);
    // A poke-only coin costs its poke alone: no claim is sent or budgeted for it.
    expect(all.txs.map((x) => x.gas)).toEqual([
      base + perCoin + 2n * perConvertPoke,
    ]);
    expect(aggregate(all.txs[0]!.data)).toEqual([
      claimCall(earning!.distributor),
      pokeCall(held!.poolId),
      pokeCall(named!.poolId),
    ]);
    // No claim ran for them, so no receipt can leave them to retry.
    expect(t.client.holders.unclaimed(all, [])).toEqual([earning!.token]);
  });

  // Bankr's API pokes every coin on its list that does not exclude the account, and reads no balance of its own:
  // the SDK's list is the coins the caller names, so a named coin is never dropped before its pile is read.
  test("a named coin the account has earned nothing from and holds none of: its due pile is poked all the same, and no balance is read", async () => {
    const piles: Piles = { pile: { 0: 5n, 1: 4n } };
    const t = setup(2, piles, NONE);
    const all = await t.build();
    expect(all.coins.map((c) => [c.token, c.poke, c.earned])).toEqual([
      [t.launches[0]!.token, true, { token: 0n, quote: 0n, bnkr: 0n }],
    ]);
    expect(all.txs.map((x) => x.gas)).toEqual([base + perConvertPoke]);
    expect(aggregate(all.txs[0]!.data)).toEqual([
      pokeCall(t.launches[0]!.poolId),
    ]);
    expect(t.client.holders.unclaimed(all, [])).toEqual([]);
    // Every named coin's pile was read, the one under its floor too; the account's balance decides nothing.
    const holdersBuckets = t.launches.map((l) => bucketIds.holders(l.poolId));
    expect(
      t.f.fake
        .callsTo("claimable")
        .map((c) => c.args[0])
        .filter((b) => holdersBuckets.includes(b as `0x${string}`)),
    ).toEqual(holdersBuckets);
    expect(t.f.fake.callsTo("balanceOf")).toEqual([]);
    // A forward-only pile, and a contract account's own poke, the same way.
    const forward = await setup(2, { ...piles, mode: 1 }, NONE).build();
    expect(forward.txs.map((x) => x.gas)).toEqual([base + perPoke]);
    const safe = setup(2, piles, NONE);
    safe.f.fake.setCode(OTHER, "0x6080");
    const direct = await safe.build();
    expect(direct.txs.map((x) => [x.to, x.gas, x.data])).toEqual([
      [COIN_LEG, CONVERT_GAS, pokeCall(safe.launches[0]!.poolId).callData],
    ]);
    // An account the distributor excludes is still left out, and so is a named coin with no pile due.
    const excluded = setup(2, piles, NONE);
    excluded.launches[0]!.excluded.add(OTHER.toLowerCase());
    expect((await excluded.build()).coins).toEqual([]);
    expect((await setup(2, {}, NONE).build()).coins).toEqual([]);
  });

  test("with nothing earned anywhere the plan is the due pokes alone; an excluded account pokes nothing", async () => {
    const piles: Piles = { pile: { 0: 5n, 1: 4n } };
    const who: Holdings = { ...NONE, held: [0, 1] };
    const t = setup(2, piles, who);
    const all = await t.build();
    expect(all.coins.map((c) => [c.token, c.poke])).toEqual([
      [t.launches[0]!.token, true],
    ]);
    expect(all.txs.map((x) => x.gas)).toEqual([base + perConvertPoke]);
    expect(aggregate(all.txs[0]!.data)).toEqual([
      pokeCall(t.launches[0]!.poolId),
    ]);
    expect(t.client.holders.unclaimed(all, [])).toEqual([]);
    // A pile the forward rule pays in quote takes the forward-only budget.
    const forward = await setup(2, { ...piles, mode: 1 }, who).build();
    expect(forward.txs.map((x) => x.gas)).toEqual([base + perPoke]);
    // An account the distributor excludes never earns from the coin: its claim-all leaves the pile to the holders.
    const excluded = setup(2, piles, who);
    excluded.launches[0]!.excluded.add(OTHER.toLowerCase());
    expect(await excluded.build()).toEqual({
      account: OTHER,
      mode: "multicall",
      coins: [],
      txs: [],
    });
    // Nothing earned and no pile due: nothing to send.
    const idle = await setup(2, {}, who).build();
    expect([idle.coins, idle.txs]).toEqual([[], []]);
  });

  test("poke-only coins batch inside the same budget: 6 converting pokes a transaction at 15M, 4 at 10M, 33 forward-only; the claims fill the first transactions", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
    const due = (n: number): Piles => ({
      pile: Object.fromEntries(ids(n).map((i) => [i, 5n])),
    });
    const t = setup(10, due(10), { ...NONE, held: ids(10) });
    const all = await t.build();
    expect(all.txs.map((x) => x.gas)).toEqual([
      base + 6n * perConvertPoke,
      base + 4n * perConvertPoke,
    ]);
    expect(base + 6n * perConvertPoke).toBe(13_560_000n);
    expect(all.txs.map((x) => aggregate(x.data))).toEqual([
      t.launches.slice(0, 6).map((l) => pokeCall(l.poolId)),
      t.launches.slice(6).map((l) => pokeCall(l.poolId)),
    ]);
    expect((await t.build(10_000_000n)).txs.map((x) => x.gas)).toEqual([
      base + 4n * perConvertPoke,
      base + 4n * perConvertPoke,
      base + 2n * perConvertPoke,
    ]);
    const forward = await setup(
      40,
      { ...due(40), mode: 1 },
      { ...NONE, held: ids(40) },
    ).build();
    expect(forward.txs.map((x) => x.gas)).toEqual([
      base + 33n * perPoke,
      base + 7n * perPoke,
    ]);
    expect(base + 33n * perPoke).toBe(14_760_000n);
    // Coins 8 and 9 earn and are due, the other eight are poke-only: both claims ride the first transaction.
    const m = setup(10, due(10), { earning: [8, 9], held: ids(8) });
    const mixed = await m.build();
    const order = [8, 9, 0, 1, 2, 3, 4, 5, 6, 7].map((i) => m.launches[i]!);
    expect(mixed.coins.map((c) => c.token)).toEqual(order.map((l) => l.token));
    expect(mixed.txs.map((x) => x.gas)).toEqual([
      base + 2n * (perCoin + perConvertPoke) + 3n * perConvertPoke,
      base + 5n * perConvertPoke,
    ]);
    expect(aggregate(mixed.txs[0]!.data)).toEqual([
      claimCall(m.launches[8]!.distributor),
      claimCall(m.launches[9]!.distributor),
      ...order.slice(0, 5).map((l) => pokeCall(l.poolId)),
    ]);
    // A budget that cannot hold one converting poke plans nothing rather than a transaction that cannot land.
    let refused: unknown;
    try {
      await t.build(base + perConvertPoke - 1n);
    } catch (err) {
      refused = err;
    }
    expect(isLaunchSdkError(refused, "INVALID_PARAMS")).toBe(true);
    expect((refused as { detail?: string }).detail).toBe(
      "maxGasPerTx is under the 3,560,000 gas one of these coins needs: its claim where it has rewards, and the poke of its holders' pile where one is due.",
    );
  });

  test("a contract account that has earned nothing sends the due pokes alone, each at the convert action's limit", async () => {
    const t = setup(2, { pile: { 0: 5n, 1: 4n } }, { ...NONE, held: [0, 1] });
    t.f.fake.setCode(OTHER, "0x6080");
    const all = await t.build();
    expect(all.mode).toBe("direct");
    expect(all.txs.map((x) => [x.to, x.gas, x.data])).toEqual([
      [COIN_LEG, CONVERT_GAS, pokeCall(t.launches[0]!.poolId).callData],
    ]);
  });
});
