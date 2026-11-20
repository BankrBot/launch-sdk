import {
  encodeAbiParameters,
  encodePacked,
  isHex,
  keccak256,
  sha256,
  type Address,
  type Hex,
} from "viem";
import type { LaunchChain } from "./chains/index.js";
import {
  EXT_AFTER_GAS,
  EXT_QUOTE_GAS,
  extensionGasBudgets,
} from "./economics.js";
import {
  EXTENSION_PRESETS,
  PRESET_FIELDS,
  intIn,
  presetKeyOf,
  presetTerms,
  refuseExtension,
  type ExtensionTerms,
  type PresetKey,
  type PresetName,
  type PresetParams,
} from "./presets.js";
import { requireAddress } from "./recipient.js";
import {
  EXTENSION_PRESET_WORDS,
  decodeExtensionPresetParams,
  encodeExtensionPresetParams,
} from "./launch/presets.js";
import type { ExtensionGas } from "./swapGas.js";
import { NO_EXTENSION, type LaunchExtension } from "./terms.js";

// A launch's `extension` option, vendored from core's bankr-v4 extensions.ts (src/__internal__ holds each equal): its
// three forms, custom code's binding rules, and the chain's view of it (kind, allowlist key). Pure.

interface ExtensionPayee {
  /** Who is paid the extension's fee, after Bankr's 2/7. Default: the launch's first fee recipient; a launch with
   *  several fee recipients must name it. */
  payee?: Address;
}

type ByNameOrId<P, Id extends number> = P extends { preset: infer K }
  ? Omit<P, "preset"> & { preset: K | Id } & ExtensionPayee
  : never;

/** Sniper Tax: a flat extra fee on buys and sells until `endSecs` after launch, inside the launchpad's limits. */
export type SniperTaxInput = ByNameOrId<
  Extract<PresetParams, { preset: "sniper_tax" }>,
  1
>;

/** Decay Tax: an extra fee each way that falls from its start to 0 over `decaySecs`, inside the launchpad's limits. */
export type DecayTaxInput = ByNameOrId<
  Extract<PresetParams, { preset: "decay_tax" }>,
  2
>;

/** Pump Brake: an extra fee on buys while the price is over `thresholdTicks` above launch. */
export type PumpBrakeInput = ByNameOrId<
  Extract<PresetParams, { preset: "pump_brake" }>,
  3
>;

/** A preset by its id and its constructor's `abi.encode`d parameters. Raffle Run (4), a reference extension and not
 *  a Bankr product, is named only this way. */
export interface RawPresetInput extends ExtensionPayee {
  presetId: number;
  params: Hex;
}

/** Extension code Bankr's allowlist holds by its code hash: what the hook binds for the pool's life. */
export interface CustomExtensionInput extends ExtensionPayee {
  address: Address;
  /** The extension's `extcodehash`; the hook refuses the launch on any other. */
  codehash: Hex;
  /** The most it may add to a buy or a sell, in pips (at most the launchpad's `extMaxPips`). */
  maxBuyPips: number;
  maxSellPips: number;
  /** True: it only quotes a fee. False: the hook also calls it after each swap. */
  quoteOnly: boolean;
  /** Seconds after launch from which it is never asked again; 0 = never. */
  sunsetSecs: number;
  /** Gas its quote is handed on every swap: omitted or 0 = 50,000, at most 250,000. */
  quoteGas?: number;
  /** Gas its post-swap call is handed: omitted or 0 = 150,000, at most 1,000,000; none when `quoteOnly`. */
  afterGas?: number;
}

/** {@link LaunchInput.extension}: one of Bankr's presets by name or id, a raw preset, or custom code. */
export type LaunchExtensionInput =
  | SniperTaxInput
  | DecayTaxInput
  | PumpBrakeInput
  | RawPresetInput
  | CustomExtensionInput;

