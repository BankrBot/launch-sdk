import {
  encodeAbiParameters,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { getCode, readContract } from "viem/actions";
import { bankrLaunchFactoryAbi } from "./abis/generated.js";
import type { LaunchProviderId, ProviderAddresses } from "./addresses.js";
import type { Authorizer } from "./authorizer.js";
import type { ChainCapabilities, LaunchChain } from "./chains/index.js";
import { DYNAMIC_FEE, TICK_SPACING } from "./economics.js";
import { LaunchRefusedError } from "./errors.js";
import type { NormalizedLaunch } from "./normalize.js";
import type { LivePointers } from "./predict.js";
import type { ReadClient } from "./providers/types.js";
import {
  hasCode,
  isDelegatedEoa,
  isSentinel,
  readLegReferences,
  refuseUnclaimableRecipient,
  bankrContracts,
} from "./recipient.js";

// What every plan is built on: its context, the pool's id, the 200-tick grid and the factory's recipient rules.

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

/** The factory's recipient rules plus the claim-capability test; returns `allowCodeVestingRecipient`. */
export async function checkRecipients(
  ctx: PlanContext,
  n: NormalizedLaunch,
  live: LivePointers,
  vestBps: number,
): Promise<boolean> {
  const chain = n.chain;
  const dead = bankrContracts(
    ctx.addresses,
    live,
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
        live.ledger,
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
