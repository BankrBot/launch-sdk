import { erc20Abi, type Address } from "viem";
import { getCode, readContract } from "viem/actions";
import {
  bankrFeeLedgerAbi,
  bankrLaunchSettingsAbi,
} from "../abis/generated.js";
import type { LaunchChain } from "../chains/index.js";
import {
  START_FDV_USD,
  holderShareToHoldersBps,
  quoteFdvTick,
  startTickForFdv,
  type LaunchEconomics,
} from "../economics.js";
import {
  LaunchExecutionError,
  LaunchRefusedError,
  type CodeOfKind,
} from "../errors.js";
import { BANKR_LAUNCHPAD_ID } from "../launchpad.js";
import type { NormalizedLaunch } from "../normalize.js";
import { onGrid, type PlanContext, type StartTick } from "../plan.js";
import type { QuoteToken } from "../providers/types.js";
import { MAX_QUOTE_DECIMALS, quoteToken } from "../quotes.js";
import { hasCode, isDelegatedEoa } from "../recipient.js";
import { EMPTY_PRICE_ATTESTATION } from "../terms.js";
import { knobRefusal } from "./refusals.js";
import {
  KNOB,
  flagInForce,
  knobInForce,
  type CoinTerms,
  type KnobName,
  type LaunchState,
} from "./settings.js";

// What a plan settles before the chain's launch check: the pad's default economics, the start tick, the
// factory's and the pad's gates on the quote, and (after it) the claim operator a takeover coin's contract recipient
// needs. Vendored from core's bankr-v4 launch preparation.

const PRICING = ["none", "chainlink", "signed"] as const;

/** A plan's context. */
export type LaunchPlanContext<C extends LaunchChain = LaunchChain> =
  PlanContext<C>;

type Ctx<C extends LaunchChain> = LaunchPlanContext<C>;

/** The launch's economics on a pad: what it names, and for the rest the pad's default as the owner's limits
 *  leave it. A pad's opening fee applies with its default decay; with either missing the fee is flat. */
export function economicsOf(
  n: Pick<
    NormalizedLaunch,
    | "schedule"
    | "referrerBps"
    | "holderShareBps"
    | "autoLpBps"
    | "buybackBps"
    | "vestToHolders"
    | "chain"
  >,
  s: Pick<LaunchState, "pad" | "limits">,
): LaunchEconomics {
  const dflt = (knob: KnobName) => Number(knobInForce(s, knob).dflt);
  const steadyPips = dflt("steadyPips");
  const decay = knobInForce(s, "decaySecs");
  const opens = decay.dflt !== 0n && dflt("startPips") > steadyPips;
  // A pad that requires a decay and defaults no opening fee to decay from: its defaults, not the launch's terms.
  if (!opens && decay.min !== 0n && !n.schedule)
    throw new LaunchRefusedError("FEE_OUT_OF_BOUNDS", {
      chain: n.chain,
      detail:
        "This launchpad's default fees do not fit together: it requires an opening fee that decays and sets none above its trading fee. Name the launch's own fees, or ask the launchpad to set its defaults again.",
    });
  const own = {
    startPips: opens ? dflt("startPips") : steadyPips,
    steadyPips,
    decaySecs: opens ? Number(decay.dflt) : 0,
  };
  const autoLpBps = n.autoLpBps ?? dflt("autoLpBps");
  const buybackBps = n.buybackBps ?? dflt("buybackBps");
  const v = n.vestToHolders;
  return {
    buy: n.schedule?.buy ?? own,
    sell: n.schedule?.sell ?? own,
    referrerBps: n.referrerBps ?? dflt("referrerBps"),
    holdersBps:
      n.holderShareBps === undefined
        ? dflt("holdersBps")
        : holderShareToHoldersBps(n.holderShareBps, autoLpBps, buybackBps),
    autoLpBps,
    buybackBps,
    vestToHoldersBps: v ? v.bps : 0,
    vestToHoldersCliff: v ? BigInt(v.cliffSecs) : 0n,
    vestToHoldersDuration: v ? BigInt(v.durationSecs) : 0n,
  };
}

