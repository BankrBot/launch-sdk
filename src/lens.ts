import {
  encodePacked,
  getAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import {
  bankrFeeLedgerAbi,
  bankrHookLensAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  holderRewardsDeployerAbi,
} from "./abis/generated.js";
import type { ProviderAddresses } from "./addresses.js";
import type { ChainCapabilities } from "./chains/index.js";
import type { LaunchCurve } from "./curve.js";
import {
  LOCKER_POSITIONS_FRAGMENT,
  launchCurveFromPositions,
} from "./curveRead.js";
import type { FeeRecipient, FeeSchedule } from "./economics.js";
import { LaunchRefusedError } from "./errors.js";
import type { ReadClient } from "./providers/types.js";
import { requireAddress } from "./recipient.js";

/** One chain's contracts and a client to read them: what every post-launch read and builder runs against. */
export interface ReadContext {
  chain: ChainCapabilities;
  addresses: ProviderAddresses;
  client: ReadClient;
  /** A fork or test client. */
  fork: boolean;
}

/** FeeMath's pool-term flags on the ledger that a launch's record names: Bankr's own part waived, and the decay
 *  surplus split out. Core's `BANKR_V4_POOL_TERMS_FLAG`; `__internal__/coreParity.test.ts` holds them equal. */
export const POOL_TERMS_FLAG = Object.freeze({ waived: 2, decaySplit: 4 });

/** A pool's fee terms as the ledger froze them at launch; `legId` is the coin's holder leg. */
async function readPoolTerms(
  ctx: ReadContext,
  poolId: Hex,
): Promise<{
  referrerBps: number;
  waived: boolean;
  decaySplit: boolean;
  legId: number;
}> {
  const t = await readContract(ctx.client, {
    address: ctx.addresses.ledger,
    abi: bankrFeeLedgerAbi,
    functionName: "poolTerms",
    args: [poolId],
  });
  return {
    referrerBps: t.referrerBps,
    waived: (t.flags & POOL_TERMS_FLAG.waived) !== 0,
    decaySplit: (t.flags & POOL_TERMS_FLAG.decaySplit) !== 0,
    legId: t.legId,
  };
}

/** The hook's record of a pool: the schedules it charges and when its next buyback fill may run. */
async function readPoolSchedules(
  ctx: ReadContext,
  lens: Address,
  poolId: Hex,
): Promise<{ fees: LaunchInfo["fees"]; buybackAt: number }> {
  const c = await readContract(ctx.client, {
    address: lens,
    abi: bankrHookLensAbi,
    functionName: "poolConfig",
    args: [poolId],
  });
  const schedule = (s: FeeSchedule): FeeSchedule => ({
    startPips: s.startPips,
    steadyPips: s.steadyPips,
    decaySecs: s.decaySecs,
  });
  return {
    fees: { buy: schedule(c.buy), sell: schedule(c.sell) },
    buybackAt: c.buybackAt,
  };
}

/** Whether Bankr lists `quote` on the chain: the settings contract's row for it. */
export async function readQuoteListed(
  ctx: ReadContext,
  quote: Address,
): Promise<boolean> {
  const row = await readContract(ctx.client, {
    address: ctx.addresses.settings,
    abi: bankrLaunchSettingsAbi,
    functionName: "quoteTerms",
    args: [quote],
  });
  return row.allowed;
}

/** `BankrLaunchHook.hookLens()`: the hook's views live on its lens. Held equal to core's hook ABI entry. */
export const HOOK_LENS_FRAGMENT = [
  {
    type: "function",
    name: "hookLens",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
] as const;

const tagged = (head: Hex, tag: string, type: "bytes32" | "address") =>
  keccak256(encodePacked([type, "string"], [head, tag]));

/** The ledger's bucket ids (BucketIds.sol). */
export const bucketIds = Object.freeze({
  /** The remainder's steady part: pad payees, then the creator side (holders, auto-LP, buyback, creator). */
  creator: (poolId: Hex) => tagged(poolId, "creator", "bytes32"),
  /** The coin holders' half of Bankr's slice; its sole, locked beneficiary is the holder leg of the coin's own
   *  launch. */
  holders: (poolId: Hex) => tagged(poolId, "holders", "bytes32"),
  /** The decay surplus above the steady rate, only when the launch's pad had a decay split (Bankr's has one). */
  decay: (poolId: Hex) => tagged(poolId, "decay", "bytes32"),
  /** Per quote: Bankr's own half of every slice, its pad-payee cut and its extension cut. */
  bankr: (quote: Address) =>
    tagged(quote.toLowerCase() as Hex, "bankr", "address"),
});

/** What a beneficiary of a launch's fee bucket is to the launch. */
export type BeneficiaryRole =
  "creator" | "holders" | "autoLp" | "buyback" | "payee";

export interface BucketShare {
  account: Address;
  /** WAD share of the bucket (1e18 = all of it). */
  sharesWad: bigint;
  /**
   * The part of `sharesWad` that is a launch fee recipient's own (`creatorShareOf`); 0 for any other entry. A fee
   * recipient that is also a pad payee holds more than this part, and a community takeover moves only this part.
   */
  creatorShareWad: bigint;
  role: BeneficiaryRole;
}

/** A launch read from the chain: the factory's record, its pad, its fee terms and the ledger's buckets. */
export interface LaunchInfo {
  token: Address;
  poolId: Hex;
  quote: Address;
  tokenIsCurrency0: boolean;
  /** The pool's hook generation. */
  hook: Address;
  launcher: Address;
  launchpadId: bigint;
  distributor: Address;
  escrow: Address | null;
  /** The schedules bound on the hook at launch. */
  fees: { buy: FeeSchedule; sell: FeeSchedule };
  referrerBps: number;
  /** Bankr's own half is waived (a BNKR-paired coin on a pad other than 0). */
  waived: boolean;
  /** The pad splits the decay window's surplus into its own bucket. */
  decaySplit: boolean;
  buckets: { creator: Hex; decay: Hex | null; holders: Hex; bankr: Hex };
  /** The creator bucket's beneficiaries: pad payees, the coin's holders, auto-LP, buyback and the fee recipients. */
  creatorShares: BucketShare[];
  decayShares: BucketShare[];
  /**
   * The launch's fee recipients now, each with its bps of the creators' own take: the creator bucket's entries with
   * a creator part, in the bucket's order. One entry after a community takeover; empty when the creators take nothing.
   */
  feeRecipients: FeeRecipient[];
  /** The only account that may replace the token's metadata URI; null when the URI is fixed for good. */
  metadataAdmin: Address | null;
  /** The Unix second trading opened or opens: the launch's own, or its scheduled start. Nobody can move it. */
  tradingStart: number;
  /**
   * The launch's curve, from the locker's launch positions: each band's pool ticks and its share of the sale. Bands
   * that equal a built-in curve's read as that built-in; a launch's receipt carries the word the launch named.
   */
  curve: LaunchCurve;
  /** The Unix second from which a swap may run the pool's next in-swap buyback fill; null without a buyback
   *  share. A swap at or after it with the fill's gas free fills once, then this moves an interval on (a minute on a
   *  refusal). */
  buybackAt: number | null;
}

const ZERO_POOL = zeroHash;

interface KnownLegs {
  distributor: Address;
  hook: Address;
  buyback: Address;
}

const legOf = (a: Address, k: KnownLegs): BeneficiaryRole | null =>
  isAddressEqual(a, k.distributor)
    ? "holders"
    : isAddressEqual(a, k.hook)
      ? "autoLp"
      : isAddressEqual(a, k.buyback)
        ? "buyback"
        : null;

/**
 * The wallets with a creator part, in the bucket's order, each as its bps of the creators' total (rounded, the
 * largest carrying the remainder so the list sums to 10,000). Held equal to core's `bankrV4CreatorRecipientsOf`.
 */
export function creatorRecipientsOf(
  entries: readonly Pick<BucketShare, "account" | "creatorShareWad">[],
): FeeRecipient[] {
  const parts = entries.filter((e) => e.creatorShareWad > 0n);
  const total = parts.reduce((sum, e) => sum + e.creatorShareWad, 0n);
  const list = parts.map((e) => ({
    recipient: getAddress(e.account),
    shareBps: Number((e.creatorShareWad * 10_000n + total / 2n) / total),
  }));
  const largest = list.reduce<FeeRecipient | null>(
    (top, r) => (top && top.shareBps >= r.shareBps ? top : r),
    null,
  );
  if (largest)
    largest.shareBps += 10_000 - list.reduce((sum, r) => sum + r.shareBps, 0);
  return list;
}

/** A bucket's entries. The ledger labels a fee recipient's entry by its creator part, on every pad, and the label
 *  follows the entry through its own moves and a takeover; the launch's own legs are known by address. */
async function sharesOf(
  ctx: ReadContext,
  ledger: Address,
  bucket: Hex,
  known: KnownLegs,
): Promise<BucketShare[]> {
  const l = { address: ledger, abi: bankrFeeLedgerAbi } as const;
  const who = await readContract(ctx.client, {
    ...l,
    functionName: "beneficiariesOf",
    args: [bucket],
  });
  const rows = await Promise.all(
    who.map((a) =>
      Promise.all([
        readContract(ctx.client, {
          ...l,
          functionName: "getShares",
          args: [bucket, a],
        }),
        readContract(ctx.client, {
          ...l,
          functionName: "creatorShareOf",
          args: [bucket, a],
        }),
      ]),
    ),
  );
  return who.map((account, i) => {
    const [sharesWad, creatorShareWad] = rows[i]!;
    return {
      account: getAddress(account),
      sharesWad,
      creatorShareWad,
      role:
        legOf(account, known) ?? (creatorShareWad > 0n ? "creator" : "payee"),
    };
  });
}

/** The factory's facts for `token`; null when this chain's factory never launched it. */
export async function readLaunchInfo(
  ctx: ReadContext,
  token: Address,
): Promise<LaunchInfo | null> {
  return (await readLaunchRecord(ctx, token))?.info ?? null;
}

/** {@link readLaunchInfo}, with the id of the holder leg the coin froze at launch. */
async function readLaunchRecord(
  ctx: ReadContext,
  token: Address,
): Promise<{ info: LaunchInfo; legId: number } | null> {
  const a = ctx.addresses;
  const { client } = ctx;
  const f = { address: a.factory, abi: bankrLaunchFactoryAbi } as const;
  const [poolId, key] = await readContract(client, {
    ...f,
    functionName: "poolOf",
    args: [token],
  });
  if (poolId === ZERO_POOL) return null;
  const quote = isAddressEqual(key.currency0, token)
    ? key.currency1
    : key.currency0;
  const hook = getAddress(key.hooks);
  const t = { address: token, abi: bankrLaunchTokenAbi } as const;
  const [
    launcher,
    escrow,
    distributor,
    launchpadId,
    terms,
    lens,
    buyback,
    ledger,
    metadataAdmin,
    tradingStart,
    locker,
  ] = await Promise.all([
    readContract(client, { ...f, functionName: "launcherOf", args: [token] }),
    readContract(client, {
      ...f,
      functionName: "vestingEscrowOf",
      args: [token],
    }),
    readContract(client, {
      address: a.holderRewardsDeployer,
      abi: holderRewardsDeployerAbi,
      functionName: "distributorOfToken",
      args: [token],
    }),
    readContract(client, {
      address: a.launchpadRegistry,
      abi: bankrLaunchpadRegistryAbi,
      functionName: "launchpadOf",
      args: [token],
    }),
    readPoolTerms(ctx, poolId),
    readContract(client, {
      address: hook,
      abi: HOOK_LENS_FRAGMENT,
      functionName: "hookLens",
    }),
    readContract(client, { ...f, functionName: "buyback" }),
    readContract(client, { ...f, functionName: "ledger" }),
    readContract(client, { ...t, functionName: "metadataAdmin" }),
    readContract(client, { ...t, functionName: "tradingStart" }),
    readContract(client, { ...f, functionName: "locker" }),
  ]);
  const [config, positions] = await Promise.all([
    readPoolSchedules(ctx, lens, poolId),
    readContract(client, {
      address: locker,
      abi: LOCKER_POSITIONS_FRAGMENT,
      functionName: "positionsOf",
      args: [poolId],
    }),
  ]);
  const buckets = {
    creator: bucketIds.creator(poolId),
    decay: terms.decaySplit ? bucketIds.decay(poolId) : null,
    holders: bucketIds.holders(poolId),
    bankr: bucketIds.bankr(quote),
  };
  const known = { distributor, hook, buyback };
  const [creatorShares, decayShares] = await Promise.all([
    sharesOf(ctx, ledger, buckets.creator, known),
    buckets.decay === null ? [] : sharesOf(ctx, ledger, buckets.decay, known),
  ]);
  const info: LaunchInfo = {
    token: getAddress(token),
    poolId,
    quote: getAddress(quote),
    tokenIsCurrency0: isAddressEqual(key.currency0, token),
    hook,
    launcher: getAddress(launcher),
    launchpadId,
    distributor: getAddress(distributor),
    escrow: isAddressEqual(escrow, zeroAddress) ? null : getAddress(escrow),
    fees: config.fees,
    referrerBps: terms.referrerBps,
    waived: terms.waived,
    decaySplit: terms.decaySplit,
    buckets,
    creatorShares,
    decayShares,
    feeRecipients: creatorRecipientsOf(creatorShares),
    metadataAdmin: isAddressEqual(metadataAdmin, zeroAddress)
      ? null
      : getAddress(metadataAdmin),
    tradingStart: Number(tradingStart),
    curve: launchCurveFromPositions(
      positions,
      isAddressEqual(key.currency0, token),
    ),
    buybackAt: config.buybackAt === 0 ? null : config.buybackAt,
  };
  return { info, legId: terms.legId };
}

/** {@link readLaunchInfo} for a builder: `INVALID_PARAMS` for a malformed address, `NOT_A_LAUNCH` for a stranger. */
export async function requireLaunch(
  ctx: ReadContext,
  token: unknown,
): Promise<LaunchInfo> {
  return (await requireLaunchRecord(ctx, token)).info;
}

/** {@link requireLaunch}, with the coin's holder leg id. */
export async function requireLaunchRecord(
  ctx: ReadContext,
  token: unknown,
): Promise<{ info: LaunchInfo; legId: number }> {
  const record = await readLaunchRecord(
    ctx,
    requireAddress(token, ctx.chain.chain),
  );
  if (record === null) {
    throw new LaunchRefusedError("NOT_A_LAUNCH", { chain: ctx.chain.chain });
  }
  return record;
}
