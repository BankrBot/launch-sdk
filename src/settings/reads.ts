import type { Address, Hex } from "viem";
import { readContract } from "viem/actions";
import { EXTENSION_PRESETS } from "../abis/knobs.js";
import { LaunchExecutionError } from "../errors.js";
import { isContractRevert } from "../simulate.js";
import {
  BANKR_PAD,
  settingsKit,
  type SettingsContext,
  type SettingsKit,
} from "./context.js";
import {
  knobsAtLaunch,
  switchesOf,
  type KnobLimits,
  type PadSwitches,
  type PresetName,
} from "./names.js";
import { orNull, presetsByName, quoteRow, settingsReaders } from "./readers.js";
import type {
  GuardTerms,
  PadQuoteTerms,
  PresetRecord,
  ProtocolTerms,
} from "./rules.js";
import type {
  LaunchPreview,
  PadSettings,
  QuoteRow,
  ResolveParams,
  ProtocolLevers,
  TemplateSettings,
} from "./settingsTypes.js";

// Every setting, read from the chain and named: what the owner holds every pad to, what a pad holds a launch to,
// and what a given launch would freeze. Nothing here is typed in: a changed setting shows on the next read.

export interface SettingsReads {
  protocol(): Promise<ProtocolTerms>;
  guards(): Promise<GuardTerms>;
  /** The owner's outer range of every knob. */
  limits(): Promise<KnobLimits>;
  /** The switches the owner lets a launchpad use at all. */
  allowedSwitches(): Promise<PadSwitches>;
  template(): Promise<TemplateSettings>;
  /** `UNKNOWN_LAUNCHPAD` past the last registered id. Default Bankr's pad, 0. `knobs` and `switches` are the
   *  pad's stored rows; `atLaunch` is what a launch meets, inside the owner's limits and allowed switches now. */
  pad(id?: bigint): Promise<PadSettings>;
  /** Every quote the owner lists. */
  quotes(): Promise<QuoteRow[]>;
  quote(quote: Address): Promise<QuoteRow>;
  /** A pad's own word on a quote, and whether a launch on the pad may pair with it by the pad's list. */
  padQuote(
    id: bigint,
    quote: Address,
  ): Promise<PadQuoteTerms & { launches: boolean }>;
  presets(): Promise<Record<PresetName, PresetRecord>>;
  extensionAllowed(key: Hex): Promise<boolean>;
  pricing(): Promise<{
    priceSigner: Address | null;
    sequencerUptimeFeed: Address | null;
    sequencerGraceSecs: number;
  }>;
  levers(): Promise<ProtocolLevers>;
  /**
   * `resolve` as a read: the terms this launch would freeze now. A launch the chain would refuse throws
   * `SIMULATION_REVERTED` with the contract's own error and arguments on `cause`; a failed request (a node that
   * does not answer) is thrown as it came, never under that code.
   */
  preview(
    params: ResolveParams,
    by: { launcher: Address; nativeDevBuy?: bigint },
  ): Promise<LaunchPreview>;
}

