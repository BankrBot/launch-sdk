// Test-only: the receipt a mined launch leaves, built from a plan made against fakeContracts.ts. Excluded
// from the build; viem and relative imports only.
import {
  decodeFunctionData,
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
import { poolIdOf } from "../plan.js";
import { predictEscrow, predictToken } from "../predict.js";
import type { LaunchPlan } from "../providers/types.js";
import {
  encodeCoinTerms,
  type CoinTerms,
  type ContractLaunchParams,
} from "../launch/settings.js";
import { feeRecipientsOf } from "../terms.js";
import { eventLog, type RpcLog, type SentTx } from "./fakeRpc.js";
import { fakeDistributor } from "./fakeRecord.js";
import {
  FAKE_TOKENS_PER_UNIT,
  type ContractsFixture,
} from "./fakeContracts.js";

/** A mined coin: what its launch's logs carry. */
export interface MinedCoin {
  token: Address;
  launcher: Address;
  poolId: Hex;
  terms: CoinTerms;
  resolvedHash: Hex;
  startTick: number;
  distributor: Address;
  escrow: Address | null;
  /** What the launch named, where a test reads it back: default the fixture's quote and pad, the launcher alone,
   *  the default curve, no link, no admin, no dev buy and trading at launch. */
  quote?: Address;
  launchpadId?: bigint;
  feeRecipients?: readonly { recipient: Address; shareBps: number }[];
  curveId?: bigint;
  metadataUri?: string;
  metadataAdmin?: Address;
  vestingRecipient?: Address;
  devBuyOut?: bigint;
  tradingStart?: bigint;
}

/** The logs a launch leaves, as its factory, ledger and token emit them, around the coin's record (`bytes`:
 *  the logged record where a test rewrites it; the logged hash stays the terms' own). */
export function minedLaunchLogs(
  f: ContractsFixture,
  m: MinedCoin,
  bytes: Hex = encodeCoinTerms(m.terms),
): RpcLog[] {
  const { token, launcher, poolId, terms: t } = m;
  const creator = bucketIds.creator(poolId);
  // A pad with no payee: the fee recipients hold the whole creator bucket, each as its creator part.
  const recipients = m.feeRecipients ?? [
    { recipient: launcher, shareBps: 10_000 },
  ];
  const parts = recipients.map((r) => BigInt(r.shareBps) * 10n ** 14n);
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
      f.deployment.factory,
    ),
    eventLog(
      bankrLaunchTokenAbi,
      "MetadataAdminSet",
      { from: zeroAddress, to: m.metadataAdmin ?? zeroAddress },
      token,
    ),
    eventLog(
      bankrFeeLedgerAbi,
      "BucketRegistered",
      {
        bucketId: creator,
        poolId,
        beneficiaries: recipients.map((r) => r.recipient),
        shares: parts,
      },
      f.deployment.ledger,
    ),
    eventLog(
      bankrFeeLedgerAbi,
      "CreatorShares",
      {
        bucketId: creator,
        creatorShares: parts,
        takeover: t.takeover,
        notice: t.ctoNotice,
        grace: t.ctoGrace,
      },
      f.deployment.ledger,
    ),
    // A mined launch's start is still ahead, so a scheduled one always logs it.
    ...(m.tradingStart === undefined
      ? []
      : [
          eventLog(
            bankrLaunchFactoryAbi,
            "TradingScheduled",
            { token, poolId, startTime: m.tradingStart },
            f.deployment.factory,
          ),
        ]),
    eventLog(
      bankrLaunchFactoryAbi,
      "TokenLaunched",
      {
        token,
        launcher,
        quote: m.quote ?? f.quote,
        poolId,
        startTick: m.startTick,
        metadataUri: m.metadataUri ?? "",
        launchpadId: m.launchpadId ?? f.padId,
      },
      f.deployment.factory,
    ),
    eventLog(
      bankrLaunchFactoryAbi,
      "LaunchResolved",
      {
        token,
        curveId: m.curveId ?? 0n,
        distributor: m.distributor,
        vestingEscrow: m.escrow ?? zeroAddress,
        vestingRecipient: m.vestingRecipient ?? launcher,
        devBuyOut: m.devBuyOut ?? 0n,
      },
      f.deployment.factory,
    ),
  ];
}

/** The params of a sent factory launch, or undefined for any other transaction (an approval). */
export function sentLaunch(
  f: ContractsFixture,
  tx: SentTx,
): ContractLaunchParams | undefined {
  if (tx.to.toLowerCase() !== f.deployment.factory.toLowerCase())
    return undefined;
  const call = decodeFunctionData({
    abi: bankrLaunchFactoryAbi,
    data: tx.data,
  });
  return call.functionName === "launch" ? call.args[0] : undefined;
}

/** The receipt logs a mined factory launch leaves for whatever the sent calldata asked for, resolved on the state
 *  in force when it lands. */
export function launchLogs(
  f: ContractsFixture,
  tx: SentTx,
): { logs: RpcLog[] } {
  const p = sentLaunch(f, tx);
  if (!p) return { logs: [] };
  const { terms, resolvedHash } = f.resolveNow(tx.from, tx.value, p);
  const token = predictToken(f.live, { ...p, terms }, tx.from, p.salt);
  return {
    logs: minedLaunchLogs(f, {
      token,
      launcher: tx.from,
      poolId: poolIdOf(token, p.quote, terms.hook).poolId,
      terms,
      resolvedHash,
      startTick: p.expectedStartTick,
      distributor: fakeDistributor(token),
      escrow:
        terms.vestedAmount > 0n ? predictEscrow(f.live, tx.from, p.salt) : null,
      quote: p.quote,
      launchpadId: p.launchpadId,
      feeRecipients: feeRecipientsOf(p, tx.from),
      curveId: p.curveId,
      metadataUri: p.metadataUri,
      metadataAdmin: p.metadataAdmin,
      vestingRecipient: p.vestingRecipient,
      devBuyOut: (tx.value + p.devBuyAmountIn) * FAKE_TOKENS_PER_UNIT,
      tradingStart: p.startTime === 0n ? undefined : p.startTime,
    }),
  };
}

/** The receipt of a plan's launch once mined; `terms` rewrites the logged record's bytes. */
export function minedLaunchReceipt(
  f: ContractsFixture,
  plan: LaunchPlan,
  terms?: (bytes: Hex) => Hex,
): { receipt: TransactionReceipt; termsHash: Hex; frozen: RpcLog } {
  const t = plan.resolved.terms;
  const bytes = encodeCoinTerms(t);
  const logs = minedLaunchLogs(
    f,
    {
      token: plan.predictedToken,
      launcher: plan.launcher,
      poolId: plan.poolId,
      terms: t,
      resolvedHash: plan.resolved.resolvedHash,
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
