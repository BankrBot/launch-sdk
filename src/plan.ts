import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { getCode, readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchpadRegistryAbi,
  holderRewardsDeployerAbi,
} from "./abis/suite3.js";
import {
  requireCapExclusions,
  type LaunchProviderId,
  type ProviderAddresses,
} from "./addresses.js";
import { parseAuthorization, type Authorizer } from "./authorizer.js";
import type { ChainCapabilities, LaunchChain } from "./chains/index.js";
import { ANY_CURVE } from "./curve.js";
import { curveOwnBuys, launchSale } from "./curveCheck.js";
import {
  refuseBrokenCurve,
  refuseClosedCurve,
  type PadCurveKeys,
} from "./curveDetail.js";
import { curveAtStart, type NormalizedCurve } from "./curveInput.js";
import {
  DYNAMIC_FEE,
  MAX_UNLISTED_START_TICK,
  MIN_START_TICK,
  START_FDV_USD,
  TICK_SPACING,
  checkEconomics,
  holdersBpsToHolderShare,
  quoteFdvTick,
  startTickForFdv,
  type LaunchParams,
} from "./economics.js";
import {
  LaunchExecutionError,
  LaunchRefusedError,
  type CodeOfKind,
} from "./errors.js";
import {
  requireExtension,
  type LaunchExtensionPreview,
} from "./extensionPreview.js";
import {
  BANKR_LAUNCHPAD_ID,
  checkPadTerms,
  padSigner,
  readPad,
  usesBuilderLane,
  volumeSplit,
  type PadState,
} from "./launchpad.js";
import {
  buildLaunchParams,
  checkStartTime,
  normalizeLaunchInput,
  resolveEconomics,
  type NormalizedLaunch,
} from "./normalize.js";
import {
  predictEscrow,
  predictToken,
  readLiveSuite,
  type LiveSuite,
} from "./predict.js";
import type {
  LaunchInput,
  LaunchPlan,
  QuoteToken,
  ReadClient,
} from "./providers/types.js";
import { quoteToken, readQuoteState } from "./quotes.js";
import {
  hasCode,
  isDelegatedEoa,
  isSentinel,
  readLegReferences,
  refuseUnclaimableRecipient,
  suiteContracts,
} from "./recipient.js";
import {
  addressMatchesVanity,
  mineVanitySalt,
  vanityRule,
  vanityUnavailable,
} from "./salt.js";
import { callPlannedLaunch, readFactoryAllowance } from "./simulate.js";
import {
  EMPTY_PRICE_ATTESTATION,
  feeRecipientsOf,
  launchTermsHash,
} from "./terms.js";
import { buildApproveTx, clampLaunchGas } from "./tx.js";

const BPS = 10_000n;

export interface PlanContext<C extends LaunchChain = LaunchChain> {
  chain: ChainCapabilities<C>;
  addresses: ProviderAddresses;
  provider: LaunchProviderId;
  client: ReadClient;
  dataSuffix: Hex | undefined;
  usedSalts: ReadonlySet<string>;
  /** Signs launches on a third-party pad with a signer (the client's `authorizer` option). */
  authorizer?: Authorizer;
}

/** The pool key's id: TOKEN and quote sorted, the dynamic fee, spacing 200, the launch's hook. */
export function poolIdOf(token: Address, quote: Address, hook: Address) {
  const tokenIsCurrency0 = BigInt(token) < BigInt(quote);
  const poolId = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [
        tokenIsCurrency0 ? token : quote,
        tokenIsCurrency0 ? quote : token,
        DYNAMIC_FEE,
        TICK_SPACING,
        hook,
      ],
    ),
  );
  return { poolId, tokenIsCurrency0 };
}

