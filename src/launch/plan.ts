import { getAddress, isAddressEqual, stringToBytes, type Hex } from "viem";
import { getCode, readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  holderRewardsDeployerAbi,
} from "../abis/generated.js";
import type { LaunchChain } from "../chains/index.js";
import { holdersBpsToHolderShare } from "../economics.js";
import {
  LaunchExecutionError,
  LaunchRefusedError,
  isLaunchSdkError,
} from "../errors.js";
import { BANKR_LAUNCHPAD_ID, volumeSplit } from "../launchpad.js";
import { normalizeLaunchInput, type NormalizedLaunch } from "../normalize.js";
import { poolIdOf } from "../plan.js";
import { predictEscrow } from "../predict.js";
import type { LaunchInput, LaunchPlan } from "../providers/types.js";
import { hasCode } from "../recipient.js";
import { callPlannedLaunch, readFactoryAllowance } from "../simulate.js";
import { feeRecipientsOf } from "../terms.js";
import { buildApproveTx, clampLaunchGas, type LaunchGasWeight } from "../tx.js";
import { draftLaunch, type LaunchDraft } from "./draft.js";
import type { LaunchPlanContext } from "./planChecks.js";
import { launchCallError } from "./revert.js";
import type { CoinTerms, PadTerms } from "./settings.js";

// A launch, planned against what the chain holds: the pad's defaults are read, the settings contract's
// `resolve` judges the launch and returns the terms its coin will freeze, and the launch is pinned to them and to
// its token. No bound of a pad or of the owner is typed here. Vendored from core's bankr-v4 launch preparation.

const BPS = 10_000n;
/** How often a plan resolves again when the terms move under it before its own simulation. */
const MAX_REPLANS = 2;

/** What a plan carries beyond the launch's tuple. */
export interface ResolvedLaunch {
  /** The terms the coin will freeze, as the chain's launch check resolved them: fees, shares, cap, clocks, takeover. */
  terms: CoinTerms;
  /** The hash of `terms`. The launch is pinned to it and to its token: it reverts where either differs when it lands. */
  resolvedHash: Hex;
  /** The launchpad's payees the launch is held to (`operatorPayeesHash`). */
  padTerms: PadTerms;
  /** What sizes the gas limit that stands in when a node gives no estimate. */
  gasWeight: LaunchGasWeight;
}

type Ctx<C extends LaunchChain> = LaunchPlanContext<C>;

/** What a drafted launch is held to once it is pinned: the factory's own token read, the launch's own addresses
 *  against who it pays, and the simulation. A pin that no longer holds rejects with `TERMS_CHANGED`. */
async function checkDraft<C extends LaunchChain>(
  ctx: Ctx<C>,
  n: NormalizedLaunch<C>,
  d: LaunchDraft,
) {
  const chain = ctx.chain.chain;
  const a = ctx.addresses;
  const { params, token } = d;
  const t = d.resolved.terms;
  const [onChain, tokenCode] = await Promise.all([
    readContract(ctx.client, {
      address: a.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "computeTokenAddress",
      args: [n.launcher, params.salt, params],
    }).catch((error: unknown) => {
      throw launchCallError(error, chain, t.curve);
    }),
    getCode(ctx.client, { address: token }),
  ]);
  if (!isAddressEqual(onChain, token))
    throw new LaunchExecutionError("PREDICTION_MISMATCH", { chain });
  if (hasCode(tokenCode))
    throw new LaunchExecutionError("POOL_ALREADY_INITIALIZED", { chain });

  const escrow = predictEscrow(d.live, n.launcher, params.salt);
  const { poolId, tokenIsCurrency0 } = poolIdOf(token, params.quote, t.hook);
  const distributor = await readContract(ctx.client, {
    address: a.holderRewardsDeployer,
    abi: holderRewardsDeployerAbi,
    functionName: "predict",
    args: [token, poolId, params.quote, escrow, t.vestToHoldersBps > 0],
  });
  const own = [token, escrow, distributor];
  const paid = feeRecipientsOf(params, n.launcher);
  if (own.some((x) => paid.some((r) => isAddressEqual(x, r.recipient))))
    throw new LaunchRefusedError("FEE_RECIPIENT_CANNOT_CLAIM", { chain });
  if (
    own.some((x) =>
      [
        params.vestingRecipient,
        ...params.extraAllocations.map((x) => x.recipient),
      ].some((r) => isAddressEqual(x, r)),
    )
  )
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail:
        "Vested tokens and builder allocations cannot go to this launch's own token, escrow or distributor.",
    });

  const sim = await callPlannedLaunch(
    ctx.client,
    {
      chain,
      factory: a.factory,
      launcher: n.launcher,
      params,
      value: d.value,
      dataSuffix: ctx.dataSuffix,
      curveRules: t.curve,
    },
    d.quote.decimals,
  );
  return { poolId, tokenIsCurrency0, distributor, sim };
}

