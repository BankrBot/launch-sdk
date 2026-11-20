import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { keccak256, type Abi } from "viem";
import { EARLIER_HOLDER_LEG_WAKE_ABI } from "../conversion.js";
import { launchTokenCreationCodeHash } from "../predict.js";
import * as generated from "./generated.js";
import manifest from "./manifest.json";
import { bnkrHolderLegAbi } from "./settings.js";
import * as suite3 from "./suite3.js";

/** Core's manifest convention: sha256 of the ABI's 2-space JSON and a newline. */
const abiSha256 = (abi: unknown): string =>
  `0x${new Bun.CryptoHasher("sha256").update(`${JSON.stringify(abi, null, 2)}\n`).digest("hex")}`;

const abiExports = (mod: Record<string, unknown>) =>
  Object.entries(mod).filter(([, v]) => Array.isArray(v)) as Array<
    [string, Abi]
  >;

const names = (abi: Abi) =>
  new Set(
    abi.flatMap((e) =>
      e.type === "function" || e.type === "event" || e.type === "error"
        ? [e.name]
        : [],
    ),
  );

// Suite 4's set (generated.ts, the manifest's top level) and suite 3's beside it (suite3.ts, `manifest.suite3`).
const SETS = [
  {
    file: "generated.ts",
    mod: generated,
    manifest,
    source: "packages/core/src/bankr-v4/abi/generated.ts",
  },
  {
    file: "suite3.ts",
    mod: suite3,
    manifest: manifest.suite3,
    source: "packages/core/src/bankr-v4/suite3/abi/generated.ts",
  },
] as const;