/** The factory's gates, the pad with its key for the launch's curve, the quote and the live suite, read in one round. */
export async function readLaunchState(ctx: PlanContext, n: NormalizedLaunch) {
  const { client, addresses: a } = ctx;
  const f = { address: a.factory, abi: bankrLaunchFactoryAbi } as const;
  const curveKey = (key: bigint) =>
    readContract(client, {
      address: a.launchpadRegistry,
      abi: bankrLaunchpadRegistryAbi,
      functionName: "isCurveAllowed",
      args: [n.launchpadId, key],
    });
  const [paused, gated, pad, quote, suite, weth, listed, anyBands] =
    await Promise.all([
      readContract(client, { ...f, functionName: "paused" }),
      readContract(client, { ...f, functionName: "launchGated" }),
      readPad(client, a.launchpadRegistry, n.launchpadId, n.chain),
      readQuoteState(client, {
        factory: a.factory,
        registry: a.launchpadRegistry,
        quote: n.quote.address,
        launchpadId: n.launchpadId,
      }),
      readLiveSuite(client, a.factory),
      readContract(client, { ...f, functionName: "weth" }),
      curveKey(n.curve.word),
      curveKey(ANY_CURVE),
    ]);
  return {
    paused,
    gated,
    pad,
    quote,
    suite,
    weth,
    curveKeys: { listed, anyBands },
  };
}

/** The factory's, the pad's and the ledger's refusals that apply to every launch against `quote`, pure or API mode. */
export function refuseGates(
  chain: LaunchChain,
  s: Pick<
    Awaited<ReturnType<typeof readLaunchState>>,
    "paused" | "gated" | "quote" | "pad"
  >,
  launchpadId: bigint,
  quote: Address,
): void {
  const refuse = (code: CodeOfKind<"refused">, detail?: string) => {
    throw new LaunchRefusedError(code, { chain, detail });
  };
  if (s.paused) refuse("PAUSED");
  if (s.gated && launchpadId !== BANKR_LAUNCHPAD_ID) refuse("LAUNCHPAD_GATED");
  // Any pad but Bankr's may pair with an ERC-20 the factory does not list (any-quote pairing); a listed one is priced.
  const q = s.quote;
  if (
    !q.padAllows ||
    (q.listed ? q.pricing === "none" : launchpadId === BANKR_LAUNCHPAD_ID)
  )
    refuse("QUOTE_NOT_ALLOWED");
  // The ledger refuses the pool's own quote among the payees it binds (InvalidBeneficiary), and the registry binds
  // no zero share: only a share of the steady split, or of the decay split while it is on, stops the pair.
  const { payees, steadySharesWad, decay } = s.pad.terms;
  const paysQuote = payees.some(
    (payee, n) =>
      isAddressEqual(payee, quote) &&
      ((steadySharesWad[n] ?? 0n) > 0n ||
        (decay.on && (decay.sharesWad[n] ?? 0n) > 0n)),
  );
  if (paysQuote)
    refuse(
      "QUOTE_NOT_ALLOWED",
      "This launchpad pays a share of its fees to this quote token's own contract, which could never collect it. Launch against another quote token, or on another launchpad.",
    );
}

/** A launch's start: its tick on the 200 grid, and how far above it the start the launch named sits (0 up to 200). */
export interface StartTick {
  tick: number;
  offsetTicks: number;
}

/** The grid tick at or under `exact`. A float a hair under a grid line rounds onto it: never a negative offset. */
export function onGrid(exact: number): StartTick {
  const tick = Math.floor(exact / TICK_SPACING) * TICK_SPACING;
  return { tick, offsetTicks: Math.max(exact - tick, 0) };
}

/**
 * The start tick. An unlisted quote's comes from `startFdv` alone, within the protocol's range (the launcher prices it,
 * as on Doppler). A listed quote's sits in the factory's live USD bounds: `startFdv`'s, the start the launch's own
 * curve names, or a built-in curve's default FDV (whose offset is 0: it draws no bands from market caps). A SIGNED
 * quote's bounds are read at `attested`, the price Bankr's prepare signed.
 */
