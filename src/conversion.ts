import { encodeFunctionData, type Address, type Hex } from "viem";
import { bnkrHolderLegAbi } from "./abis/settings.js";
import { requireLaunch, type ReadContext } from "./lens.js";
import type { UnsignedTx } from "./providers/types.js";
import { requireAddress } from "./recipient.js";
import { readCoinLeg } from "./settings/coinLeg.js";
import { buildCallTx } from "./tx.js";

/**
 * The convert action's gas limit: the in-swap wake's stipend (2.0M, which a full batch of eight first-time pools fits
 * over two hops) plus the call's own reads. Under the whole batch's reserve a poke still lands, only staging the pile.
 */
export const CONVERT_GAS = 2_100_000n;

/**
 * Whether a launch's holders' pile is due for its quote's conversion to BNKR, or its forward in quote, read at
 * the holder leg of the coin's own launch.
 */
export interface HolderConversion {
  token: Address;
  poolId: Hex;
  quote: Address;
  /** The pile waiting in the fee ledger for the coin's holder leg. */
  pile: bigint;
  /** The pile at which a swap that asks wakes the leg: the floor the leg was built with for the quote; 0 when
   *  unarmed. */
  floor: bigint;
  armed: boolean;
  /** A factory pause skips the wake. */
  paused: boolean;
  /** The quote's piles convert to BNKR; otherwise they forward to the distributor in quote, with no interval. */
  converts: boolean;
  /** The leg holds a route for the quote (`routeOf`). Without one a conversion reverts, so the pile's one stage
   *  starts the leg's stale clock, after which it forwards in quote. */
  routed: boolean;
  /** Unix seconds from which the quote's next conversion may run (0: now): when the ledger's shared conversion
   *  window reopens. */
  nextConvertAt: number;
  /** The pile already staged in the leg (a wake or poke inside a spent window), which no swap of the coin wakes for. */
  staged: bigint;
  /** The leg forwards the pile in quote now, with no interval: a quote it does not convert, or a staged pile past
   *  the leg's stale period. */
  forwardsNow: boolean;
  /** A swap that asks for the wake in its hookData (`holdersWakeRequest`) and carries its gas would forward or convert
   *  the pile now, or (no route) stage it to start its stale clock: the sponsor's cue. */
  due: boolean;
  /** `buildConvert` would forward this coin's pile, staged or not, convert it in its quote's batch now, or (no route)
   *  stage it to start its stale clock. */
  convertDue: boolean;
}

/** `leg.poke(poolId)` from `sender`, anyone: stages the launch's pile, then forwards it or converts its quote's batch. */
export async function buildConvertTx(
  ctx: ReadContext,
  token: unknown,
  sender: unknown,
): Promise<UnsignedTx> {
  const from = requireAddress(sender, ctx.chain.chain);
  const info = await requireLaunch(ctx, token);
  // The holders' bucket has one beneficiary, locked for life: the leg of the coin's own launch. A chain can have
  // several leg generations, and the record names only the one new launches bind.
  const own = await readCoinLeg(ctx.client, ctx.addresses.ledger, info.poolId);
  return {
    ...buildCallTx(
      ctx.chain.chainId,
      from,
      own ?? ctx.addresses.holderLeg,
      encodeFunctionData({
        abi: bnkrHolderLegAbi,
        functionName: "poke",
        args: [info.poolId],
      }),
    ),
    gas: CONVERT_GAS,
  };
}
