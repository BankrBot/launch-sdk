import type { Address, Hex } from "viem";
import { readContract } from "viem/actions";
import { bankrLaunchSettingsAbi } from "../abis/generated.js";
import type { ProviderAddresses } from "../addresses.js";
import type { LaunchChain } from "../chains/index.js";
import type { FeeSchedule } from "../economics.js";
import { LaunchRefusedError } from "../errors.js";
import {
  extensionAllowlistKey,
  extensionKind,
  normalizeExtension,
  type LaunchExtensionInput,
  type NormalizedExtension,
} from "../extension.js";
import {
  buildExtensionPreview,
  extensionFeeTable,
  inspectExtensionCode,
  refuseExtensionPayee,
  type LaunchExtensionPreview,
  type LaunchFees,
  type PreviewExtensionOptions,
} from "../extensionPreview.js";
import { BANKR_LAUNCHPAD_ID } from "../launchpad.js";
import type { ReadClient } from "../providers/types.js";
import { flagRefusal, knobRefusal } from "./refusals.js";
import {
  KNOB,
  PAD_FLAG,
  flagInForce,
  knobInForce,
  readLaunchState,
  type CoinTerms,
  type PadFlagName,
  type LaunchState,
} from "./settings.js";

// A launch's extension against what the settings contract holds, in the order its launch check refuses:
// the pad's switch for the extension's kind, the preset's record and the pad's limits for it, custom code's declared
// maximum against the pad's ceiling, the owner's off switch for a fee, then the owner's allowlist.

export interface ExtensionContext {
  chain: { chain: LaunchChain };
  addresses: Pick<
    ProviderAddresses,
    "factory" | "launchpadRegistry" | "create3Factory" | "settings"
  >;
  client: ReadClient;
}

type State = Pick<LaunchState, "pad" | "limits" | "allowedFlags">;

const KIND_FLAG: readonly PadFlagName[] = [
  "extPresets",
  "extQuoteOnly",
  "extCallsOut",
];

/** Why `resolve` would refuse a launch naming `e` on this pad now; null when it would not. */
function refusalOf(
  e: NormalizedExtension,
  s: State,
  i: { presetActive: boolean; allowlisted: boolean; key: Hex },
): { launchpadAllows: boolean; refusal: string | null } {
  const need = (flag: PadFlagName) =>
    flagInForce(s, flag) ? null : flagRefusal(PAD_FLAG[flag]);
  const kind = need(KIND_FLAG[extensionKind(e.params) - 1]!);
  if (kind) return { launchpadAllows: false, refusal: kind };
  if (e.preset) {
    if (!i.presetActive)
      return {
        launchpadAllows: true,
        refusal: "This extension preset is switched off.",
      };
    const at = s.pad.presetIds.indexOf(e.params.id);
    if (!s.pad.presetLimits[at]?.allowed)
      return {
        launchpadAllows: false,
        refusal: "This launchpad does not offer this extension preset.",
      };
  }
  const ceiling = knobInForce(s, "extMaxPips");
  const { maxBuyPips, maxSellPips } = e.terms;
  if (!e.preset && BigInt(Math.max(maxBuyPips, maxSellPips)) > ceiling.max)
    return {
      launchpadAllows: false,
      refusal: knobRefusal(KNOB.extMaxPips, ceiling.min, ceiling.max),
    };
  // A preset always may charge; custom code does where it declares a maximum above 0.
  const charges = e.preset !== null || (maxBuyPips | maxSellPips) !== 0;
  const fee = charges ? need("extOwnerSwitch") : null;
  if (fee) return { launchpadAllows: false, refusal: fee };
  return {
    launchpadAllows: true,
    refusal: i.allowlisted
      ? null
      : `Bankr's extension allowlist does not hold this extension's key (${i.key}). Only Bankr adds a key: a launchpad's operator cannot.`,
  };
}

/**
 * Reads what `resolve` reads for the extension (the preset's record, the allowlist's answer for its key, Bankr's
 * cut of its fee) beside the pad's row, and builds the preview. Never refuses an extension the chain would turn
 * away: that is `refusal`. Custom code that fails the hook's admission is `INVALID_PARAMS`.
 */
