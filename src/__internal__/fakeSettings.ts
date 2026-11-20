// Test-only: the settings contract, the launchpad registry and the factory's owner levers as in-memory state on
// the fake node, with `apply` writing a built transaction the way the contracts store it (no checks: a test asserts
// what a builder refuses, and what its calldata writes). Excluded from the build; viem and relative imports only.
import {
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { SETTINGS_KNOBS } from "../abis/knobs.js";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrLaunchpadRegistryAbi,
  bankrTermsLensAbi,
} from "../abis/settings.js";
import { getChain } from "../chains/index.js";
import { PAD_TREASURY_MARKER } from "../launchpad.js";
import type { UnsignedTx } from "../providers/types.js";
import type { SettingsContext } from "../settings/context.js";
import { switchWord } from "../settings/names.js";
import type {
  ChainPadTerms,
  GuardTerms,
  PadQuoteTerms,
  PresetLimits,
  PresetRecord,
  ProtocolTerms,
  QuoteTerms,
} from "../settings/rules.js";
import { FakeChain } from "./fakeRpc.js";

type Range = { min: bigint; max: bigint; dflt: bigint };

type Limit = { min: bigint; max: bigint };

/** A fixed address for a fake contract or actor, checksummed as viem decodes one. */
export const at = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, "0")}`);

export const SUITE = {
  factory: at(0xfac),
  launchpadRegistry: at(0xbe6),
  settings: at(0x5e7),
  ledger: at(0x1ed),
  termsLens: at(0x1e5),
  blockNumber: 10,
} as const;
export const OWNER = at(0xa1);
export const REGISTRY_OWNER = at(0xa2);
export const OPERATOR = at(0xb1);
export const FLYWHEEL = at(0xf1);
export const TEMPLATE_ID = 2n ** 64n - 1n;

const NO_LIMITS: PresetLimits = {
  allowed: false,
  maxWindowSecs: 0,
  minBrakeTicks: 0,
  minAnchorTau: 0,
};
const NO_PRESET: PresetRecord = {
  deployer: zeroAddress,
  deployerCodeHash: zeroHash,
  creationCodeHash: zeroHash,
  selfPayee: false,
  active: false,
};
const NO_QUOTE: QuoteTerms = {
  allowed: false,
  mode: 0,
  decimals: 0,
  maxPriceAge: 0,
  feed: zeroAddress,
  compoundFloor: 0n,
  compoundCap: 0n,
  quoteActivation: 0n,
  quotePaid: false,
};
const NO_PAD_QUOTE: PadQuoteTerms = {
  allowed: false,
  ownAmounts: false,
  compoundFloor: 0n,
  compoundCap: 0n,
};
const NO_PAYEES: ChainPadTerms = {
  payees: [],
  steadySharesWad: [],
  decay: { on: false, autoLpBps: 0, sharesWad: [] },
};

export interface FakePad {
  operator: Address;
  pendingOperator: Address;
  signer: Address;
  paused: boolean;
  verified: boolean;
  vanity: { suffix: number; nibbles: number };
  uri: string;
  ranges: Range[];
  flags: bigint;
  capController: Address;
  terms: ChainPadTerms;
  presetLimits: Map<number, PresetLimits>;
  waived: boolean;
  quotes: Map<string, PadQuoteTerms>;
  curveFlip: Set<bigint>;
}

const lower = (a: string) => a.toLowerCase();
const knob = (name: string): number =>
  SETTINGS_KNOBS.find((k) => k.name === name)!.id;
const pin = (v: bigint): Range => ({ min: v, max: v, dflt: v });

/** The settings a fresh fake deployment starts with. */
export class FakeSettings {
  readonly chain = new FakeChain(base);
  owner = OWNER;
  pendingOwner: Address = zeroAddress;
  registryOwner = REGISTRY_OWNER;
  registryPendingOwner: Address = zeroAddress;
  paused = true;
  launchGated = true;
  treasury = at(0xe1);
  hook = at(0xc1);
  holderLeg = at(0xd1);
  readonly bankrCode = new Set<string>([
    lower(SUITE.factory),
    lower(SUITE.ledger),
  ]);
  readonly named = new Map<string, bigint>();
  readonly legIds = new Map<string, number>([[lower(this.holderLeg), 1]]);
  protocol: ProtocolTerms = {
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
  };
  guards: GuardTerms = {
    refTauSecs: 1_800,
    compoundSwapMaxTicks: 50,
    fillTravelTicks: 100,
    fillTravelCompoundingTicks: 25,
    fillStartGapTicks: 20,
    minRoundTripPips: 10_000,
    curveNearStep: 13,
    maxCompoundUsd: 10_000,
  };
  readonly hard: Limit[] = SETTINGS_KNOBS.map((k) => ({
    min: k.hardMin,
    max: k.hardMax,
  }));
  limits: Limit[] = this.hard.map((l) => ({ ...l }));
  allowedFlags = 2_047n;
  template = {
    ranges: [] as Range[],
    flags: switchWord({
      devBuy: true,
      allocations: true,
      capExclusions: true,
      metadataAdmin: true,
      unlistedQuotes: true,
      extPresets: true,
      extOwnerSwitch: true,
    }),
    capController: zeroAddress as Address,
    presetLimits: new Map<number, PresetLimits>(),
    waived: true,
  };
  readonly pads = new Map<bigint, FakePad>();
  readonly quotes = new Map<string, QuoteTerms>();
  quoteList: Address[] = [];
  readonly presets = new Map<number, PresetRecord>();
  readonly extAllowed = new Set<string>();
  priceSigner: Address = zeroAddress;
  sequencerFeed: Address = zeroAddress;
  sequencerGrace = 0;
  bond = 10n ** 16n;
  maxUri = 2_048;
  readonly vanityOwners = new Map<string, bigint>([["2979/3", 0n]]);
  readonly termsHashes = new Map<string, Hex>();
  /** What the lens answers `coinTermsMatch` for a token: the coin's stores still hold its record. */
  readonly storesHold = new Map<string, boolean>();
  /** What the lens answers `coinTerms` for a token. */
  readonly storedTerms = new Map<string, unknown>();

  constructor() {
    this.limits[knob("steadyPips")] = { min: 500n, max: 999_999n };
    this.limits[knob("feeRecipients")] = { min: 1n, max: 10n };
    this.template.ranges = this.limits.map((l) => ({
      min: l.min,
      max: l.max,
      dflt: l.min,
    }));
    this.template.ranges[knob("steadyPips")] = {
      min: 500n,
      max: 100_000n,
      dflt: 500n,
    };
    this.template.ranges[knob("referrerBps")] = pin(0n);
    for (let id = 1; id <= 4; id++)
      this.template.presetLimits.set(id, {
        allowed: true,
        maxWindowSecs: 3_600,
        minBrakeTicks: 0,
        minAnchorTau: 21_600,
      });
    const bankr = this.newPad(REGISTRY_OWNER, zeroAddress, {
      payees: [PAD_TREASURY_MARKER, FLYWHEEL],
      steadySharesWad: [246_031_746_031_746_032n, 150_793_650_793_650_794n],
      decay: {
        on: true,
        autoLpBps: 10_000,
        sharesWad: [447_089_947_089_947_090n, 251_322_751_322_751_323n],
      },
    });
    bankr.ranges[knob("steadyPips")] = pin(17_500n);
    bankr.ranges[knob("startPips")] = pin(800_000n);
    bankr.ranges[knob("decaySecs")] = pin(14n);
    bankr.flags = switchWord(
      { takeover: true, unlistedQuotes: false },
      this.template.flags,
    );
    bankr.waived = false;
    this.pads.set(0n, bankr);
    this.install();
  }

  /** A pad as `register` leaves it: the template's rows, takeover off, these payees. */
  newPad(operator: Address, signer: Address, terms: ChainPadTerms): FakePad {
    return {
      operator,
      pendingOperator: zeroAddress,
      signer,
      paused: false,
      verified: false,
      vanity: { suffix: 0, nibbles: 0 },
      uri: "",
      ranges: this.template.ranges.map((r) => ({ ...r })),
      flags: this.template.flags & this.allowedFlags & ~16n,
      capController: this.template.capController,
      terms,
      presetLimits: new Map(this.template.presetLimits),
      waived: this.template.waived,
      quotes: new Map(),
      curveFlip: new Set(),
    };
  }

  /** Registers a pad directly, as a test's starting state; returns its id. */
  addPad(
    terms: ChainPadTerms = NO_PAYEES,
    operator: Address = OPERATOR,
  ): bigint {
    const id = BigInt(this.pads.size);
    this.pads.set(id, this.newPad(operator, zeroAddress, terms));
    return id;
  }

  pad(id: bigint): FakePad {
    const pad = this.pads.get(id);
    if (!pad) throw new Error(`no fake pad ${id}`);
    return pad;
  }

  context(): SettingsContext {
    return {
      chain: getChain("base"),
      client: this.chain.publicClient(),
      addresses: SUITE,
    };
  }

  private rows(id: bigint) {
    return id === TEMPLATE_ID ? this.template : this.pad(id);
  }

  private install(): void {
    const c = this.chain;
    const arg = <T>(args: readonly unknown[], i = 0) => args[i] as T;
    const empty = (id: bigint) => !this.pads.has(id);
    c.contract(SUITE.settings, bankrLaunchSettingsAbi, {
      protocolTerms: () => this.protocol,
      guardTerms: () => this.guards,
      limits: () => this.limits,
      limitOf: (a: readonly unknown[]) => this.limits[arg<number>(a)],
      hardBounds: (a: readonly unknown[]) => {
        const h = this.hard[arg<number>(a)]!;
        return [h.min, h.max];
      },
      allowedFlags: () => this.allowedFlags,
      template: () => [
        this.template.ranges,
        this.template.flags,
        this.template.capController,
      ],
      templatePresetLimits: (a: readonly unknown[]) =>
        this.template.presetLimits.get(arg<number>(a)) ?? NO_LIMITS,
      padConfig: (a: readonly unknown[]) => {
        const id = arg<bigint>(a);
        const pad = empty(id)
          ? this.newPad(zeroAddress, zeroAddress, NO_PAYEES)
          : this.pad(id);
        return {
          knobs: pad.ranges.map((_, i) => i),
          ranges: empty(id) ? pad.ranges.map(() => pin(0n)) : pad.ranges,
          flags: empty(id) ? 0n : pad.flags,
          capController: pad.capController,
          terms: pad.terms,
          presetIds: empty(id) ? [] : [...pad.presetLimits.keys()],
          presetLimits: empty(id) ? [] : [...pad.presetLimits.values()],
        };
      },
      payeesOf: (a: readonly unknown[]) =>
        empty(arg<bigint>(a)) ? NO_PAYEES : this.pad(arg<bigint>(a)).terms,
      bnkrPairWaiver: (a: readonly unknown[]) =>
        this.rows(arg<bigint>(a)).waived,
      quoteTerms: (a: readonly unknown[]) =>
        this.quotes.get(lower(arg<Address>(a))) ?? NO_QUOTE,
      quoteList: () => this.quoteList,
      padQuoteTerms: (a: readonly unknown[]) =>
        this.pad(arg<bigint>(a)).quotes.get(lower(arg<Address>(a, 1))) ??
        NO_PAD_QUOTE,
      isQuoteAllowed: (a: readonly unknown[]) => {
        const listed = [...this.pad(arg<bigint>(a)).quotes.entries()].filter(
          ([, t]) => t.allowed,
        );
        return (
          listed.length === 0 ||
          listed.some(([q]) => q === lower(arg<Address>(a, 1)))
        );
      },
      isCurveAllowed: (a: readonly unknown[]) => {
        const key = arg<bigint>(a, 1);
        return this.pad(arg<bigint>(a)).curveFlip.has(key) !== key < 3n;
      },
      presetOf: (a: readonly unknown[]) =>
        this.presets.get(arg<number>(a)) ?? NO_PRESET,
      extensionAllowed: (a: readonly unknown[]) =>
        this.extAllowed.has(lower(arg<Hex>(a))),
      pricingConfig: () => [
        this.priceSigner,
        this.sequencerFeed,
        this.sequencerGrace,
      ],
      namedAs: (a: readonly unknown[]) =>
        this.named.get(lower(arg<Address>(a))) ?? 0n,
    });
    c.contract(SUITE.launchpadRegistry, bankrLaunchpadRegistryAbi, {
      launchpadCount: () => BigInt(this.pads.size - 1),
      owner: () => this.registryOwner,
      pendingOwner: () => this.registryPendingOwner,
      operatorOf: (a: readonly unknown[]) =>
        arg<bigint>(a) === 0n
          ? this.registryOwner
          : this.pad(arg<bigint>(a)).operator,
      getLaunchpad: (a: readonly unknown[]) => {
        const pad = this.pad(arg<bigint>(a));
        return {
          operator: arg<bigint>(a) === 0n ? zeroAddress : pad.operator,
          pendingOperator: pad.pendingOperator,
          signer: pad.signer,
          paused: pad.paused,
          verified: pad.verified,
          vanity: pad.vanity,
        };
      },
      metadataUriOf: (a: readonly unknown[]) => this.pad(arg<bigint>(a)).uri,
      registrationBondWei: () => this.bond,
      maxPadUriBytes: () => this.maxUri,
      bankrSigner: () => this.pad(0n).signer,
      vanityOwner: (a: readonly unknown[]) => {
        const owner = this.vanityOwners.get(
          `${arg<number>(a)}/${arg<number>(a, 1)}`,
        );
        return [owner !== undefined, owner ?? 0n];
      },
    });
    c.contract(SUITE.factory, bankrLaunchFactoryAbi, {
      owner: () => this.owner,
      pendingOwner: () => this.pendingOwner,
      paused: () => this.paused,
      launchGated: () => this.launchGated,
      treasury: () => this.treasury,
      hook: () => this.hook,
      hookGenerations: () => [this.hook],
      holderLeg: () => this.holderLeg,
      settings: () => SUITE.settings,
      launchpadRegistry: () => SUITE.launchpadRegistry,
      ledger: () => SUITE.ledger,
      isSuite: (a: readonly unknown[]) =>
        this.bankrCode.has(lower(arg<Address>(a))),
      termsHashOf: (a: readonly unknown[]) =>
        this.termsHashes.get(lower(arg<Address>(a))) ?? zeroHash,
    });
    c.contract(SUITE.ledger, bankrFeeLedgerAbi, {
      legIdOf: (a: readonly unknown[]) =>
        this.legIds.get(lower(arg<Address>(a))) ?? 0,
      claimRestricted: () => false,
    });
    c.contract(SUITE.termsLens, bankrTermsLensAbi, {
      coinTerms: (a: readonly unknown[]) =>
        this.storedTerms.get(lower(arg<Address>(a))),
      coinTermsMatch: (a: readonly unknown[]) =>
        keccak256(arg<Hex>(a, 1)) ===
          this.termsHashes.get(lower(arg<Address>(a))) &&
        (this.storesHold.get(lower(arg<Address>(a))) ?? true),
    });
  }

  /** Writes a built transaction as the contract it names would store it, and returns what it called. */
  apply(tx: UnsignedTx): { functionName: string; args: readonly unknown[] } {
    const to = lower(tx.to);
    const abi =
      to === lower(SUITE.settings)
        ? bankrLaunchSettingsAbi
        : to === lower(SUITE.launchpadRegistry)
          ? bankrLaunchpadRegistryAbi
          : bankrLaunchFactoryAbi;
    const call = decodeFunctionData({ abi, data: tx.data }) as {
      functionName: string;
      args?: readonly unknown[];
    };
    const a = call.args ?? [];
    const write = this.writers(tx)[`${to}:${call.functionName}`];
    if (!write)
      throw new Error(`the fake contracts do not apply ${call.functionName}`);
    write(a);
    return { functionName: call.functionName, args: a };
  }

  private setKnobs(
    id: bigint,
    knobs: readonly number[],
    ranges: readonly Range[],
  ) {
    knobs.forEach((k, i) => (this.rows(id).ranges[k] = ranges[i]!));
  }

  private writers(
    tx: UnsignedTx,
  ): Record<string, (a: readonly unknown[]) => void> {
    const s = lower(SUITE.settings);
    const reg = lower(SUITE.launchpadRegistry);
    const f = lower(SUITE.factory);
    const v = <T>(a: readonly unknown[], i = 0) => a[i] as T;
    return {
      [`${s}:setProtocolTerms`]: (a) => (this.protocol = v(a)),
      [`${s}:setGuardTerms`]: (a) => (this.guards = v(a)),
      [`${s}:setLimits`]: (a) =>
        v<number[]>(a).forEach(
          (k, i) => (this.limits[k] = v<Limit[]>(a, 1)[i]!),
        ),
      [`${s}:setTemplate`]: (a) => {
        this.setKnobs(TEMPLATE_ID, v(a), v(a, 1));
        this.template.flags = v(a, 2);
        this.template.capController = v(a, 3);
      },
      [`${s}:setTemplatePresetLimits`]: (a) =>
        this.template.presetLimits.set(v(a), v(a, 1)),
      [`${s}:setAllowedFlags`]: (a) => (this.allowedFlags = v(a)),
      [`${s}:setQuote`]: (a) => {
        const q = v<Address>(a);
        if (!this.quotes.get(lower(q))?.allowed) this.quoteList.push(q);
        this.quotes.set(lower(q), v(a, 1));
        this.named.set(lower(q), (this.named.get(lower(q)) ?? 0n) | 1n);
      },
      [`${s}:removeQuote`]: (a) => {
        this.quotes.delete(lower(v<Address>(a)));
        this.quoteList = this.quoteList.filter((q) => !isAddressEqual(q, v(a)));
      },
      [`${s}:setPriceSigner`]: (a) => (this.priceSigner = v(a)),
      [`${s}:setSequencerUptimeFeed`]: (a) => {
        this.sequencerFeed = v(a);
        this.sequencerGrace = v(a, 1);
      },
      [`${s}:setPreset`]: (a) => this.presets.set(v(a), v(a, 1)),
      [`${s}:setExtensionAllowed`]: (a) =>
        v<boolean>(a, 1)
          ? this.extAllowed.add(lower(v<Hex>(a)))
          : this.extAllowed.delete(lower(v<Hex>(a))),
      [`${s}:setBnkrPairWaiver`]: (a) => (this.rows(v(a)).waived = v(a, 1)),
      // configure moves the knobs and preset limits it names, and writes the other three as sent.
      [`${s}:configure`]: (a) => {
        const c = v<{
          knobs: number[];
          ranges: Range[];
          flags: bigint;
          capController: Address;
          terms: ChainPadTerms;
          presetIds: number[];
          presetLimits: PresetLimits[];
        }>(a, 1);
        const pad = this.pad(v(a));
        this.setKnobs(v(a), c.knobs, c.ranges);
        pad.flags = c.flags;
        pad.capController = c.capController;
        pad.terms = c.terms;
        c.presetIds.forEach((p, i) =>
          pad.presetLimits.set(p, c.presetLimits[i]!),
        );
      },
      [`${s}:setKnobs`]: (a) => this.setKnobs(v(a), v(a, 1), v(a, 2)),
      [`${s}:setFlags`]: (a) => (this.pad(v(a)).flags = v(a, 1)),
      [`${s}:setPayees`]: (a) => (this.pad(v(a)).terms = v(a, 1)),
      [`${s}:setCapController`]: (a) =>
        (this.pad(v(a)).capController = v(a, 1)),
      [`${s}:setQuoteTerms`]: (a) =>
        this.pad(v(a)).quotes.set(lower(v<Address>(a, 1)), v(a, 2)),
      [`${s}:setCurveAllowed`]: (a) => {
        const flips = this.pad(v(a)).curveFlip;
        const key = v<bigint>(a, 1);
        if (v<boolean>(a, 2) !== key < 3n) flips.add(key);
        else flips.delete(key);
      },
      [`${s}:setPresetLimits`]: (a) =>
        this.pad(v(a)).presetLimits.set(v(a, 1), v(a, 2)),
      [`${reg}:register`]: (a) => {
        this.pads.set(
          BigInt(this.pads.size),
          Object.assign(
            this.newPad(tx.from, v(a), {
              payees: v(a, 1),
              steadySharesWad: v(a, 2),
              decay: NO_PAYEES.decay,
            }),
            { uri: v<string>(a, 3) },
          ),
        );
      },
      [`${reg}:setSigner`]: (a) => (this.pad(v(a)).signer = v(a, 1)),
      // The pad's old suffix is released, then the new one is its own.
      [`${reg}:setVanity`]: (a) => {
        const pad = this.pad(v(a));
        const next = v<FakePad["vanity"]>(a, 1);
        this.vanityOwners.delete(`${pad.vanity.suffix}/${pad.vanity.nibbles}`);
        if (next.nibbles !== 0)
          this.vanityOwners.set(`${next.suffix}/${next.nibbles}`, v<bigint>(a));
        pad.vanity = next;
      },
      [`${reg}:setMetadataUri`]: (a) => (this.pad(v(a)).uri = v(a, 1)),
      [`${reg}:setPaused`]: (a) => (this.pad(v(a)).paused = v(a, 1)),
      [`${reg}:transferOperator`]: (a) =>
        (this.pad(v(a)).pendingOperator = v(a, 1)),
      [`${reg}:acceptOperator`]: (a) =>
        Object.assign(this.pad(v(a)), {
          operator: tx.from,
          pendingOperator: zeroAddress,
        }),
      [`${reg}:setRegistrationBond`]: (a) => (this.bond = v(a)),
      [`${reg}:setMaxPadUriBytes`]: (a) => (this.maxUri = v(a)),
      [`${reg}:setBankrSigner`]: (a) => (this.pad(0n).signer = v(a)),
      [`${reg}:setVerified`]: (a) => (this.pad(v(a)).verified = v(a, 1)),
      [`${reg}:revokeVanity`]: (a) => {
        const pad = this.pad(v(a));
        this.vanityOwners.set(
          `${pad.vanity.suffix}/${pad.vanity.nibbles}`,
          TEMPLATE_ID,
        );
        pad.vanity = { suffix: 0, nibbles: 0 };
      },
      [`${reg}:assignVanity`]: () => undefined,
      [`${reg}:transferOwnership`]: (a) => (this.registryPendingOwner = v(a)),
      [`${reg}:acceptOwnership`]: () => {
        this.registryOwner = tx.from;
        this.registryPendingOwner = zeroAddress;
      },
      [`${f}:setHook`]: (a) => (this.hook = v(a)),
      [`${f}:setHolderLeg`]: (a) => {
        this.holderLeg = v(a);
        this.legIds.set(lower(v<Address>(a)), this.legIds.size + 1);
      },
      [`${f}:setTreasury`]: (a) => (this.treasury = v(a)),
      [`${f}:setPaused`]: (a) => (this.paused = v(a)),
      [`${f}:setLaunchGated`]: (a) => (this.launchGated = v(a)),
      [`${f}:transferOwnership`]: (a) => (this.pendingOwner = v(a)),
      [`${f}:acceptOwnership`]: () => {
        this.owner = tx.from;
        this.pendingOwner = zeroAddress;
      },
    };
  }
}