export async function placeStartTick(
  ctx: PlanContext,
  quote: Pick<QuoteToken, "address" | "listed">,
  n: Pick<NormalizedLaunch, "startFdv" | "curve">,
  attested: LaunchParams["priceAttestation"] = EMPTY_PRICE_ATTESTATION,
): Promise<StartTick> {
  const chain = ctx.chain.chain;
  const invalid = (detail: string): never => {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain, detail });
  };
  const { startFdv, curve } = n;
  const fdv = startFdv === undefined ? null : onGrid(quoteFdvTick(startFdv));
  // Beside startFdv a curve names no second start: its market caps are in startFdv's unit and begin at it.
  if (startFdv !== undefined && curve.startMarketCap !== undefined) {
    if (curve.marketCaps === null)
      invalid("Set startFdv or curve.startFdvUsd, not both.");
    if (curve.startMarketCap !== Number(startFdv))
      invalid(
        "With startFdv set, market caps are in the quote's base units and the first range must start at startFdv.",
      );
  }
  if (!quote.listed) {
    if (fdv === null)
      return invalid(
        "A quote the factory does not list has no USD price: set startFdv, in the quote's base units.",
      );
    if (fdv.tick < MIN_START_TICK || fdv.tick > MAX_UNLISTED_START_TICK)
      invalid(
        `startFdv puts the start tick at ${fdv.tick}, outside the protocol's ${MIN_START_TICK} to ${MAX_UNLISTED_START_TICK} (above it no built-in curve can place the sale).`,
      );
    return fdv;
  }
  const f = {
    address: ctx.addresses.factory,
    abi: bankrLaunchFactoryAbi,
  } as const;
  let bounds: { lowest: number; highest: number; maxStartFdvUsd: number };
  try {
    const [[lowest, highest], [, , , maxStartFdvUsd]] = await Promise.all([
      readContract(ctx.client, {
        ...f,
        functionName: "startTickBounds",
        args: [quote.address, 0n, attested],
      }),
      readContract(ctx.client, { ...f, functionName: "pricingConfig" }),
    ]);
    bounds = { lowest, highest, maxStartFdvUsd: Number(maxStartFdvUsd) };
  } catch (cause) {
    throw new LaunchRefusedError("QUOTE_NOT_ALLOWED", {
      chain,
      cause,
      detail: "The factory cannot price this quote right now.",
    });
  }
  if (fdv !== null) {
    if (fdv.tick < bounds.lowest || fdv.tick > bounds.highest)
      invalid("startFdv is outside the factory's USD window for this quote.");
    return fdv;
  }
  const named = curve.startMarketCap;
  const targetFdvUsd =
    named ??
    (curve.builtIn === null
      ? invalid(
          "A launch with its own liquidity bands has no default start price: set curve.startFdvUsd, the whole supply's value in USD at the start (or startFdv, in the quote's base units).",
        )
      : START_FDV_USD[curve.builtIn]);
  const tick = startTickForFdv({ ...bounds, targetFdvUsd });
  if (tick === null)
    throw new LaunchExecutionError("START_TICK_CHANGED", {
      chain: ctx.chain.chain,
    });
  if (named === undefined) return { tick, offsetTicks: 0 };
  // A start the launcher named is never moved into the window: a curve drawn from it would sit elsewhere.
  const exact = onGrid(
    bounds.highest -
      Math.log(bounds.maxStartFdvUsd / targetFdvUsd) / Math.log(1.0001),
  );
  if (exact.tick !== tick)
    invalid(
      "The curve's start market cap is outside the factory's USD window for this quote.",
    );
  return exact;
}

/**
 * The launch's curve at its start tick. Market-cap ranges are placed from it, each band's end on the grid line at or
 * under its market cap, and the pad's key is read for the word that gives them; any other curve is the input's own.
 */
export async function curveAtStartTick(
  ctx: PlanContext,
  n: Pick<NormalizedLaunch, "curve" | "launchpadId">,
  offsetTicks: number,
  keys: PadCurveKeys,
): Promise<NormalizedCurve> {
  if (n.curve.marketCaps === null) return n.curve;
  const chain = ctx.chain.chain;
  const curve = curveAtStart(n.curve, offsetTicks, (detail) => {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain, detail });
  });
  // A pad open to any bands needs no listing; the word read with the launch's state is the one from a grid start.
  const listed =
    keys.anyBands || curve.word === n.curve.word
      ? keys.listed
      : await readContract(ctx.client, {
          address: ctx.addresses.launchpadRegistry,
          abi: bankrLaunchpadRegistryAbi,
          functionName: "isCurveAllowed",
          args: [n.launchpadId, curve.word],
        });
  refuseClosedCurve(chain, n.launchpadId, curve.word, { ...keys, listed });
  return curve;
}

