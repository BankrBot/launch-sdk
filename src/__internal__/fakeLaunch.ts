// Test-only: a launched token on a fake v4 suite (factory record, ledger buckets, hook lens, distributor, escrow and
// the token itself), so the post-launch reads and builders run through viem's real encode and decode. Shipped with
// the public tests' fakes (viem and relative imports only).
import {
  encodePacked,
  getAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  bankrFeeLedgerAbi,
  bankrHookLensAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  creatorVestingEscrowAbi,
  holderRewardsDeployerAbi,
  holderRewardsDistributorAbi,
} from "../abis/suite3.js";
import { base } from "viem/chains";
import { CHAINS } from "../chains/index.js";
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
import { FakeChain, Revert, eventLog, type RpcLog } from "./fakeRpc.js";
import {
  CAP_CONTROLLER,
  fakeAddress,
  fakeDistributor,
  installSuite,
  liveSuiteOf,
  testSuite,
  type SuiteFixture,
} from "./fakeSuite.js";

export const HOOK_LENS = fakeAddress(0x8a10);
export const SUITE = testSuite(8453);
export const WETH = getAddress(CHAINS.base.quotes.WETH.address);
export const LAUNCHER = getAddress(
  "0x1111111111111111111111111111111111111111",
);
export const OTHER = getAddress("0x2222222222222222222222222222222222222222");

/**
 * A Base suite and a client over it (post-launch reads work whether or not the chain is deployed). `api` points the
 * client's Bankr API at a fake fetch; `fork` makes it a fork client.
 */
export function postLaunchFixture(
  o: { api?: LaunchApiOptions; fork?: boolean } = {},
) {
  const f = installSuite(new FakeChain(base), SUITE, {
    [WETH]: { decimals: 18 },
  });
  launchesOf(f);
  const client = createLaunchClient({
    chain: "base",
    addresses: SUITE,
    publicClient: f.fake.publicClient(),
    api: o.api,
    fork: o.fork,
  });
  return { f, client };
}

const ledgerBalances = new WeakMap<object, Map<string, bigint>>();

/** The ledger's `balances(account, currency)` on `f`'s suite (referral slices and settled shares). */
export function setLedgerBalance(
  f: SuiteFixture,
  account: Address,
  currency: Address,
  amount: bigint,
): void {
  balancesOf(f).set(`${lower(account)}:${lower(currency)}`, amount);
}

function balancesOf(f: SuiteFixture): Map<string, bigint> {
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
  /** The lens's `extSwapGasHeadroom(poolId, pins)`; 0 for a pool without an extension (the default). */
  extSwapGasHeadroom: (pins: bigint) => bigint;
  /** Token overrides: `setToken(fn, value)`. */
  setToken(fn: string, value: unknown): void;
}

const lower = (a: string): string => a.toLowerCase();
const registries = new WeakMap<object, Map<string, FakeLaunch>>();
export const FAKE_BNKR = fakeAddress(0xb4b4);

/** Every launch installed on a fixture, keyed by lowercase token. */
function launchesOf(f: SuiteFixture): Map<string, FakeLaunch> {
  let m = registries.get(f.fake);
  if (!m) {
    m = new Map();
    registries.set(f.fake, m);
    installReaders(f, m);
  }
  return m;
}