describe("generated ABIs match their manifest (edit only via scripts/gen-abis.ts)", () => {
  test("every export hashes to its manifest entry, and nothing is missing or extra", () => {
    for (const set of SETS) {
      const exported = abiExports(set.mod);
      const hashes: Record<string, string> = set.manifest.abis;
      expect(exported.map(([n]) => n).sort(), set.file).toEqual(
        Object.keys(hashes).sort(),
      );
      for (const [name, abi] of exported) {
        expect(abiSha256(abi), `${set.file} ${name}`).toBe(hashes[name]!);
      }
      expect(set.manifest.source).toBe(set.source);
    }
  });

  test("each module header names its source and solc, so every regen shows up in the diff", async () => {
    for (const set of SETS) {
      const head = (await Bun.file(join(import.meta.dir, set.file)).text())
        .split("\n")
        .slice(0, 3)
        .join("\n");
      expect(head).toContain(set.manifest.source);
      expect(head).toContain(set.manifest.solc);
    }
  });

  test("each suite's BankrLaunchToken creation code hashes to the manifest, and the two differ", () => {
    for (const set of SETS) {
      expect(keccak256(set.mod.bankrLaunchTokenCreationCode), set.file).toBe(
        set.manifest.creationCodes.bankrLaunchToken as `0x${string}`,
      );
    }
    expect(generated.bankrLaunchTokenCreationCode).not.toBe(
      suite3.bankrLaunchTokenCreationCode,
    );
  });

  test("launchTokenCreationCodeHash is the latest contracts' token's unless the earlier one is asked for", () => {
    expect(launchTokenCreationCodeHash()).toBe(
      keccak256(generated.bankrLaunchTokenCreationCode),
    );
    expect(launchTokenCreationCodeHash(3)).toBe(
      keccak256(suite3.bankrLaunchTokenCreationCode),
    );
  });

  test("suite 4's launch path is on the vendored ABIs: the launch check, the pins' errors and the frozen record", () => {
    const factory = names(generated.bankrLaunchFactoryAbi);
    for (const n of [
      "launch",
      "computeTokenAddress",
      "hashLaunchTerms",
      "termsHashOf",
      "settings",
      "poolOf",
      "TokenLaunched",
      "LaunchResolved",
      "CoinTermsFrozen",
      "TokenAddressChanged",
      "TokenSaltTaken",
      "CompoundStartTooDeep",
    ])
      expect(factory, n).toContain(n);
    // What the settings contract took over from the factory and the pad registry.
    for (const n of ["startTickBounds", "quoteList", "capController"])
      expect(factory, n).not.toContain(n);
    const settings = names(generated.bankrLaunchSettingsAbi);
    for (const n of [
      "resolve",
      "padConfig",
      "limits",
      "allowedFlags",
      "quoteTerms",
      "quoteList",
      "startTickBounds",
      "isCurveAllowed",
      "isQuoteAllowed",
      "presetOf",
      "extensionKey",
      "OutsideLaunchpadRange",
      "NotAllowedByLaunchpad",
      "HardBound",
      "TermsChanged",
      "InvalidOptions",
      "OperatorPayeesMismatch",
      "StartTickOutOfBounds",
    ])
      expect(settings, n).toContain(n);
    const registry = names(generated.bankrLaunchpadRegistryAbi);
    for (const n of ["getLaunchpad", "bankrSigner", "InvalidAuthorization"])
      expect(registry, n).toContain(n);
    for (const n of ["payeesOf", "isQuoteAllowed", "isCurveAllowed"])
      expect(registry, n).not.toContain(n);
    const ledger = names(generated.bankrFeeLedgerAbi);
    for (const n of ["claimRestricted", "isClaimOperator", "mayClaimFor"])
      expect(ledger, n).toContain(n);
  });

  test("suite 3's launch path, reads and claims are on its vendored ABIs", () => {
    const generated = suite3;
    const factory = names(generated.bankrLaunchFactoryAbi);
    for (const n of [
      "launch",
      "computeTokenAddress",
      "hashLaunchTerms",
      "startTickBounds",
      "quoteList",
      "poolOf",
      "TokenLaunched",
      "LaunchResolved",
      "StartTickOutOfBounds",
      "TokenSaltTaken",
    ])
      expect(factory, n).toContain(n);
    const registry = names(generated.bankrLaunchpadRegistryAbi);
    for (const n of [
      "getLaunchpad",
      "payeesOf",
      "isQuoteAllowed",
      "OperatorPayeesMismatch",
      "InvalidAuthorization",
    ])
      expect(registry, n).toContain(n);
    const ledger = names(generated.bankrFeeLedgerAbi);
    for (const n of [
      "claimable",
      "collectFees",
      "collectFeesSide",
      "updateBeneficiary",
      "balances",
      "settle",
      "withdraw",
      "setClaimRestricted",
      "setClaimOperator",
      "mayClaimFor",
      "getCumulatedFees0",
      "getLastCumulatedFees0",
      "bucketOf",
      "BucketRegistered",
      "UpdateBeneficiary",
      "CtoExecuted",
    ])
      expect(ledger, n).toContain(n);
    const distributor = names(generated.holderRewardsDistributorAbi);
    for (const n of [
      "claim",
      "claimLeg",
      "claimFor",
      "claimForMany",
      "earned",
      "ClaimerNotAllowed",
    ])
      expect(distributor, n).toContain(n);
    // Q9: one claim policy per account, on the ledger; the distributor reads it and keeps no operators of its own.
    for (const n of ["setClaimOperator", "isClaimOperator", "ClaimOperatorSet"])
      expect(distributor, n).not.toContain(n);
    expect(ledger).not.toContain("settledCodeless");
    expect(names(generated.creatorVestingEscrowAbi)).toContain("releaseFor");
    expect(names(generated.bankrHookLensAbi)).toContain("poolConfig");
  });
});

