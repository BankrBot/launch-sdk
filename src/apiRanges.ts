import { curveOwnBuys, launchSale } from "./curveCheck.js";
import { refuseBrokenCurve, refuseClosedCurve } from "./curveDetail.js";
import { curveAtStart, type NormalizedCurve } from "./curveInput.js";
import type { LaunchParams } from "./economics.js";
import { LaunchExecutionError, LaunchRefusedError } from "./errors.js";
import { resolveEconomics, type NormalizedLaunch } from "./normalize.js";
import {
  curveAtStartTick,
  placeStartTick,
  type PlanContext,
  type readLaunchState,
} from "./plan.js";
import type { QuoteToken } from "./providers/types.js";

// Market-cap ranges in API mode. Bankr places the start tick after the bands are sent, so the SDK places the ranges
// from the factory's own price first and holds the prepare to that start.

/** How many times a launch's ranges are prepared before the quote's price counts as moving under them. */
const RANGE_PREPARES = 3;

const PRICE_KEPT_MOVING =
  "The quote's price kept moving while the launch's market-cap ranges were placed from its start tick. Plan the launch again, or convert the ranges once with curveFromMarketCaps and launch with those bands.";

/**
 * Prepares a launch whose curve is market-cap ranges, so each band ends under its market cap by less than one tick
 * spacing. The ranges are placed from the factory's price as read here (a SIGNED quote's only from a prepare's own
 * attestation), held to the rules in both token orders, and prepared again while the start or its bands differ.
 */
export async function prepareRanges<P extends { params: LaunchParams }>(
  ctx: PlanContext,
  n: NormalizedLaunch,
  s: Pick<Awaited<ReturnType<typeof readLaunchState>>, "pad" | "curveKeys">,
  quote: QuoteToken,
  prepare: (curve: NormalizedCurve) => Promise<P>,
): Promise<P> {
  const chain = ctx.chain.chain;
  const invalid = (detail: string): never => {
    throw new LaunchRefusedError("INVALID_PARAMS", { chain, detail });
  };
  // The pad's defaults as Bankr applies them: the rules need the sale and whether the pool buys its own token.
  const economics = resolveEconomics(n, s.pad);
  const rules = {
    sale: launchSale({
      totalSupply: 0n,
      vestBps: n.vestBps ?? s.pad.pad.policy.defaultVestBps,
      econ: economics,
      extraAllocations: [],
    }),
    ownBuys: curveOwnBuys({
      buybackBps: economics.buybackBps,
      autoLpBps: economics.autoLpBps,
      padDecay: s.pad.terms.decay,
      extensionCallsOut: false,
    }),
  };
  let start =
    quote.pricing === "signed" ? null : await placeStartTick(ctx, quote, n);
  for (let prepares = 0; prepares < RANGE_PREPARES; prepares++) {
    let curve = n.curve;
    if (start === null) {
      // No price before Bankr attests one: the first prepare carries the bands of a start on the grid.
      refuseClosedCurve(chain, n.launchpadId, curve.word, s.curveKeys);
    } else {
      curve = await curveAtStartTick(ctx, n, start.offsetTicks, s.curveKeys);
      refuseBrokenCurve(
        { curve: curve.word, startTick: start.tick, ...rules },
        chain,
        true,
      );
    }
    const prepared = await prepare(curve);
    const p = prepared.params;
    const placed = await placeStartTick(ctx, quote, n, p.priceAttestation);
    if (
      placed.tick === p.expectedStartTick &&
      curveAtStart(n.curve, placed.offsetTicks, invalid).word === p.curveId
    )
      return prepared;
    start = placed;
  }
  throw new LaunchExecutionError("START_TICK_CHANGED", {
    chain,
    detail: PRICE_KEPT_MOVING,
  });
}
