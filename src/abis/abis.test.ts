import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { keccak256, type Abi } from "viem";
import * as generated from "./generated.js";
import manifest from "./manifest.json";
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
