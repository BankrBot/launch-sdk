import { isAddressEqual, zeroAddress, type Address } from "viem";
import { readContract } from "viem/actions";
import { EXTENSION_PRESETS } from "../abis/knobs.js";
import { bankrLaunchSettingsAbi } from "../abis/settings.js";
import { MAX_UINT64, type SettingsKit } from "./context.js";
import {
  knobsByName,
  limitsByName,
  switchesOf,
  type PresetName,
} from "./names.js";
import {
  PRICING_MODE,
  type ChainPadTerms,
  type PresetLimits,
  type PricingModeName,
  type QuoteTerms,
} from "./rules.js";
import type { PadPayees, QuoteRow, TemplateSettings } from "./settingsTypes.js";

export const orNull = (a: Address): Address | null =>
  isAddressEqual(a, zeroAddress) ? null : a;

/** A quote row with its pricing mode by name. */
export function quoteRow(quote: Address, t: QuoteTerms): QuoteRow {
  const pricing = (Object.keys(PRICING_MODE) as PricingModeName[]).find(
    (k) => PRICING_MODE[k] === t.mode,
  );
  return {
    quote,
    listed: t.allowed,
    pricing: pricing ?? "none",
    decimals: t.decimals,
    maxPriceAge: t.maxPriceAge,
    feed: orNull(t.feed),
    compoundFloor: t.compoundFloor,
    compoundCap: t.compoundCap,
    quoteActivation: t.quoteActivation,
    quotePaid: t.quotePaid,
  };
}

/** Chain payees as named rows. */
export function payeesOf(t: ChainPadTerms): PadPayees {
  return {
    payees: t.payees.map((address, i) => ({
      address,
      steadyShareWad: t.steadySharesWad[i] ?? 0n,
      decayShareWad: (t.decay.on ? t.decay.sharesWad[i] : undefined) ?? 0n,
    })),
    decay: { on: t.decay.on, autoLpBps: t.decay.autoLpBps },
  };
}

export const presetsByName = <T>(
  of: (id: number) => T,
): Record<PresetName, T> =>
  Object.fromEntries(
    EXTENSION_PRESETS.map((p) => [p.name, of(p.id)]),
  ) as Record<PresetName, T>;

/** The chain reads the builders share with the public reads. */
export function settingsReaders(kit: SettingsKit) {
  const { client, addresses: a } = kit;
  const s = { address: a.settings, abi: bankrLaunchSettingsAbi } as const;
  const protocol = () =>
    readContract(client, { ...s, functionName: "protocolTerms" });
  const guards = () =>
    readContract(client, { ...s, functionName: "guardTerms" });
  const limits = async () =>
    limitsByName(await readContract(client, { ...s, functionName: "limits" }));
  const allowedFlags = () =>
    readContract(client, { ...s, functionName: "allowedFlags" });
  const padConfig = (id: bigint) =>
    readContract(client, { ...s, functionName: "padConfig", args: [id] });
  const quoteTerms = (quote: Address) =>
    readContract(client, { ...s, functionName: "quoteTerms", args: [quote] });
  const waiver = (id: bigint) =>
    readContract(client, { ...s, functionName: "bnkrPairWaiver", args: [id] });

  async function template(): Promise<
    TemplateSettings & { flags: bigint; controller: Address }
  > {
    const [[knobs, flags, controller], waived, ...presetLimits] =
      await Promise.all([
        readContract(client, { ...s, functionName: "template" }),
        waiver(MAX_UINT64),
        ...EXTENSION_PRESETS.map((p) =>
          readContract(client, {
            ...s,
            functionName: "templatePresetLimits",
            args: [p.id],
          }),
        ),
      ]);
    return {
      knobs: knobsByName(knobs),
      switches: switchesOf(flags),
      capController: orNull(controller),
      presets: presetsByName((id) => presetLimits[id - 1]!),
      bnkrPairWaived: waived,
      flags,
      controller,
    };
  }

  /** A registered pad's rows: the chain's own config beside its named form. */
  async function padRow(id: bigint) {
    await kit.requireRegistered(id);
    const [config, waived] = await Promise.all([padConfig(id), waiver(id)]);
    const limitsOf = new Map(
      config.presetIds.map((p, i) => [p, config.presetLimits[i]!]),
    );
    const off: PresetLimits = {
      allowed: false,
      maxWindowSecs: 0,
      minBrakeTicks: 0,
      minAnchorTau: 0,
    };
    return {
      config,
      knobs: knobsByName(config.ranges),
      switches: switchesOf(config.flags),
      capController: orNull(config.capController),
      presets: presetsByName((p) => limitsOf.get(p) ?? off),
      bnkrPairWaived: waived,
      ...payeesOf(config.terms),
    };
  }

  return {
    s,
    protocol,
    guards,
    limits,
    allowedFlags,
    padConfig,
    quoteTerms,
    template,
    padRow,
  };
}

export type SettingsReaders = ReturnType<typeof settingsReaders>;
