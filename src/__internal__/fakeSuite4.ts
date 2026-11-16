// Test-only: a suite 4 on a FakeChain whose settings contract answers `resolve` with the fake's own launch check
// (fakeResolver.ts, core's resolver port) over a state the test holds and may change. The SDK's suite 4 plan runs
// against it through viem's real encode and decode. Excluded from the build; viem and relative imports only.
import {
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrLaunchpadRegistryAbi,
  holderRewardsDeployerAbi,
} from "../abis/generated.js";
import type { ProviderAddresses } from "../addresses.js";
import { decodeLaunchOptions } from "../suite4/options.js";
import { poolIdOf } from "../plan.js";
import {
  predictEscrow,
  predictToken,
  type Suite4LiveSuite,
} from "../predict.js";
import { HOLDER_LEG_REFERENCES_ABI } from "../recipient.js";
import type { Suite4LaunchParams } from "../suite4/settings.js";
import { resolveBankrV4Launch } from "./fakeResolver.js";
import {
  BankrV4ResolveRevert,
  bankrV4KnobInForce,
  type BankrV4ResolverState,
} from "./fakeResolverState.js";
import { bankrV4StartWindow } from "./fakeStartWindow.js";
import { FakeChain, Revert, type CallContext } from "./fakeRpc.js";
import { fakeAddress, fakeDistributor, testSuite } from "./fakeSuite.js";
import {
  FRESH_PAD_ID,
  FRESH_QUOTE,
  freshSuite4State,
} from "./fakeSuite4State.js";

export const FAKE_SETTINGS = fakeAddress(0x84e7);
/** Tokens a dev buy receives per quote base unit. */
export const SUITE4_TOKENS_PER_UNIT = 1_000n;

type Pad = {
  operator: Address;
  pendingOperator: Address;
  signer: Address;
  paused: boolean;
  verified: boolean;
  vanity: { suffix: number; nibbles: number };
};

export interface Suite4Fixture {
  fake: FakeChain;
  suite: ProviderAddresses & { settings: Address };
  /** The suite's wiring as the factory's getters answer it: what a token's address is predicted from. */
  live: Suite4LiveSuite;
  /** What `resolve` reads. A test moves the owner's or the pad's settings by changing it. */
  state: BankrV4ResolverState;
  /** The pad the state is for, and the registry's own row for it. */
  padId: bigint;
  pad: Pad;
  /** The state's quote: the fake factory's WETH, so a dev buy on it is native. */
  quote: Address;
  /** Accounts with restricted claims, and `account:operator` pairs, lowercase. */
  restricted: Set<string>;
  operators: Set<string>;
  /** The preset records by id (`presetOf`); a custom extension's code is the state's `extensionCode`. */
  presets: Map<number, { creationCodeHash: Hex; active: boolean }>;
  /** `factory.termsHashOf` by token, lowercase: a mined coin's record. Zero for a token it never launched. */
  termsHashes: Map<string, Hex>;
  /** Every launch's params that reached `resolve`, through the settings contract or the factory. */
  resolved: Suite4LaunchParams[];
  /** Runs before each `factory.launch`: a test moves settings between a plan's resolve and its simulation. */
  beforeLaunch: () => void;
  /** Runs before each `resolve`, the factory's own included, with how many ran before it. */
  beforeResolve: (earlier: number) => void;
}

const lower = (a: string) => a.toLowerCase();
const ERRORS = [...bankrLaunchSettingsAbi, ...bankrLaunchFactoryAbi].filter(
  (e) => e.type === "error",
);

/** What a fake suite 4 starts from: the state its launch check reads, and the pad and quote that state is for. */
export interface Suite4Start {
  state: BankrV4ResolverState;
  padId: bigint;
  quote: Address;
}

/**
 * A suite 4 whose launch check is the resolver port over `start.state`: the pad, the owner's limits, the quote and
 * the wiring a launch meets. Default: a fresh suite's open pad on WETH. The registry's pad is open: no signer.
 */
