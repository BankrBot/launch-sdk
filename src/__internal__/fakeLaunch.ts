// Test-only: a launched coin on fake contracts (factory record, ledger buckets, hook lens, distributor, escrow, the
// token itself and the holder leg its launch froze), so the post-launch reads and builders run through viem's real
// encode and decode. Shipped with the public tests' fakes.
import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type AbiParameter,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import {
  bankrFeeLedgerAbi,
  bankrHookLensAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  creatorVestingEscrowAbi,
  holderRewardsDeployerAbi,
  holderRewardsDistributorAbi,
} from "../abis/generated.js";
import { bnkrHolderLegAbi } from "../abis/settings.js";
import { createLaunchClient, type LaunchApiOptions } from "../client.js";
import { placeCurve } from "../curve.js";
import { LOCKER_POSITIONS_FRAGMENT } from "../curveRead.js";
import {
  DEFAULT_TOTAL_SUPPLY,
  DYNAMIC_FEE,
  TICK_SPACING,
} from "../economics.js";
import { HOOK_LENS_FRAGMENT, bucketIds } from "../lens.js";
import { poolIdOf } from "../plan.js";
import { predictEscrow, predictToken } from "../predict.js";
import type { CoinTerms } from "../launch/settings.js";
import { FakeChain, Revert, eventLog, type RpcLog } from "./fakeRpc.js";
import {
  CAP_CONTROLLER,
  fakeAddress,
  fakeDistributor,
  livePointersOf,
  type RecordFixture,
} from "./fakeRecord.js";
import { installContracts, type ContractsFixture } from "./fakeContracts.js";
import { FRESH_QUOTE } from "./fakeContractsState.js";

export const HOOK_LENS = fakeAddress(0x8a10);
export const LAUNCHER = getAddress(
  "0x1111111111111111111111111111111111111111",
);
export const OTHER = getAddress("0x2222222222222222222222222222222222222222");
export const FAKE_BNKR = fakeAddress(0xb4b4);

/** The leg the fixture's coins froze at launch: not the one the record names for launches from now on. */
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

/** What a launched token is installed on: the fake contracts, with the factory's record of each coin's terms. */
export type LaunchFixture = RecordFixture &
  Partial<Pick<ContractsFixture, "termsHashes">>;

/**
 * Fake contracts on Base and a client over them. `launch` installs a coin on the fixture's quote (its WETH) whose
 * holders' bucket is the coin leg's alone; post-launch reads work whether or not launches are open. `api` points
 * the client's Bankr API at a fake fetch; `fork` makes it a fork client.
 */
