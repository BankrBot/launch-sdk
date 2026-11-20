import { isAddress, isAddressEqual, type Address } from "viem";
import { launchParamsFromJson } from "./abiJson.js";
import { requireCapExclusions } from "./addresses.js";
import type { PrepareRequest, PrepareResponse, Preparer } from "./api.js";
import { prepareRanges } from "./apiRanges.js";
import { parseAuthorization } from "./authorizer.js";
import type { LaunchChain } from "./chains/index.js";
import { CURVE_NAMES } from "./curve.js";
import { curveOwnBuys, launchSale } from "./curveCheck.js";
import { refuseBrokenCurve, refuseClosedCurve } from "./curveDetail.js";
import type { NormalizedCurve } from "./curveInput.js";
import {
  checkEconomics,
  holderShareToHoldersBps,
  type LaunchParams,
} from "./economics.js";
import {
  LaunchApiError,
  LaunchExecutionError,
  LaunchRefusedError,
  isLaunchSdkError,
} from "./errors.js";
import { padSigner } from "./launchpad.js";
import {
  checkStartTime,
  normalizeLaunchInput,
  type NormalizedLaunch,
} from "./normalize.js";
import {
  finishPlan,
  readLaunchState,
  refuseGates,
  type PlanContext,
} from "./plan.js";
import type { LaunchInput, LaunchPlan } from "./providers/types.js";
import { quoteToken } from "./quotes.js";
import { feeRecipientsOf, launchTermsHash, NO_EXTENSION } from "./terms.js";

const DECIMAL = /^\d+$/;

