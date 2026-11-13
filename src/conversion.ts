import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import { bankrFeeLedgerAbi, bankrLaunchFactoryAbi } from "./abis/generated.js";
import { bucketIds, requireLaunch, type SuiteReadContext } from "./lens.js";
import type { UnsignedTx } from "./providers/types.js";
import { requireAddress } from "./recipient.js";
import { buildCallTx } from "./tx.js";

/** BnkrHolderLeg's wake views and its permissionless poke, entry for entry as core's generated ABI has them. */
export const HOLDER_LEG_WAKE_ABI = [
  {
    type: "function",
    name: "payoutMode",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "enum IBnkrHolderLeg.PayoutMode",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bnkr",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "retiredBnkr",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lastConvertAt",
    inputs: [{ name: "quote", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MIN_CONVERT_INTERVAL",
    inputs: [],
    outputs: [{ name: "", type: "uint32", internalType: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pending",
    inputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingSince",
    inputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "STALE_AFTER",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_BATCH",
    inputs: [],
    outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "batchOf",
    inputs: [{ name: "quote", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "bytes32[]", internalType: "bytes32[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bnkrExecuteAfter",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "routeExecuteAfter",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingRouteOf",
    inputs: [{ name: "quote", type: "address", internalType: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct IBnkrHolderLeg.Hop[]",
        components: [
          { name: "tokenOut", type: "address", internalType: "address" },
          { name: "v3Pool", type: "address", internalType: "address" },
          {
            name: "v4Key",
            type: "tuple",
            internalType: "struct PoolKey",
            components: [
              { name: "currency0", type: "address", internalType: "Currency" },
              { name: "currency1", type: "address", internalType: "Currency" },
              { name: "fee", type: "uint24", internalType: "uint24" },
              { name: "tickSpacing", type: "int24", internalType: "int24" },
              {
                name: "hooks",
                type: "address",
                internalType: "contract IHooks",
              },
            ],
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "routeOf",
    inputs: [{ name: "quote", type: "address", internalType: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct IBnkrHolderLeg.Hop[]",
        components: [
          { name: "tokenOut", type: "address", internalType: "address" },
          { name: "v3Pool", type: "address", internalType: "address" },
          {
            name: "v4Key",
            type: "tuple",
            internalType: "struct PoolKey",
            components: [
              { name: "currency0", type: "address", internalType: "Currency" },
              { name: "currency1", type: "address", internalType: "Currency" },
              { name: "fee", type: "uint24", internalType: "uint24" },
              { name: "tickSpacing", type: "int24", internalType: "int24" },
              {
                name: "hooks",
                type: "address",
                internalType: "contract IHooks",
              },
            ],
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "poke",
    inputs: [{ name: "poolId", type: "bytes32", internalType: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * The convert action's gas limit: the in-swap wake's stipend (2.0M, which a full batch of eight first-time pools fits
 * over two hops) plus the call's own reads. Under the whole batch's reserve a poke still lands, only staging the pile.
 */
export const CONVERT_GAS = 2_100_000n;

/** LaunchConstants.TIMELOCK_GRACE: a queued BNKR swap or route stays executable, and opens the forward, this long. */
export const TIMELOCK_GRACE_SECS = 7 * 86_400;

/** BnkrHolderLeg.FLOOR_DIVISOR: a quote's pile floor is its compound floor over this. */
export const FLOOR_DIVISOR = 50n;
/** The leg's floor for a quote the factory never floored (an unlisted one): type(uint96).max, so it never converts. */
export const UNLISTED_FLOOR = (1n << 96n) - 1n;

/** The pile the leg holds a quote's pools to: its wake word's floor, or for a quote no stage has floored yet (`wake`
 *  0) what the first poke's own sync sets (BnkrHolderLeg._syncFloor). UNLISTED_FLOOR is no floor at all. */
export function holderPileFloor(
  wake: bigint,
  minCompoundQuote: bigint,
): bigint {
  if (wake !== 0n) return wake >> 160n;
  const c = minCompoundQuote / FLOOR_DIVISOR;
  return c === 0n || c > UNLISTED_FLOOR ? UNLISTED_FLOOR : c;
}

/** Whether a leg route (`routeOf`, `pendingRouteOf`) ends at `token`; an empty route ends nowhere. */
export function routeEndsAt(
  hops: readonly { tokenOut: Address }[],
  token: Address,
): boolean {
  const end = hops.at(-1)?.tokenOut;
  return end !== undefined && isAddressEqual(end, token);
}

/** What the leg's wake rule reads for one pool and its quote. */
export interface HoldersWakeReads {
  /** {@link holderPileFloor} of the quote. */
  floor: bigint;
  /** The pile asked about: the ledger's for a swap's wake, the ledger's and the staged one together for a poke. */
  pile: bigint;
  quote: Address;
  payoutMode: number;
  bnkr: Address;
  retired: boolean;
  /** Unix seconds; 0 = never converted. */
  lastConvertAt: bigint;
  minConvertInterval: number;
  /** The pool's pile already staged in the leg, and since when (unix seconds; 0 with none). */
  staged: bigint;
  stagedSince: bigint;
  staleAfter: bigint;
  /** A queued BNKR swap's and the quote's queued route's unlock times (0: none queued). */
  bnkrExecuteAfter: bigint;
  routeExecuteAfter: bigint;
  pendingRouteToBnkr: boolean;
  routeToBnkr: boolean;
}

/**
 * Q4's predicate for a quote armed at `r.floor`, the factory's pause aside: what the leg does with the pile at `now`
 * (unix seconds). Core's `bankrV4HoldersWakeDue`; `__internal__/coreParity.test.ts` holds the two equal.
 */
export function holdersWakeDue(r: HoldersWakeReads, now: number) {
  // BnkrHolderLeg._converts: an unlisted quote's floor is type(uint96).max, so its piles forward in quote
  const converts =
    r.payoutMode === 0 &&
    !isAddressEqual(r.bnkr, zeroAddress) &&
    !isAddressEqual(r.quote, r.bnkr) &&
    !r.retired &&
    r.floor !== UNLISTED_FLOOR;
  const nextConvertAt =
    r.lastConvertAt === 0n ? 0 : Number(r.lastConvertAt) + r.minConvertInterval;
  // BnkrHolderLeg._forward and _queued (round 9 RSEC-6): a notice or a stale staged pile forwards inside the window
  const queued = (at: bigint) =>
    at !== 0n && now <= Number(at) + TIMELOCK_GRACE_SECS;
  const forwardsNow =
    !converts ||
    queued(r.bnkrExecuteAfter) ||
    (queued(r.routeExecuteAfter) && r.pendingRouteToBnkr) ||
    (r.staged !== 0n && now >= Number(r.stagedSince) + Number(r.staleAfter));
  // BnkrHolderLeg._run: NoRoute, or RouteNotToBnkr for a route left ending elsewhere
  const convertsNow = r.routeToBnkr && now >= nextConvertAt;
  // _stage starts pendingSince only from nothing staged, so without a route that one stage is the work due
  const startsClock = converts && !r.routeToBnkr && r.staged === 0n;
  return {
    converts,
    nextConvertAt,
    forwardsNow,
    convertsNow,
    startsClock,
    /** The leg forwards or converts the pile, or (no route) stages it to start its stale clock. */
    due: r.pile >= r.floor && (forwardsNow || convertsNow || startsClock),
  };
}

/** Whether a launch's holders' pile is due for its quote's conversion to BNKR, or its forward in quote (Q4). */
export interface HolderConversion {
  token: Address;
  poolId: Hex;
  quote: Address;
  /** The pile waiting in the fee ledger for the chain's holder leg. */
  pile: bigint;
  /** The pile at which a swap that asks wakes the leg (the quote's compound floor / 50, about $5); 0 when unarmed. */
  floor: bigint;
  armed: boolean;
  /** A factory pause skips the wake (Q5). */
  paused: boolean;
  /** The quote's piles convert to BNKR; otherwise they forward to the distributor in quote, with no interval. */
  converts: boolean;
  /** A route ending at BNKR is in force (`routeOf`). Without one a conversion reverts, so the pile's one stage starts
   *  its STALE_AFTER clock, after which it forwards in quote. */
  routed: boolean;
  /** Unix seconds from which the quote's next conversion may run (0: now). */
  nextConvertAt: number;
  /** The pile already staged in the leg (a wake or poke inside a spent window), which no swap of the coin wakes for. */
  staged: bigint;
  /** The leg forwards the pile in quote now, with no interval: QUOTE mode, a queued BNKR swap or route to BNKR, or a
   *  staged pile past STALE_AFTER (the notice is the holders' exit). */
  forwardsNow: boolean;
  /** A swap that asks for the wake in its hookData (`holdersWakeRequest`) and carries its gas would forward or convert
   *  the pile now, or (no route) stage it to start its stale clock: the sponsor's cue. */
  due: boolean;
  /** `buildConvert` would forward this coin's pile, staged or not, convert it in its quote's batch now, or (no route)
   *  stage it to start its stale clock. */
  convertDue: boolean;
}

export async function readHolderConversion(
  ctx: SuiteReadContext,
  token: unknown,
  now: number = Math.floor(Date.now() / 1_000),
): Promise<HolderConversion> {
  const info = await requireLaunch(ctx, token);
  const { client, addresses: a } = ctx;
  const [wake, paused] = await Promise.all([
    readContract(client, {
      address: a.ledger,
      abi: bankrFeeLedgerAbi,
      functionName: "holdersWake",
      args: [info.quote],
    }),
    readContract(client, {
      address: a.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "paused",
    }),
  ]);
  const armed = wake !== 0n;
  let floor = wake >> 160n;
  // Unarmed: a quote no stage has floored yet, an unlisted one (any-quote pairing) above all. The chain's leg holds
  // the pile, and the first poke floors it as BnkrHolderLeg._syncFloor does, then forwards or batches it.
  const leg = armed
    ? getAddress(
        `0x${(wake & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`,
      )
    : a.holderLeg;
  if (!armed) {
    const entry = await readContract(client, {
      address: a.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "quoteEntry",
      args: [info.quote],
    });
    floor = holderPileFloor(wake, entry.minCompoundQuote);
  }
  const base = { token: info.token, poolId: info.poolId, quote: info.quote };
  const l = { address: leg, abi: HOLDER_LEG_WAKE_ABI } as const;
  const [
    claimable,
    mode,
    bnkr,
    retired,
    last,
    interval,
    staged,
    since,
    staleAfter,
    maxBatch,
    batch,
    bnkrAt,
    routeAt,
    route,
    live,
  ] = await Promise.all([
    readContract(client, {
      address: a.ledger,
      abi: bankrFeeLedgerAbi,
      functionName: "claimable",
      args: [bucketIds.holders(info.poolId), leg],
    }),
    readContract(client, { ...l, functionName: "payoutMode" }),
    readContract(client, { ...l, functionName: "bnkr" }),
    readContract(client, {
      ...l,
      functionName: "retiredBnkr",
      args: [info.quote],
    }),
    readContract(client, {
      ...l,
      functionName: "lastConvertAt",
      args: [info.quote],
    }),
    readContract(client, { ...l, functionName: "MIN_CONVERT_INTERVAL" }),
    readContract(client, {
      ...l,
      functionName: "pending",
      args: [info.poolId],
    }),
    readContract(client, {
      ...l,
      functionName: "pendingSince",
      args: [info.poolId],
    }),
    readContract(client, { ...l, functionName: "STALE_AFTER" }),
    readContract(client, { ...l, functionName: "MAX_BATCH" }),
    readContract(client, { ...l, functionName: "batchOf", args: [info.quote] }),
    readContract(client, { ...l, functionName: "bnkrExecuteAfter" }),
    readContract(client, {
      ...l,
      functionName: "routeExecuteAfter",
      args: [info.quote],
    }),
    readContract(client, {
      ...l,
      functionName: "pendingRouteOf",
      args: [info.quote],
    }),
    readContract(client, { ...l, functionName: "routeOf", args: [info.quote] }),
  ]);
  const pile = claimable[0] + claimable[1];
  const routed = routeEndsAt(live, bnkr);
  const w = holdersWakeDue(
    {
      floor,
      pile,
      quote: info.quote,
      payoutMode: mode,
      bnkr,
      retired,
      lastConvertAt: last,
      minConvertInterval: interval,
      staged,
      stagedSince: since,
      staleAfter,
      bnkrExecuteAfter: bnkrAt,
      routeExecuteAfter: routeAt,
      pendingRouteToBnkr: routeEndsAt(route, bnkr),
      routeToBnkr: routed,
    },
    now,
  );
  // A poke stages the pile first (FF4): it then forwards, or converts it in the batch if it is there or has room.
  const total = pile + staged;
  const batched =
    batch.some((p) => p.toLowerCase() === info.poolId.toLowerCase()) ||
    batch.length < maxBatch;
  return {
    ...base,
    pile,
    floor,
    armed,
    paused,
    converts: w.converts,
    routed,
    nextConvertAt: w.nextConvertAt,
    staged,
    forwardsNow: w.forwardsNow,
    // Only an armed quote's swap reaches the wake, and a factory pause skips it (Q5).
    due: armed && !paused && w.due,
    convertDue:
      total !== 0n &&
      (w.forwardsNow ||
        w.startsClock ||
        (w.convertsNow && total >= floor && batched)),
  };
}

/** `leg.poke(poolId)` from `sender`, anyone: stages the launch's pile, then forwards it or converts its quote's batch. */
export async function buildConvertTx(
  ctx: SuiteReadContext,
  token: unknown,
  sender: unknown,
): Promise<UnsignedTx> {
  const from = requireAddress(sender, ctx.chain.chain);
  const info = await requireLaunch(ctx, token);
  return {
    ...buildCallTx(
      ctx.chain.chainId,
      from,
      ctx.addresses.holderLeg,
      encodeFunctionData({
        abi: HOLDER_LEG_WAKE_ABI,
        functionName: "poke",
        args: [info.poolId],
      }),
    ),
    gas: CONVERT_GAS,
  };
}
