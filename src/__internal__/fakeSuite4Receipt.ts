// Test-only: the receipt a mined suite 4 launch leaves, built from a plan made against fakeSuite4.ts. Excluded
// from the build; viem and relative imports only.
import {
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
} from "../abis/generated.js";
import { bucketIds } from "../lens.js";
import type { LaunchPlan } from "../providers/types.js";
import { encodeCoinTerms, type CoinTerms } from "../suite4/settings.js";
import { eventLog, type RpcLog } from "./fakeRpc.js";
import type { Suite4Fixture } from "./fakeSuite4.js";

/** A mined suite 4 coin: what its launch's logs carry. */
export interface MinedSuite4Coin {
  token: Address;
  launcher: Address;
  poolId: Hex;
  terms: CoinTerms;
  resolvedHash: Hex;
  startTick: number;
  distributor: Address;
  escrow: Address | null;
}

/** The logs a suite 4 launch leaves, as its factory, ledger and token emit them, around the coin's record (`bytes`:
 *  the logged record where a test rewrites it; the logged hash stays the terms' own). */
export function suite4LaunchLogs(
  f: Suite4Fixture,
  m: MinedSuite4Coin,
  bytes: Hex = encodeCoinTerms(m.terms),
): RpcLog[] {
  const { token, launcher, poolId, terms: t } = m;
  const creator = bucketIds.creator(poolId);
  return [
    eventLog(
      bankrLaunchFactoryAbi,
      "CoinTermsFrozen",
      {
        token,
        poolId,
        termsHash: keccak256(encodeCoinTerms(t)),
        resolvedHash: m.resolvedHash,
        terms: bytes,
      },
      f.suite.factory,
    ),
    eventLog(
      bankrLaunchTokenAbi,
      "MetadataAdminSet",
      { from: zeroAddress, to: zeroAddress },
      token,
    ),
    eventLog(
      bankrFeeLedgerAbi,
      "BucketRegistered",
      {
        bucketId: creator,
        poolId,
        beneficiaries: [launcher],
        shares: [10n ** 18n],
      },
      f.suite.ledger,
    ),
    eventLog(
      bankrFeeLedgerAbi,
      "CreatorShares",
      {
        bucketId: creator,
        creatorShares: [10n ** 18n],
        takeover: t.takeover,
        notice: t.ctoNotice,
        grace: t.ctoGrace,
      },
      f.suite.ledger,
    ),
    eventLog(
      bankrLaunchFactoryAbi,
      "TokenLaunched",
      {
        token,
        launcher,
        quote: f.quote,
        poolId,
        startTick: m.startTick,
        metadataUri: "",
        launchpadId: f.padId,
      },
      f.suite.factory,
    ),
    eventLog(
      bankrLaunchFactoryAbi,
      "LaunchResolved",
      {
        token,
        curveId: 0n,
        distributor: m.distributor,
        vestingEscrow: m.escrow ?? zeroAddress,
        vestingRecipient: launcher,
        devBuyOut: 0n,
      },
      f.suite.factory,
    ),
  ];
}

/** The receipt of a plan's launch once mined; `terms` rewrites the logged record's bytes. */
export function suite4LaunchReceipt(
  f: Suite4Fixture,
  plan: LaunchPlan,
  terms?: (bytes: Hex) => Hex,
): { receipt: TransactionReceipt; termsHash: Hex; frozen: RpcLog } {
  const t = plan.suite4!.terms;
  const bytes = encodeCoinTerms(t);
  const logs = suite4LaunchLogs(
    f,
    {
      token: plan.predictedToken,
      launcher: plan.launcher,
      poolId: plan.poolId,
      terms: t,
      resolvedHash: plan.suite4!.resolvedHash,
      startTick: plan.params.expectedStartTick,
      distributor: plan.distributor,
      escrow: plan.escrow,
    },
    terms ? terms(bytes) : bytes,
  );
  const receipt = {
    transactionHash: `0x${"aa".repeat(32)}`,
    blockNumber: 7n,
    status: "success",
    logs: logs.map((log, logIndex) => ({
      ...log,
      logIndex,
      blockNumber: 7n,
      blockHash: `0x${"bb".repeat(32)}`,
      transactionHash: `0x${"aa".repeat(32)}`,
      transactionIndex: 0,
      removed: false,
    })),
  } as unknown as TransactionReceipt;
  return { receipt, termsHash: keccak256(bytes), frozen: logs[0]! };
}