// A default client reads a suite 4 coin through suite 3's set wherever the two agree (fees, holders, vesting, the
// metadata link, the factory's record). That holds only while each entry named here is one value in both sets;
// what suite 4 moved (`poolTerms`, `poolConfig`, `holdersWake`, the quote rows) is read by its own set instead.
describe("the after-launch reads both suites share", () => {
  type Shared = keyof typeof suite3 & keyof typeof generated;

  const SHARED: Array<[Shared, string[]]> = [
    [
      "bankrLaunchFactoryAbi",
      [
        "poolOf",
        "launcherOf",
        "vestingEscrowOf",
        "buyback",
        "ledger",
        "locker",
        "paused",
        "launchGated",
        "isSuite",
        // receipt.ts reads these events from either suite's receipt with suite 3's set.
        "TokenLaunched",
        "TradingScheduled",
      ],
    ],
    ["bankrLaunchpadRegistryAbi", ["launchpadOf"]],
    [
      "bankrFeeLedgerAbi",
      [
        "beneficiariesOf",
        "getShares",
        "creatorShareOf",
        "claimable",
        "balances",
        "mayClaimFor",
        "claimRestricted",
        "isClaimsCollector",
        "isProtocolSink",
        "collectFees",
        "collectFeesMany",
        "collectFeesSide",
        "settle",
        "withdraw",
        "withdrawFor",
        "setClaimRestricted",
        "setClaimOperator",
        "updateBeneficiary",
        "updateBeneficiaryMany",
        "BucketRegistered",
      ],
    ],
    ["holderRewardsDeployerAbi", ["distributorOfToken"]],
    [
      "holderRewardsDistributorAbi",
      [
        "rewardExcluded",
        "bnkrEpoch",
        "assetOf",
        "earned",
        "pastBnkr",
        "claim",
        "claimLeg",
        "claimFor",
        "claimForMany",
        "claimPastBnkr",
        "RewardClaimed",
      ],
    ],
    [
      "creatorVestingEscrowAbi",
      [
        "scheduleCount",
        "scheduleOf",
        "vestingStart",
        "computeAvailableVestedAmount",
        "computePushableAmount",
        "release",
        "releaseFor",
      ],
    ],
    [
      "bankrLaunchTokenAbi",
      [
        "metadataAdmin",
        "pendingMetadataAdmin",
        "metadataUri",
        "tradingStart",
        "setMetadataUri",
        "transferMetadataAdmin",
        "acceptMetadataAdmin",
        "renounceMetadataAdmin",
        "MetadataAdminSet",
      ],
    ],
    ["bankrHookLensAbi", ["extSwapGasHeadroom"]],
  ];
  const named = (abi: Abi, name: string) =>
    abi.filter((e) => "name" in e && e.name === name);

  test("each entry is one value in suite 3's set and suite 4's", () => {
    for (const [abi, entries] of SHARED)
      for (const name of entries) {
        const [a, b] = [
          named(suite3[abi] as Abi, name),
          named(generated[abi] as Abi, name),
        ];
        expect(a.length, `${abi}.${name} in suite 3`).toBeGreaterThan(0);
        expect(b, `${abi}.${name}`).toEqual(a);
      }
  });

  test("the leg's poke and its BNKR are one value in the hand-kept wake fragment and a suite 4 leg's ABI", () => {
    for (const name of ["poke", "bnkr"])
      expect(named(bnkrHolderLegAbi as Abi, name), name).toEqual(
        named(EARLIER_HOLDER_LEG_WAKE_ABI as Abi, name),
      );
  });

  test("what suite 4 moved is not on the list: it is read by suite 4's own set", () => {
    for (const [abi, name] of [
      ["bankrFeeLedgerAbi", "poolTerms"],
      ["bankrFeeLedgerAbi", "holdersWake"],
      ["bankrHookLensAbi", "poolConfig"],
    ] as const)
      expect(named(generated[abi] as Abi, name)).not.toEqual(
        named(suite3[abi] as Abi, name),
      );
    for (const gone of ["quoteEntry", "capController"])
      expect(named(generated.bankrLaunchFactoryAbi as Abi, gone)).toEqual([]);
  });
});
