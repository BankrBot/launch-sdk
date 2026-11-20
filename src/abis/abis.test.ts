import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { keccak256, type Abi } from "viem";
import { launchTokenCreationCodeHash } from "../predict.js";
import * as generated from "./generated.js";
import manifest from "./manifest.json";
import { bnkrHolderLegAbi } from "./settings.js";

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

const FILE = "generated.ts";
const SOURCE = "packages/core/src/bankr-v4/abi/generated.ts";

describe("generated ABIs match their manifest (edit only via scripts/gen-abis.ts)", () => {
  test("every export hashes to its manifest entry, and nothing is missing or extra", () => {
    const exported = abiExports(generated);
    const hashes: Record<string, string> = manifest.abis;
    expect(exported.map(([n]) => n).sort()).toEqual(Object.keys(hashes).sort());
    for (const [name, abi] of exported)
      expect(abiSha256(abi), name).toBe(hashes[name]!);
    expect(manifest.source).toBe(SOURCE);
    // One contract set: the manifest names no other.
    expect(Object.keys(manifest).sort()).toEqual([
      "abis",
      "creationCodes",
      "solc",
      "source",
    ]);
  });

  test("the module header names its source and solc, so every regen shows up in the diff", async () => {
    const head = (await Bun.file(join(import.meta.dir, FILE)).text())
      .split("\n")
      .slice(0, 3)
      .join("\n");
    expect(head).toContain(manifest.source);
    expect(head).toContain(manifest.solc);
  });

  test("the BankrLaunchToken creation code hashes to the manifest, and launchTokenCreationCodeHash is its hash", () => {
    expect(keccak256(generated.bankrLaunchTokenCreationCode)).toBe(
      manifest.creationCodes.bankrLaunchToken as `0x${string}`,
    );
    expect(launchTokenCreationCodeHash()).toBe(
      keccak256(generated.bankrLaunchTokenCreationCode),
    );
  });

  test("the launch path is on the vendored ABIs: the launch check, the pins' errors and the frozen record", () => {
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
});

// What the after-launch reads and builders call (fees, holders, vesting, the metadata link, the factory's record):
// a regen that drops one of these would break a read no launch test meets.
describe("the after-launch reads and claims are on the vendored ABIs", () => {
  const USED: Array<[keyof typeof generated, string[]]> = [
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
        "TokenLaunched",
        "TradingScheduled",
      ],
    ],
    ["bankrLaunchpadRegistryAbi", ["launchpadOf"]],
    [
      "bankrFeeLedgerAbi",
      [
        "poolTerms",
        "holdersWake",
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
        "getCumulatedFees0",
        "getLastCumulatedFees0",
        "bucketOf",
        "BucketRegistered",
        "CreatorShares",
        "UpdateBeneficiary",
        "CtoExecuted",
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
        "ClaimerNotAllowed",
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
        "metadataMaxBytes",
        "tradingStart",
        "setMetadataUri",
        "transferMetadataAdmin",
        "acceptMetadataAdmin",
        "renounceMetadataAdmin",
        "MetadataAdminSet",
      ],
    ],
    ["bankrHookLensAbi", ["poolConfig", "extSwapGasHeadroom"]],
  ];

  test("each entry the reads and builders name is there", () => {
    for (const [abi, entries] of USED) {
      const has = names(generated[abi] as Abi);
      for (const name of entries) expect(has, `${abi}.${name}`).toContain(name);
    }
    // Q9: one claim policy per account, on the ledger; the distributor reads it and keeps no operators of its own.
    const distributor = names(generated.holderRewardsDistributorAbi);
    for (const n of ["setClaimOperator", "isClaimOperator", "ClaimOperatorSet"])
      expect(distributor, n).not.toContain(n);
  });

  test("the holder leg's poke and its BNKR are on the leg's ABI", () => {
    const leg = names(bnkrHolderLegAbi as Abi);
    for (const name of ["poke", "bnkr"]) expect(leg, name).toContain(name);
  });
});