/**
 * The start tick. An unlisted quote's comes from `startFdv` alone: the launcher prices it, and the curve
 * and the launch check decide whether it launches. A listed quote's sits in the pad's USD window at the quote's
 * price (`settings.startTickBounds`): `startFdv`'s, the start the launch's curve names, or the pad's default.
 */
export async function placeStartTick(
  ctx: Ctx<LaunchChain>,
  n: Pick<NormalizedLaunch, "startFdv" | "curve" | "launchpadId">,
  s: LaunchState,
  quote: Pick<QuoteToken, "address" | "listed">,
  supply: bigint | undefined,
): Promise<StartTick> {
  const chain = ctx.chain.chain;
  const invalid = (detail: string): never => {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain, detail });
  };
  const { startFdv, curve } = n;
  const whole = knobInForce(s, "supply").dflt * 10n ** 18n;
  const fdv =
    startFdv === undefined
      ? null
      : onGrid(quoteFdvTick(startFdv, supply ?? whole));
  if (startFdv !== undefined && curve.startMarketCap !== undefined) {
    if (curve.marketCaps === null)
      invalid("Set startFdv or curve.startFdvUsd, not both.");
    if (curve.startMarketCap !== Number(startFdv))
      invalid(
        "With startFdv set, market caps are in the quote's base units and the first range must start at startFdv.",
      );
  }
  if (!quote.listed)
    return (
      fdv ??
      invalid(
        "A quote Bankr does not list has no USD price: set startFdv, in the quote's base units.",
      )
    );
  const range = knobInForce(s, "startFdvUsd");
  const [min, max] = [Number(range.min), Number(range.max)];
  let bounds: { lowest: number; highest: number; maxStartFdvUsd: number };
  try {
    const [lowest, highest] = await readContract(ctx.client, {
      address: ctx.addresses.settings,
      abi: bankrLaunchSettingsAbi,
      functionName: "startTickBounds",
      args: [
        n.launchpadId,
        quote.address,
        supply ?? 0n,
        EMPTY_PRICE_ATTESTATION,
      ],
    });
    bounds = { lowest, highest, maxStartFdvUsd: max };
  } catch (cause) {
    throw new LaunchRefusedError("QUOTE_NOT_ALLOWED", {
      chain,
      cause,
      detail: "This quote cannot be priced right now.",
    });
  }
  if (fdv !== null) {
    if (fdv.tick < bounds.lowest || fdv.tick > bounds.highest)
      invalid(
        "startFdv is outside this launchpad's USD window for this quote.",
      );
    return fdv;
  }
  const named = curve.startMarketCap;
  if (named !== undefined && !(named >= min && named <= max))
    throw new LaunchRefusedError("OUTSIDE_LAUNCHPAD_RANGE", {
      chain,
      detail: knobRefusal(KNOB.startFdvUsd, range.min, range.max),
    });
  // The pad's default start, scaled as the built-in curves scale theirs (degen starts at a quarter), held inside
  // the pad's range.
  const scaled = (builtIn: 0 | 1 | 2) =>
    Math.min(
      Math.max(
        (Number(range.dflt) * START_FDV_USD[builtIn]) / START_FDV_USD[0],
        min,
      ),
      max,
    );
  const targetFdvUsd =
    named ??
    (curve.builtIn === null
      ? invalid(
          "A launch with its own liquidity bands has no default start price: set curve.startFdvUsd, the whole supply's value in USD at the start (or startFdv, in the quote's base units).",
        )
      : scaled(curve.builtIn));
  const tick = startTickForFdv({ ...bounds, targetFdvUsd });
  if (tick === null)
    throw new LaunchExecutionError("START_TICK_CHANGED", { chain });
  if (named === undefined) return { tick, offsetTicks: 0 };
  // A start the launcher named is never moved into the window: a curve drawn from it would sit elsewhere.
  const exact = onGrid(
    bounds.highest -
      Math.log(bounds.maxStartFdvUsd / targetFdvUsd) / Math.log(1.0001),
  );
  if (exact.tick !== tick)
    invalid(
      "The curve's start market cap is outside this launchpad's USD window for this quote.",
    );
  return exact;
}

