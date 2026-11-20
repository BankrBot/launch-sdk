// Test-only: what a fresh deployment holds for an open launchpad on WETH, as the fake contracts' launch check reads it:
// the template's rows, the owner's limits and terms, one feed-priced quote. Forge's own deploy, value for value
// (the parity suite holds it to settingsForgeVectors.json). Excluded from the build; viem and relative imports only.
import { getAddress, zeroHash, type Address } from "viem";
import { SETTINGS_KNOBS } from "../abis/knobs.js";
import { PAD_FLAG, type KnobName } from "../launch/settings.js";
import type { BankrV4ResolverState } from "./fakeResolverState.js";

/** The fake deployment's WETH: listed, 18 decimals, priced by a feed at $2,500. */
export const FRESH_QUOTE = getAddress(
  "0xC9E459D48Fb9874A699587A9Cf1Df146e41Ec57F",
);
/** The id of the open pad the state is for: the first pad registered after Bankr's. */
export const FRESH_PAD_ID = 1n;

type Row = readonly [min: bigint, max: bigint, dflt: bigint];

/** What a new launchpad copies from the template: each knob's range and the default a launch takes. */
export const TEMPLATE_ROWS: Record<KnobName, Row> = {
  steadyPips: [500n, 100_000n, 500n],
  startPips: [0n, 800_000n, 0n],
  decaySecs: [0n, 120n, 0n],
  referrerBps: [0n, 0n, 0n],
  holdersBps: [0n, 10_000n, 1_167n],
  autoLpBps: [0n, 10_000n, 3_000n],
  buybackBps: [0n, 10_000n, 0n],
  vestBps: [0n, 5_000n, 1_500n],
  vestToHoldersBps: [0n, 5_000n, 0n],
  vestedTotalBps: [0n, 5_000n, 0n],
  vestToHoldersSecs: [86_400n, 31_536_000n, 31_536_000n],
  vestCliffSecs: [2_592_000n, 2_592_000n, 2_592_000n],
  vestSecs: [31_536_000n, 31_536_000n, 31_536_000n],
  supply: [1n, 100_000_000_000n, 100_000_000_000n],
  capBps: [200n, 200n, 200n],
  capSecs: [86_400n, 86_400n, 86_400n],
  devBuyMaxBps: [0n, 200n, 0n],
  startDelaySecs: [0n, 604_800n, 0n],
  startFdvUsd: [2_000n, 125_000_000n, 10_000n],
  metadataBytes: [0n, 2_048n, 0n],
  feeRecipients: [1n, 10n, 1n],
  compoundIntervalSecs: [300n, 300n, 300n],
  compoundShareBps: [2_500n, 2_500n, 2_500n],
  compoundDeviationTicks: [488n, 488n, 488n],
  bandHalfWidth: [34n, 34n, 34n],
  bandGrid: [10n, 10n, 10n],
  buybackIntervalSecs: [300n, 300n, 300n],
  buybackRetrySecs: [60n, 60n, 60n],
  rewardStreamSecs: [86_400n, 86_400n, 86_400n],
  feeCeilingPips: [100_000n, 100_000n, 100_000n],
  extMaxPips: [0n, 100_000n, 0n],
  curveMinDepthDiv: [10n, 10n, 10n],
  curveMaxDensity: [2n, 2n, 2n],
  curvePlaceTicks: [120_000n, 120_000n, 120_000n],
  curvePlaceBps: [9_000n, 9_000n, 9_000n],
  curveDustPpm: [2n, 2n, 2n],
  padShareBps: [0n, 10_000n, 0n],
  rewardRestartBps: [1_000n, 1_000n, 1_000n],
};

/** The rules a launch's own bands meet on the template when its pool buys its own token (13 times within the
 *  compound band's half width, 34 spacings). */
export const TEMPLATE_CURVE_RULES = {
  minDepthDiv: Number(TEMPLATE_ROWS.curveMinDepthDiv[2]),
  maxDensity: Number(TEMPLATE_ROWS.curveMaxDensity[2]),
  placeTicks: Number(TEMPLATE_ROWS.curvePlaceTicks[2]),
  placeBps: Number(TEMPLATE_ROWS.curvePlaceBps[2]),
  nearTicks: Number(TEMPLATE_ROWS.bandHalfWidth[2]) * 200,
  nearStep: 13,
  dustPpm: Number(TEMPLATE_ROWS.curveDustPpm[2]),
} as const;

/** The owner's limits where they start inside a knob's hard range; every other knob's limit is that range. */
export const OWNER_LIMITS: Partial<
  Record<KnobName, { min: bigint; max: bigint }>
