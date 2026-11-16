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
import type { LaunchpadPolicy } from "./launchpad.js";
import {
  EXTENSION_FEE_BOUNDS,
  EXTENSION_PRESETS,
  PRESET_BOUNDS,
  PRESET_WORDS,
  decodePresetParams,
  encodePresetParams,
  intIn,
  presetKeyOf,
  presetTerms,
  refuseExtension,
  type ExtensionTerms,
  type PresetKey,
  type PresetParams,
} from "./presets.js";
import { requireAddress } from "./recipient.js";
import {
  SUITE4_PRESET_WORDS,
  decodeSuite4PresetParams,
  encodeSuite4PresetParams,
  type Suite4PresetParams,
} from "./suite4/presets.js";
import type { ExtensionGas } from "./swapGas.js";
import { NO_EXTENSION, type LaunchExtension } from "./terms.js";

// A launch's `extension` option, vendored from core's bankr-v4 extensions.ts (src/__internal__ holds each equal): its
// three forms, custom code's binding rules, and the registry's view of it (kind, allowlist key, pad policy). Pure.

interface ExtensionPayee {
  /** Who is paid the extension's fee, after Bankr's 2/7. Default: the launch's first fee recipient; a launch with
   *  several fee recipients must name it. */
  payee?: Address;
}

type ByNameOrId<P, Id extends number> = P extends { preset: infer K }
  ? Omit<P, "preset"> & { preset: K | Id } & ExtensionPayee
  : never;

/** Sniper Tax: a flat extra fee on buys (1 to 100,000 pips) and sells until `endSecs` (121 to 3,600) after launch. */
export type SniperTaxInput = ByNameOrId<
  Extract<PresetParams, { preset: "sniper_tax" }>,
  1
>;

/** Decay Tax: an extra fee each way that falls from its start to 0 over `decaySecs` (121 seconds to 7 days). */
export type DecayTaxInput = ByNameOrId<
  Extract<PresetParams, { preset: "decay_tax" }>,
  2
>;

/** Pump Brake: an extra fee on buys while the price is over `thresholdTicks` (6,932, about 2x, or more) above launch. */
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

/** Extension code the suite's allowlist holds by its code hash: what the hook binds for the pool's life. */
export interface CustomExtensionInput extends ExtensionPayee {
  address: Address;
  /** The extension's `extcodehash`; the hook refuses the launch on any other. */
  codehash: Hex;
  /** The most it may add to a buy or a sell, in pips (at most 100,000). */
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

const B = PRESET_BOUNDS;
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
 *  Suite 3 holds the parameters to its compiled bounds here; suite 4 only to their widths (its pad's limits follow). */
function presetExtension(
  p: PresetParams,
  payee: Address,
  chain?: LaunchChain,
  suite: 3 | 4 = 3,
): NormalizedExtension {
  const terms = presetTerms(p);
  return {
    params: {
      ...NO_EXTENSION,
      id: EXTENSION_PRESETS[p.preset].id,
      params:
        suite === 4
          ? encodeSuite4PresetParams(p as Suite4PresetParams, chain)
          : encodePresetParams(p, chain),
      payee,
    },
    preset: p,
    terms,
    gas: extensionGasBudgets({ quoteOnly: terms.quoteOnly }, chain),
  };
}

/**
 * A launch's `extension` option with its static refusals applied: the form (one of a preset, a raw preset or custom
 * code, and only that form's fields: `INVALID_PARAMS`), then each parameter against the bound its contract holds it
 * to (`EXTENSION_OUT_OF_BOUNDS`, the detail naming the bound).
 */
export function normalizeExtension(
  input: unknown,
  chain?: LaunchChain,
  suite: 3 | 4 = 3,
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
      !Object.hasOwn(B, preset) ||
      EXTENSION_PRESETS[preset].reference
    )
      return invalid(
        'extension.preset must be "sniper_tax", "decay_tax" or "pump_brake" (or its id, 1 to 3). Raffle Run is a reference extension, not a Bankr product: name it by presetId and params.',
      );
    const fields = Object.keys(B[preset]);
    only(["preset", ...fields], `the ${EXTENSION_PRESETS[preset].name} preset`);
    const own = Object.fromEntries(fields.map((k) => [k, v[k]]));
    return presetExtension(
      { preset, ...own } as PresetParams,
      payee,
      chain,
      suite,
    );
  }
  if (forms[0] === "presetId") {
    only(["presetId", "params"], "a raw preset");
    const preset = presetKeyOf(v.presetId);
    if (!preset)
      return invalid(
        "extension.presetId must be 1 (Sniper Tax), 2 (Decay Tax), 3 (Pump Brake) or 4 (Raffle Run, a reference extension): the suite deploys no other preset.",
      );
    if (!isHex(v.params, { strict: true }) || v.params.length % 2 !== 0)
      return invalid(
        "extension.params must be the preset's ABI-encoded parameters, as hex bytes.",
      );
    const id = EXTENSION_PRESETS[preset].id;
    // Raffle Run's constructor takes six words on suite 4, four on suite 3.
    const [decoded, words] =
      suite === 4
        ? [decodeSuite4PresetParams(id, v.params), SUITE4_PRESET_WORDS]
        : [decodePresetParams(id, v.params), PRESET_WORDS];
    if (!decoded)
      return refuseExtension(
        "EXTENSION_OUT_OF_BOUNDS",
        `${EXTENSION_PRESETS[preset].name} params must be exactly ${words[preset]} ABI words (${words[preset] * 32} bytes), each within its parameter's width.`,
        chain,
      );
    return presetExtension(decoded, payee, chain, suite);
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
  // Suite 4's ceiling is the pad's (K30): `resolve` holds a declared maximum to it, and names the range.
  const fee = suite === 4 ? ([0, 2 ** 24 - 1] as const) : EXTENSION_FEE_BOUNDS;
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
 * The registry's allowlist key for a launch's extension, as `LaunchRegistry._launchTerms` builds it; null without
 * one. A preset by id; custom code by its codehash, or sha256 over it and the budgets its binding will hold when the
 * launch names any (sha256, so no contract's keccak256 code hash can equal a budget key).
 */
export function extensionAllowlistKey(e: LaunchExtension): Hex | null {
  if (e.id !== 0)
    return keccak256(encodePacked(["string", "uint8"], ["preset", e.id]));
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

/**
 * Suite 4's `settings.extensionKey(extension)`: what the owner allowlists. A preset's key carries its creation-code
 * hash (`presetOf(id).creationCodeHash`), so replacing a preset's code needs a new key; custom code keys as on suite 3.
 */
export function suite4ExtensionAllowlistKey(
  e: LaunchExtension,
  presetCreationCodeHash?: Hex,
): Hex | null {
  if (e.id === 0) return extensionAllowlistKey(e);
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

/** `BankrLaunchpadRegistry._checkPolicy`: the pad's `allowedExtensions` bit for the extension's kind, and custom
 *  code's larger declared maximum within the pad's `maxExtensionPips`. */
export function padAllowsExtension(
  policy: Pick<LaunchpadPolicy, "allowedExtensions" | "maxExtensionPips">,
  e: LaunchExtension,
): boolean {
  const kind = extensionKind(e);
  if (kind === 0) return true;
  const declared = kind > 1 ? Math.max(e.maxBuyPips, e.maxSellPips) : 0;
  return (
    ((policy.allowedExtensions >> (kind - 1)) & 1) === 1 &&
    declared <= policy.maxExtensionPips
  );
}
