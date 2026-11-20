import type { LaunchChain } from "./chains/index.js";
import { LaunchRefusedError } from "./errors.js";

// The extension presets, vendored from core's bankr-v4 extensions.ts (src/__internal__ holds each equal): their ids,
// their constructors' arguments and what each binds. Their limits are a launchpad's, never typed here. Pure.

/** Bankr's presets by id (BankrPreset.sol's `Presets`). Raffle Run is a reference extension, not a Bankr product. */
export const EXTENSION_PRESETS = Object.freeze({
  sniper_tax: { id: 1, name: "Sniper Tax", reference: false },
  decay_tax: { id: 2, name: "Decay Tax", reference: false },
  pump_brake: { id: 3, name: "Pump Brake", reference: false },
  raffle_run: { id: 4, name: "Raffle Run", reference: true },
} as const);

export type PresetKey = keyof typeof EXTENSION_PRESETS;

/** Bankr's own presets, the ones the `extension` option takes by name. */
export type PresetName = Exclude<PresetKey, "raffle_run">;

/** The parameters each of Bankr's own presets takes by name, in its constructor's order. */
export const PRESET_FIELDS = Object.freeze({
  sniper_tax: ["buyPips", "sellPips", "endSecs"],
  decay_tax: ["startBuyPips", "startSellPips", "decaySecs"],
  pump_brake: ["brakePips", "thresholdTicks"],
} as const satisfies Record<PresetName, readonly string[]>);

/** A preset's constructor arguments, in its `abi.encode` order. */
export type PresetParams =
  | { preset: "sniper_tax"; buyPips: number; sellPips: number; endSecs: number }
  | {
      preset: "decay_tax";
      startBuyPips: number;
      startSellPips: number;
      decaySecs: number;
    }
  | { preset: "pump_brake"; brakePips: number; thresholdTicks: number }
  | {
      preset: "raffle_run";
      buyPips: number;
      sellPips: number;
      runSecs: number;
      minTicketQuote: bigint;
      /** The least quote a buyback spends: at least 2, at most the site's dust ceiling. */
      minBuyback: bigint;
      /** How slowly the buyback's price ceiling follows the market, in seconds: six hours to a year. */
      anchorTauSecs: number;
    };

/** What the hook binds: the extension's declared maxima, its quote-only flag and its sunset. */
export interface ExtensionTerms {
  maxBuyPips: number;
  maxSellPips: number;
  quoteOnly: boolean;
  /** Seconds after launch from which the extension is never asked again; 0 = never. */
  sunsetSecs: number;
}

const KEYS = Object.keys(EXTENSION_PRESETS) as PresetKey[];
/** The preset with this id, if the contracts deploy one. */
export const presetKeyOf = (id: unknown): PresetKey | undefined =>
  KEYS.find((k) => EXTENSION_PRESETS[k].id === id);

export function refuseExtension(
  code: "INVALID_PARAMS" | "EXTENSION_OUT_OF_BOUNDS",
  detail: string,
  chain?: LaunchChain,
): never {
  throw new LaunchRefusedError(code, { chain, detail });
}

export function intIn(
  v: unknown,
  [lo, hi]: readonly [number, number],
  what: string,
  chain?: LaunchChain,
): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    refuseExtension(
      "EXTENSION_OUT_OF_BOUNDS",
      `${what} must be between ${lo} and ${hi}.`,
      chain,
    );
}

/** What `BankrPresetDeployer.deploy` hands the hook: the instance's maxima, `quoteOnly()` and `sunsetSecs()`. */
export function presetTerms(p: PresetParams): ExtensionTerms {
  switch (p.preset) {
    case "sniper_tax":
      return {
        maxBuyPips: p.buyPips,
        maxSellPips: p.sellPips,
        quoteOnly: true,
        sunsetSecs: p.endSecs,
      };
    case "decay_tax":
      return {
        maxBuyPips: p.startBuyPips,
        maxSellPips: p.startSellPips,
        quoteOnly: true,
        sunsetSecs: p.decaySecs,
      };
    case "pump_brake":
      return {
        maxBuyPips: p.brakePips,
        maxSellPips: 0,
        quoteOnly: true,
        sunsetSecs: 0,
      };
    case "raffle_run":
      return {
        maxBuyPips: p.buyPips,
        maxSellPips: p.sellPips,
        quoteOnly: false,
        sunsetSecs: 0,
      };
  }
}

const pct = (pips: number) => `${pips / 10_000}%`;

/** One line for a confirm screen, from Bankr's own reading of the parameters (never the launcher's words). */
export function describePreset(p: PresetParams): string {
  switch (p.preset) {
    case "sniper_tax":
      return `Sniper Tax: buys +${pct(p.buyPips)}, sells +${pct(p.sellPips)} until ${p.endSecs}s after launch, then 0`;
    case "decay_tax":
      return `Decay Tax: buys +${pct(p.startBuyPips)}, sells +${pct(p.startSellPips)} falling to 0 over ${p.decaySecs}s`;
    case "pump_brake":
      return `Pump Brake: buys +${pct(p.brakePips)} while the price is over ${p.thresholdTicks} ticks above launch`;
    case "raffle_run":
      return `Raffle Run: buys +${pct(p.buyPips)}, sells +${pct(p.sellPips)} for ${p.runSecs}s; tickets on buys, buybacks on sells`;
  }
}