export function installSuite4(
  fake: FakeChain,
  start: Suite4Start = {
    state: freshSuite4State(),
    padId: FRESH_PAD_ID,
    quote: FRESH_QUOTE,
  },
): Suite4Fixture {
  const { state, padId } = start;
  const quote = getAddress(start.quote);
  const suite = Object.freeze({
    ...testSuite(fake.chain.id),
    weth: quote,
    hook: state.wiring.hook,
    holderLeg: state.wiring.holderLeg,
    settings: FAKE_SETTINGS,
  });
  const live = {
    factory: suite.factory,
    tokenDeployer: suite.tokenDeployer,
    vestingEscrowImpl: suite.vestingEscrowImpl,
    poolManager: fakeAddress(0x8a01),
    locker: suite.locker,
    hook: suite.hook,
    ledger: suite.ledger,
    treasury: suite.treasury,
    buyback: suite.buyback,
  };
  const f: Suite4Fixture = {
    fake,
    suite,
    live,
    state,
    padId,
    pad: {
      operator: fakeAddress(0x0b1),
      pendingOperator: zeroAddress,
      signer: zeroAddress,
      paused: false,
      verified: false,
      vanity: { suffix: 0, nibbles: 0 },
    },
    quote,
    restricted: new Set(),
    operators: new Set(),
    presets: new Map(
      [1, 2, 3, 4].map((id) => [
        id,
        {
          creationCodeHash: `0x${id.toString(16).padStart(64, "c")}`,
          active: true,
        },
      ]),
    ),
    termsHashes: new Map(),
    resolved: [],
    beforeLaunch: () => {},
    beforeResolve: () => {},
  };

  /** `resolve` as the chain runs it now: the state at this second, the port's revert as the contract's. */
  const resolve = (
    launcher: Address,
    nativeDevBuy: bigint,
    p: Suite4LaunchParams,
  ) => {
    f.beforeResolve(f.resolved.length);
    f.resolved.push(p);
    const now = BigInt(Math.floor(Date.now() / 1000));
    try {
      return resolveBankrV4Launch(
        {
          ...f.state,
          now,
          pad: p.launchpadId === f.padId ? f.state.pad : null,
          quote: isAddressEqual(p.quote, f.quote)
            ? f.state.quote
            : {
                ...f.state.quote,
                terms: { ...f.state.quote.terms, allowed: false, mode: 0 },
                feedPriceUsdE18: null,
              },
        },
        { launcher, nativeDevBuy, params: p },
      );
    } catch (error) {
      if (error instanceof BankrV4ResolveRevert)
        throw new Revert(error.error, [...error.args]);
      throw error;
    }
  };
  const tokenOf = (launcher: Address, p: Suite4LaunchParams) =>
    predictToken(
      live,
      { ...p, terms: resolve(launcher, 0n, p).terms },
      launcher,
      p.salt,
    );
  const from = (call: CallContext) => getAddress(call.from ?? zeroAddress);
  const knob = (name: Parameters<typeof bankrV4KnobInForce>[1]) =>
    bankrV4KnobInForce({ pad: f.state.pad!, limits: f.state.limits }, name);

  fake.setBalance(suite.factory, 0n);
  fake.contract(suite.factory, [...bankrLaunchFactoryAbi, ...ERRORS] as Abi, {
    paused: false,
    launchGated: false,
    weth: quote,
    tokenDeployer: live.tokenDeployer,
    vestingEscrowImpl: live.vestingEscrowImpl,
    poolManager: live.poolManager,
    locker: live.locker,
    hook: () => f.state.wiring.hook,
    ledger: live.ledger,
    treasury: live.treasury,
    buyback: live.buyback,
    isSuite: false,
    termsHashOf: ([token]: readonly unknown[]) =>
      f.termsHashes.get(lower(token as string)) ?? `0x${"00".repeat(32)}`,
    computeTokenAddress: ([launcher, , p]: readonly unknown[]) =>
      tokenOf(launcher as Address, p as Suite4LaunchParams),
    launch: ([raw]: readonly unknown[], call: CallContext) => {
      f.beforeLaunch();
      const p = raw as Suite4LaunchParams;
      const launcher = from(call);
      const { terms } = resolve(launcher, call.value, p);
      const token = predictToken(live, { ...p, terms }, launcher, p.salt);
      const pinned = decodeLaunchOptions(p.options)!.expectedToken;
      if (BigInt(pinned) !== 0n && !isAddressEqual(pinned, token))
        throw new Revert("TokenAddressChanged", [token]);
      if ((fake.code.get(lower(token)) ?? "0x") !== "0x")
        throw new Revert("TokenSaltTaken");
      const amount = call.value + p.devBuyAmountIn;
      return [
        token,
        poolIdOf(token, p.quote, terms.hook).poolId,
        fakeDistributor(token),
        terms.vestedAmount > 0n
          ? predictEscrow(live, launcher, p.salt)
          : zeroAddress,
        amount * SUITE4_TOKENS_PER_UNIT,
      ];
    },
  });
  fake.contract(suite.settings, bankrLaunchSettingsAbi as Abi, {
    padConfig: ([id]: readonly unknown[]) =>
      id === f.padId
        ? f.state.pad
        : {
            knobs: [],
            ranges: [],
            flags: 0n,
            capController: zeroAddress,
            terms: {
              payees: [],
              steadySharesWad: [],
              decay: { on: false, autoLpBps: 0, sharesWad: [] },
            },
            presetIds: [],
            presetLimits: [],
          },
    limits: () => f.state.limits,
    allowedFlags: () => f.state.allowedFlags,
    protocolTerms: () => f.state.protocol,
    quoteTerms: ([q]: readonly unknown[]) =>
      isAddressEqual(q as Address, f.quote)
        ? f.state.quote.terms
        : { ...f.state.quote.terms, allowed: false, mode: 0 },
    isQuoteAllowed: () => f.state.quote.padTakes,
    presetOf: ([id]: readonly unknown[]) => {
      const record = f.presets.get(id as number);
      return {
        deployer: record ? fakeAddress(0x9e00 + (id as number)) : zeroAddress,
        deployerCodeHash: `0x${"00".repeat(32)}`,
        creationCodeHash: record?.creationCodeHash ?? `0x${"00".repeat(32)}`,
        selfPayee: id === 4,
        active: record?.active ?? false,
      };
    },
    extensionAllowed: () => f.state.extensionAllowed,
    // LaunchPricing's window at the feed's price, for the supply asked (0: the pad's default).
    startTickBounds: ([, , supply]: readonly unknown[]) => {
      const price = f.state.quote.feedPriceUsdE18;
      if (price === null) throw new Revert("StartPriceUnavailable");
      const { lowest, highest } = bankrV4StartWindow({
        fdvUsd: knob("startFdvUsd"),
        decimals: f.state.quote.terms.decimals,
        priceUsdE18: price,
        supply: (supply as bigint) || knob("supply").dflt * 10n ** 18n,
      });
      return [lowest, highest];
    },
    resolve: ([launcher, value, p]: readonly unknown[]) => {
      const r = resolve(
        launcher as Address,
        value as bigint,
        p as Suite4LaunchParams,
      );
      return [r.terms, r.resolvedHash, r.expectedToken, r.padTerms];
    },
  });
  fake.contract(suite.launchpadRegistry, bankrLaunchpadRegistryAbi as Abi, {
    // The registry numbers its pads 1 to launchpadCount (`id = ++launchpadCount`): the fake's pad is the newest.
    launchpadCount: () => f.padId,
    getLaunchpad: ([id]: readonly unknown[]) =>
      id === f.padId
        ? f.pad
        : { ...f.pad, operator: zeroAddress, signer: zeroAddress },
  });
  fake.contract(suite.ledger, bankrFeeLedgerAbi as Abi, {
    claimRestricted: ([account]: readonly unknown[]) =>
      f.restricted.has(lower(account as string)),
    isClaimOperator: ([account, operator]: readonly unknown[]) =>
      f.operators.has(
        `${lower(account as string)}:${lower(operator as string)}`,
      ),
  });
  fake.contract(suite.holderRewardsDeployer, holderRewardsDeployerAbi as Abi, {
    predict: ([token]: readonly unknown[]) => fakeDistributor(token as Address),
  });
  fake.contract(suite.holderLeg, HOLDER_LEG_REFERENCES_ABI as Abi, {
    references: fakeAddress(0x8014),
  });
  return f;
}
