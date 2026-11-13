import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { keccak256, type Abi } from "viem";
import * as generated from "./generated.js";
import manifest from "./manifest.json";

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

describe("generated ABIs match their manifest (edit only via scripts/gen-abis.ts)", () => {
  test("every export hashes to manifest.abis, and nothing is missing or extra", () => {
    const exported = abiExports(generated);
    expect(exported.map(([n]) => n).sort()).toEqual(
      Object.keys(manifest.abis).sort(),
    );
    for (const [name, abi] of exported) {
      expect(abiSha256(abi), name).toBe(
        manifest.abis[name as keyof typeof manifest.abis],
      );
    }
    expect(manifest.source).toBe("packages/core/src/bankr-v4/abi/generated.ts");
  });

  test("the module header names its source and solc, so every regen shows up in the diff", async () => {
    const head = (await Bun.file(join(import.meta.dir, "generated.ts")).text())
      .split("\n")
      .slice(0, 3)
      .join("\n");
    expect(head).toContain(manifest.source);
    expect(head).toContain(manifest.solc);
  });

  test("the BankrLaunchToken creation code hashes to the manifest", () => {
    expect(keccak256(generated.bankrLaunchTokenCreationCode)).toBe(
      manifest.creationCodes.bankrLaunchToken as `0x${string}`,
    );
  });

  test("the launch path's entry points, events and refusals are on the vendored ABIs", () => {
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
