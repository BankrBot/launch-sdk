// Test-only: the contracts on a FakeChain whose settings contract answers `resolve` with the fake's own launch check
// (fakeResolver.ts, core's resolver port) over a state the test holds and may change. The SDK's plan runs
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
import { LAUNCH_CHAINS, CHAINS } from "../chains/index.js";
import { erc20SlotsFor } from "../data/erc20Slots.js";
import { decodeLaunchOptions } from "../launch/options.js";
import { poolIdOf } from "../plan.js";
import { predictEscrow, predictToken, type LivePointers } from "../predict.js";
import { HOLDER_LEG_REFERENCES_ABI } from "../recipient.js";
import type { ContractLaunchParams } from "../launch/settings.js";
import { resolveBankrV4Launch } from "./fakeResolver.js";
import {
  BankrV4ResolveRevert,
  bankrV4KnobInForce,
  type BankrV4ResolverState,
} from "./fakeResolverState.js";
import { bankrV4StartWindow } from "./fakeStartWindow.js";
import { FakeChain, Revert, type CallContext } from "./fakeRpc.js";
import {
  FAKE_SETTINGS,
  POOL_MANAGER,
  fakeAddress,
  fakeDistributor,
  testRecord,
} from "./fakeRecord.js";
import {
  FRESH_PAD_ID,
  FRESH_QUOTE,
  freshContractsState,
} from "./fakeContractsState.js";

export { FAKE_SETTINGS };
/** Tokens a dev buy receives per quote base unit. */
export const FAKE_TOKENS_PER_UNIT = 1_000n;

type Pad = {
  operator: Address;
  pendingOperator: Address;
  signer: Address;
  paused: boolean;
  verified: boolean;
  vanity: { suffix: number; nibbles: number };
};

export interface ContractsFixture {
  fake: FakeChain;
  deployment: ProviderAddresses;
  /** The suite's wiring as the factory's getters answer it: what a token's address is predicted from. */
  live: LivePointers;
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
  resolved: ContractLaunchParams[];
  /** Runs before each `factory.launch`: a test moves settings between a plan's resolve and its simulation. */
  beforeLaunch: () => void;
  /** Runs before each `resolve`, the factory's own included, with how many ran before it. */
  beforeResolve: (earlier: number) => void;
  /** The launch check on the state in force now, as a mined launch would meet it: no hook runs, nothing is counted. */
  resolveNow(
    launcher: Address,
    nativeDevBuy: bigint,
    p: ContractLaunchParams,
  ): ReturnType<typeof resolveBankrV4Launch>;
}

const lower = (a: string) => a.toLowerCase();
const ERRORS = [...bankrLaunchSettingsAbi, ...bankrLaunchFactoryAbi].filter(
  (e) => e.type === "error",
);

/** What the fake contracts start from: the state its launch check reads, and the pad and quote that state is for. */
export interface ContractsStart {
  state: BankrV4ResolverState;
  padId: bigint;
  quote: Address;
  /** The factory's wrapped native token. Default: the quote, so a dev buy on it is native. Name another and the
   *  quote is an ERC-20 the factory pulls a dev buy of. */
  weth?: Address;
}

/**
 * Contracts whose launch check is the resolver port over `start.state`: the pad, the owner's limits, the quote and
 * the wiring a launch meets. Default: a fresh suite's open pad on WETH. The registry's pad is open: no signer.
 */
