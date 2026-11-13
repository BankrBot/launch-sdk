// Test-only: a v4 suite on a FakeChain (factory, launchpad registry, ledger, distributor deployer), so plans,
// simulations and receipts run through viem's real encode and decode. Shipped with the public tests' fakes.
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  holderRewardsDeployerAbi,
} from "../abis/generated.js";
import type { ProviderAddresses } from "../addresses.js";
import { CHAINS, LAUNCH_CHAINS } from "../chains/index.js";
import { ANY_CURVE, builtInCurveId } from "../curve.js";
import {
  checkCurve,
  checkCurveFormat,
  curveOwnBuys,
  launchSale,
} from "../curveCheck.js";
import { erc20SlotsFor } from "../data/erc20Slots.js";
import {
  DEFAULT_TOTAL_SUPPLY,
  MAX_FEE_RECIPIENTS,
  MAX_START_DELAY_SECS,
  MAX_UNLISTED_START_TICK,
  MIN_START_TICK,
  type LaunchParams,
} from "../economics.js";
import {
  BANKR_PAD_VANITY,
  PAD_TREASURY_MARKER,
  padTermsHash,
  type Launchpad,
  type PadTerms,
} from "../launchpad.js";
import { bucketIds } from "../lens.js";
import { poolIdOf } from "../plan.js";
import { predictEscrow, predictToken, type LiveSuite } from "../predict.js";
import { HOLDER_LEG_WAKE_ABI } from "../conversion.js";
import { HOLDER_LEG_REFERENCES_ABI, isDelegatedEoa } from "../recipient.js";
import { feeRecipientsOf } from "../terms.js";
import {
  FakeChain,
  Revert,
  eventLog,
  type CallContext,
  type RpcLog,
  type SentTx,
} from "./fakeRpc.js";