/**
 * A plan: the pad's defaults, the start tick, the chain's launch check (refusals worded from their own
 * arguments), the vanity salt mined from the resolved terms, both pins, a signed pad's signature, and the simulation.
 * A plan whose terms move after its launch check is resolved again, at most twice.
 */
export async function planLaunch<C extends LaunchChain>(
  ctx: Ctx<C>,
  input: LaunchInput<C>,
): Promise<LaunchPlan<C>> {
  const caps = ctx.chain;
  const chain = caps.chain;
  const a = ctx.addresses;
  const n = normalizeLaunchInput(caps, input, ctx.usedSalts);
  // Bankr signs every id-0 launch with its own key, which nothing in this SDK version can ask for: say so.
  if (n.launchpadId === BANKR_LAUNCHPAD_ID)
    throw new LaunchRefusedError("AUTHORIZATION_REQUIRED", {
      chain,
      detail:
        "Bankr's own launchpad (id 0) is signed by Bankr, and this SDK version cannot ask for that signature: name your own launchpad or any open one as launchpadId.",
    });
  for (let replans = 0; ; replans++) {
    const d = await draftLaunch(ctx, n);
    const { params, token, resolved } = d;
    const t = resolved.terms;
    let checked: Awaited<ReturnType<typeof checkDraft>>;
    try {
      checked = await checkDraft(ctx, n, d);
    } catch (error) {
      // An owner or pad change after `resolve`: the pin held, in the factory's token read or in the simulation, so
      // resolve again on what is in force.
      const moved =
        isLaunchSdkError(error, "TERMS_CHANGED") ||
        isLaunchSdkError(error, "LAUNCHPAD_TERMS_CHANGED");
      if (moved && replans < MAX_REPLANS && n.salt === undefined) continue;
      throw error;
    }
    const { poolId, tokenIsCurrency0, distributor, sim } = checked;
    const allowance = await readFactoryAllowance(ctx.client, {
      params,
      launcher: n.launcher,
      factory: a.factory,
    });
    if (!isAddressEqual(sim.token, token))
      throw new LaunchExecutionError("PREDICTION_MISMATCH", { chain });
    const gasWeight: LaunchGasWeight = {
      padPayees: resolved.padTerms.payees.length,
      linkBytes: stringToBytes(params.metadataUri).length,
    };
    const devBuy = d.value > 0n || params.devBuyAmountIn > 0n;
    // Refuses a launch whose gas exceeds the chain's per-transaction ceiling.
    clampLaunchGas(
      caps,
      sim.gas,
      devBuy,
      params.extraAllocations.length,
      gasWeight,
    );
    const econ = params.econ;
    const amount = params.devBuyAmountIn;
    return {
      chain,
      provider: ctx.provider,
      factory: getAddress(a.factory),
      launcher: n.launcher,
      launchpadId: params.launchpadId,
      params: {
        ...params,
        devBuyMinOut: (sim.devBuyOut * (BPS - BigInt(n.slippageBps))) / BPS,
      },
      resolved: {
        terms: t,
        resolvedHash: resolved.resolvedHash,
        padTerms: resolved.padTerms,
        gasWeight,
      },
      value: d.value,
      predictedToken: getAddress(token),
      poolId,
      tokenIsCurrency0,
      distributor: getAddress(distributor),
      escrow: sim.escrow,
      quote: d.quote,
      economics: econ,
      holderShareBps: holdersBpsToHolderShare(
        econ.holdersBps,
        econ.autoLpBps,
        econ.buybackBps,
      ),
      volumeSplit: volumeSplit({
        steadyPips: t.pool.buy.steadyPips,
        terms: resolved.padTerms,
        economics: t,
        waived: t.waiveBnkrPair,
        bankrTerms: t,
      }),
      approvals:
        amount > allowance
          ? [
              buildApproveTx(
                caps.chainId,
                n.launcher,
                params.quote,
                getAddress(a.factory),
                amount,
              ),
            ]
          : [],
      devBuyOut: sim.devBuyOut,
      gasEstimate: sim.gas,
      dataSuffix: ctx.dataSuffix,
      extension: d.extension,
    };
  }
}