export function installContracts(
  fake: FakeChain,
  start: ContractsStart = {
    state: freshContractsState(),
    padId: FRESH_PAD_ID,
    quote: FRESH_QUOTE,
  },
): ContractsFixture {
  const { state, padId } = start;
  const quote = getAddress(start.quote);
  const weth = getAddress(start.weth ?? start.quote);
  const deployment = Object.freeze({
    ...testRecord(fake.chain.id),
    weth,
    hook: state.wiring.hook,
    holderLeg: state.wiring.holderLeg,
    settings: FAKE_SETTINGS,
  });
  const live = {
    factory: deployment.factory,
    tokenDeployer: deployment.tokenDeployer,
    vestingEscrowImpl: deployment.vestingEscrowImpl,
    poolManager: POOL_MANAGER,
    locker: deployment.locker,
    hook: deployment.hook,
    ledger: deployment.ledger,
    treasury: deployment.treasury,
    buyback: deployment.buyback,
  };
  const f: ContractsFixture = {
    fake,
    deployment,
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
    resolveNow: (launcher, nativeDevBuy, p) =>
      resolveNow(launcher, nativeDevBuy, p),
  };

  /** The launch check over the state at this second, the port's revert as the contract's. */
  const resolveNow = (
    launcher: Address,
    nativeDevBuy: bigint,
    p: ContractLaunchParams,
  ) => {
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
  /** `resolve` as a call meets it: a test's hook first, and the launch kept for the test to read. */
  const resolve = (
    launcher: Address,
    nativeDevBuy: bigint,
    p: ContractLaunchParams,
  ) => {
    f.beforeResolve(f.resolved.length);
    f.resolved.push(p);
    return resolveNow(launcher, nativeDevBuy, p);
  };
  // A quote that is not the wrapped native token is an ERC-20: at the SDK's pinned slots where it has them (its
  // overrides must land there), a plain OZ layout otherwise.
  if (!isAddressEqual(quote, weth)) {
    const chain = LAUNCH_CHAINS.find(
      (c) => CHAINS[c].chainId === fake.chain.id,
    );
    fake.erc20(
      quote,
      state.quote.terms.decimals,
      (chain && erc20SlotsFor(chain, quote)) ?? { balances: 0, allowances: 1 },
    );
  }
  const tokenOf = (launcher: Address, p: ContractLaunchParams) =>
    predictToken(
      live,
      { ...p, terms: resolve(launcher, 0n, p).terms },
      launcher,
      p.salt,
    );
  const from = (call: CallContext) => getAddress(call.from ?? zeroAddress);
  const knob = (name: Parameters<typeof bankrV4KnobInForce>[1]) =>
    bankrV4KnobInForce({ pad: f.state.pad!, limits: f.state.limits }, name);

  fake.setBalance(deployment.factory, 0n);
  fake.contract(
    deployment.factory,
    [...bankrLaunchFactoryAbi, ...ERRORS] as Abi,
    {
      paused: false,
      launchGated: false,
      weth,
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
        tokenOf(launcher as Address, p as ContractLaunchParams),
      launch: ([raw]: readonly unknown[], call: CallContext) => {
        f.beforeLaunch();
        const p = raw as ContractLaunchParams;
        const launcher = from(call);
        const { terms } = resolve(launcher, call.value, p);
        const token = predictToken(live, { ...p, terms }, launcher, p.salt);
        const pinned = decodeLaunchOptions(p.options)!.expectedToken;
        if (BigInt(pinned) !== 0n && !isAddressEqual(pinned, token))
          throw new Revert("TokenAddressChanged", [token]);
        if ((fake.code.get(lower(token)) ?? "0x") !== "0x")
          throw new Revert("TokenSaltTaken");
        if (p.devBuyAmountIn > 0n)
          fake.pullErc20(
            p.quote,
            launcher,
            deployment.factory,
            p.devBuyAmountIn,
            call,
          );
        const amount = call.value + p.devBuyAmountIn;
        return [
          token,
          poolIdOf(token, p.quote, terms.hook).poolId,
          fakeDistributor(token),
          terms.vestedAmount > 0n
            ? predictEscrow(live, launcher, p.salt)
            : zeroAddress,
          amount * FAKE_TOKENS_PER_UNIT,
        ];
      },
    },
  );
  fake.contract(deployment.settings, bankrLaunchSettingsAbi as Abi, {
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
        p as ContractLaunchParams,
      );
      return [r.terms, r.resolvedHash, r.expectedToken, r.padTerms];
    },
  });
  fake.contract(
    deployment.launchpadRegistry,
    bankrLaunchpadRegistryAbi as Abi,
    {
      // The registry numbers its pads 1 to launchpadCount (`id = ++launchpadCount`): the fake's pad is the newest.
      launchpadCount: () => f.padId,
      getLaunchpad: ([id]: readonly unknown[]) =>
        id === f.padId
          ? f.pad
          : { ...f.pad, operator: zeroAddress, signer: zeroAddress },
    },
  );
  fake.contract(deployment.ledger, bankrFeeLedgerAbi as Abi, {
    claimRestricted: ([account]: readonly unknown[]) =>
      f.restricted.has(lower(account as string)),
    isClaimOperator: ([account, operator]: readonly unknown[]) =>
      f.operators.has(
        `${lower(account as string)}:${lower(operator as string)}`,
      ),
  });
  fake.contract(
    deployment.holderRewardsDeployer,
    holderRewardsDeployerAbi as Abi,
    {
      predict: ([token]: readonly unknown[]) =>
        fakeDistributor(token as Address),
    },
  );
  fake.contract(deployment.holderLeg, HOLDER_LEG_REFERENCES_ABI as Abi, {
    references: fakeAddress(0x8014),
  });
  return f;
}