export async function readExtensionPreview(
  ctx: ExtensionContext,
  e: NormalizedExtension,
  i: {
    state: State;
    fees: LaunchFees;
    payee: Address | null;
    /** The launch's own fee ceiling; omitted, the pad's default. */
    feeCeilingPips?: number;
  },
): Promise<LaunchExtensionPreview> {
  const s = { address: ctx.addresses.settings, abi: bankrLaunchSettingsAbi };
  const custom = e.preset === null;
  const [record, protocol, scan] = await Promise.all([
    custom
      ? null
      : readContract(ctx.client, {
          ...s,
          functionName: "presetOf",
          args: [e.params.id],
        }),
    readContract(ctx.client, { ...s, functionName: "protocolTerms" }),
    custom ? inspectExtensionCode(ctx, e.params.ext, e.params.codehash) : null,
  ]);
  const key = extensionAllowlistKey(e.params, record?.creationCodeHash)!;
  const allowlisted = await readContract(ctx.client, {
    ...s,
    functionName: "extensionAllowed",
    args: [key],
  });
  return buildExtensionPreview(e, {
    key,
    allowlisted,
    ...refusalOf(e, i.state, {
      presetActive: record?.active ?? true,
      allowlisted,
      key,
    }),
    scan,
    payee: i.payee,
    fees: i.fees,
    treasuryShareBps: cutBps(protocol.extBankrNum, protocol.extBankrDen),
    feeCeilingPips:
      i.feeCeilingPips ?? Number(knobInForce(i.state, "feeCeilingPips").dflt),
  });
}

/** Bankr's share of an extension's fee in bps, from the cut's two terms. */
const cutBps = (num: number, den: number): number =>
  den === 0 ? 0 : Math.round((num * 10_000) / den);

/**
 * A plan's preview with the figures of the terms `resolve` returned: Bankr's cut, the pool's fee ceiling and the
 * launch's fee each way. The preview's own reads came before `resolve`; a plan shows what its launch is pinned to.
 */
export function pinExtensionPreview(
  preview: LaunchExtensionPreview,
  e: NormalizedExtension,
  pool: CoinTerms["pool"],
): LaunchExtensionPreview {
  const treasuryShareBps = cutBps(pool.bankrNum, pool.bankrDen);
  return {
    ...preview,
    treasuryShareBps,
    payeeShareBps: 10_000 - treasuryShareBps,
    feeTable: extensionFeeTable(
      e,
      { buy: pool.buy, sell: pool.sell },
      pool.feeCeilingPips,
    ),
  };
}

/**
 * A launch's extension held to the chain before anything is mined or signed: `EXTENSION_NOT_ALLOWED`, with
 * the reason, where the launch check would turn it away. `payee` is the launch's first fee recipient, paid when the
 * extension names nobody.
 */
export async function requireExtension(
  ctx: ExtensionContext,
  e: NormalizedExtension,
  i: {
    state: State;
    fees: LaunchFees;
    payee: Address;
    feeCeilingPips?: number;
  },
): Promise<LaunchExtensionPreview> {
  const named = BigInt(e.params.payee) !== 0n;
  const [preview] = await Promise.all([
    readExtensionPreview(ctx, e, {
      ...i,
      payee: named ? e.params.payee : i.payee,
    }),
    named ? refuseExtensionPayee(ctx, e.params.payee) : null,
  ]);
  if (preview.refusal !== null)
    throw new LaunchRefusedError("EXTENSION_NOT_ALLOWED", {
      chain: ctx.chain.chain,
      detail: preview.refusal,
    });
  return preview;
}

/** The pad's default fee each way: its opening fee over its default decay, or flat at its trading fee. */
function padDefaultFees(s: State): FeeSchedule {
  const dflt = (knob: "steadyPips" | "startPips" | "decaySecs") =>
    Number(knobInForce(s, knob).dflt);
  const steadyPips = dflt("steadyPips");
  const opens = dflt("decaySecs") !== 0 && dflt("startPips") > steadyPips;
  return {
    startPips: opens ? dflt("startPips") : steadyPips,
    steadyPips,
    decaySecs: opens ? dflt("decaySecs") : 0,
  };
}

/** `client.previewExtension`: the extension's shape, then the launchpad's row and the chain's answers. */
export async function previewLaunchExtension(
  ctx: ExtensionContext,
  input: LaunchExtensionInput,
  o: PreviewExtensionOptions = {},
): Promise<LaunchExtensionPreview> {
  const chain = ctx.chain.chain;
  const e = normalizeExtension(input, chain);
  const padId = o.launchpadId ?? BANKR_LAUNCHPAD_ID;
  const named = BigInt(e.params.payee) !== 0n ? e.params.payee : null;
  // The quote is no part of an extension's admission: any address reads the pad's row.
  const [state] = await Promise.all([
    readLaunchState(ctx.client, ctx.addresses, {
      padId,
      quote: ctx.addresses.factory,
    }),
    named ? refuseExtensionPayee(ctx, named) : null,
  ]);
  if (padId > state.padCount)
    throw new LaunchRefusedError("UNKNOWN_LAUNCHPAD", { chain });
  const own = o.schedule ?? padDefaultFees(state);
  return readExtensionPreview(ctx, e, {
    state,
    fees: o.fees ?? { buy: own, sell: own },
    payee: named,
  });
}