/** A launch's extension with its static refusals passed. */
export interface NormalizedExtension {
  /** `LaunchParams.extension`, exactly as the factory takes it (a zero payee = the first fee recipient). */
  params: LaunchExtension;
  /** A preset's decoded parameters; null for custom code. */
  preset: PresetParams | null;
  terms: ExtensionTerms;
  /** The gas budgets the hook binds for the pool's life; a preset's are the floors. */
  gas: ExtensionGas;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const CUSTOM_FIELDS = [
  "address",
  "codehash",
  "maxBuyPips",
  "maxSellPips",
  "quoteOnly",
  "sunsetSecs",
  "quoteGas",
  "afterGas",
];

/** A preset launch: its id and exact params, every custom field 0 (else the factory reverts `AmbiguousExtension`).
 *  The parameters are held to their widths here; the launchpad's limits for them follow, on chain. */
function presetExtension(
  p: PresetParams,
  payee: Address,
  chain?: LaunchChain,
): NormalizedExtension {
  const terms = presetTerms(p);
  return {
    params: {
      ...NO_EXTENSION,
      id: EXTENSION_PRESETS[p.preset].id,
      params: encodeExtensionPresetParams(p, chain),
      payee,
    },
    preset: p,
    terms,
    gas: extensionGasBudgets({ quoteOnly: terms.quoteOnly }, chain),
  };
}

/**
 * A launch's `extension` option with its static refusals applied: the form (one of a preset, a raw preset or custom
 * code, and only that form's fields: `INVALID_PARAMS`), then each parameter against the width its encoding gives it
 * (`EXTENSION_OUT_OF_BOUNDS`, the detail naming the bound).
 */
export function normalizeExtension(
  input: unknown,
  chain?: LaunchChain,
): NormalizedExtension {
  const invalid = (detail: string): never =>
    refuseExtension("INVALID_PARAMS", detail, chain);
  const v = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  const forms = (["preset", "presetId", "address"] as const).filter(
    (k) => v[k] !== undefined,
  );
  if (forms.length === 0)
    invalid(
      "extension names a preset ({ preset, its parameters }), a raw preset ({ presetId, params }) or custom code ({ address, codehash, its terms }).",
    );
  if (forms.length > 1)
    invalid(
      "Name the extension one way: a preset, a raw preset or custom code.",
    );
  const only = (allowed: readonly string[], what: string) => {
    const stray = Object.keys(v).find(
      (k) => k !== "payee" && !allowed.includes(k),
    );
    if (stray !== undefined)
      invalid(
        `extension.${stray} is not a field of ${what}: it takes ${allowed.join(", ")} and payee.`,
      );
  };
  const payee =
    v.payee === undefined
      ? NO_EXTENSION.payee
      : requireAddress(v.payee, chain, "extension.payee");

  if (forms[0] === "preset") {
    const preset =
      typeof v.preset === "string"
        ? (v.preset as PresetKey)
        : presetKeyOf(v.preset);
    if (
      !preset ||
      !Object.hasOwn(PRESET_FIELDS, preset) ||
      EXTENSION_PRESETS[preset].reference
    )
      return invalid(
        'extension.preset must be "sniper_tax", "decay_tax" or "pump_brake" (or its id, 1 to 3). Raffle Run is a reference extension, not a Bankr product: name it by presetId and params.',
      );
    const fields: readonly string[] = PRESET_FIELDS[preset as PresetName];
    only(["preset", ...fields], `the ${EXTENSION_PRESETS[preset].name} preset`);
    const own = Object.fromEntries(fields.map((k) => [k, v[k]]));
    return presetExtension({ preset, ...own } as PresetParams, payee, chain);
  }
  if (forms[0] === "presetId") {
    only(["presetId", "params"], "a raw preset");
    const preset = presetKeyOf(v.presetId);
    if (!preset)
      return invalid(
        "extension.presetId must be 1 (Sniper Tax), 2 (Decay Tax), 3 (Pump Brake) or 4 (Raffle Run, a reference extension): there is no other preset.",
      );
    if (!isHex(v.params, { strict: true }) || v.params.length % 2 !== 0)
      return invalid(
        "extension.params must be the preset's ABI-encoded parameters, as hex bytes.",
      );
    const id = EXTENSION_PRESETS[preset].id;
    const decoded = decodeExtensionPresetParams(id, v.params);
    const words = EXTENSION_PRESET_WORDS;
    if (!decoded)
      return refuseExtension(
        "EXTENSION_OUT_OF_BOUNDS",
        `${EXTENSION_PRESETS[preset].name} params must be exactly ${words[preset]} ABI words (${words[preset] * 32} bytes), each within its parameter's width.`,
        chain,
      );
    return presetExtension(decoded, payee, chain);
  }

  only(CUSTOM_FIELDS, "a custom extension");
  const ext = requireAddress(v.address, chain, "extension.address");
  if (
    typeof v.codehash !== "string" ||
    !BYTES32.test(v.codehash) ||
    BigInt(v.codehash) === 0n
  )
    invalid(
      "extension.codehash must be the extension's 32-byte code hash, not zero.",
    );
  if (typeof v.quoteOnly !== "boolean")
    invalid("extension.quoteOnly must be true or false.");
  // The ceiling is the pad's (K30): `resolve` holds a declared maximum to it, and names the range.
  const fee = [0, 2 ** 24 - 1] as const;
  intIn(v.maxBuyPips, fee, "Maximum buy fee (pips)", chain);
  intIn(v.maxSellPips, fee, "Maximum sell fee (pips)", chain);
  // Any second: the extension is asked from the first swap, so a sunset inside the fee decay still bounds it.
  intIn(v.sunsetSecs, [0, 2 ** 32 - 1], "Sunset (seconds after launch)", chain);
  const terms = {
    maxBuyPips: v.maxBuyPips as number,
    maxSellPips: v.maxSellPips as number,
    quoteOnly: v.quoteOnly as boolean,
    sunsetSecs: v.sunsetSecs as number,
  };
  const gas = extensionGasBudgets(
    {
      quoteOnly: terms.quoteOnly,
      quoteGas: v.quoteGas as number | undefined,
      afterGas: v.afterGas as number | undefined,
    },
    chain,
  );
  return {
    params: {
      ...NO_EXTENSION,
      ...terms,
      payee,
      ext,
      codehash: (v.codehash as string).toLowerCase() as Hex,
      // A floor goes out as 0: the factory reverts AmbiguousExtension on one spelled out (one encoding per term).
      quoteGas: gas.quoteGas === EXT_QUOTE_GAS ? 0 : gas.quoteGas,
      afterGas: gas.afterGas === EXT_AFTER_GAS ? 0 : gas.afterGas,
    },
    preset: null,
    terms,
    gas,
  };
}

/** `IBankrLaunchpadRegistry`'s `EXT_KIND_*`: 0 none, 1 a preset, 2 custom code that only quotes, 3 custom code the
 *  hook also calls after each swap. */
export function extensionKind(e: LaunchExtension): 0 | 1 | 2 | 3 {
  if (e.id !== 0) return 1;
  if (BigInt(e.ext) === 0n) return 0;
  return e.quoteOnly ? 2 : 3;
}

/**
 * `settings.extensionKey(extension)`: what Bankr allowlists; null without an extension. A preset's key carries its
 * creation-code hash (`settings.presetOf(id).creationCodeHash`), so replacing a preset's code needs a new key. Custom
 * code keys by its codehash, or sha256 over it and the budgets its binding will hold when the launch names any
 * (sha256, so no contract's keccak256 code hash can equal a budget key).
 */
export function extensionAllowlistKey(
  e: LaunchExtension,
  presetCreationCodeHash?: Hex,
): Hex | null {
  if (e.id !== 0) {
    if (!presetCreationCodeHash)
      throw new TypeError(
        "a preset's allowlist key needs its creation-code hash",
      );
    return keccak256(
      encodePacked(
        ["string", "uint8", "bytes32"],
        ["preset", e.id, presetCreationCodeHash],
      ),
    );
  }
  if (BigInt(e.ext) === 0n) return null;
  if ((e.quoteGas | e.afterGas) === 0) return e.codehash;
  return sha256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [
        e.codehash,
        BigInt(e.quoteGas === 0 ? EXT_QUOTE_GAS : e.quoteGas),
        BigInt(e.afterGas === 0 && !e.quoteOnly ? EXT_AFTER_GAS : e.afterGas),
      ],
    ),
  );
}
