import type { Address, Hex } from "viem";
import { BANKR_V4_CAP_EXCLUSIONS } from "../addresses.js";
import { parseAuthorization } from "../authorizer.js";
import type { LaunchChain } from "../chains/index.js";
import { refuseBrokenCurve, refuseMalformedCurve } from "../curveDetail.js";
import { curveAtStart } from "../curveInput.js";
import {
  LaunchExecutionError,
  LaunchRefusedError,
  type CodeOfKind,
} from "../errors.js";
import { buildLaunchParams, type NormalizedLaunch } from "../normalize.js";
import { checkRecipients } from "../plan.js";
import {
  predictToken,
  readLivePointers,
  type LivePointers,
} from "../predict.js";
import type { LaunchPlan, QuoteToken } from "../providers/types.js";
import {
  addressMatchesVanity,
  mineVanitySalt,
  vanityRule,
  vanityUnavailable,
} from "../salt.js";
import { launchTermsHash } from "../terms.js";
import { pinExtensionPreview, requireExtension } from "./extension.js";
import { launchCapExclusions, featureOptionsOf } from "./featureOptions.js";
import {
  encodeLaunchOptions,
  launchOptions,
  pinLaunchOptions,
} from "./options.js";
import { checkLaunchPreset, presetIsQuoteOnly } from "./presets.js";
import {
  placeStartTick,
  requireClaimOperators,
  economicsOf,
  launchQuote,
  type LaunchPlanContext,
} from "./planChecks.js";
import { launchCallError } from "./revert.js";
import {
  knobInForce,
  readLaunchState,
  resolveLaunchTerms,
  maxOperatorShareBps,
  padTermsHash,
  type ResolvedTerms,
  type ContractLaunchParams,
  type LaunchState,
} from "./settings.js";

// One pass of a plan up to its signature: the pad's defaults, the start, the chain's launch check, the salt
// and the pins. plan.ts holds the result to the factory and simulates it. Vendored from core's bankr-v4 launch preparation.

type Ctx<C extends LaunchChain> = LaunchPlanContext<C>;

export interface LaunchDraft {
  s: LaunchState;
  live: LivePointers;
  quote: QuoteToken;
  params: ContractLaunchParams;
  value: bigint;
  token: Address;
  resolved: ResolvedTerms;
  extension: LaunchPlan["extension"];
}

