import type { Address } from "viem";
import type { LaunchChain } from "../chains/index.js";
import { LaunchRefusedError } from "../errors.js";
import type { LaunchChoices } from "./input.js";
import type { LaunchOptionsInput } from "./options.js";
import {
  flagInForce,
  knobInForce,
  type KnobName,
  type LaunchState,
} from "./settings.js";

// A launch's option groups against the features it has, each group whole: a term left out of a group takes
// the pad's default, and an option for a feature the launch leaves off is refused by name, never dropped.

/** What the launch's own fields and its pad say of the features an option belongs to. */
export interface FeatureState {
  /** The creator's vest in bps of supply, the pad's default applied. */
  vestBps: number;
  buybackBps: number;
  autoLpBps: number;
  hasExtension: boolean;
}

/**
 * The launch's `options`, each group whole: a term the launch left out of a group it names takes the pad's default
 * in force. An option for a feature the launch leaves off is `OPTION_FOR_FEATURE_OFF`, naming it: the chain would
 * refuse it with no argument (`InvalidOptions`), and dropping it would launch other terms than the caller asked for.
 */
export function featureOptionsOf(
  c: LaunchChoices,
  s: Pick<LaunchState, "pad" | "limits" | "allowedFlags">,
  f: FeatureState,
  chain?: LaunchChain,
): LaunchOptionsInput {
  const off = (detail: string): never => {
    throw new LaunchRefusedError("OPTION_FOR_FEATURE_OFF", { chain, detail });
  };
  const dflt = (knob: KnobName) => Number(knobInForce(s, knob).dflt);
  // Auto-liquidity can come from the pad's decay split alone, whatever the launch's own share.
  const decay = s.pad.terms.decay;
  const compounds = f.autoLpBps > 0 || (decay.on && decay.autoLpBps > 0);
  if (c.vestClock && f.vestBps === 0)
    off(
      "vesting.cliffSeconds and vesting.durationSeconds are terms of a creator vest, and this launch vests nothing (vesting.bps is 0).",
    );
  if (c.buybackCadence && f.buybackBps === 0)
    off(
      "buyback.intervalSeconds and buyback.retrySeconds are terms of a buyback, and this launch has no buyback share.",
    );
  if (c.feeCeilingPips !== undefined && !f.hasExtension)
    off("feeCeilingPips is a term of a launch with an extension.");
  if ((c.compoundAmounts || c.compoundCadence || c.compoundBand) && !compounds)
    off(
      "autoLp's floor, cap, cadence and band are terms of auto-liquidity, and this launch has none: neither its own share nor the launchpad's decay split sends fees to it.",
    );
  if (c.compoundAmounts && !flagInForce(s, "launchCompoundAmounts"))
    throw new LaunchRefusedError("NOT_ALLOWED_BY_LAUNCHPAD", {
      chain,
      detail:
        "This launchpad does not allow a launch's own compound floor and cap.",
    });
  return {
    walletCap: c.walletCap,
    vestClock: c.vestClock && {
      cliffSeconds: c.vestClock.cliffSeconds ?? dflt("vestCliffSecs"),
      durationSeconds: c.vestClock.durationSeconds ?? dflt("vestSecs"),
    },
    compoundAmounts: c.compoundAmounts,
    compoundCadence: c.compoundCadence && {
      intervalSeconds:
        c.compoundCadence.intervalSeconds ?? dflt("compoundIntervalSecs"),
      shareBps: c.compoundCadence.shareBps ?? dflt("compoundShareBps"),
      deviationTicks:
        c.compoundCadence.deviationTicks ?? dflt("compoundDeviationTicks"),
    },
    compoundBand: c.compoundBand,
    buybackCadence: c.buybackCadence && {
      intervalSeconds:
        c.buybackCadence.intervalSeconds ?? dflt("buybackIntervalSecs"),
      retrySeconds: c.buybackCadence.retrySeconds ?? dflt("buybackRetrySecs"),
    },
    rewardStream: c.rewardStream,
    feeCeilingPips: c.feeCeilingPips,
  };
}

/**
 * The wallets a launch exempts from its cap. The chain's settlers ride only where the launch has a cap and the pad
 * and the owner allow exemptions now: sent for a feature that is off they would refuse the launch. A list the
 * caller named is never dropped: with no cap it is `OPTION_FOR_FEATURE_OFF`, on a closed pad `NOT_ALLOWED_BY_LAUNCHPAD`.
 */
export function launchCapExclusions(
  c: Pick<LaunchChoices, "walletCap" | "capExclusions">,
  s: Pick<LaunchState, "pad" | "limits" | "allowedFlags">,
  settlers: readonly Address[],
  chain?: LaunchChain,
): readonly Address[] {
  const cap = c.walletCap;
  const capped =
    cap === undefined
      ? knobInForce(s, "capSecs").dflt !== 0n
      : cap !== false && cap.seconds !== 0;
  const allowed = flagInForce(s, "capExclusions");
  const own = c.capExclusions;
  if (own === undefined || own.length === 0)
    return own === undefined && capped && allowed ? settlers : [];
  if (!capped)
    throw new LaunchRefusedError("OPTION_FOR_FEATURE_OFF", {
      chain,
      detail:
        "capExclusions exempts wallets from the wallet cap, and this launch has none.",
    });
  if (!allowed)
    throw new LaunchRefusedError("NOT_ALLOWED_BY_LAUNCHPAD", {
      chain,
      detail: "This launchpad does not allow extra wallet-cap exemptions.",
    });
  return own;
}
