// Test-only: what every fake of Bankr's contracts shares: distinct addresses, a complete record for a chain and
// the distributor a fake deployer predicts. Shipped with the public tests' fakes.
import { getAddress, keccak256, toHex, zeroAddress, type Address } from "viem";
import type { ProviderAddresses } from "../addresses.js";
import { CHAINS, LAUNCH_CHAINS } from "../chains/index.js";
import type { LivePointers } from "../predict.js";
import type { FakeChain } from "./fakeRpc.js";

/** Distinct fake addresses for the parts of a deployment. */
export const fakeAddress = (n: number): Address =>
  getAddress(`0x${n.toString(16).padStart(40, "0")}`);

export const PAD_OPERATOR = fakeAddress(0x0b1);
export const PAD_PAYEE = fakeAddress(0x0b2);
export const FLYWHEEL = fakeAddress(0x0b3);
export const POOL_MANAGER = fakeAddress(0x8a01);
export const CAP_CONTROLLER = fakeAddress(0x8a02);
export const FAKE_SETTINGS = fakeAddress(0x84e7);
export const FAKE_TERMS_LENS = fakeAddress(0x84e8);

/** A complete record for `chainId`, standing in for a broadcast deployment (a fork or test override). */
export function testRecord(chainId: number): ProviderAddresses {
  return Object.freeze({
    chainId,
    hook: fakeAddress(0x8001),
    ledger: fakeAddress(0x8002),
    factory: fakeAddress(0x8003),
    locker: fakeAddress(0x8004),
    holderRewardsDeployer: fakeAddress(0x8005),
    tokenDeployer: fakeAddress(0x8006),
    tokenDeployerKind: "erc20",
    vestingEscrowImpl: fakeAddress(0x8007),
    launchpadRegistry: fakeAddress(0x8008),
    presetDeployer: zeroAddress,
    claimsRedeemer: fakeAddress(0x8009),
    launchRegistryLibrary: fakeAddress(0x800a),
    launchEconomicsLibrary: fakeAddress(0x800b),
    launchPoolLibrary: fakeAddress(0x800c),
    ledgerCtoLibrary: fakeAddress(0x8016),
    hookColdLibrary: fakeAddress(0x8017),
    create3Factory: fakeAddress(0x800d),
    deployer: fakeAddress(0x800e),
    owner: fakeAddress(0x800f),
    weth: getAddress(
      (
        CHAINS[
          LAUNCH_CHAINS.find((c) => CHAINS[c].chainId === chainId) ?? "base"
        ].quotes as Readonly<Record<string, { address: Address }>>
      ).WETH?.address ?? fakeAddress(0x8010),
    ),
    treasury: fakeAddress(0x8011),
    holderLeg: fakeAddress(0x8012),
    referenceOracle: fakeAddress(0x8014),
    buyback: fakeAddress(0x8013),
    blockNumber: 1,
    gitCommit: "5f61b77f01a3c2d1e0f9a8b7c6d5e4f3a2b1c0d9",
    settings: FAKE_SETTINGS,
    termsLens: FAKE_TERMS_LENS,
    raffleRunCode: fakeAddress(0x8018),
    launchResolverLibrary: fakeAddress(0x8019),
    launchPricingLibrary: fakeAddress(0x801a),
    settingsColdLibrary: fakeAddress(0x801b),
    ledgerColdLibrary: fakeAddress(0x801c),
  });
}

/** The factory's live pointers for a record nobody rotated. */
export const livePointersOf = (s: ProviderAddresses): LivePointers => ({
  factory: s.factory,
  tokenDeployer: s.tokenDeployer,
  vestingEscrowImpl: s.vestingEscrowImpl,
  poolManager: POOL_MANAGER,
  locker: s.locker,
  hook: s.hook,
  ledger: s.ledger,
  treasury: s.treasury,
  buyback: s.buyback,
});

/** What a fake is installed on: a chain and the record its contracts answer at. */
export interface RecordFixture {
  fake: FakeChain;
  deployment: ProviderAddresses;
}

/** The distributor the fake deployer predicts for a token: a pure function of it. */
export const fakeDistributor = (token: Address): Address =>
  getAddress(
    `0x${keccak256(toHex(`distributor:${token.toLowerCase()}`)).slice(26)}`,
  );
