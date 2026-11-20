// Errors a launch can revert with from contracts whose ABI the SDK doesn't vendor; simulate.ts and suite4/revert.ts
// both decode with them.

/** The hook's extension errors a launch or a buy can surface; the hook's ABI is not vendored. Held equal to core's
 *  hook ABI entries. */
export const HOOK_EXTENSION_ERRORS = [
  { type: "error", name: "ExtensionGasBudget", inputs: [] },
  { type: "error", name: "ExtensionRefusedBuy", inputs: [] },
  { type: "error", name: "ExtensionRejected", inputs: [] },
  { type: "error", name: "ExtensionCodehashMismatch", inputs: [] },
] as const;

/** What a preset launch reverts with from code the SDK vendors no ABI of: each preset's constructor (its bounds) and
 *  the preset deployer. Held equal to core's ABI entries. */
export const PRESET_ERRORS = [
  { type: "error", name: "PresetParamsMalformed", inputs: [] },
  { type: "error", name: "PresetFeeOutOfBounds", inputs: [] },
  { type: "error", name: "PresetTimeOutOfBounds", inputs: [] },
  { type: "error", name: "PresetThresholdOutOfBounds", inputs: [] },
  {
    type: "error",
    name: "UnknownPreset",
    inputs: [{ name: "preset", type: "uint8", internalType: "uint8" }],
  },
] as const;