function installReaders(f: SuiteFixture, launches: Map<string, FakeLaunch>) {
  const { fake, suite } = f;
  const get = (token: unknown) => launches.get(lower(String(token)));
  const byPool = (poolId: unknown) =>
    [...launches.values()].find((l) => l.poolId === poolId);
  const key = (l: FakeLaunch) => ({
    currency0: l.tokenIsCurrency0 ? l.token : l.quote,
    currency1: l.tokenIsCurrency0 ? l.quote : l.token,
    fee: DYNAMIC_FEE,
    tickSpacing: TICK_SPACING,
    hooks: suite.hook,
  });
  const noKey = {
    currency0: zeroAddress,
    currency1: zeroAddress,
    fee: 0,
    tickSpacing: 0,
    hooks: zeroAddress,
  };
  fake.contract(suite.factory, bankrLaunchFactoryAbi, {
    poolOf: ([t]: readonly unknown[]) => {
      const l = get(t);
      return l ? [l.poolId, key(l)] : [`0x${"00".repeat(32)}`, noKey];
    },
    launcherOf: ([t]: readonly unknown[]) => get(t)?.launcher ?? zeroAddress,
    vestingEscrowOf: ([t]: readonly unknown[]) => get(t)?.escrow ?? zeroAddress,
  });
  fake.contract(suite.holderRewardsDeployer, holderRewardsDeployerAbi, {
    distributorOfToken: ([t]: readonly unknown[]) =>
      get(t)?.distributor ?? zeroAddress,
  });
  fake.contract(suite.launchpadRegistry, bankrLaunchpadRegistryAbi, {
    // Batch F: a token the suite never launched reverts UnknownLaunch, never reads as id 0.
    launchpadOf: ([t]: readonly unknown[]) => {
      const l = get(t);
      if (!l) throw new Revert("UnknownLaunch", []);
      return l.launchpadId;
    },
  });
  const bucketsOf = (bucket: unknown) =>
    [...launches.values()].find((l) =>
      [bucketIds.creator(l.poolId), bucketIds.decay(l.poolId)].includes(
        bucket as Hex,
      ),
    );
  fake.contract(suite.ledger, bankrFeeLedgerAbi, {
    poolTerms: ([poolId]: readonly unknown[]) => {
      const l = byPool(poolId);
      const decay = l
        ? [...l.shares.keys()].some((k) =>
            k.startsWith(bucketIds.decay(l.poolId)),
          )
        : false;
      return {
        hook: suite.hook,
        quoteIs0: l ? !l.tokenIsCurrency0 : false,
        waived: false,
        decaySplit: decay,
        referrerBps: l?.referrerBps ?? 0,
        treasuryCut: false,
        holderIntake: false,
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
  fake.contract(suite.hook, HOOK_LENS_FRAGMENT, { hookLens: HOOK_LENS });
  fake.contract(HOOK_LENS, bankrHookLensAbi, {
    poolConfig: ([poolId]: readonly unknown[]) => {
      const l = byPool(poolId);
      const sched = { startPips: 17_500, steadyPips: 17_500, decaySecs: 0 };
      return {
        registered: l !== undefined,
        tokenIsCurrency0: l?.tokenIsCurrency0 ?? false,
        initTimestamp: 1,
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
        buybackAt: 0, // no buyback share: no in-swap fill (decision 3)
        openTick: 0,
        heldQuote: 0n,
        heldToken: 0n,
        buy: sched,
        sell: sched,
      };
    },
    extSwapGasHeadroom: ([poolId, pins]: readonly unknown[]) =>
      byPool(poolId)?.extSwapGasHeadroom(pins as bigint) ?? 0n,
  });
  // The locker: the launch's bands at salt keccak256("launch", i), then one position per compound band.
  fake.contract(suite.locker, LOCKER_POSITIONS_FRAGMENT, {
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
 * A token launched through `f`'s suite, as its contracts would report it: the factory's record, ledger buckets with
 * the given shares, the hook's pool, the distributor, the escrow and the token. The token's address is the suite's
 * prediction for `launcher` and `salt`, so the invariant checks can hold it to its receipt.
 */
export function installLaunch(
  f: SuiteFixture,
  input: FakeLaunchInput,
): FakeLaunch {
  const { fake, suite } = f;
  const live = liveSuiteOf(suite);
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
    totalSupply: 0n,
    capExclusions: [],
  };
  const token = predictToken(live, identity, input.launcher, salt);
  const { poolId, tokenIsCurrency0 } = poolIdOf(token, input.quote, suite.hook);
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
    extSwapGasHeadroom: () => 0n,
    setToken: (fn, value) => {
      const entry = fake.contracts.get(lower(token));
      if (entry) entry.fns[fn] = value;
    },
  };
  launches.set(lower(token), launch);
  // The ledger's registrations, so a log scan finds every beneficiary.
  for (const bucket of [bucketIds.creator(poolId), bucketIds.decay(poolId)]) {
    const held = [...shares].filter(([k]) => k.startsWith(`${bucket}:`));
    if (held.length === 0) continue;
    fake.addLog(
      eventLog(
        bankrFeeLedgerAbi,
        "BucketRegistered",
        {
          bucketId: bucket,
          poolId,
          beneficiaries: held.map(([k]) => getAddress(k.split(":")[1]!)),
          shares: held.map(([, v]) => v),
        },
        suite.ledger,
      ),
    );
    // Entry by entry beside BucketRegistered; only Bankr's pad's creator entries can be taken over.
    if (held.some(([k]) => creatorParts.has(k)))
      fake.addLog(
        eventLog(
          bankrFeeLedgerAbi,
          "CreatorShares",
          {
            bucketId: bucket,
            creatorShares: held.map(([k]) => creatorParts.get(k) ?? 0n),
            takeover: (input.launchpadId ?? 1n) === 0n,
          },
          suite.ledger,
        ),
      );
  }

  fake.contract(token, bankrLaunchTokenAbi, {
    name,
    symbol,
    metadataUri,
    metadataAdmin: identity.metadataAdmin,
    pendingMetadataAdmin: zeroAddress,
    tradingStart: 1n,
    decimals: 18,
    totalSupply: DEFAULT_TOTAL_SUPPLY,
    maxBalanceLimit: (DEFAULT_TOTAL_SUPPLY * 200n) / 10_000n,
    factory: suite.factory,
    controller: CAP_CONTROLLER,
    rewardHook: distributor,
    balanceOf: ([a]: readonly unknown[]) =>
      launch.balances.get(lower(String(a))) ?? 0n,
  });
  fake.contract(suite.factory, bankrLaunchFactoryAbi, {
    capController: CAP_CONTROLLER,
  });
  const legAsset = [token, launch.quote, launch.bnkr] as const;
  fake.contract(distributor, holderRewardsDistributorAbi, {
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

/** A receipt for `l`'s launch: the token's admin, the ledger's creator bucket, the factory's `TokenLaunched` and
 *  `LaunchResolved` (and `TradingScheduled` with a `tradingStart`), plus any `extraLogs`. */
export function launchReceipt(
  f: SuiteFixture,
  l: FakeLaunch,
  o: {
    extraLogs?: RpcLog[];
    from?: Address;
    startTick?: number;
    devBuyOut?: bigint;
    tradingStart?: bigint;
  } = {},
): TransactionReceipt {
  const creatorId = bucketIds.creator(l.poolId);
  const held = [...l.shares].filter(([k]) => k.startsWith(`${creatorId}:`));
  const logs = [
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
      f.suite.ledger,
    ),
    eventLog(
      bankrFeeLedgerAbi,
      "CreatorShares",
      {
        bucketId: creatorId,
        creatorShares: held.map(([k]) => l.creatorParts.get(k) ?? 0n),
        takeover: l.launchpadId === 0n,
      },
      f.suite.ledger,
    ),
    ...(o.tradingStart === undefined
      ? []
      : [
          eventLog(
            bankrLaunchFactoryAbi,
            "TradingScheduled",
            { token: l.token, poolId: l.poolId, startTime: o.tradingStart },
            f.suite.factory,
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
      f.suite.factory,
    ),
    eventLog(
      bankrLaunchFactoryAbi,
      "LaunchResolved",
      {
        token: l.token,
        curveId: l.curve,
        holdersBps: l.holdersBps,
        distributor: l.distributor,
        vestingEscrow: l.escrow ?? zeroAddress,
        vestingRecipient: l.launcher,
        vestBps: l.schedules.some((s) => !s.push) ? 1_500 : 0,
        totalSupply: DEFAULT_TOTAL_SUPPLY,
        devBuyOut: o.devBuyOut ?? 0n,
      },
      f.suite.factory,
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
    to: f.suite.factory,
    transactionHash: hash,
    transactionIndex: 0,
    type: "eip1559",
  };
}