/** The settings of one chain's contracts, read live. No wallet needed. */
export function createSettingsReads(ctx: SettingsContext): SettingsReads {
  const kit: SettingsKit = settingsKit(ctx);
  const r = settingsReaders(kit);
  const { client, registry, factory } = kit;
  const { s } = r;

  return {
    protocol: r.protocol,
    guards: r.guards,
    limits: r.limits,
    allowedSwitches: async () => switchesOf(await r.allowedFlags()),

    async template() {
      const t = await r.template();
      return {
        knobs: t.knobs,
        switches: t.switches,
        capController: t.capController,
        presets: t.presets,
        bnkrPairWaived: t.bnkrPairWaived,
      };
    },

    async pad(id = BANKR_PAD) {
      const n = kit.requireId(id);
      const [row, limits, allowed, pad, metadataUri, settingsOperator] =
        await Promise.all([
          r.padRow(n),
          r.limits(),
          r.allowedFlags(),
          readContract(client, {
            ...registry,
            functionName: "getLaunchpad",
            args: [n],
          }),
          readContract(client, {
            ...registry,
            functionName: "metadataUriOf",
            args: [n],
          }),
          kit.settingsOperator(n),
        ]);
      return {
        id: n,
        // The registry stores no operator for Bankr's pad: it answers its own owner.
        operator: n === BANKR_PAD ? await kit.registryOwner() : pad.operator,
        settingsOperator,
        pendingOperator: orNull(pad.pendingOperator),
        signer: orNull(pad.signer),
        paused: pad.paused,
        verified: pad.verified,
        vanity: pad.vanity.nibbles === 0 ? null : pad.vanity,
        metadataUri,
        knobs: row.knobs,
        switches: row.switches,
        atLaunch: {
          knobs: knobsAtLaunch(row.knobs, limits),
          switches: switchesOf(row.config.flags & allowed),
        },
        capController: row.capController,
        presets: row.presets,
        bnkrPairWaived: row.bnkrPairWaived,
        payees: row.payees,
        decay: row.decay,
      };
    },

    async quotes() {
      const list = await readContract(client, {
        ...s,
        functionName: "quoteList",
      });
      const rows = await Promise.all(list.map((q) => r.quoteTerms(q)));
      return list.map((q, i) => quoteRow(q, rows[i]!));
    },

    async quote(quote) {
      const q = kit.address(quote, "The quote");
      return quoteRow(q, await r.quoteTerms(q));
    },

    async padQuote(id, quote) {
      const n = kit.requireId(id);
      const q = kit.address(quote, "The quote");
      const [, terms, launches] = await Promise.all([
        kit.requireRegistered(n),
        readContract(client, {
          ...s,
          functionName: "padQuoteTerms",
          args: [n, q],
        }),
        readContract(client, {
          ...s,
          functionName: "isQuoteAllowed",
          args: [n, q],
        }),
      ]);
      return { ...terms, launches };
    },

    async presets() {
      const records = await Promise.all(
        EXTENSION_PRESETS.map((p) =>
          readContract(client, {
            ...s,
            functionName: "presetOf",
            args: [p.id],
          }),
        ),
      );
      return presetsByName((id) => records[id - 1]!);
    },

    extensionAllowed: (key) =>
      readContract(client, {
        ...s,
        functionName: "extensionAllowed",
        args: [key],
      }),

    async pricing() {
      const [signer, feed, grace] = await readContract(client, {
        ...s,
        functionName: "pricingConfig",
      });
      return {
        priceSigner: orNull(signer),
        sequencerUptimeFeed: orNull(feed),
        sequencerGraceSecs: grace,
      };
    },

    async levers() {
      const [
        owner,
        pendingOwner,
        paused,
        launchGated,
        treasury,
        hook,
        hookGenerations,
        holderLeg,
        registryOwner,
        registrationBondWei,
        maxPadUriBytes,
        bankrSigner,
      ] = await Promise.all([
        kit.owner(),
        readContract(client, { ...factory, functionName: "pendingOwner" }),
        readContract(client, { ...factory, functionName: "paused" }),
        readContract(client, { ...factory, functionName: "launchGated" }),
        readContract(client, { ...factory, functionName: "treasury" }),
        readContract(client, { ...factory, functionName: "hook" }),
        readContract(client, { ...factory, functionName: "hookGenerations" }),
        readContract(client, { ...factory, functionName: "holderLeg" }),
        kit.registryOwner(),
        readContract(client, {
          ...registry,
          functionName: "registrationBondWei",
        }),
        readContract(client, { ...registry, functionName: "maxPadUriBytes" }),
        readContract(client, { ...registry, functionName: "bankrSigner" }),
      ]);
      return {
        owner,
        pendingOwner: orNull(pendingOwner),
        paused,
        launchGated,
        treasury,
        hook,
        hookGenerations,
        holderLeg,
        registryOwner,
        registrationBondWei,
        maxPadUriBytes,
        bankrSigner: orNull(bankrSigner),
      };
    },

    async preview(params, by) {
      const launcher = kit.address(by?.launcher, "The launcher");
      try {
        const [terms, resolvedHash, expectedToken, padTerms] =
          await readContract(client, {
            ...s,
            functionName: "resolve",
            args: [launcher, by.nativeDevBuy ?? 0n, params],
          });
        return { terms, resolvedHash, expectedToken, padTerms };
      } catch (cause) {
        // Only the contract's own refusal: a transport or RPC failure is thrown as it came.
        if (!isContractRevert(cause)) throw cause;
        throw new LaunchExecutionError("SIMULATION_REVERTED", {
          chain: kit.chain,
          cause,
        });
      }
    },
  };
}