/** Distinct fake addresses for the parts of a suite. */
export const fakeAddress = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, "0")}`);

/** Dev-buy output per input base unit in the fake launch: a fixed price, so tests can predict `devBuyOut`. */
export const FAKE_TOKENS_PER_UNIT = 1_000n;
export const BANKR_SIGNER = fakeAddress(0xb5);
export const PAD_OPERATOR = fakeAddress(0x0b1);
export const PAD_PAYEE = fakeAddress(0x0b2);
export const FLYWHEEL = fakeAddress(0x0b3);
export const POOL_MANAGER = fakeAddress(0x8a01);
export const CAP_CONTROLLER = fakeAddress(0x8a02);
export const START_TICK_BOUNDS = [-280_000, -120_000] as const;
/** The attested price at which a SIGNED quote's bounds are `START_TICK_BOUNDS`. */
export const FAKE_SIGNED_PRICE = 10n ** 18n;
/** The factory's start-FDV window; a $20K start sits log(10)/log(1.0001) ticks above the lowest bound. */
export const MIN_START_FDV_USD = 2_000n;
/** The fake registry's `registrationBondWei`: 0.01 ETH, Base's configured bond. */
export const FAKE_REGISTRATION_BOND = 10n ** 16n;

/** A complete v4 record for `chainId`, standing in for a broadcast suite (a fork or test override). */
export function testSuite(chainId: number): ProviderAddresses {
  return Object.freeze({
    chainId,
    hook: fakeAddress(0x8001),
    ledger: fakeAddress(0x8002),
    factory: fakeAddress(0x8003),
    locker: fakeAddress(0x8004),
    holderRewardsDeployer: fakeAddress(0x8005),
    tokenDeployer: fakeAddress(0x8006),
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: fakeAddress(0x8007),
    launchpadRegistry: fakeAddress(0x8008),
    presetDeployer: zeroAddress,
    claimsRedeemer: fakeAddress(0x8009),
    launchRegistryLibrary: fakeAddress(0x800a),
    launchEconomicsLibrary: fakeAddress(0x800b),
    launchPoolLibrary: fakeAddress(0x800c),
    ledgerCtoLibrary: fakeAddress(0x8016),
    hookColdLibrary: fakeAddress(0x8017),
    create3Factory: fakeAddress(0x800d),
    deployer: fakeAddress(0x800e),
    owner: fakeAddress(0x800f),
    weth: getAddress(
      (
        CHAINS[
          LAUNCH_CHAINS.find((c) => CHAINS[c].chainId === chainId) ?? "base"
        ].quotes as Readonly<Record<string, { address: Address }>>
      ).WETH?.address ?? fakeAddress(0x8010),
    ),
    treasury: fakeAddress(0x8011),
    holderLeg: fakeAddress(0x8012),
    referenceOracle: fakeAddress(0x8014),
    buyback: fakeAddress(0x8013),
    blockNumber: 1,
    gitCommit: "5f61b77f01a3c2d1e0f9a8b7c6d5e4f3a2b1c0d9",
  });
}

export const liveSuiteOf = (s: ProviderAddresses): LiveSuite => ({
  factory: s.factory,
  tokenDeployer: s.tokenDeployer,
  vestingEscrowImpl: s.vestingEscrowImpl,
  poolManager: POOL_MANAGER,
  locker: s.locker,
  hook: s.hook,
  ledger: s.ledger,
  treasury: s.treasury,
  capController: CAP_CONTROLLER,
  buyback: s.buyback,
});

/** A pad as the fake registry serves it. */
export interface FakePad {
  pad: Launchpad;
  terms: PadTerms;
  metadataUri: string;
  /** Quotes this pad refuses (lowercase); every other factory quote is allowed. */
  refusedQuotes?: string[];
  /** The registry's curve keys the operator flipped: a built-in switched off, bands listed, or the any key opened. */
  curveFlips?: Set<bigint>;
}

/** `setCurveAllowed(id, key, allowed)` as the registry stores it: a built-in is on, and anything else off, until flipped. */
export function setFakeCurveAllowed(
  pad: FakePad,
  key: bigint,
  allowed: boolean,
): void {
  const flips = (pad.curveFlips ??= new Set());
  if (allowed !== key < 3n) flips.add(key);
  else flips.delete(key);
}

const fakeCurveAllowed = (pad: FakePad | undefined, key: bigint): boolean =>
  (pad?.curveFlips?.has(key) ?? false) !== key < 3n;

const policy = (o: Partial<Launchpad["policy"]> = {}): Launchpad["policy"] => ({
  minHoldersBps: 0,
  maxHoldersBps: 10_000,
  minAutoLpBps: 0,
  minVestBps: 0,
  maxVestBps: 5_000,
  allowBuilderLane: true,
  allowedExtensions: 1,
  maxExtensionPips: 0,
  defaultHoldersBps: 1_167,
  defaultAutoLpBps: 3_000,
  defaultVestBps: 0,
  maxVestToHoldersBps: 5_000,
  minVestToHoldersSecs: 86_400n,
  maxBuybackBps: 10_000,
  maxStartDelay: MAX_START_DELAY_SECS,
  ...o,
});

/** Bankr's pad at the 1.75 % preset: signed, `…ba3`, pinned 80 % → 1.75 % over 14 s, a decay split. */
export function bankrPad(): FakePad {
  return {
    pad: {
      operator: fakeAddress(0x800f),
      pendingOperator: zeroAddress,
      signer: BANKR_SIGNER,
      paused: false,
      verified: true,
      allowedQuoteCount: 0,
      vanity: {
        suffix: BANKR_PAD_VANITY.suffix,
        nibbles: BANKR_PAD_VANITY.nibbles,
      },
      feeBounds: {
        minSteadyPips: 17_500,
        maxSteadyPips: 17_500,
        maxStartPips: 800_000,
        maxDecaySecs: 14,
        maxReferrerBps: 500,
      },
      policy: policy({ minAutoLpBps: 3_000, defaultVestBps: 1_500 }),
    },
    terms: {
      payees: [getAddress(PAD_TREASURY_MARKER), FLYWHEEL],
      steadySharesWad: [246_031_746_031_746_032n, 150_793_650_793_650_794n],
      decay: {
        on: true,
        autoLpBps: 10_000,
        sharesWad: [447_089_947_089_947_090n, 251_322_751_322_751_323n],
      },
    },
    metadataUri: "ipfs://bankr-pad",
  };
}

/** What the registry's `getLaunchpad` returns for an id it never registered: a zeroed struct, not a revert. */
const unregisteredPad = (): Launchpad => ({
  operator: zeroAddress,
  pendingOperator: zeroAddress,
  signer: zeroAddress,
  paused: false,
  verified: false,
  allowedQuoteCount: 0,
  vanity: { suffix: 0, nibbles: 0 },
  feeBounds: {
    minSteadyPips: 0,
    maxSteadyPips: 0,
    maxStartPips: 0,
    maxDecaySecs: 0,
    maxReferrerBps: 0,
  },
  policy: policy({
    maxHoldersBps: 0,
    maxVestBps: 0,
    allowBuilderLane: false,
    allowedExtensions: 0,
    defaultHoldersBps: 0,
    defaultAutoLpBps: 0,
    maxVestToHoldersBps: 0,
    minVestToHoldersSecs: 0n,
    maxBuybackBps: 0,
    maxStartDelay: 0,
  }),
});

/** An open third-party pad: no signer, no vanity, 0.05–10 % fees, one payee at 10 % of the remainder. */
export function openPad(
  o: { signer?: Address; vanity?: { suffix: number; nibbles: number } } = {},
): FakePad {
  return {
    pad: {
      operator: PAD_OPERATOR,
      pendingOperator: zeroAddress,
      signer: o.signer ?? zeroAddress,
      paused: false,
      verified: false,
      allowedQuoteCount: 0,
      vanity: o.vanity ?? { suffix: 0, nibbles: 0 },
      feeBounds: {
        minSteadyPips: 500,
        maxSteadyPips: 100_000,
        maxStartPips: 800_000,
        maxDecaySecs: 120,
        maxReferrerBps: 500,
      },
      policy: policy(),
    },
    terms: {
      payees: [PAD_PAYEE],
      steadySharesWad: [10n ** 17n],
      decay: { on: false, autoLpBps: 0, sharesWad: [] },
    },
    metadataUri: "ipfs://open-pad",
  };
}

export interface SuiteFixture {
  fake: FakeChain;
  suite: ProviderAddresses;
  pads: Map<bigint, FakePad>;
  /** Overrides one suite function: `set("factory", "paused", true)`. */
  set(
    contract: "factory" | "registry" | "ledger" | "distributors",
    fn: string,
    value: unknown,
  ): void;
}

export interface FakeQuote {
  decimals: number;
  /** 1 CHAINLINK (default), 2 SIGNED, 0 NONE. */
  pricing?: 0 | 1 | 2;
  /** false: an ERC-20 the factory does not list (any-quote pairing): no entry, no pricing, the protocol's tick range. */
  listed?: boolean;
}

const lower = (a: string) => a.toLowerCase();

/** The distributor the fake deployer predicts for a token: a pure function of it. */
export const fakeDistributor = (token: Address): Address =>
  getAddress(`0x${keccak256(toHex(`distributor:${lower(token)}`)).slice(26)}`);

/**
 * A live-looking v4 suite on `fake`: unpaused and ungated, every listed quote allowed and priced, pads 0 (Bankr's),
 * 1 (open) and 2 (open with a signer and a 1-nibble vanity, so tests mine fast), and a `launch` that deploys the
 * predicted token and buys `FAKE_TOKENS_PER_UNIT` per quote base unit.
 */
export function installSuite(
  fake: FakeChain,
  suite: ProviderAddresses,
  quotes: Record<string, FakeQuote>,
  options: { pads?: Map<bigint, FakePad>; padSigner?: Address } = {},
): SuiteFixture {
  const live = liveSuiteOf(suite);
  const pads =
    options.pads ??
    new Map<bigint, FakePad>([
      [0n, bankrPad()],
      [1n, openPad()],
      [
        2n,
        openPad({
          signer: options.padSigner ?? fakeAddress(0x5161),
          vanity: { suffix: 0xa, nibbles: 1 },
        }),
      ],
    ]);
  const byAddress = Object.fromEntries(
    Object.entries(quotes).map(([a, v]) => [lower(a), v]),
  );
  const q = (a: unknown) => byAddress[lower(String(a))];
  const listed = (a: unknown) => {
    const v = q(a);
    return v !== undefined && v.listed !== false;
  };
  // LaunchEconomics.startTickBounds: a SIGNED quote's follow its attestation (none is StartPriceUnavailable), each
  // 0.01 % of price above FAKE_SIGNED_PRICE one tick lower; a feed's are fixed here.
  const boundsOf = (
    a: unknown,
    attested?: unknown,
  ): readonly [number, number] => {
    if (!listed(a)) return [MIN_START_TICK, MAX_UNLISTED_START_TICK];
    if (q(a)?.pricing !== 2) return START_TICK_BOUNDS;
    const price = (attested as LaunchParams["priceAttestation"] | undefined)
      ?.priceUsdE18;
    if (!price) throw new Revert("StartPriceUnavailable");
    const down = Math.round(
      Math.log(Number(price) / Number(FAKE_SIGNED_PRICE)) / Math.log(1.0001),
    );
    return [START_TICK_BOUNDS[0] - down, START_TICK_BOUNDS[1] - down];
  };
  const pad = (id: unknown) => {
    const p = pads.get(id as bigint);
    if (!p) throw new Revert("UnknownLaunchpad");
    return p;
  };
  // The ledger's live `claimRestricted`, a value or a handler a test installed.
  const restricted = (a: Address, call: CallContext): boolean => {
    const v = fake.contracts.get(lower(suite.ledger))?.fns.claimRestricted;
    return typeof v === "function"
      ? (v as (args: readonly unknown[], call: CallContext) => unknown)(
          [a],
          call,
        ) === true
      : v === true;
  };
  // LaunchEconomics.checkFeeRecipients on the resolved list, the launch's own addresses aside.
  const checkFeeRecipients = (
    p: LaunchParams,
    launcher: Address,
    call: CallContext,
  ) => {
    const list = feeRecipientsOf(p, launcher);
    const bad =
      list.length > MAX_FEE_RECIPIENTS ||
      list.some(
        (r, i) =>
          BigInt(r.recipient) === 0n ||
          r.shareBps === 0 ||
          list
            .slice(0, i)
            .some((x) => lower(x.recipient) === lower(r.recipient)),
      ) ||
      list.reduce((sum, r) => sum + r.shareBps, 0) !== 10_000;
    if (bad) throw new Revert("InvalidFeeRecipients");
    for (const { recipient: a } of list) {
      const code = fake.code.get(lower(a));
      const contract = code !== undefined && code !== "0x";
      if (
        !p.allowOpenCodeFeeRecipients &&
        contract &&
        !isDelegatedEoa(code) &&
        !restricted(a, call)
      )
        throw new Revert("OpenContractFeeRecipient", [a]);
    }
  };

  fake.contract(suite.factory, bankrLaunchFactoryAbi, {
    paused: false,
    launchGated: false,
    weth: suite.weth,
    tokenDeployer: live.tokenDeployer,
    vestingEscrowImpl: live.vestingEscrowImpl,
    poolManager: live.poolManager,
    locker: live.locker,
    hook: live.hook,
    ledger: live.ledger,
    treasury: live.treasury,
    capController: live.capController,
    buyback: live.buyback,
    holderLeg: suite.holderLeg,
    quoteList: Object.keys(quotes)
      .filter(listed)
      .map((a) => getAddress(a)),
    quoteEntry: ([a]: readonly unknown[]) => ({
      allowed: listed(a),
      minCompoundQuote: 0n,
      maxCompoundQuote: 0n,
      maxCompoundBps: 0,
      maxCompoundDeviationBps: 500,
      minCompoundInterval: 300,
      removalExecuteAfter: 0n,
    }),
    quotePricing: ([a]: readonly unknown[]) => ({
      mode: listed(a) ? (q(a)?.pricing ?? 1) : 0,
      decimals: listed(a) ? q(a)!.decimals : 0,
      maxPriceAge: 7_200,
      feed: zeroAddress,
    }),
    pricingConfig: [zeroAddress, zeroAddress, MIN_START_FDV_USD, 125_000_000n],
    startTickBounds: ([a, , attested]: readonly unknown[]) =>
      boundsOf(a, attested),
    // The suite's own contracts; a launched token or escrow is a suite account too, not modelled here.
    isSuite: ([a]: readonly unknown[]) =>
      [
        suite.factory,
        suite.hook,
        suite.ledger,
        suite.locker,
        suite.launchpadRegistry,
        suite.holderRewardsDeployer,
        suite.tokenDeployer,
        suite.vestingEscrowImpl,
        suite.holderLeg,
        suite.buyback,
        suite.claimsRedeemer,
        POOL_MANAGER,
      ].some((x) => lower(x) === lower(String(a))),
    computeTokenAddress: ([launcher, salt, p]: readonly unknown[]) =>
      predictToken(live, p as LaunchParams, launcher as Address, salt as Hex),
    launch: ([raw]: readonly unknown[], call: CallContext) => {
      const p = raw as LaunchParams;
      const launcher = call.from ?? zeroAddress;
      const entry = pad(p.launchpadId);
      // LaunchEconomics.checkStartTick: the scheduled start against the block's clock, then the tick.
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (p.startTime !== 0n) {
        if (p.startTime <= now) throw new Revert("StartPassed");
        if (p.startTime > now + BigInt(MAX_START_DELAY_SECS))
          throw new Revert("StartTooFar");
      }
      const [lo, hi] = boundsOf(p.quote, p.priceAttestation);
      if (p.expectedStartTick < lo || p.expectedStartTick > hi)
        throw new Revert("StartTickOutOfBounds", [lo, hi]);
      // CurveTable.checkFormat: a launch's own bands, before anything is deployed.
      const ownBands = builtInCurveId(p.curveId) === null;
      if (ownBands && !checkCurveFormat(p.curveId, p.expectedStartTick))
        throw new Revert("InvalidCurve");
      // LaunchRegistry._checkUnlisted: Bankr's pad lists its quotes; nothing compounds an unlisted one
      if (!listed(p.quote) && p.launchpadId === 0n)
        throw new Revert("QuoteNotAllowed");
      if (
        !listed(p.quote) &&
        (p.econ.autoLpBps > 0 ||
          (entry.terms.decay.on && entry.terms.decay.autoLpBps > 0))
      )
        throw new Revert("UnlistedQuoteAutoLp");
      if (p.operatorPayeesHash !== padTermsHash(entry.terms))
        throw new Revert("OperatorPayeesMismatch");
      if (BigInt(entry.pad.signer) !== 0n && p.authorization.signature === "0x")
        throw new Revert("InvalidAuthorization");
      if (
        p.startTime > now &&
        p.startTime - now > BigInt(entry.pad.policy.maxStartDelay)
      )
        throw new Revert("StartDelayAboveLaunchpadMax");
      checkFeeRecipients(p, launcher, call);
      const token = predictToken(live, p, launcher, p.salt);
      if (fake.code.has(lower(token))) throw new Revert("TokenSaltTaken");
      // recordLaunch's curve key, then LaunchPool's rules on a launch's own bands (the fake launches no extension).
      if (
        !fakeCurveAllowed(entry, p.curveId) &&
        !(ownBands && fakeCurveAllowed(entry, ANY_CURVE))
      )
        throw new Revert("CurveNotAllowedByLaunchpad");
      const curve = ownBands
        ? checkCurve({
            curve: p.curveId,
            startTick: p.expectedStartTick,
            tokenIsCurrency0: poolIdOf(token, p.quote, live.hook)
              .tokenIsCurrency0,
            sale: launchSale(p),
            ownBuys: curveOwnBuys({
              buybackBps: p.econ.buybackBps,
              autoLpBps: p.econ.autoLpBps,
              padDecay: entry.terms.decay,
              extensionCallsOut: false,
            }),
          })
        : null;
      if (curve && !curve.ok) {
        const { name, row, unplaced } = curve.revert;
        const arg = row === null ? unplaced : BigInt(row);
        throw new Revert(name, arg === null ? [] : [arg]);
      }
      if (p.devBuyAmountIn > 0n)
        fake.pullErc20(
          p.quote,
          launcher,
          suite.factory,
          p.devBuyAmountIn,
          call,
        );
      const devBuyOut = (call.value + p.devBuyAmountIn) * FAKE_TOKENS_PER_UNIT;
      if (
        devBuyOut >
        ((p.totalSupply || DEFAULT_TOTAL_SUPPLY) * 200n) / 10_000n
      )
        throw new Revert("DevBuyTooLarge");
      if (devBuyOut < p.devBuyMinOut) throw new Revert("DevBuyTooLittle");
      const vests = p.vestBps > 0 || p.econ.vestToHoldersBps > 0;
      return {
        token,
        poolId: poolIdOf(token, p.quote, live.hook).poolId,
        distributor: fakeDistributor(token),
        vestingEscrow: vests
          ? predictEscrow(live, launcher, p.salt)
          : zeroAddress,
        devBuyOut,
      };
    },
  });
  fake.contract(suite.launchpadRegistry, bankrLaunchpadRegistryAbi, {
    launchpadCount: () => BigInt(Math.max(...[...pads.keys()].map(Number))),
    // Zeroed past the count, as on-chain: a read that skips the count check sees operator 0x0, not a revert.
    getLaunchpad: ([id]: readonly unknown[]) =>
      pads.get(id as bigint)?.pad ?? unregisteredPad(),
    payeesOf: ([id]: readonly unknown[]) => pad(id).terms,
    metadataUriOf: ([id]: readonly unknown[]) => pad(id).metadataUri,
    // A pad with no quote set allows every quote, listed or not (allowedQuoteCount 0).
    isQuoteAllowed: ([id, a]: readonly unknown[]) =>
      !(pad(id).refusedQuotes ?? []).includes(lower(String(a))),
    // No revert past the count, as on-chain: an unregistered pad reads as one nobody flipped.
    isCurveAllowed: ([id, key]: readonly unknown[]) =>
      fakeCurveAllowed(pads.get(id as bigint), key as bigint),
    bankrSigner: BANKR_SIGNER,
    registrationBondWei: FAKE_REGISTRATION_BOND,
    // The pad owning exactly this suffix (the registry's owner word), from each pad's live vanity.
    vanityOwner: ([suffix, nibbles]: readonly unknown[]) => {
      const owner = [...pads].find(
        ([, p]) =>
          p.pad.vanity.nibbles !== 0 &&
          p.pad.vanity.nibbles === nibbles &&
          p.pad.vanity.suffix === suffix,
      );
      return owner ? [true, owner[0]] : [false, 0n];
    },
  });
  // The leg's references in force: the record's go-live oracle until a test swaps them. Nothing is staged yet.
  fake.contract(
    suite.holderLeg,
    [...HOLDER_LEG_REFERENCES_ABI, ...HOLDER_LEG_WAKE_ABI],
    { references: suite.referenceOracle, pending: 0n, pendingSince: 0n },
  );
  fake.contract(suite.holderRewardsDeployer, holderRewardsDeployerAbi, {
    predict: ([token]: readonly unknown[]) => fakeDistributor(token as Address),
  });
  // Q9's default policy: every account open, so anyone (Multicall3 included) may claim for it. No quote's wake is
  // armed until a test arms one.
  fake.contract(suite.ledger, bankrFeeLedgerAbi, {
    claimRestricted: false,
    mayClaimFor: true,
    isClaimsCollector: false,
    isProtocolSink: false,
    holdersWake: 0n,
  });
  const chain = LAUNCH_CHAINS.find((c) => CHAINS[c].chainId === fake.chain.id);
  for (const [address, quote] of Object.entries(quotes)) {
    if (lower(address) === lower(suite.weth)) continue;
    // The SDK's pinned slots where it has them (its overrides must land there); a plain OZ layout otherwise.
    const slots = (chain && erc20SlotsFor(chain, address as Address)) ?? {
      balances: 0,
      allowances: 1,
    };
    fake.erc20(address as Address, quote.decimals, slots);
  }
  const byName = {
    factory: suite.factory,
    registry: suite.launchpadRegistry,
    ledger: suite.ledger,
    distributors: suite.holderRewardsDeployer,
  };
  return {
    fake,
    suite,
    pads,
    set: (contract, fn, value) => {
      const entry = fake.contracts.get(lower(byName[contract]));
      if (!entry) throw new Error(`no ${contract} installed`);
      entry.fns[fn] = value;
    },
  };
}

/** The params of a sent factory launch, or undefined for any other transaction (an approval). */
export function sentLaunch(
  f: SuiteFixture,
  tx: SentTx,
): LaunchParams | undefined {
  if (lower(tx.to) !== lower(f.suite.factory)) return undefined;
  const { args } = decodeFunctionData({
    abi: bankrLaunchFactoryAbi,
    data: tx.data,
  });
  return args[0] as LaunchParams;
}

/** The receipt logs a successful factory launch emits for whatever the sent calldata asked for. */
export function launchLogs(f: SuiteFixture, tx: SentTx): { logs: RpcLog[] } {
  const p = sentLaunch(f, tx);
  if (!p) return { logs: [] };
  const live = liveSuiteOf(f.suite);
  const token = predictToken(live, p, tx.from, p.salt);
  const vests = p.vestBps > 0 || p.econ.vestToHoldersBps > 0;
  const poolId = poolIdOf(token, p.quote, live.hook).poolId;
  // A pad with no payee or contract share: the fee recipients hold the whole creator bucket, each as its creator part.
  const recipients = feeRecipientsOf(p, tx.from);
  const parts = recipients.map((r) => BigInt(r.shareBps) * 10n ** 14n);
  return {
    logs: [
      eventLog(
        bankrLaunchTokenAbi,
        "MetadataAdminSet",
        { from: zeroAddress, to: p.metadataAdmin },
        token,
      ),
      eventLog(
        bankrFeeLedgerAbi,
        "BucketRegistered",
        {
          bucketId: bucketIds.creator(poolId),
          poolId,
          beneficiaries: recipients.map((r) => r.recipient),
          shares: parts,
        },
        f.suite.ledger,
      ),
      eventLog(
        bankrFeeLedgerAbi,
        "CreatorShares",
        {
          bucketId: bucketIds.creator(poolId),
          creatorShares: parts,
          takeover: p.launchpadId === 0n,
        },
        f.suite.ledger,
      ),
      // A mined launch's start is still ahead, so a scheduled one always logs it.
      ...(p.startTime === 0n
        ? []
        : [
            eventLog(
              bankrLaunchFactoryAbi,
              "TradingScheduled",
              { token, poolId, startTime: p.startTime },
              f.suite.factory,
            ),
          ]),
      eventLog(
        bankrLaunchFactoryAbi,
        "TokenLaunched",
        {
          token,
          launcher: tx.from,
          quote: p.quote,
          poolId,
          startTick: p.expectedStartTick,
          metadataUri: p.metadataUri,
          launchpadId: p.launchpadId,
        },
        f.suite.factory,
      ),
      eventLog(
        bankrLaunchFactoryAbi,
        "LaunchResolved",
        {
          token,
          curveId: p.curveId,
          holdersBps: p.econ.holdersBps,
          distributor: fakeDistributor(token),
          vestingEscrow: vests
            ? predictEscrow(live, tx.from, p.salt)
            : zeroAddress,
          vestingRecipient: p.vestingRecipient,
          vestBps: p.vestBps,
          totalSupply: p.totalSupply || DEFAULT_TOTAL_SUPPLY,
          devBuyOut: (tx.value + p.devBuyAmountIn) * FAKE_TOKENS_PER_UNIT,
        },
        f.suite.factory,
      ),
    ],
  };
}
