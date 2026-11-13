import {
  getAddress,
  isAddressEqual,
  parseEventLogs,
  zeroAddress,
  type Address,
  type TransactionReceipt,
} from "viem";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
} from "./abis/generated.js";
import type { ProviderAddresses } from "./addresses.js";
import type { LaunchChain } from "./chains/index.js";
import { launchCurveAt } from "./curve.js";
import { LaunchExecutionError } from "./errors.js";
import { bucketIds, creatorRecipientsOf } from "./lens.js";
import type { LaunchResult } from "./providers/types.js";

/**
 * The launch in a mined receipt, from the `TokenLaunched` and `LaunchResolved` logs this chain's factory emitted, the
 * creator bucket its ledger registered and the token's own first log. Each log is matched by its emitter, so a copied
 * or bundled call can never be attributed to the wrong launch. `RECEIPT_MISSING_LAUNCH` when there is no such launch,
 * or several and no `expectedToken` to choose.
 */
export function parseLaunchReceipt<C extends LaunchChain>(
  suite: Pick<ProviderAddresses, "factory" | "ledger">,
  chain: C,
  receipt: TransactionReceipt,
  expectedToken?: Address,
): LaunchResult<C> {
  const { factory } = suite;
  const missing = () =>
    new LaunchExecutionError("RECEIPT_MISSING_LAUNCH", { chain });
  const logs = receipt.logs.filter((log) => !log.removed);
  const fromFactory = (log: { address: Address; args: { token: Address } }) =>
    isAddressEqual(log.address, factory) &&
    (expectedToken === undefined ||
      isAddressEqual(log.args.token, expectedToken));
  const launches = parseEventLogs({
    abi: bankrLaunchFactoryAbi,
    eventName: "TokenLaunched",
    logs,
    strict: true,
  }).filter(fromFactory);
  const [launch] = launches;
  if (!launch || launches.length > 1) throw missing();
  const ofLaunch = (log: { address: Address; args: { token: Address } }) =>
    isAddressEqual(log.address, factory) &&
    isAddressEqual(log.args.token, launch.args.token);
  const resolved = parseEventLogs({
    abi: bankrLaunchFactoryAbi,
    eventName: "LaunchResolved",
    logs,
    strict: true,
  }).find(ofLaunch);
  if (!resolved) throw missing();
  const scheduled = parseEventLogs({
    abi: bankrLaunchFactoryAbi,
    eventName: "TradingScheduled",
    logs,
    strict: true,
  }).find(ofLaunch);

  // The ledger logs the creator bucket's entries, then each entry's creator part beside them, on every pad.
  const creatorId = bucketIds.creator(launch.args.poolId);
  const ofBucket = (log: { address: Address; args: { bucketId: string } }) =>
    isAddressEqual(log.address, suite.ledger) &&
    log.args.bucketId.toLowerCase() === creatorId;
  const bucket = parseEventLogs({
    abi: bankrFeeLedgerAbi,
    eventName: "BucketRegistered",
    logs,
    strict: true,
  }).find(ofBucket);
  const parts = parseEventLogs({
    abi: bankrFeeLedgerAbi,
    eventName: "CreatorShares",
    logs,
    strict: true,
  }).find(ofBucket);
  if (
    !bucket ||
    !parts ||
    parts.args.creatorShares.length !== bucket.args.beneficiaries.length
  )
    throw missing();
  // The constructor's event (from the zero address) names the admin at launch; any later one is a hand-over.
  const admin = parseEventLogs({
    abi: bankrLaunchTokenAbi,
    eventName: "MetadataAdminSet",
    logs,
    strict: true,
  }).find(
    (log) =>
      isAddressEqual(log.address, launch.args.token) &&
      isAddressEqual(log.args.from, zeroAddress),
  );
  if (!admin) throw missing();

  const a = launch.args;
  const r = resolved.args;
  // The curve is LaunchResolved's word. TokenLaunched's start tick is quote per token: the pair's order mirrors it.
  const curve = launchCurveAt(
    r.curveId,
    a.startTick,
    BigInt(a.token) < BigInt(a.quote),
  );
  if (!curve) throw missing();
  return {
    chain,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    token: getAddress(a.token),
    poolId: a.poolId,
    launcher: getAddress(a.launcher),
    quote: getAddress(a.quote),
    launchpadId: a.launchpadId,
    startTick: a.startTick,
    metadataUri: a.metadataUri,
    metadataAdmin: isAddressEqual(admin.args.to, zeroAddress)
      ? null
      : getAddress(admin.args.to),
    feeRecipients: creatorRecipientsOf(
      bucket.args.beneficiaries.map((account, i) => ({
        account,
        creatorShareWad: parts.args.creatorShares[i]!,
      })),
    ),
    tradingStart: scheduled ? Number(scheduled.args.startTime) : null,
    curve,
    holdersBps: r.holdersBps,
    distributor: getAddress(r.distributor),
    escrow: isAddressEqual(r.vestingEscrow, zeroAddress)
      ? null
      : getAddress(r.vestingEscrow),
    vestingRecipient: getAddress(r.vestingRecipient),
    vestBps: r.vestBps,
    totalSupply: r.totalSupply,
    devBuyOut: r.devBuyOut,
  };
}