/** The factory's recipient rules plus the claim-capability test; returns `allowCodeVestingRecipient`. */
export async function checkRecipients(
  ctx: PlanContext,
  n: NormalizedLaunch,
  suite: Omit<LiveSuite, "capController">,
  vestBps: number,
): Promise<boolean> {
  const chain = n.chain;
  const dead = suiteContracts(
    ctx.addresses,
    suite,
    await readLegReferences(ctx.client, ctx.addresses.holderLeg),
  );
  // LaunchEconomics.checkFeeRecipients holds every entry of the list to the primary's rules, and to the open-code one.
  const list = n.feeRecipients;
  const refusals = await Promise.all(
    list.map((x) =>
      refuseUnclaimableRecipient(
        ctx.client,
        chain,
        x.recipient,
        dead,
        n.allowContractFeeRecipient,
        suite.ledger,
        ctx.addresses.factory,
        { allowOpen: n.allowOpenCodeFeeRecipients, quote: n.quote.address },
      ).then(
        () => null,
        (e: unknown) => ({ e }),
      ),
    ),
  );
  const at = refusals.findIndex((x) => x !== null);
  if (at !== -1) {
    const { e } = refusals[at]!;
    // With several recipients the refusal names its entry.
    if (list.length > 1 && e instanceof LaunchRefusedError)
      throw new LaunchRefusedError(e.code, {
        chain,
        cause: e.cause,
        detail: `feeRecipients[${at}] (${list[at]!.recipient}): ${e.detail ?? e.message}`,
      });
    throw e;
  }
  const r = n.vestingRecipient;
  const invalid = (detail: string): never => {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain, detail });
  };
  if (isSentinel(r) || dead.some((d) => isAddressEqual(d, r)))
    invalid(
      "The vesting recipient cannot be a reserved address or a Bankr launch contract.",
    );
  // The factory refuses a vesting recipient with code unless the launch allows it, even when nothing vests.
  const code = await getCode(ctx.client, { address: r });
  if (!hasCode(code)) return false;
  // The factory's isSuite holds every launch's token, escrow and distributor too (InvalidVestingRecipient).
  if (
    !isDelegatedEoa(code) &&
    (await readContract(ctx.client, {
      address: ctx.addresses.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "isSuite",
      args: [r],
    }))
  )
    invalid(
      "The vesting recipient cannot be a reserved address or a Bankr launch contract.",
    );
  const ownWallet = isDelegatedEoa(code) || isAddressEqual(r, n.launcher);
  if (vestBps > 0 && !ownWallet && !n.allowContractVestingRecipient)
    invalid(
      "The vesting recipient is a contract: set vesting.allowContractRecipient if it can call release.",
    );
  return true;
}

/**
 * The plan's last steps, shared by pure and API mode: the token cross-checked against the factory, the pool and
 * distributor, the launch's own addresses kept out of its recipients, a funded simulation (dev-buy output, gas),
 * the dev-buy floor and the approvals still needed.
 */