/** The pad's and the factory's gates, and the quote as this launch may use it. */
export async function launchQuote<C extends LaunchChain>(
  ctx: Ctx<C>,
  n: NormalizedLaunch<C>,
  s: LaunchState,
): Promise<QuoteToken> {
  const chain = ctx.chain.chain;
  const refuse = (code: CodeOfKind<"refused">, detail?: string): never => {
    throw new LaunchRefusedError(code, { chain, detail });
  };
  if (s.paused) refuse("PAUSED");
  if (s.gated && n.launchpadId !== BANKR_LAUNCHPAD_ID)
    refuse("LAUNCHPAD_GATED");
  // Ids run 1 to launchpadCount, plus Bankr's 0: the newest pad's id is the count itself.
  if (n.launchpadId > s.padCount) refuse("UNKNOWN_LAUNCHPAD");
  if (s.registryPad.paused) refuse("LAUNCHPAD_PAUSED");
  if (!s.padTakesQuote)
    refuse(
      "QUOTE_NOT_ALLOWED",
      "This launchpad does not take this quote token.",
    );
  const listed = s.quote.allowed;
  if (!listed && !flagInForce(s, "unlistedQuotes"))
    refuse(
      "QUOTE_NOT_ALLOWED",
      "This launchpad does not allow a quote token Bankr does not list.",
    );
  const pricing = PRICING[s.quote.mode] ?? "none";
  if (listed && pricing === "none") refuse("QUOTE_NOT_ALLOWED");
  if (listed && pricing === "signed") refuse("PRICE_ATTESTATION_REQUIRED");
  // A listed quote's decimals are its row's; an unlisted one's are its own answer.
  const decimals = listed
    ? s.quote.decimals
    : await readContract(ctx.client, {
        address: n.quote.address,
        abi: erc20Abi,
        functionName: "decimals",
      }).catch(() => null);
  if (decimals === null || decimals > MAX_QUOTE_DECIMALS)
    refuse(
      "INVALID_PARAMS",
      "The quote's decimals() cannot be read, or is above 36: it is not an ERC-20 the launch can use.",
    );
  return quoteToken(ctx.chain, n.quote, { listed, pricing, decimals }, s.weth);
}

/**
 * On a coin that can be taken over, a takeover settles every recipient's share into a balance only the account, or
 * its claim operator, withdraws. A contract that restricted its claims and named no operator may never collect it,
 * so the launch is refused before any call.
 */
export async function requireClaimOperators<C extends LaunchChain>(
  ctx: Ctx<C>,
  n: NormalizedLaunch<C>,
  ledger: Address,
  terms: CoinTerms,
): Promise<void> {
  if (!terms.takeover) return;
  const operator = n.choices.claimOperator;
  const l = { address: ledger, abi: bankrFeeLedgerAbi } as const;
  await Promise.all(
    n.feeRecipients.map(async ({ recipient }) => {
      const code = await getCode(ctx.client, { address: recipient });
      if (!hasCode(code) || isDelegatedEoa(code)) return;
      // A Safe withdraws for itself; so does any contract the launcher vouched for that leaves its claims open.
      const restricted = await readContract(ctx.client, {
        ...l,
        functionName: "claimRestricted",
        args: [recipient],
      });
      if (!restricted) return;
      const named =
        operator !== undefined &&
        (await readContract(ctx.client, {
          ...l,
          functionName: "isClaimOperator",
          args: [recipient, operator],
        }));
      if (!named)
        throw new LaunchRefusedError("CLAIM_OPERATOR_REQUIRED", {
          chain: ctx.chain.chain,
          detail: `Fee recipient ${recipient} is a contract that restricted its claims on the fee ledger${operator === undefined ? "" : `, and ${operator} is not its claim operator`}. This coin can be taken over, and a takeover leaves its share in a balance only it or its operator can withdraw: have it name an operator (setClaimOperator) and pass that address as claimOperator, or use a wallet address.`,
        });
    }),
  );
}
