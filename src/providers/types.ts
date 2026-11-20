import type {
  Address,
  Chain,
  Client,
  Hex,
  TransactionReceipt,
  Transport,
} from "viem";
import type { LaunchProviderId, ProviderInfo } from "../addresses.js";
import type { RegisterResult } from "../api.js";
import type {
  ChainCapabilities,
  LaunchChain,
  QuoteFor,
} from "../chains/index.js";
import type { LaunchCurve } from "../curve.js";
import type { LaunchCurveInput } from "../curveInput.js";
import type {
  FeeRecipient,
  FeeSchedule,
  LaunchEconomics,
  LaunchParams,
} from "../economics.js";
import type { LaunchExtensionInput } from "../extension.js";
import type {
  LaunchExtensionPreview,
  PreviewExtensionOptions,
} from "../extensionPreview.js";
import type { LaunchFees } from "../fees.js";
import type { LaunchHolders } from "../holders.js";
import type { LaunchpadOperations } from "../launchpads.js";
import type { LaunchContracts } from "../settings/index.js";
import type { InvariantReport } from "../invariants.js";
import type { LaunchpadInfo, VolumeSplit } from "../launchpad.js";
import type { LaunchInfo } from "../lens.js";
import type { ResolvedLaunch } from "../suite4/plan.js";
import type { LaunchMetadataAdmin, TradingStatus } from "../token.js";
import type { LaunchVesting } from "../vesting.js";

export type { FeeRecipient, FeeSchedule, LaunchEconomics, LaunchParams };

/**
 * Any viem client that reads the chain: a `PublicClient`, including one for an OP-stack chain whose custom
 * formatters make it unassignable to viem's default `PublicClient` type.
 */
export type ReadClient = Client<Transport, Chain | undefined>;

/** How a quote funds a dev buy: `msg.value` (WETH), an ERC-20 approved to the factory, or not at all. */
export type DevBuyKind = "native" | "erc20" | "none";

/** Token metadata Bankr pins for you in API mode. Pure mode takes a ready `metadataUri` instead. */
export interface LaunchMetadata {
  image?: string;
  description?: string;
  tweetUrl?: string;
  websiteUrl?: string;
}

/**
 * One launch. Every economic field defaults to the launchpad's terms (`client.launchpad(id)` shows them) and is
 * checked against the protocol's bounds and the pad's before anything is signed.
 */