export async function finishPlan<C extends LaunchChain>(
  ctx: PlanContext<C>,
  i: {
    n: NormalizedLaunch<C>;
    pad: PadState;
    quote: QuoteToken;
    suite: LiveSuite;
    params: LaunchParams;
    value: bigint;
    token: Address;
    /** The launch's extension, read and admitted before the salt was mined; omitted, none. */
    extension?: LaunchExtensionPreview | null;
  },
): Promise<LaunchPlan<C>> {
  const { client, addresses: a, chain: caps } = ctx;
  const chain = caps.chain;
  const { n, params } = i;
  const [onChain, tokenCode] = await Promise.all([
    readContract(client, {
      address: a.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "computeTokenAddress",
      args: [n.launcher, params.salt, params],
    }),
    getCode(client, { address: i.token }),
  ]);
  if (!isAddressEqual(onChain, i.token))
    throw new LaunchExecutionError("PREDICTION_MISMATCH", { chain });
  if (hasCode(tokenCode))
    throw new LaunchExecutionError("POOL_ALREADY_INITIALIZED", { chain });

  const escrow = predictEscrow(i.suite, n.launcher, params.salt);
  const { poolId, tokenIsCurrency0 } = poolIdOf(
    i.token,
    params.quote,
    i.suite.hook,
  );
  const distributor = await readContract(client, {
    address: a.holderRewardsDeployer,
    abi: holderRewardsDeployerAbi,
    functionName: "predict",
    args: [
      i.token,
      poolId,
      params.quote,
      escrow,
      params.econ.vestToHoldersBps > 0,
    ],
  });
  // The factory refuses the launch's own token, escrow and distributor as any recipient (review C 6).
  const own = [i.token, escrow, distributor];
  const paid = feeRecipientsOf(params, n.launcher);
  if (own.some((x) => paid.some((r) => isAddressEqual(x, r.recipient))))
    throw new LaunchRefusedError("FEE_RECIPIENT_CANNOT_CLAIM", { chain });
  if (own.some((x) => isAddressEqual(x, params.vestingRecipient)))
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail:
        "Vested tokens cannot go to this launch's own token, escrow or distributor.",
    });
  // A payee the launch names is held to the same rule (InvalidExtensionPayee); unnamed, it is the first recipient.
  if (own.some((x) => isAddressEqual(x, params.extension.payee)))
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail:
        "The extension's payee cannot be this launch's own token, escrow or distributor.",
    });

  const [sim, allowance] = await Promise.all([
    callPlannedLaunch(
      client,
      {
        chain,
        factory: a.factory,
        launcher: n.launcher,
        params,
        value: i.value,
        dataSuffix: ctx.dataSuffix,
      },
      i.quote.decimals,
    ),
    readFactoryAllowance(client, {
      params,
      launcher: n.launcher,
      factory: a.factory,
    }),
  ]);
  if (!isAddressEqual(sim.token, i.token))
    throw new LaunchExecutionError("PREDICTION_MISMATCH", { chain });
  const devBuy = i.value > 0n || params.devBuyAmountIn > 0n;
  // Refuses a launch whose gas exceeds the chain's per-transaction ceiling.
  clampLaunchGas(caps, sim.gas, devBuy, params.extraAllocations.length);

  const amount = params.devBuyAmountIn;
  const econ = params.econ;
  return {
    chain,
    provider: ctx.provider,
    factory: getAddress(a.factory),
    launcher: n.launcher,
    launchpadId: params.launchpadId,
    params: {
      ...params,
      devBuyMinOut: (sim.devBuyOut * (BPS - BigInt(n.slippageBps))) / BPS,
    },
    value: i.value,
    predictedToken: getAddress(i.token),
    poolId,
    tokenIsCurrency0,
    distributor: getAddress(distributor),
    escrow: sim.escrow,
    quote: i.quote,
    economics: econ,
    holderShareBps: holdersBpsToHolderShare(
      econ.holdersBps,
      econ.autoLpBps,
      econ.buybackBps,
    ),
    volumeSplit: volumeSplit({
      steadyPips: econ.buy.steadyPips,
      terms: i.pad.terms,
      economics: econ,
    }),
    approvals:
      amount > allowance
        ? [
            buildApproveTx(
              caps.chainId,
              n.launcher,
              params.quote,
              getAddress(a.factory),
              amount,
            ),
          ]
        : [],
    devBuyOut: sim.devBuyOut,
    extension: i.extension ?? null,
    gasEstimate: sim.gas,
    dataSuffix: ctx.dataSuffix,
  };
}

/**
 * Pure mode: validates and refuses, reads the pad and its defaults, holds an extension to the registry's allowlist
 * and the pad's policy, places the start tick, mines the pad's vanity salt (cross-checked against the factory), has
 * a signed pad's authorizer sign the terms (the extension's included), simulates the launch (a
 * dev buy with the launcher funded and approved by state override) for the dev buy's output and the gas, and lists
 * the approvals an ERC-20 dev buy still needs.
 */