export function postLaunchFixture(
  o: { api?: LaunchApiOptions; fork?: boolean } = {},
) {
  const s4 = installContracts(new FakeChain(base));
  const { fake, deployment } = s4;
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
  fake.contract(deployment.ledger, bankrFeeLedgerAbi as Abi, {
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
  /** Overrides one function of the factory or the ledger: `set("factory", "paused", true)`. */
  const set = (contract: "factory" | "ledger", fn: string, value: unknown) =>
    contract === "factory"
      ? fake.contract(deployment.factory, bankrLaunchFactoryAbi as Abi, {
          [fn]: value,
        })
      : fake.contract(deployment.ledger, bankrFeeLedgerAbi as Abi, {
          [fn]: value,
        });
  const f = Object.assign(s4, { set });
  launchesOf(f);
  const client = createLaunchClient({
    chain: "base",
    addresses: deployment,
    publicClient: fake.publicClient(),
    api: o.api,
    fork: o.fork,
  });
  return {
    f,
    s4,
    leg,
    client,
    /** A coin on the fixture's quote (its WETH), whose holders' pile waits at the coin leg. */
    launch(input: Omit<FakeLaunchInput, "quote">): FakeLaunch {
      return installLaunch(f, { ...input, quote: s4.quote });
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

/** The quote a fixture's coins pair with by default: its WETH. */
export const WETH = FRESH_QUOTE;
/** The record every fixture's contracts answer at: the same addresses on each fresh chain. */
export const SUITE = installContracts(new FakeChain(base)).deployment;

const resolveFn = bankrLaunchSettingsAbi.find(
  (e) => e.type === "function" && e.name === "resolve",
);
const COIN_TERMS_PARAM = (
  resolveFn?.type === "function" ? resolveFn.outputs[0] : undefined
) as AbiParameter;

/** The zero value of an ABI type: every number 0, every address and word zero, every list empty. */
function zeroOf(p: AbiParameter): unknown {
  if (p.type.endsWith("]")) return [];
  if (p.type === "tuple")
    return Object.fromEntries(
      (p as { components: readonly AbiParameter[] }).components.map((c) => [
        c.name,
        zeroOf(c),
      ]),
    );
  if (p.type === "address") return zeroAddress;
  if (p.type === "bool") return false;
  if (p.type === "bytes32") return zeroHash;
  if (p.type === "bytes") return "0x";
  if (p.type === "string") return "";
  const bits = Number(/^u?int(\d+)$/.exec(p.type)?.[1] ?? 256);
  return bits <= 48 ? 0 : 0n;
}

/** The wallet cap every fake coin is built with: 2 % of its supply for a day, ended only by `CAP_CONTROLLER`. */
const FAKE_TOKEN_TERMS = Object.freeze({
  totalSupply: DEFAULT_TOTAL_SUPPLY,
  capAmount: (DEFAULT_TOTAL_SUPPLY * 200n) / 10_000n,
  capSecs: 86_400,
  capController: CAP_CONTROLLER,
});

/** The record a fake coin's launch froze: its supply and cap, its shares and its takeover, everything else zero. */
export const fakeCoinTerms = (
  l: Pick<FakeLaunch, "holdersBps" | "launchpadId" | "schedules">,
): CoinTerms => ({
  ...(zeroOf(COIN_TERMS_PARAM) as CoinTerms),
  ...FAKE_TOKEN_TERMS,
  holdersBps: l.holdersBps,
  vestBps: l.schedules.some((s) => !s.push) ? 1_500 : 0,
  takeover: l.launchpadId === 0n,
});

const coinTermsBytes = (t: CoinTerms): Hex =>
  encodeAbiParameters([COIN_TERMS_PARAM], [t]);

const ledgerBalances = new WeakMap<object, Map<string, bigint>>();

/** The ledger's `balances(account, currency)` on `f`'s contracts (referral slices and settled shares). */
export function setLedgerBalance(
  f: LaunchFixture,
  account: Address,
  currency: Address,
  amount: bigint,
): void {
  balancesOf(f).set(`${lower(account)}:${lower(currency)}`, amount);
}

function balancesOf(f: LaunchFixture): Map<string, bigint> {
  let m = ledgerBalances.get(f.fake);
  if (!m) {
    m = new Map();
    ledgerBalances.set(f.fake, m);
  }
  return m;
}

export interface FakeSchedule {
  beneficiary: Address;
  total: bigint;
  released: bigint;
  cliff: bigint;
  duration: bigint;
  push: boolean;
  /** What `computeAvailableVestedAmount` / `computePushableAmount` answers for this beneficiary. */
  available: bigint;
}

export interface FakeBucketShare {
  account: Address;
  sharesWad: bigint;
  creatorShareWad?: bigint;
}

export interface FakeLaunchInput {
  launcher: Address;
  quote: Address;
  name?: string;
  symbol?: string;
  metadataUri?: string;
  /** Default the zero address: nobody. */
  metadataAdmin?: Address;
  salt?: Hex;
  launchpadId?: bigint;
  /** Creator-bucket beneficiaries and their WAD shares; default the launcher alone. `creatorShareWad` is the entry's
   *  creator part (`creatorShareOf`): default its whole share when `creators` names it, else 0. */
  creatorShares?: FakeBucketShare[];
  /** A decay bucket (Bankr's pad) with these shares. */
  decayShares?: FakeBucketShare[];
  /** The launch's fee recipients, the entries holding a creator part on every pad; default the launcher. */
  creators?: readonly Address[];
  schedules?: FakeSchedule[];
  /** Vest-to-holders: a push schedule after `schedules`, to the launch's own distributor. */
  holderVest?: { total: bigint; available: bigint };
  referrerBps?: number;
  holdersBps?: number;
  /** `LaunchParams.curveId`: a built-in's id or the launch's own bands. Default 0n. */
  curve?: bigint;
  /** The launch's start tick, as quote per token. Default -200,000. */
  startTick?: number;
  /** What the launch sold into its bands. Default 85 B tokens. */
  sale?: bigint;
  /** Positions the hook's compounds added to the locker after launch. */
  compounds?: { lower: number; upper: number; liquidity: bigint }[];
}

export interface FakeLaunch {
  token: Address;
  poolId: Hex;
  tokenIsCurrency0: boolean;
  launcher: Address;
  quote: Address;
  name: string;
  symbol: string;
  metadataUri: string;
  metadataAdmin: Address;
  salt: Hex;
  launchpadId: bigint;
  distributor: Address;
  escrow: Address | null;
  schedules: FakeSchedule[];
  holdersBps: number;
  referrerBps: number;
  curve: bigint;
  startTick: number;
  sale: bigint;
  compounds: { lower: number; upper: number; liquidity: bigint }[];
  /** Ledger state, keyed `bucket:account` (lowercase): [fees0, fees1] claimable and WAD shares. */
  claimable: Map<string, readonly [bigint, bigint]>;
  shares: Map<string, bigint>;
  /** The ledger's creator part per `bucket:account` (`creatorShareOf`); an entry without one is no fee recipient's. */
  creatorParts: Map<string, bigint>;
  /** Per bucket: [cumulated0, cumulated1]; per `bucket:account`: its [lastCumulated0, lastCumulated1]. Default 0. */
  cumulated: Map<string, readonly [bigint, bigint]>;
  checkpoints: Map<string, readonly [bigint, bigint]>;
  /** Distributor `rewardExcluded`, per lowercase account. */
  excluded: Set<string>;
  /** Distributor `earned(leg, account)`, keyed `leg:account`. */
  earned: Map<string, bigint>;
  /** Distributor `bnkrEpoch()`: the open BNKR epoch and the token it drains into (0 when steady). */
  bnkrEpoch: [bigint, Address];
  /** Distributor `pastBnkr(epoch, account)`, keyed `epoch:account`: [epoch token, owed, claimable]. */
  pastBnkr: Map<string, readonly [Address, bigint, bigint]>;
  /** Token reads per lowercase account. */
  balances: Map<string, bigint>;
  bnkr: Address;
  /** The holder leg the coin keeps for life and the ledger's id for it, and Bankr's own part waived. */
  leg: Address;
  legId: number;
  waived: boolean;
  /** The pool's init second, as the hook's lens reports it. */
  initTimestamp: number;
  /** The lens's `extSwapGasHeadroom(poolId, pins)`; 0 for a pool without an extension (the default). */
  extSwapGasHeadroom: (pins: bigint) => bigint;
  /** Token overrides: `setToken(fn, value)`. */
  setToken(fn: string, value: unknown): void;
}

const lower = (a: string): string => a.toLowerCase();
const registries = new WeakMap<object, Map<string, FakeLaunch>>();

/** Every launch installed on a fixture, keyed by lowercase token. */
function launchesOf(f: LaunchFixture): Map<string, FakeLaunch> {
  let m = registries.get(f.fake);
  if (!m) {
    m = new Map();
    registries.set(f.fake, m);
    installReaders(f, m);
  }
  return m;
}

function installReaders(f: LaunchFixture, launches: Map<string, FakeLaunch>) {
  const { fake, deployment } = f;
  const get = (token: unknown) => launches.get(lower(String(token)));
  const byPool = (poolId: unknown) =>
    [...launches.values()].find((l) => l.poolId === poolId);
  const key = (l: FakeLaunch) => ({
    currency0: l.tokenIsCurrency0 ? l.token : l.quote,
    currency1: l.tokenIsCurrency0 ? l.quote : l.token,
    fee: DYNAMIC_FEE,
    tickSpacing: TICK_SPACING,
    hooks: deployment.hook,
  });
  const noKey = {
    currency0: zeroAddress,
    currency1: zeroAddress,
    fee: 0,
    tickSpacing: 0,
    hooks: zeroAddress,
  };
  fake.contract(deployment.factory, bankrLaunchFactoryAbi as Abi, {
    poolOf: ([t]: readonly unknown[]) => {
      const l = get(t);
      return l ? [l.poolId, key(l)] : [`0x${"00".repeat(32)}`, noKey];
    },
    launcherOf: ([t]: readonly unknown[]) => get(t)?.launcher ?? zeroAddress,
    vestingEscrowOf: ([t]: readonly unknown[]) => get(t)?.escrow ?? zeroAddress,
  });
  fake.contract(
    deployment.holderRewardsDeployer,
    holderRewardsDeployerAbi as Abi,
    {
      distributorOfToken: ([t]: readonly unknown[]) =>
        get(t)?.distributor ?? zeroAddress,
    },
  );
  fake.contract(
    deployment.launchpadRegistry,
    bankrLaunchpadRegistryAbi as Abi,
    {
      // A token the contracts never launched reverts UnknownLaunch, never reads as id 0.
      launchpadOf: ([t]: readonly unknown[]) => {
        const l = get(t);
        if (!l) throw new Revert("UnknownLaunch", []);
        return l.launchpadId;
      },
    },
  );
  const bucketsOf = (bucket: unknown) =>
    [...launches.values()].find((l) =>
      [
        bucketIds.creator(l.poolId),
        bucketIds.decay(l.poolId),
        bucketIds.holders(l.poolId),
      ].includes(bucket as Hex),
    );
  fake.contract(deployment.ledger, bankrFeeLedgerAbi as Abi, {
    poolTerms: ([poolId]: readonly unknown[]) => {
      const l = byPool(poolId);
      const decay = l
        ? [...l.shares.keys()].some((k) =>
            k.startsWith(bucketIds.decay(l.poolId)),
          )
        : false;
      // FeeMath's T_QUOTE_IS_0 1, T_WAIVED 2, T_DECAY_SPLIT 4.
      return {
        hook: deployment.hook,
        flags:
          (l && !l.tokenIsCurrency0 ? 1 : 0) |
          (l?.waived ? 2 : 0) |
          (decay ? 4 : 0),
        referrerBps: l?.referrerBps ?? 0,
        bankrFeeBps: 1_000,
        bankrMinPips: 250,
        holdersShareBps: 5_000,
        legId: l?.legId ?? 0,
        treasuryWad: 0n,
        treasuryDecayWad: 0n,
        distributor: zeroAddress,
        holderWad: 0n,
      };
    },
    beneficiariesOf: ([bucket]: readonly unknown[]) => {
      const l = bucketsOf(bucket);
      if (!l) return [];
      return [...l.shares.keys()]
        .filter((k) => k.startsWith(`${bucket as string}:`))
        .map((k) => getAddress(k.split(":")[1]!));
    },
    creatorShareOf: ([bucket, a]: readonly unknown[]) =>
      bucketsOf(bucket)?.creatorParts.get(
        `${bucket as string}:${lower(String(a))}`,
      ) ?? 0n,
    creatorCount: ([bucket]: readonly unknown[]) =>
      BigInt(
        [...(bucketsOf(bucket)?.creatorParts ?? [])].filter(
          ([k, part]) => k.startsWith(`${bucket as string}:`) && part > 0n,
        ).length,
      ),
    getShares: ([bucket, a]: readonly unknown[]) =>
      bucketsOf(bucket)?.shares.get(
        `${bucket as string}:${lower(String(a))}`,
      ) ?? 0n,
    claimable: ([bucket, a]: readonly unknown[]) =>
      bucketsOf(bucket)?.claimable.get(
        `${bucket as string}:${lower(String(a))}`,
      ) ?? [0n, 0n],
    bucketOf: ([bucket]: readonly unknown[]) => {
      const l = bucketsOf(bucket);
      if (!l) return [`0x${"00".repeat(32)}`, zeroAddress, zeroAddress, false];
      const k = key(l);
      return [l.poolId, k.currency0, k.currency1, true];
    },
    getCumulatedFees0: ([bucket]: readonly unknown[]) =>
      bucketsOf(bucket)?.cumulated.get(bucket as string)?.[0] ?? 0n,
    getCumulatedFees1: ([bucket]: readonly unknown[]) =>
      bucketsOf(bucket)?.cumulated.get(bucket as string)?.[1] ?? 0n,
    getLastCumulatedFees0: ([bucket, a]: readonly unknown[]) =>
      bucketsOf(bucket)?.checkpoints.get(
        `${bucket as string}:${lower(String(a))}`,
      )?.[0] ?? 0n,
    getLastCumulatedFees1: ([bucket, a]: readonly unknown[]) =>
      bucketsOf(bucket)?.checkpoints.get(
        `${bucket as string}:${lower(String(a))}`,
      )?.[1] ?? 0n,
    balances: ([a, c]: readonly unknown[]) =>
      balancesOf(f).get(`${lower(String(a))}:${lower(String(c))}`) ?? 0n,
  });
  fake.contract(deployment.hook, HOOK_LENS_FRAGMENT, { hookLens: HOOK_LENS });
  fake.contract(HOOK_LENS, bankrHookLensAbi as Abi, {
    poolConfig: ([poolId]: readonly unknown[]) => {
      const l = byPool(poolId);
      const sched = { startPips: 17_500, steadyPips: 17_500, decaySecs: 0 };
      // The pool's own rules after `openTick`, and a compound floor on each schedule.
      const own = {
        floorTick: -887_220,
        edgeTick: 887_220,
        refTauSecs: 1_800,
        buy: { ...sched, compoundFloor: 10n ** 17n },
        sell: { ...sched, compoundFloor: 10n ** 17n },
        works: {
          compoundCap: 2n * 10n ** 17n,
          compoundInterval: 300,
          compoundShareBps: 2_500,
          compoundDeviationTicks: 488,
          bandHalfWidth: 34,
          bandGrid: 10,
          swapCapTicks: 50,
        },
        fill: {
          buybackInterval: 300,
          buybackRetry: 60,
          fillTravelTicks: 100,
          fillStartGapTicks: 20,
        },
      };
      return {
        registered: l !== undefined,
        tokenIsCurrency0: l?.tokenIsCurrency0 ?? false,
        initTimestamp: l?.initTimestamp ?? 1,
        // The pool's own tick: a currency1 token's is the negative of its quote-per-token start.
        startTick: l ? (l.tokenIsCurrency0 ? l.startTick : -l.startTick) : 0,
        token: l?.token ?? zeroAddress,
        hasExtension: false,
        decaySplit: false,
        refTick: 0,
        refTs: 0,
        lastCompoundTs: 0,
        creatorLp: true,
        refFrac: 0,
        buybackAt: 0, // no buyback share: no in-swap fill
        openTick: 0,
        heldQuote: 0n,
        heldToken: 0n,
        ...own,
      };
    },
    extSwapGasHeadroom: ([poolId, pins]: readonly unknown[]) =>
      byPool(poolId)?.extSwapGasHeadroom(pins as bigint) ?? 0n,
  });
  // The locker: the launch's bands at salt keccak256("launch", i), then one position per compound band.
  fake.contract(deployment.locker, LOCKER_POSITIONS_FRAGMENT, {
    positionsOf: ([poolId]: readonly unknown[]) => {
      const l = byPool(poolId);
      if (!l) return [];
      const bands = placeCurve({
        curve: l.curve,
        startTick: l.startTick,
        tokenIsCurrency0: l.tokenIsCurrency0,
        sale: l.sale,
      });
      return [
        ...bands.map((b, i) => ({
          lower: b.lower,
          upper: b.upper,
          salt: keccak256(
            encodePacked(["string", "uint256"], ["launch", BigInt(i)]),
          ),
          liquidity: b.liquidity,
        })),
        ...l.compounds.map((c) => ({
          ...c,
          salt: keccak256(
            encodePacked(
              ["string", "int24", "int24"],
              ["compound", c.lower, c.upper],
            ),
          ),
        })),
      ];
    },
  });
}

/**
 * A token launched through `f`'s contracts, as they would report it: the factory's record, ledger buckets with the
 * given shares, the hook's pool, the distributor, the escrow, the token and the holder leg its launch froze. The
 * token's address is the prediction for `launcher` and `salt` under the coin's own terms.
 */
export function installLaunch(
  f: LaunchFixture,
  input: FakeLaunchInput,
): FakeLaunch {
  const { fake, deployment } = f;
  const live = livePointersOf(deployment);
  const launches = launchesOf(f);
  const name = input.name ?? "Launch SDK Test";
  const symbol = input.symbol ?? "LSDK";
  const metadataUri = input.metadataUri ?? "ipfs://bafy-test";
  const salt = input.salt ?? keccak256(toHex(`salt-${launches.size}`));
  const identity = {
    name,
    symbol,
    metadataUri,
    metadataAdmin: input.metadataAdmin ?? zeroAddress,
    capExclusions: [],
    terms: FAKE_TOKEN_TERMS,
  };
  const token = predictToken(live, identity, input.launcher, salt);
  const { poolId, tokenIsCurrency0 } = poolIdOf(
    token,
    input.quote,
    deployment.hook,
  );
  const distributor = fakeDistributor(token);
  const schedules = [...(input.schedules ?? [])];
  if (input.holderVest) {
    schedules.push({
      beneficiary: distributor,
      total: input.holderVest.total,
      released: 0n,
      cliff: 30n * 86_400n,
      duration: 365n * 86_400n,
      push: true,
      available: input.holderVest.available,
    });
  }
  const escrow =
    schedules.length > 0 ? predictEscrow(live, input.launcher, salt) : null;
  const shares = new Map<string, bigint>();
  const creatorParts = new Map<string, bigint>();
  const creators = (input.creators ?? [input.launcher]).map(lower);
  const put = (bucket: Hex, s: FakeBucketShare) => {
    const k = `${bucket}:${lower(s.account)}`;
    shares.set(k, s.sharesWad);
    const part =
      s.creatorShareWad ??
      (creators.includes(lower(s.account)) ? s.sharesWad : 0n);
    if (part > 0n) creatorParts.set(k, part);
  };
  for (const s of input.creatorShares ?? [
    { account: input.launcher, sharesWad: 10n ** 18n },
  ])
    put(bucketIds.creator(poolId), s);
  for (const s of input.decayShares ?? []) put(bucketIds.decay(poolId), s);
  // The holders' bucket has one beneficiary, locked for life: the leg of the coin's launch.
  shares.set(`${bucketIds.holders(poolId)}:${lower(COIN_LEG)}`, 10n ** 18n);
  const launch: FakeLaunch = {
    token,
    poolId,
    tokenIsCurrency0,
    launcher: input.launcher,
    quote: getAddress(input.quote),
    name,
    symbol,
    metadataUri,
    metadataAdmin: identity.metadataAdmin,
    salt,
    launchpadId: input.launchpadId ?? 1n,
    distributor,
    escrow,
    schedules,
    holdersBps: input.holdersBps ?? 0,
    referrerBps: input.referrerBps ?? 0,
    curve: input.curve ?? 0n,
    startTick: input.startTick ?? -200_000,
    sale: input.sale ?? 85n * 10n ** 27n,
    compounds: input.compounds ?? [],
    claimable: new Map(),
    shares,
    creatorParts,
    cumulated: new Map(),
    checkpoints: new Map(),
    excluded: new Set(),
    earned: new Map(),
    bnkrEpoch: [0n, zeroAddress],
    pastBnkr: new Map(),
    balances: new Map(),
    bnkr: FAKE_BNKR,
    leg: COIN_LEG,
    legId: COIN_LEG_ID,
    waived: false,
    initTimestamp: 1,
    extSwapGasHeadroom: () => 0n,
    setToken: (fn, value) => {
      const entry = fake.contracts.get(lower(token));
      if (entry) entry.fns[fn] = value;
    },
  };
  launches.set(lower(token), launch);
  f.termsHashes?.set(
    lower(token),
    keccak256(coinTermsBytes(fakeCoinTerms(launch))),
  );
  fake.contract(token, bankrLaunchTokenAbi as Abi, {
    // The link's limit is the coin's own.
    metadataMaxBytes: 2_048,
    name,
    symbol,
    metadataUri,
    metadataAdmin: identity.metadataAdmin,
    pendingMetadataAdmin: zeroAddress,
    tradingStart: 1n,
    decimals: 18,
    totalSupply: FAKE_TOKEN_TERMS.totalSupply,
    maxBalanceLimit: FAKE_TOKEN_TERMS.capAmount,
    capEnd: 1_800_086_400n,
    factory: deployment.factory,
    controller: CAP_CONTROLLER,
    rewardHook: distributor,
    balanceOf: ([a]: readonly unknown[]) =>
      launch.balances.get(lower(String(a))) ?? 0n,
  });
  const legAsset = [token, launch.quote, launch.bnkr] as const;
  fake.contract(distributor, holderRewardsDistributorAbi as Abi, {
    holderLeg: () => launch.leg,
    assetOf: ([leg]: readonly unknown[]) =>
      legAsset[Number(leg)] ?? zeroAddress,
    earned: ([leg, a]: readonly unknown[]) =>
      launch.earned.get(`${String(leg)}:${lower(String(a))}`) ?? 0n,
    rewardExcluded: ([a]: readonly unknown[]) =>
      launch.excluded.has(lower(String(a))),
    bnkrEpoch: () => launch.bnkrEpoch,
    pastBnkr: ([e, a]: readonly unknown[]) =>
      launch.pastBnkr.get(`${String(e)}:${lower(String(a))}`) ?? [
        zeroAddress,
        0n,
        0n,
      ],
  });
  if (escrow) {
    const find = (b: unknown) =>
      schedules.find((s) => lower(s.beneficiary) === lower(String(b)));
    fake.contract(escrow, creatorVestingEscrowAbi, {
      scheduleCount: BigInt(schedules.length),
      scheduleOf: ([i]: readonly unknown[]) => {
        const s = schedules[Number(i)]!;
        return [
          s.beneficiary,
          s.total,
          s.released,
          s.cliff,
          s.duration,
          s.push,
        ];
      },
      vestingStart: 1_000n,
      computeAvailableVestedAmount: ([b]: readonly unknown[]) =>
        schedules
          .filter((s) => lower(s.beneficiary) === lower(String(b)))
          .reduce((a, s) => a + s.available, 0n),
      computePushableAmount: ([b]: readonly unknown[]) => {
        const s = find(b);
        return s?.push ? s.available : 0n;
      },
    });
  }
  return launch;
}

/** A receipt for `l`'s launch: the coin's frozen record, the token's admin, the ledger's creator bucket, the
 *  factory's `TokenLaunched` and `LaunchResolved` (and `TradingScheduled` with a `tradingStart`), plus any
 *  `extraLogs`. `terms` changes the record the launch froze. */
export function launchReceipt(
  f: LaunchFixture,
  l: FakeLaunch,
  o: {
    extraLogs?: RpcLog[];
    from?: Address;
    startTick?: number;
    devBuyOut?: bigint;
    tradingStart?: bigint;
    terms?: Partial<CoinTerms>;
  } = {},
): TransactionReceipt {
  const creatorId = bucketIds.creator(l.poolId);
  const held = [...l.shares].filter(([k]) => k.startsWith(`${creatorId}:`));
  const terms = { ...fakeCoinTerms(l), ...o.terms };
  const bytes = coinTermsBytes(terms);
  const logs = [
    eventLog(
      bankrLaunchFactoryAbi,
      "CoinTermsFrozen",
      {
        token: l.token,
        poolId: l.poolId,
        termsHash: keccak256(bytes),
        resolvedHash: zeroHash,
        terms: bytes,
      },
      f.deployment.factory,
    ),
    eventLog(
      bankrLaunchTokenAbi,
      "MetadataAdminSet",
      { from: zeroAddress, to: l.metadataAdmin },
      l.token,
    ),
    eventLog(
      bankrFeeLedgerAbi,
      "BucketRegistered",
      {
        bucketId: creatorId,
        poolId: l.poolId,
        beneficiaries: held.map(([k]) => getAddress(k.split(":")[1]!)),
        shares: held.map(([, v]) => v),
      },
      f.deployment.ledger,
    ),
    eventLog(
      bankrFeeLedgerAbi,
      "CreatorShares",
      {
        bucketId: creatorId,
        creatorShares: held.map(([k]) => l.creatorParts.get(k) ?? 0n),
        takeover: terms.takeover,
        notice: terms.ctoNotice,
        grace: terms.ctoGrace,
      },
      f.deployment.ledger,
    ),
    ...(o.tradingStart === undefined
      ? []
      : [
          eventLog(
            bankrLaunchFactoryAbi,
            "TradingScheduled",
            { token: l.token, poolId: l.poolId, startTime: o.tradingStart },
            f.deployment.factory,
          ),
        ]),
    eventLog(
      bankrLaunchFactoryAbi,
      "TokenLaunched",
      {
        token: l.token,
        launcher: l.launcher,
        quote: l.quote,
        poolId: l.poolId,
        startTick: o.startTick ?? l.startTick,
        metadataUri: l.metadataUri,
        launchpadId: l.launchpadId,
      },
      f.deployment.factory,
    ),
    eventLog(
      bankrLaunchFactoryAbi,
      "LaunchResolved",
      {
        token: l.token,
        curveId: l.curve,
        distributor: l.distributor,
        vestingEscrow: l.escrow ?? zeroAddress,
        vestingRecipient: l.launcher,
        devBuyOut: o.devBuyOut ?? 0n,
      },
      f.deployment.factory,
    ),
    ...(o.extraLogs ?? []),
  ];
  const hash = keccak256(toHex(`receipt-${l.token}`));
  return {
    blockHash: keccak256(toHex("block")),
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n,
    from: o.from ?? l.launcher,
    gasUsed: 1n,
    logs: logs.map((log, i) => ({
      ...log,
      blockHash: keccak256(toHex("block")),
      blockNumber: 100n,
      logIndex: i,
      removed: false,
      transactionHash: hash,
      transactionIndex: 0,
    })),
    logsBloom: `0x${"00".repeat(256)}`,
    status: "success",
    to: f.deployment.factory,
    transactionHash: hash,
    transactionIndex: 0,
    type: "eip1559",
  };
}
