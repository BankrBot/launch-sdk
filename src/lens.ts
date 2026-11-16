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
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  holderRewardsDeployerAbi,
} from "./abis/suite3.js";
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

/** One chain's suite and a client to read it: what every post-launch read and builder runs against. */
export interface SuiteReadContext {
  chain: ChainCapabilities;
  addresses: ProviderAddresses;
  client: ReadClient;
  /** A fork or test client. */
  fork: boolean;
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
  /** The coin holders' half of Bankr's slice; its sole, locked beneficiary is the chain's BNKR holder leg. */
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
  /** Decision 3: the Unix second from which a swap may run the pool's next in-swap buyback fill; null without a buyback
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
  ctx: SuiteReadContext,
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
  ctx: SuiteReadContext,
  token: Address,
): Promise<LaunchInfo | null> {
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
    readContract(client, {
      address: a.ledger,
      abi: bankrFeeLedgerAbi,
      functionName: "poolTerms",
      args: [poolId],
    }),
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
    readContract(client, {
      address: lens,
      abi: bankrHookLensAbi,
      functionName: "poolConfig",
      args: [poolId],
    }),
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
  return {
    token: getAddress(token),
    poolId,
    quote: getAddress(quote),
    tokenIsCurrency0: isAddressEqual(key.currency0, token),
    hook,
    launcher: getAddress(launcher),
    launchpadId,
    distributor: getAddress(distributor),
    escrow: isAddressEqual(escrow, zeroAddress) ? null : getAddress(escrow),
    fees: { buy: config.buy, sell: config.sell },
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
}

/** {@link readLaunchInfo} for a builder: `INVALID_PARAMS` for a malformed address, `NOT_A_LAUNCH` for a stranger. */
export async function requireLaunch(
  ctx: SuiteReadContext,
  token: unknown,
): Promise<LaunchInfo> {
  const info = await readLaunchInfo(
    ctx,
    requireAddress(token, ctx.chain.chain),
  );
  if (info === null) {
    throw new LaunchRefusedError("NOT_A_LAUNCH", { chain: ctx.chain.chain });
  }
  return info;
}