/** The request in the API's units; economic fields only where the input set them, so Bankr applies the pad's defaults. */
function toPrepareRequest(
  n: NormalizedLaunch,
  input: LaunchInput,
): PrepareRequest {
  const economics: NonNullable<PrepareRequest["economics"]> = {
    ...(n.schedule ? { buy: n.schedule.buy, sell: n.schedule.sell } : {}),
    ...(n.holderShareBps === undefined
      ? {}
      : { holderShareBps: n.holderShareBps }),
    ...(n.autoLpBps === undefined ? {} : { autoLpBps: n.autoLpBps }),
    ...(n.buybackBps === undefined ? {} : { buybackBps: n.buybackBps }),
    ...(n.referrerBps === undefined ? {} : { referrerBps: n.referrerBps }),
    ...(input.vestToHolders ? { vestToHolders: input.vestToHolders } : {}),
  };
  // The default curve is the API's own default; own bands go out as bands, whichever form the input took
  // (market-cap ranges as apiRanges.ts placed them).
  const curve: PrepareRequest["curve"] =
    n.curve.builtIn === null
      ? { bands: n.curve.bands, startFdvUsd: n.curve.startMarketCap as number }
      : n.curve.builtIn === 0
        ? undefined
        : CURVE_NAMES[n.curve.builtIn];
  return {
    chain: n.chain,
    launcher: n.launcher,
    launchpadId: n.launchpadId.toString(),
    name: n.name,
    symbol: n.symbol,
    ...(input.metadataUri ? { metadataUri: input.metadataUri } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(BigInt(n.metadataAdmin) === 0n
      ? {}
      : { metadataAdmin: n.metadataAdmin }),
    quote: n.quote.address,
    feeRecipients: n.feeRecipients.map((r) => ({
      address: r.recipient,
      bps: r.shareBps,
    })),
    ...(n.allowOpenCodeFeeRecipients
      ? { allowOpenCodeFeeRecipients: true }
      : {}),
    ...(n.startTime === 0 ? {} : { startTime: n.startTime }),
    ...(curve === undefined ? {} : { curve }),
    ...(input.vesting
      ? {
          vesting: {
            bps: input.vesting.bps,
            ...(input.vesting.recipient
              ? { recipient: n.vestingRecipient }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(economics).length > 0 ? { economics } : {}),
    ...(n.devBuyAmount > 0n
      ? { devBuy: { amount: n.devBuyAmount.toString() } }
      : {}),
  };
}

/**
 * Holds a prepare to the request and this client's suite: the same chain, factory, launcher and pad; the requested
 * name, symbol, quote, curve, recipients (their order, shares and waiver), metadata admin, start time, economics,
 * vesting and dev buy; the chain's cap exclusions; no extension or allocations; the pad's live terms pinned. Anything
 * else is `API_ERROR`: a preparer chooses the salt, the start tick, Bankr's pin and signatures, nothing that moves funds.
 */
function verifyPrepared(
  ctx: PlanContext,
  n: NormalizedLaunch,
  input: LaunchInput,
  r: PrepareResponse,
  termsHash: string,
): { params: LaunchParams; value: bigint } {
  const chain = ctx.chain.chain;
  const fail = (field: string): never => {
    throw new LaunchApiError("API_ERROR", {
      chain,
      cause: new TypeError(
        `The prepared launch does not match the request: ${field}`,
      ),
    });
  };
  const same = (a: unknown, b: Address) =>
    typeof a === "string" &&
    isAddress(a, { strict: false }) &&
    isAddressEqual(a, b);
  if (r.chain !== chain || r.chainId !== ctx.chain.chainId) fail("chain");
  if (!same(r.factory, ctx.addresses.factory)) fail("factory");
  if (!same(r.launcher, n.launcher)) fail("launcher");
  if (r.launchpadId !== n.launchpadId.toString()) fail("launchpadId");
  if (!isAddress(r.predictedToken, { strict: false })) fail("predictedToken");
  let p: LaunchParams;
  try {
    p = launchParamsFromJson(r.params);
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : "params");
  }
  if (p.launchpadId !== n.launchpadId) fail("params.launchpadId");
  if (p.name !== n.name || p.symbol !== n.symbol) fail("name or symbol");
  if (p.metadataUri !== r.metadataUri) fail("metadataUri");
  if (input.metadataUri && p.metadataUri !== input.metadataUri)
    fail("metadataUri");
  if (!isAddressEqual(p.quote, n.quote.address)) fail("quote");
  if (p.curveId !== n.curve.word) fail("curve");
  const resolve = (a: Address) => (BigInt(a) === 0n ? n.launcher : a);
  // The list's order is a term (the first is the primary); none named comes back empty, the launcher alone.
  const paid = feeRecipientsOf(p, n.launcher);
  if (
    paid.length !== n.feeRecipients.length ||
    n.feeRecipients.some(
      (want, i) =>
        !isAddressEqual(paid[i]!.recipient, want.recipient) ||
        paid[i]!.shareBps !== want.shareBps,
    )
  )
    fail("feeRecipients");
  if (p.allowOpenCodeFeeRecipients !== n.allowOpenCodeFeeRecipients)
    fail("allowOpenCodeFeeRecipients");
  if (!isAddressEqual(p.metadataAdmin, n.metadataAdmin)) fail("metadataAdmin");
  if (p.startTime !== BigInt(n.startTime)) fail("startTime");
  if (!isAddressEqual(resolve(p.vestingRecipient), n.vestingRecipient))
    fail("vestingRecipient");
  if (n.vestBps !== undefined && p.vestBps !== n.vestBps) fail("vestBps");
  if (p.totalSupply !== 0n || p.extraAllocations.length > 0)
    fail("supply or allocations");
  const ex = requireCapExclusions(chain);
  if (
    p.capExclusions.length !== ex.length ||
    p.capExclusions.some((a, i) => !isAddressEqual(a, ex[i]!))
  )
    fail("capExclusions");
  if (p.extension.id !== NO_EXTENSION.id || BigInt(p.extension.ext) !== 0n)
    fail("extension");
  if (p.operatorPayeesHash.toLowerCase() !== termsHash.toLowerCase())
    fail("operatorPayeesHash");

  const e = p.econ;
  if (n.schedule) {
    for (const [got, want] of [
      [e.buy, n.schedule.buy],
      [e.sell, n.schedule.sell],
    ] as const) {
      if (
        got.startPips !== want.startPips ||
        got.steadyPips !== want.steadyPips ||
        got.decaySecs !== want.decaySecs
      )
        fail("fee schedule");
    }
  }
  if (n.autoLpBps !== undefined && e.autoLpBps !== n.autoLpBps)
    fail("autoLpBps");
  if (n.buybackBps !== undefined && e.buybackBps !== n.buybackBps)
    fail("buybackBps");
  if (n.referrerBps !== undefined && e.referrerBps !== n.referrerBps)
    fail("referrerBps");
  if (e.autoLpBps + e.buybackBps > 10_000) fail("economics");
  if (
    n.holderShareBps !== undefined &&
    e.holdersBps !==
      holderShareToHoldersBps(n.holderShareBps, e.autoLpBps, e.buybackBps)
  )
    fail("holderShareBps");
  const v = n.vestToHolders;
  if (
    (v?.bps ?? 0) !== e.vestToHoldersBps ||
    (v !== undefined &&
      (e.vestToHoldersCliff !== BigInt(v.cliffSecs) ||
        e.vestToHoldersDuration !== BigInt(v.durationSecs)))
  )
    fail("vestToHolders");

  if (!DECIMAL.test(r.value)) fail("value");
  const value = BigInt(r.value);
  const native = value > 0n;
  const amount = native ? value : p.devBuyAmountIn;
  if (amount !== n.devBuyAmount || (native && p.devBuyAmountIn !== 0n))
    fail("devBuy");
  const approvalOk =
    r.approval === null
      ? native || amount === 0n
      : !native &&
        same(r.approval.token, p.quote) &&
        r.approval.amount === amount.toString();
  if (!approvalOk) fail("approval");
  if (ctx.usedSalts.has(p.salt.toLowerCase())) fail("salt reused");
  return { params: p, value };
}

/**
 * API mode: Bankr's prepare endpoint builds the launch (it pins `metadata`, prices a SIGNED quote, and signs id 0's
 * terms; a prepare-scoped key earns `prepared` attribution). The SDK holds the response to its own input and suite,
 * has a third-party pad's `authorizer` sign when Bankr returns the terms unsigned, simulates the launch itself and
 * sets the dev-buy floor (blanked in the signed terms), then sends only calldata it encoded. A caller's `salt` is
 * `INVALID_PARAMS`: the salt is Bankr's. So is an `extension`: the endpoint takes none. Market-cap ranges are
 * prepared as bands placed from the start tick.
 */
export async function planWithPreparer<C extends LaunchChain>(
  ctx: PlanContext<C>,
  preparer: Preparer,
  input: LaunchInput<C>,
): Promise<LaunchPlan<C>> {
  const chain = ctx.chain.chain;
  if (input.salt !== undefined)
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail: "In API mode the salt is Bankr's: omit salt.",
    });
  if (input.extension !== undefined)
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail:
        "Bankr's prepare endpoint takes no extension: launch one in pure mode, on a launchpad other than Bankr's own.",
    });
  if (input.metadata !== undefined && input.metadataUri)
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail: "Pass metadata or metadataUri, not both.",
    });
  const n = normalizeLaunchInput(ctx.chain, input, ctx.usedSalts, {
    allowMetadata: true,
  });
  requireCapExclusions(chain);
  const s = await readLaunchState(ctx, n);
  refuseGates(chain, s, n.launchpadId, n.quote.address);
  if (!s.quote.listed)
    throw new LaunchRefusedError("QUOTE_NOT_ALLOWED", {
      chain,
      detail:
        "Bankr's API prepares only quotes the factory lists: launch this one in pure mode on your own launchpad.",
    });
  if (n.startFdv !== undefined)
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail: "In API mode Bankr places the start price: omit startFdv.",
    });
  // Market-cap ranges get their word from the start tick: their key is checked once it is read.
  if (n.curve.marketCaps === null)
    refuseClosedCurve(chain, n.launchpadId, n.curve.word, s.curveKeys);
  if (n.curve.builtIn === null && n.curve.startMarketCap === undefined)
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail:
        "In API mode a launch with its own liquidity bands names its start price in USD: set curve.startFdvUsd.",
    });
  checkStartTime({
    startTime: n.startTime,
    nowSeconds: Math.floor(Date.now() / 1000),
    maxStartDelaySecs: s.pad.pad.policy.maxStartDelay,
    chain,
  });

  const quote = quoteToken(ctx.chain, n.quote, s.quote, s.weth);
  const prepare = async (curve: NormalizedCurve) => {
    const at = { ...n, curve };
    let response: PrepareResponse;
    try {
      response = await preparer(toPrepareRequest(at, input));
    } catch (err) {
      if (isLaunchSdkError(err)) throw err;
      throw new LaunchApiError("API_ERROR", { chain, cause: err });
    }
    const held = verifyPrepared(ctx, at, input, response, s.pad.termsHash);
    return { response, ...held };
  };
  const { response, ...verified } =
    n.curve.marketCaps === null
      ? await prepare(n.curve)
      : await prepareRanges(ctx, n, s, quote, prepare);
  let params = verified.params;
  const signer = padSigner(s.pad);
  checkEconomics(params.econ, params.vestBps, chain);
  // The prepared salt fixes the token's side of the pool: its own bands are held to the rules in that order.
  if (n.curve.builtIn === null)
    refuseBrokenCurve(
      {
        curve: params.curveId,
        startTick: params.expectedStartTick,
        tokenIsCurrency0:
          BigInt(response.predictedToken) < BigInt(params.quote),
        sale: launchSale(params),
        ownBuys: curveOwnBuys({
          buybackBps: params.econ.buybackBps,
          autoLpBps: params.econ.autoLpBps,
          padDecay: s.pad.terms.decay,
          extensionCallsOut: false,
        }),
      },
      chain,
      n.curve.marketCaps !== null,
    );

  if (signer !== null && response.authorization === null) {
    // Bankr returns a third-party signed pad's terms unsigned; the pad's own authorizer signs them here.
    if (!ctx.authorizer)
      throw new LaunchRefusedError("AUTHORIZATION_REQUIRED", { chain });
    const authorization = parseAuthorization(
      await ctx.authorizer({
        chain,
        chainId: ctx.chain.chainId,
        registry: ctx.addresses.launchpadRegistry,
        factory: ctx.addresses.factory,
        launchpadId: n.launchpadId,
        launcher: n.launcher,
        params,
        nativeDevBuy: verified.value,
        paramsHash: launchTermsHash(params, n.launcher, verified.value),
        signer,
      }),
    );
    if (authorization === null)
      throw new LaunchExecutionError("AUTHORIZATION_INVALID", { chain });
    params = { ...params, authorization };
  }
  const plan = await finishPlan(ctx, {
    n: { ...n, metadataUri: params.metadataUri },
    pad: s.pad,
    quote,
    suite: s.suite,
    params,
    value: verified.value,
    token: response.predictedToken,
  });
  return response.prepareId === null
    ? plan
    : { ...plan, prepareId: response.prepareId };
}