export /** One pass: the draft, the launch check, the checks only the factory runs, the salt, the pins and the signature. */
async function draftLaunch<C extends LaunchChain>(
  ctx: Ctx<C>,
  n: NormalizedLaunch<C>,
): Promise<LaunchDraft> {
  const caps = ctx.chain;
  const chain = caps.chain;
  const a = ctx.addresses;
  const c = n.choices;
  const refuse = (code: CodeOfKind<"refused">, detail?: string): never => {
    throw new LaunchRefusedError(code, { chain, detail });
  };
  const [s, live] = await Promise.all([
    readLaunchState(ctx.client, a, {
      padId: n.launchpadId,
      quote: n.quote.address,
    }),
    readLivePointers(ctx.client, a.factory),
  ]);
  const quote = await launchQuote(ctx, n, s);
  const signer =
    BigInt(s.registryPad.signer) === 0n ? null : s.registryPad.signer;
  if (signer !== null && !ctx.authorizer)
    throw new LaunchRefusedError("AUTHORIZATION_REQUIRED", {
      chain,
      detail: "Pass the client this launchpad's authorizer.",
    });

  const economics = economicsOf(n, s);
  const vestBps = n.vestBps ?? Number(knobInForce(s, "vestBps").dflt);
  const options = featureOptionsOf(
    c,
    s,
    {
      vestBps,
      buybackBps: economics.buybackBps,
      autoLpBps: economics.autoLpBps,
      hasExtension: n.extension !== null,
    },
    chain,
  );
  const capExclusions = launchCapExclusions(
    c,
    s,
    BANKR_V4_CAP_EXCLUSIONS[chain],
    chain,
  );
  const native = quote.devBuy === "native";
  const [start, allowCodeVestingRecipient, preview] = await Promise.all([
    placeStartTick(ctx, n, s, quote, c.supply),
    checkRecipients(ctx, n, live, vestBps),
    n.extension === null
      ? null
      : requireExtension(ctx, n.extension, {
          state: s,
          fees: economics,
          payee: n.feeRecipients[0]!.recipient,
          feeCeilingPips: c.feeCeilingPips,
        }),
  ]);
  const curve = curveAtStart(n.curve, start.offsetTicks, (detail) =>
    refuse("INVALID_PARAMS", detail),
  );
  // `resolve` raises a table's form as a bare InvalidCurve: held here first, where the sentence says what to change.
  if (curve.builtIn === null)
    refuseMalformedCurve(curve.word, start.tick, chain);
  const draft: ContractLaunchParams = {
    ...buildLaunchParams({
      ...n,
      curve,
      quote: quote.address,
      capExclusions,
      startTick: start.tick,
      deadline: BigInt(Math.floor(Date.now() / 1000) + n.deadlineSeconds),
      economics,
      launchpadId: n.launchpadId,
      // Pin the pad's payees as read: an operator change before inclusion reverts the launch.
      maxOperatorShareBps: maxOperatorShareBps(s.pad.terms),
      operatorPayeesHash: padTermsHash(s.pad.terms),
      vestBps,
      allowCodeVestingRecipient,
      devBuyAmountIn: native ? 0n : n.devBuyAmount,
    }),
    totalSupply: c.supply ?? 0n,
    extraAllocations: c.allocations.map((x) => ({ ...x, push: false })),
    options: encodeLaunchOptions(launchOptions(options)),
  };
  const value = native ? n.devBuyAmount : 0n;
  const resolved = await resolveLaunchTerms(ctx.client, a.settings, {
    launcher: n.launcher,
    nativeDevBuy: value,
    params: draft,
  }).catch((error: unknown) => {
    throw launchCallError(error, chain);
  });
  const t = resolved.terms;
  // `resolve` builds no preset: its constructor's bounds are held here, against the site the coin will freeze.
  checkLaunchPreset(draft.extension, t.presetSite, chain);
  // The preview was read before `resolve`: its cut, ceiling and fees are shown as the pinned terms hold them.
  const extension =
    preview === null || n.extension === null
      ? null
      : pinExtensionPreview(preview, n.extension, t.pool);
  // The launch's own bands against the coin's own rules, in both token orders: the salt decides the order later.
  if (curve.builtIn === null)
    refuseBrokenCurve(
      {
        curve: curve.word,
        startTick: start.tick,
        sale: t.totalSupply - t.vestedAmount,
        ownBuys:
          t.pool.creatorLp ||
          t.pool.decayLp ||
          t.pool.buyback ||
          t.pool.afterGas !== 0 ||
          presetIsQuoteOnly(t.presetId) === false,
        rules: t.curve,
      },
      chain,
      curve.marketCaps !== null,
    );
  await requireClaimOperators(ctx, n, live.ledger, t);

  const rule = vanityRule(n.launchpadId, s.registryPad.vanity);
  const identity = { ...draft, terms: t };
  let salt: Hex;
  let token: Address;
  if (n.salt !== undefined) {
    salt = n.salt;
    token = predictToken(live, identity, n.launcher, salt);
    if (!addressMatchesVanity(token, rule))
      refuse(
        "INVALID_PARAMS",
        "This salt's token address does not carry the launchpad's vanity rule.",
      );
  } else {
    const mined = await mineVanitySalt({
      live,
      identity,
      launcher: n.launcher,
      rule,
    });
    if (mined === null) throw vanityUnavailable(chain, n.launchpadId, rule);
    ({ salt, token } = mined);
  }
  let params: ContractLaunchParams = {
    ...draft,
    salt,
    options: pinLaunchOptions(draft.options, {
      expectedTermsHash: resolved.resolvedHash,
      expectedToken: token,
    }),
  };
  if (signer !== null) {
    const authorization = parseAuthorization(
      await ctx.authorizer!({
        chain,
        chainId: caps.chainId,
        registry: a.launchpadRegistry,
        factory: a.factory,
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
  return { s, live, quote, params, value, token, resolved, extension };
}