export interface LaunchInput<C extends LaunchChain = LaunchChain> {
  /** 1–100 characters. */
  name: string;
  /** 1–20 characters. */
  symbol: string;
  /** Pure mode: the token's metadata URI, at most 2,048 bytes; after launch only `metadataAdmin` may replace it.
   *  Defaults to "". */
  metadataUri?: string;
  /** Who may replace the token's metadata URI after launch, hand that role on or renounce it. Default nobody: the URI
   *  is fixed from the first block. It is part of the token's address. */
  metadataAdmin?: Address;
  /** API mode only (Bankr pins the JSON); pure mode refuses it. */
  metadata?: LaunchMetadata;
  /**
   * The account that is `msg.sender` at the factory (not necessarily `tx.from`): it pays the dev buy, receives the
   * dev-buy tokens, and is the default fee and vesting recipient. A relayer or multicall becomes the launcher.
   */
  launcher: Address;
  /**
   * The launchpad (uint64). Default `0n`, Bankr's own pad, which Bankr signs: launch it in API mode. Open pads
   * launch unsigned; a pad with a signer needs the client's `authorizer`.
   */
  launchpadId?: bigint;
  /**
   * A named major (`CHAINS[chain].quotes`) or any ERC-20's address. Default WETH (USDC on Arc). On a pad other than
   * Bankr's, a quote the factory does not list launches too (any-quote pairing): set `startFdv`, and no auto-LP.
   */
  quote?: QuoteFor[C] | Address;
  /**
   * The start FDV of the whole supply, in the quote's base units: the start tick is
   * `floor200(ln(startFdv / supply) / ln(1.0001))`. Required for a quote the factory does not list (the launcher prices
   * it; no USD bound), optional for a listed one, where it must sit in the factory's USD window.
   */
  startFdv?: bigint;
  /**
   * Where the sale's liquidity sits. Default `"runner_v1"`. A built-in by name or id (`"degen"` starts at $2,500),
   * or your own bands: `{ bands }`, or `{ marketCaps }` ranges as Doppler's multicurve takes them. Own bands launch
   * only on a launchpad that allows them (`CURVE_NOT_ALLOWED` otherwise) and are held to the pool's rules first.
   */
  curve?: LaunchCurveInput;
  /** Who claims the creator's share; defaults to `launcher`. The same as a one-entry `feeRecipients`: set one, not both. */
  feeRecipient?: Address;
  /**
   * The creator's own take split over 1–10 distinct recipients: each `shareBps` above 0, together 10,000. The order is
   * kept and signed; the first is the primary and takes the rounding remainder. The split is fixed at launch.
   */
  feeRecipients?: readonly FeeRecipient[];
  /** Allow a contract fee recipient the SDK cannot prove is able to claim (a Safe or a 7702 wallet needs no flag).
   *  Any contract recipient, a Safe included, must also have restricted its claim policy (`setClaimRestricted(true)` on
   *  the fee ledger) unless the launch sets `allowOpenCodeFeeRecipients`. Default false. */
  allowContractFeeRecipient?: boolean;
  /** The launch's own waiver, part of its signed terms: its recipients may be contracts that still let anyone claim
   *  for them. Without it the factory reverts such a launch (`OpenContractFeeRecipient`). Default false. */
  allowOpenCodeFeeRecipients?: boolean;
  /**
   * When public trading opens: a `Date` (floored to the second) or unix seconds, after now and at most 7 days ahead,
   * or the pad's shorter `policy.maxStartDelay`. Default (or 0): at launch. Fixed for good once the launch lands.
   */
  startTime?: Date | number;
  /** Each direction's schedule (a buy is quote in). Default: the pad's. Set `fees` or `schedule`, not both. */
  fees?: { buy: FeeSchedule; sell: FeeSchedule };
  /** One schedule for both directions. */
  schedule?: FeeSchedule;
  /** The referrer's slice of each fee, in bps of the fee (at most 500, and the pad's maximum). Default 0. */
  referrerBps?: number;
  /**
   * Fees to the coin's holders, in bps of the creator's own take (what the creator keeps after auto-LP and buyback):
   * 10,000 sends all of it to holders. Converted with {@link holderShareToHoldersBps}. Default: the pad's.
   */
  holderShareBps?: number;
  /** Auto-liquidity, in bps of the creator side. Default: the pad's (Bankr's pad floors it at 30 %). */
  autoLpBps?: number;
  /** Buyback, in bps of the creator side. Default 0. */
  buybackBps?: number;
  /**
   * Creator vesting. Default: the pad's share and schedule (suite 3: a 30-day cliff, then linear to 365 days).
   * `recipient` defaults to the launcher. Suite 4: `cliffSeconds` and `durationSeconds` name the schedule inside the
   * pad's range (name one and the other takes the pad's default); both 0 unlock the slice at the trading start.
   */
  vesting?: {
    bps: number;
    recipient?: Address;
    allowContractRecipient?: boolean;
    cliffSeconds?: number;
    durationSeconds?: number;
  };
  /** A share of supply vested to the coin's holders, pushed to the launch's distributor. Counts toward the 50 % cap. */
  vestToHolders?: {
    bps: number;
    cliffSeconds: number;
    durationSeconds: number;
  };
  /** In the quote's base units; native on WETH (not on Arc), an ERC-20 approval to the factory otherwise. `slippageBps` defaults to 200. */
  devBuy?: { amount: bigint; slippageBps?: number };
  /**
   * An extension the hook binds to the pool for good: one of Bankr's presets by name or id with its parameters
   * (`{ preset: "sniper_tax", buyPips, sellPips, endSecs }`, `"decay_tax"`, `"pump_brake"`), a raw preset
   * (`{ presetId, params }`), or custom code the suite's allowlist holds (`{ address, codehash, … }`). Each parameter
   * is held to its contract's bound (`EXTENSION_OUT_OF_BOUNDS`), then the registry's allowlist and the launchpad's
   * policy are read (`EXTENSION_NOT_ALLOWED`). Pure mode only. Default: none.
   */
  extension?: LaunchExtensionInput;
  // Suite 4 only, each optional: unset takes the launchpad's default, resolved on chain. A suite 3 launch refuses them.
  /** The total supply in the token's base units (18 decimals), inside the pad's range. Default: the pad's. */
  supply?: bigint;
  /** The wallet cap: its size in bps of supply and its length in seconds, or `false` for none. Default: the pad's. */
  walletCap?: { bps: number; seconds: number } | false;
  /**
   * Builder allocations: slices of the supply to other wallets, in the token's base units, each on its own schedule.
   * `cliffSeconds` and `durationSeconds` default to 0: unlocked at the trading start. The pad must allow them.
   */
  allocations?: readonly LaunchAllocation[];
  /**
   * Auto-liquidity's own terms beside `autoLpBps` (set `bps` here or `autoLpBps`, not both): the compound's `floor`
   * and `cap` in the quote's base units (both, where the pad allows a launch its own), its cadence and its band, in
   * ticks on the 200 grid. A term left out of a group takes the pad's default. Refused on a launch with no auto-LP.
   */
  autoLp?: {
    bps?: number;
    floor?: bigint;
    cap?: bigint;
    intervalSeconds?: number;
    /** Of the backlog; 0: no share cap. */
    shareBps?: number;
    deviationTicks?: number;
    band?: { halfWidthTicks: number; gridTicks: number };
  };
  /** The buyback's cadence beside `buybackBps` (set `bps` here or `buybackBps`, not both). Refused with no buyback. */
  buyback?: { bps?: number; intervalSeconds?: number; retrySeconds?: number };
  /** How the holders' rewards stream: over how many seconds, and the share of a top-up that restarts the clock. */
  holderStream?: { seconds: number; restartBps: number };
  /**
   * Wallets exempt from the wallet cap beside the suite's own. Default: the chain's settlers, sent only where the
   * launch has a cap and the pad allows exemptions. Refused when named on a launch with no cap.
   */
  capExclusions?: readonly Address[];
  /** With an extension: the most the base fee and the extension's fee may reach together, in pips. Default: the pad's. */
  feeCeilingPips?: number;
  /**
   * Pins the launch to the terms and the token the plan showed: if either differs when it lands it reverts
   * (`TERMS_CHANGED`) and is planned again. Default true; false takes whatever terms are in force at inclusion.
   */
  pin?: boolean;
  /**
   * The claim operator a contract fee recipient with restricted claims has named on the fee ledger. On a coin that
   * can be taken over, a takeover settles its share into a balance only it or its operator withdraws: without one
   * the launch is refused (`CLAIM_OPERATOR_REQUIRED`). A wallet, a Safe and an EIP-7702 account need none.
   */
  claimOperator?: Address;
  /** Pure mode only: a single-use bytes32 that satisfies the pad's vanity. By default the SDK mines a fresh one. */
  salt?: Hex;
  /** Default 1,200. Raise it for Safe or ERC-4337 launchers, whose signing latency can outlast the default. */
  deadlineSeconds?: number;
}