> = {
  steadyPips: { min: 500n, max: 999_999n },
  decaySecs: { min: 0n, max: 120n },
  metadataBytes: { min: 0n, max: 2_048n },
  feeRecipients: { min: 1n, max: 10n },
  compoundDeviationTicks: { min: 1n, max: 1_800n },
  startDelaySecs: { min: 0n, max: 604_800n },
  buybackIntervalSecs: { min: 300n, max: 31_536_000n },
  buybackRetrySecs: { min: 60n, max: 31_536_000n },
  rewardStreamSecs: { min: 86_400n, max: 2_592_000n },
};

/** A new pad's switches: everything the template grants. Takeover, custom code and own compound amounts start off. */
export const TEMPLATE_FLAGS =
  PAD_FLAG.devBuy |
  PAD_FLAG.allocations |
  PAD_FLAG.capExclusions |
  PAD_FLAG.metadataAdmin |
  PAD_FLAG.unlistedQuotes |
  PAD_FLAG.extPresets |
  PAD_FLAG.extOwnerSwitch;

const at = (a: string): Address => getAddress(a);

/** The state a launch on the open pad meets on a fresh deployment, at `now`. Each call returns its own copy. */
export function freshContractsState(
  o: { chainId?: number; now?: bigint } = {},
): BankrV4ResolverState {
  return {
    chainId: o.chainId ?? 31_337,
    now: o.now ?? 1_800_000_000n,
    protocol: {
      bankrFeeBps: 1_000,
      bankrMinPips: 250,
      holdersShareBps: 5_000,
      extBankrNum: 2,
      extBankrDen: 7,
      ctoNotice: 172_800,
      ctoGrace: 604_800,
      tokenActivationDivisor: 10_000,
      bnkrActivationDivisor: 10_000_000,
      maxPadPayees: 4,
    },
    guards: {
      refTauSecs: 1_800,
      compoundSwapMaxTicks: 50,
      fillTravelTicks: 100,
      fillTravelCompoundingTicks: 25,
      fillStartGapTicks: 20,
      minRoundTripPips: 10_000,
      curveNearStep: 13,
      maxCompoundUsd: 10_000,
    },
    limits: SETTINGS_KNOBS.map(
      (k) => OWNER_LIMITS[k.name] ?? { min: k.hardMin, max: k.hardMax },
    ),
    allowedFlags: 2_047n,
    pad: {
      knobs: SETTINGS_KNOBS.map((k) => k.id),
      ranges: SETTINGS_KNOBS.map((k) => {
        const [min, max, dflt] = TEMPLATE_ROWS[k.name];
        return { min, max, dflt };
      }),
      flags: TEMPLATE_FLAGS,
      capController: at("0x7c8999dC9a822c1f0Df42023113EDB4FDd543266"),
      terms: {
        payees: [],
        steadySharesWad: [],
        decay: { on: false, autoLpBps: 0, sharesWad: [] },
      },
      presetIds: [1, 2, 3, 4],
      presetLimits: [
        [3_600, 0],
        [604_800, 0],
        [0, 6_932],
        [2_592_000, 0],
      ].map(([maxWindowSecs, minBrakeTicks]) => ({
        allowed: true,
        maxWindowSecs: maxWindowSecs!,
        minBrakeTicks: minBrakeTicks!,
        minAnchorTau: 21_600,
      })),
    },
    padWaiver: true,
    quote: {
      terms: {
        allowed: true,
        mode: 1,
        decimals: 18,
        maxPriceAge: 7_200,
        feed: at("0xa15D69064bf0D35aFDcEdDef6217153e126b9282"),
        compoundFloor: 10n ** 17n,
        compoundCap: 2n * 10n ** 17n,
        quoteActivation: 10n ** 15n,
        quotePaid: false,
      },
      padTakes: true,
      padAmounts: { own: false, compoundFloor: 0n, compoundCap: 0n },
      hasCode: true,
      totalSupply: 3_000_000n * 10n ** 18n,
      feedPriceUsdE18: 2_500n * 10n ** 18n,
    },
    wiring: {
      hook: at("0x5018e24b12633b731aB34A21d4984C630Ea15B79"),
      holderLeg: at("0x23581C651eB5C5555dCCa0bC481e5b6C3248Cec6"),
      legId: 1,
      bnkr: at("0xa3F54cAD0739A0022daaD9ffbc21f1d792c9a0fD"),
      legPaysInQuote: false,
      legConverts: true,
    },
    priceSigner: at("0x08d30B2e6975f3646F156D61c0A9422981b9f7eD"),
    attestationSigner: null,
    curveAllowed: true,
    anyTableAllowed: false,
    extensionAllowed: false,
    extensionCode: { exists: true, startsEf: false, codehash: zeroHash },
  };
}
