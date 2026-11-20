import { isAddressEqual, type Address, type Hex } from "viem";
import { getBlock, readContract } from "viem/actions";
import { bankrFeeLedgerAbi, bankrLaunchFactoryAbi } from "../abis/settings.js";
import type { HolderConversion } from "../conversion.js";
import { LaunchRefusedError } from "../errors.js";
import type { HolderPile, HolderPoke } from "../holderPiles.js";
import {
  readQuoteListed,
  requireLaunchRecord,
  type ReadContext,
} from "../lens.js";
import {
  legOfWake,
  once,
  readCoinLeg,
  readLegPile,
} from "../settings/coinLeg.js";
import {
  UNFLOORED,
  holderPileDue,
  type HolderPileReads,
} from "../settings/holderPile.js";

// A coin's holders' pile waits at the leg its launch froze, never at the one the record names for launches
// from now on: that leg's own floor and terms, and the ledger's shared window, decide what a wake or a poke does.

/** The leg of a launched pool's coin; a pool whose holders' bucket names none is no launch of this ledger. */
async function requireCoinLeg(ctx: ReadContext, poolId: Hex): Promise<Address> {
  const leg = await readCoinLeg(ctx.client, ctx.addresses.ledger, poolId);
  if (!leg)
    throw new LaunchRefusedError("NOT_A_LAUNCH", { chain: ctx.chain.chain });
  return leg;
}

/** What `leg.poke(poolId)` would do at `now`: it stages the ledger's pile onto the staged one, then runs the leg's
 *  rule at the leg's own floor, with no pause gate (Bankr's API decides a claim-all's pokes the same way). */
function pokeOf(
  r: Omit<HolderPileReads, "wake" | "paused">,
  leg: Address,
  now: bigint,
): HolderPoke {
  const pile = r.pile + r.pending;
  // Never floored: any pile forwards in quote at once.
  if (r.legFloor === 0n || r.legFloor === UNFLOORED)
    return pile > 0n ? "forward" : "none";
  const w = holderPileDue(
    { ...r, wake: (r.legFloor << 160n) | BigInt(leg), paused: false, pile },
    now,
  );
  return !w.due ? "none" : w.forwardsNow ? "forward" : "convert";
}

const chainNow = async (ctx: ReadContext): Promise<bigint> =>
  (await getBlock(ctx.client, { blockTag: "latest" })).timestamp;

/** Per pool, in order: the coin's own leg and what a poke of its pile there would do at the chain's clock. */
export async function readHolderPiles(
  ctx: ReadContext,
  pools: readonly { poolId: Hex; quote: Address }[],
): Promise<HolderPile[]> {
  if (pools.length === 0) return [];
  const { client } = ctx;
  const ledger = ctx.addresses.ledger;
  const shared = once();
  const [now, rows] = await Promise.all([
    chainNow(ctx),
    Promise.all(
      pools.map(async (p) => {
        const [leg, listed] = await Promise.all([
          requireCoinLeg(ctx, p.poolId),
          shared(`listed:${p.quote.toLowerCase()}`, () =>
            readQuoteListed(ctx, p.quote),
          ),
        ]);
        const reads = await readLegPile(client, ledger, { ...p, leg }, shared);
        return { leg, listed, reads };
      }),
    ),
  ]);
  return rows.map(({ leg, listed, reads }) => ({
    leg,
    listed,
    poke: pokeOf(reads, leg, now),
  }));
}

/** `holders.getConversion` for a coin: its pile at its own leg, at `now` (default the chain's clock). */
export async function readHolderConversion(
  ctx: ReadContext,
  token: unknown,
  now?: number,
): Promise<HolderConversion> {
  const { info, legId } = await requireLaunchRecord(ctx, token);
  const { client, addresses: a } = ctx;
  const chain = ctx.chain.chain;
  const [leg, paused, at] = await Promise.all([
    requireCoinLeg(ctx, info.poolId),
    readContract(client, {
      address: a.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "paused",
    }),
    now === undefined ? chainNow(ctx) : BigInt(now),
  ]);
  const pool = { poolId: info.poolId, quote: info.quote, leg };
  const [wake, reads] = await Promise.all([
    readContract(client, {
      address: a.ledger,
      abi: bankrFeeLedgerAbi,
      functionName: "holdersWake",
      args: [legId, info.quote],
    }),
    readLegPile(client, a.ledger, pool),
  ]);
  // An armed word names the leg it wakes: it is the coin's own, by the ledger's key.
  if (wake !== 0n && !isAddressEqual(legOfWake(wake), leg))
    throw new LaunchRefusedError("NOT_A_LAUNCH", { chain });
  const w = holderPileDue({ ...reads, wake, paused }, at);
  return {
    token: info.token,
    poolId: info.poolId,
    quote: info.quote,
    pile: reads.pile,
    floor: w.floor,
    armed: w.armed,
    paused,
    converts: w.converts,
    routed: reads.routed,
    nextConvertAt: Number(w.nextConvertAt),
    staged: reads.pending,
    forwardsNow: w.forwardsNow,
    due: w.due,
    convertDue: pokeOf(reads, leg, at) !== "none",
  };
}