/** One builder allocation of a suite 4 launch. */
export interface LaunchAllocation {
  recipient: Address;
  /** In the token's base units. */
  amount: bigint;
  /** Seconds after the trading start before any of it unlocks. Default 0. */
  cliffSeconds?: number;
  /** Seconds after the trading start by which all of it has unlocked. Default 0: unlocked at once. */
  durationSeconds?: number;
}

/** One quote the chain's factory allows, prices and the launch's pad accepts. */
export interface QuoteToken {
  /** The SDK's name for a named major; null for any other quote. */
  symbol: string | null;
  address: Address;
  decimals: number;
  isDefault: boolean;
  /** Listed by the chain's factory; an unlisted quote launches only on a pad other than Bankr's, in pure mode. */
  listed: boolean;
  /** CHAINLINK quotes launch in pure mode; SIGNED ones need Bankr's price attestation (API mode); an unlisted quote
   *  is `unpriced` (its launcher sets `startFdv`). */
  pricing: "chainlink" | "signed" | "unpriced";
  devBuy: DevBuyKind;
}

/** A transaction for any signer (viem, wagmi, a Safe, an ERC-4337 bundler). `from` is its sender. */
export interface UnsignedTx {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  /** Set on launch transactions (clamped to the chain's per-transaction ceiling), claim-all ones (the plan's), and
   *  every holder-rewards claim, sized from the distributor's caps. */
  gas?: bigint;
}

/** A validated launch, ready to build, simulate or send. Plans go stale: the start tick and any authorization are fixed in it. */
export interface LaunchPlan<C extends LaunchChain = LaunchChain> {
  chain: C;
  provider: LaunchProviderId;
  factory: Address;
  launcher: Address;
  launchpadId: bigint;
  /** `factory.launch`'s tuple. A suite 4 launch carries `options`: what it names beyond the pad's defaults, and its pins. */
  params: LaunchParams & { options?: Hex };
  /** A suite 4 launch: the terms its coin will freeze, as the chain's launch check resolved them. */
  resolved?: ResolvedLaunch;
  /** `msg.value`: a native dev buy, else 0. */
  value: bigint;
  predictedToken: Address;
  poolId: Hex;
  /** Whether the token sorts below its quote (currency0 of the pool). */
  tokenIsCurrency0: boolean;
  /** The launch's holder-rewards distributor (every launch has one). */
  distributor: Address;
  /** The vesting escrow, or null when nothing vests. */
  escrow: Address | null;
  quote: QuoteToken;
  /** The economics the launch binds, and the public holder share they carry. */
  economics: LaunchEconomics;
  holderShareBps: number;
  /** The steady-state legs of each swap fee, in pips of volume. */
  volumeSplit: VolumeSplit;
  /** ERC-20 dev buys only: the approval to the factory to send (or batch) before the launch. */
  approvals: readonly UnsignedTx[];
  /** The dev buy's simulated output; `params.devBuyMinOut` applies the slippage to it. */
  devBuyOut: bigint;
  /** The launch's extension as the hook will bind it, with what a confirm screen shows; null when it names none. */
  extension: LaunchExtensionPreview | null;
  /** From a funded simulation; null when the RPC could not estimate. */
  gasEstimate: bigint | null;
  /** The ERC-8021 builder-code suffix appended to the launch calldata, if any. */
  dataSuffix: Hex | undefined;
  /** API mode with a prepare-scoped key: Bankr's record of the prepare. */
  prepareId?: string;
}

