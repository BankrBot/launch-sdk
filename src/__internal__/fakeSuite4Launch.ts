// Test-only: launched coins on a fake suite 4, read through a client that names no suite: the factory, ledger, hook
// lens, token and distributor answer in suite 4's encodings, and each coin's holders' pile waits at the leg of its
// own launch, an earlier generation than the record's. Excluded from the build; viem and relative imports only.
import { zeroAddress, type Abi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { bankrFeeLedgerAbi } from "../abis/generated.js";
import { bnkrHolderLegAbi } from "../abis/settings.js";
import { createLaunchClient, type LaunchApiOptions } from "../client.js";
import { bucketIds } from "../lens.js";
import {
  FAKE_BNKR,
  installLaunch,
  type FakeLaunch,
  type FakeLaunchInput,
} from "./fakeLaunch.js";
import { FakeChain } from "./fakeRpc.js";
import { fakeAddress } from "./fakeSuite.js";
import { installSuite4 } from "./fakeSuite4.js";

/** The leg the fixture's coins froze at launch: not the one the suite's record names for launches from now on. */
export const COIN_LEG = fakeAddress(0x1e61);
export const COIN_LEG_ID = 1;

const HOP = {
  tokenOut: FAKE_BNKR,
  v3Pool: fakeAddress(0x1e62),
  v4Key: {
    currency0: zeroAddress,
    currency1: zeroAddress,
    fee: 0,
    tickSpacing: 0,
    hooks: zeroAddress,
  },
};

/** What the coins' leg and the ledger's wake answer; a test changes it between reads. */
export interface FakeCoinLeg {
  payoutMode: number;
  bnkr: Address;
  /** `minPile(quote)`: the pile a pool needs to join its quote's line. */
  minPile: bigint;
  paidInQuote: boolean;
  /** `routeOf(quote)` is this hop, or empty. */
  routed: boolean;
  staleAfter: number;
  /** `ledger.holdersWake(legId, quote)`'s floor; null: unarmed. */
  wakeFloor: bigint | null;
  /** `ledger.windowOf(quote)`. */
  window: [until: number, left: bigint];
  /** Per pool id: the pile staged in the leg, and since when. */
  pending: Map<Hex, readonly [bigint, bigint]>;
}

/**
 * A fake suite 4 on Base and a client over it that names no suite. `launch` installs a coin on the suite's quote
 * whose holders' bucket is the coin leg's alone; post-launch reads work whether or not launches are open.
 */
export function suite4PostLaunchFixture(
  o: { api?: LaunchApiOptions; fork?: boolean } = {},
) {
  const s4 = installSuite4(new FakeChain(base));
  const { fake, suite } = s4;
  const leg: FakeCoinLeg = {
    payoutMode: 0,
    bnkr: FAKE_BNKR,
    minPile: 2n * 10n ** 15n,
    paidInQuote: false,
    routed: true,
    staleAfter: 86_400,
    wakeFloor: 2n * 10n ** 15n,
    window: [0, 0n],
    pending: new Map(),
  };
  fake.contract(COIN_LEG, bnkrHolderLegAbi as Abi, {
    payoutMode: () => leg.payoutMode,
    bnkr: () => leg.bnkr,
    minPile: () => leg.minPile,
    paidInQuote: () => leg.paidInQuote,
    routeOf: () => (leg.routed ? [HOP] : []),
    legTerms: () => ({
      minConvertInterval: 300,
      staleAfter: leg.staleAfter,
      maxRouteFeePips: 10_000,
      referenceGuardSqrtBps: 500,
      fillSlackBps: 100,
      maxImpactBps: 300,
    }),
    pending: ([poolId]: readonly unknown[]) =>
      leg.pending.get(poolId as Hex)?.[0] ?? 0n,
    pendingSince: ([poolId]: readonly unknown[]) =>
      leg.pending.get(poolId as Hex)?.[1] ?? 0n,
  });
  fake.contract(suite.ledger, bankrFeeLedgerAbi as Abi, {
    holdersWake: ([legId]: readonly unknown[]) =>
      legId === COIN_LEG_ID && leg.wakeFloor !== null
        ? (leg.wakeFloor << 160n) | BigInt(COIN_LEG)
        : 0n,
    windowOf: () => leg.window,
    legIdOf: ([a]: readonly unknown[]) =>
      String(a).toLowerCase() === COIN_LEG.toLowerCase() ? COIN_LEG_ID : 0,
    mayClaimFor: true,
    isClaimsCollector: false,
    isProtocolSink: false,
  });
  const f = { fake, suite };
  const client = createLaunchClient({
    chain: "base",
    addresses: suite,
    publicClient: fake.publicClient(),
    api: o.api,
    fork: o.fork,
  });
  return {
    f,
    s4,
    leg,
    client,
    /** A coin on the suite's quote (its WETH), whose holders' pile waits at the coin leg. */
    launch(input: Omit<FakeLaunchInput, "quote">): FakeLaunch {
      const l = installLaunch(f, { ...input, quote: s4.quote });
      l.leg = COIN_LEG;
      l.legId = COIN_LEG_ID;
      // The holders' bucket has one beneficiary, locked for life: the leg of the coin's launch.
      l.shares.set(
        `${bucketIds.holders(l.poolId)}:${COIN_LEG.toLowerCase()}`,
        10n ** 18n,
      );
      s4.termsHashes.set(l.token.toLowerCase(), `0x${"7e".repeat(32)}`);
      return l;
    },
    /** The coin's holders' pile waiting in the ledger for its leg, on the quote's side. */
    setPile(l: FakeLaunch, amount: bigint): void {
      l.claimable.set(
        `${bucketIds.holders(l.poolId)}:${COIN_LEG.toLowerCase()}`,
        l.tokenIsCurrency0 ? [0n, amount] : [amount, 0n],
      );
    },
  };
}