export async function planLaunch<C extends LaunchChain>(
  ctx: PlanContext<C>,
  input: LaunchInput<C>,
): Promise<LaunchPlan<C>> {
  const caps = ctx.chain;
  const chain = caps.chain;
  const refuse = (code: CodeOfKind<"refused">, detail?: string): never => {
    throw new LaunchRefusedError(code, { chain, detail });
  };
  const n = normalizeLaunchInput(caps, input, ctx.usedSalts);
  const capExclusions = requireCapExclusions(chain);
  // Bankr signs every id-0 launch with its own key, reachable only through the prepare endpoint.
  if (n.launchpadId === BANKR_LAUNCHPAD_ID) refuse("AUTHORIZATION_REQUIRED");
  const s = await readLaunchState(ctx, n);
  refuseGates(chain, s, n.launchpadId, n.quote.address);
  // Market-cap ranges get their word from the start tick: their key is checked once it is known, before any salt.
  if (n.curve.marketCaps === null)
    refuseClosedCurve(chain, n.launchpadId, n.curve.word, s.curveKeys);
  if (s.quote.decimals === null)
    refuse(
      "INVALID_PARAMS",
      "The quote's decimals() cannot be read, or is above 36: it is not an ERC-20 the launch can use.",
    );
  if (s.quote.listed && s.quote.pricing === "signed")
    refuse("PRICE_ATTESTATION_REQUIRED");
  const signer = padSigner(s.pad);
  if (signer !== null && !ctx.authorizer) refuse("AUTHORIZATION_REQUIRED");

  const quote = quoteToken(caps, n.quote, s.quote, s.weth);
  const economics = resolveEconomics(n, s.pad, quote.listed);
  const vestBps = n.vestBps ?? s.pad.pad.policy.defaultVestBps;
  checkEconomics(economics, vestBps, chain);
  checkPadTerms(s.pad, {
    economics,
    vestBps,
    usesBuilderLane: usesBuilderLane({
      extraAllocations: 0,
      capExclusions: capExclusions.length,
      devBuy: n.devBuyAmount,
      totalSupply: 0n,
    }),
    chain,
  });
  checkStartTime({
    startTime: n.startTime,
    nowSeconds: Math.floor(Date.now() / 1000),
    maxStartDelaySecs: s.pad.pad.policy.maxStartDelay,
    chain,
  });
  const native = quote.devBuy === "native";
  const [start, allowCodeVestingRecipient, extension] = await Promise.all([
    placeStartTick(ctx, quote, n),
    checkRecipients(ctx, n, s.suite, vestBps),
    n.extension &&
      requireExtension(ctx, n.extension, {
        policy: s.pad.pad.policy,
        fees: economics,
        payee: n.feeRecipients[0]!.recipient,
      }),
  ]);
  const tick = start.tick;
  const curve = await curveAtStartTick(ctx, n, start.offsetTicks, s.curveKeys);

  const draft = buildLaunchParams({
    ...n,
    curve,
    quote: quote.address,
    capExclusions,
    startTick: tick,
    deadline: BigInt(Math.floor(Date.now() / 1000) + n.deadlineSeconds),
    economics,
    launchpadId: n.launchpadId,
    maxOperatorShareBps: s.pad.maxOperatorShareBps,
    operatorPayeesHash: s.pad.termsHash,
    vestBps,
    allowCodeVestingRecipient,
    devBuyAmountIn: native ? 0n : n.devBuyAmount,
  });
  // The launch's own bands, held to the pool's rules in both token orders: the salt decides the order later.
  if (curve.builtIn === null)
    refuseBrokenCurve(
      {
        curve: curve.word,
        startTick: tick,
        sale: launchSale(draft),
        ownBuys: curveOwnBuys({
          buybackBps: economics.buybackBps,
          autoLpBps: economics.autoLpBps,
          padDecay: s.pad.terms.decay,
          extensionCallsOut: n.extension ? !n.extension.terms.quoteOnly : false,
        }),
      },
      chain,
      curve.marketCaps !== null,
    );
  const rule = vanityRule(n.launchpadId, s.pad.pad.vanity);
  let salt: Hex;
  let token: Address;
  if (n.salt !== undefined) {
    salt = n.salt;
    token = predictToken(s.suite, draft, n.launcher, salt);
    if (!addressMatchesVanity(token, rule))
      refuse(
        "INVALID_PARAMS",
        "This salt's token address does not carry the launchpad's vanity rule.",
      );
  } else {
    const mined = await mineVanitySalt({
      suite: s.suite,
      identity: draft,
      launcher: n.launcher,
      rule,
    });
    if (mined === null) throw vanityUnavailable(chain, n.launchpadId, rule);
    ({ salt, token } = mined);
  }
  let params: LaunchParams = { ...draft, salt };
  const value = native ? n.devBuyAmount : 0n;
  if (signer !== null) {
    const authorization = parseAuthorization(
      await ctx.authorizer!({
        chain,
        chainId: caps.chainId,
        registry: ctx.addresses.launchpadRegistry,
        factory: ctx.addresses.factory,
        launchpadId: n.launchpadId,
        launcher: n.launcher,
        params,
        nativeDevBuy: value,
        paramsHash: launchTermsHash(params, n.launcher, value),
        signer,
      }),
    );
    if (authorization === null)
      throw new LaunchExecutionError("AUTHORIZATION_INVALID", { chain });
    params = { ...params, authorization };
  }
  return finishPlan(ctx, {
    n,
    pad: s.pad,
    quote,
    suite: s.suite,
    params,
    value,
    token,
    extension,
  });
}