/** A launch that simulated cleanly. */
export interface SimResult {
  token: Address;
  poolId: Hex;
  distributor: Address;
  escrow: Address | null;
  devBuyOut: bigint;
  gas: bigint | null;
  /** True when a pending ERC-20 approval was assumed through a state override. */
  assumedApprovals: boolean;
}

/**
 * The facts of a mined launch: the factory's `TokenLaunched`, `LaunchResolved` and `TradingScheduled` logs, the
 * ledger's creator bucket (`BucketRegistered`, `CreatorShares`) and the token's own `MetadataAdminSet`.
 */
export interface LaunchResult<C extends LaunchChain = LaunchChain> {
  chain: C;
  txHash: Hex;
  blockNumber: bigint;
  token: Address;
  poolId: Hex;
  launcher: Address;
  quote: Address;
  launchpadId: bigint;
  startTick: number;
  metadataUri: string;
  /** May replace `metadataUri` after launch; null when the launch named nobody and the link is fixed. */
  metadataAdmin: Address | null;
  /**
   * The launch's fee recipients as the ledger registered them, each with its bps of the creators' own take, in the
   * creator bucket's order (the launch's own, except a recipient that is also a pad payee sits at the payee's place).
   */
  feeRecipients: FeeRecipient[];
  /** The scheduled trading start in Unix seconds; null when trading opened with the launch. */
  tradingStart: number | null;
  /** The launch's curve: a built-in's id and name, or the launcher's own bands, each band with its pool ticks. */
  curve: LaunchCurve;
  /** The contract's `holdersBps` (of the creator side). */
  holdersBps: number;
  distributor: Address;
  escrow: Address | null;
  vestingRecipient: Address;
  vestBps: number;
  totalSupply: bigint;
  devBuyOut: bigint;
  /**
   * API mode's `launch()` only: Bankr's index registration at 5 confirmations, or null when it failed (the indexer
   * still indexes the launch at the chain's full depth).
   */
  registration?: RegisterResult | null;
}

/** Live state of a chain's suite. */
export interface LaunchStatus {
  /** This SDK version launches on the chain: `CHAINS[chain].deployed`, whatever the client's options. */
  deployed: boolean;
  /** The client was built with `fork: true`, so its launch methods run whether or not the chain is `deployed`. */
  fork: boolean;
  /** New launches are paused at the factory. */
  paused: boolean;
  /** Only Bankr's own launchpad (id 0) may launch right now. */
  gated: boolean;
}

/** One launch provider on one chain. The client adds the wallet flow (approve, send, wait) on top. */
export interface LaunchProviderAdapter<C extends LaunchChain = LaunchChain> {
  readonly id: LaunchProviderId;
  readonly chain: ChainCapabilities<C>;
  readonly info: ProviderInfo<C>;
  status(): Promise<LaunchStatus>;
  launchpad(id?: bigint): Promise<LaunchpadInfo>;
  readQuotes(launchpadId?: bigint): Promise<QuoteToken[]>;
  plan(input: LaunchInput<C>): Promise<LaunchPlan<C>>;
  previewExtension(
    extension: LaunchExtensionInput,
    options?: PreviewExtensionOptions,
  ): Promise<LaunchExtensionPreview>;
  buildLaunchTx(plan: LaunchPlan<C>, options?: { gas?: bigint }): UnsignedTx;
  /** `blockNumber` replays the launch at a past block, e.g. to read why a mined launch reverted. */
  simulate(
    plan: LaunchPlan<C>,
    options?: { assumeApprovals?: boolean; blockNumber?: bigint },
  ): Promise<SimResult>;
  parseReceipt(
    receipt: TransactionReceipt,
    expectedToken?: Address,
  ): LaunchResult<C>;
  launchInfo(token: Address): Promise<LaunchInfo | null>;
  tradingStatus(token: Address): Promise<TradingStatus>;
  readonly fees: LaunchFees;
  readonly holders: LaunchHolders;
  readonly vesting: LaunchVesting;
  readonly metadataAdmin: LaunchMetadataAdmin;
  readonly launchpads: LaunchpadOperations;
  contracts(): LaunchContracts;
  verifyTokenInvariants(
    token: Address,
    receipt?: TransactionReceipt,
  ): Promise<InvariantReport>;
}
