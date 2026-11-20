import {
  decodeFunctionData,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { call, getTransaction, readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
} from "../abis/generated.js";
import type { ProviderAddresses } from "../addresses.js";
import type { ChainCapabilities } from "../chains/index.js";
import {
  OWNER_PROBES,
  isRevert,
  passes,
  type InvariantReport,
  type Outcome,
} from "../invariants.js";
import { predictToken, readLivePointers } from "../predict.js";
import type { ReadClient } from "../providers/types.js";
import { parseLaunchReceipt } from "../receipt.js";
import { requireAddress } from "../recipient.js";
import { findFrozenLog } from "../settings/frozenLog.js";
import { decodeCoinTerms, type CoinTerms } from "./settings.js";

// A suite 4 token is held to its own record, not to a compiled figure: the terms its launch froze
// (`CoinTermsFrozen`), whose hash the factory keeps for good (`termsHashOf`). The supply, the wallet cap's size and
// end and the cap controller are that coin's own.

export interface Suite4InvariantContext {
  chain: Pick<ChainCapabilities, "chain" | "maxLogRange">;
  addresses: Pick<ProviderAddresses, "factory" | "ledger" | "blockNumber"> & {
    settings: Address;
  };
  client: ReadClient;
}

/** The token's `CoinTermsFrozen` terms bytes: from the receipt, else from the factory's log of its launch, found
 *  from the token's trading start. Null where the node serves none, or the token answers no start. */
async function frozenTerms(
  ctx: Suite4InvariantContext,
  token: Address,
  receipt?: TransactionReceipt,
): Promise<Hex | null> {
  const { factory } = ctx.addresses;
  if (receipt === undefined) {
    const search = await findFrozenLog(ctx.client, {
      factory,
      token,
      maxLogRange: ctx.chain.maxLogRange,
      deployBlock: ctx.addresses.blockNumber,
    }).catch(() => null);
    return search?.found?.terms ?? null;
  }
  const hit = parseEventLogs({
    abi: bankrLaunchFactoryAbi,
    eventName: "CoinTermsFrozen",
    logs: receipt.logs,
    strict: true,
  }).find(
    (log) =>
      !log.removed &&
      isAddressEqual(log.address, factory) &&
      isAddressEqual(log.args.token, token),
  );
  return hit?.args.terms ?? null;
}

/**
 * Holds a suite 4 token to what its launch froze, by reads alone: the logged record hashes to the factory's
 * `termsHashOf`, and the supply, wallet cap and cap controller are that record's. With the receipt: the reward hook,
 * the logged URI where no admin was named, and the CREATE2 address of the launch's calldata under its own terms.
 */
export async function verifySuite4TokenInvariants(
  ctx: Suite4InvariantContext,
  tokenInput: Address,
  receipt?: TransactionReceipt,
): Promise<InvariantReport> {
  const chain = ctx.chain.chain;
  const token = requireAddress(tokenInput, chain);
  const a = ctx.addresses;
  const { client } = ctx;
  const t = { address: token, abi: bankrLaunchTokenAbi } as const;
  const [termsHash, bytes] = await Promise.all([
    readContract(client, {
      address: a.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "termsHashOf",
      args: [token],
    }),
    frozenTerms(ctx, token, receipt),
  ]);
  let launch: ReturnType<typeof parseLaunchReceipt> | null = null;
  if (receipt !== undefined) {
    try {
      launch = parseLaunchReceipt(a, chain, receipt, token);
    } catch {
      launch = null;
    }
  }
  const terms: CoinTerms | null =
    bytes !== null && keccak256(bytes) === termsHash
      ? decodeCoinTerms(bytes)
      : null;

  const checks: [string, Promise<Outcome>][] = [];
  const check = (name: string, pass: Promise<Outcome> | Outcome) =>
    checks.push([name, Promise.resolve(pass)]);
  const skipped: string[] = [];

  check("registered", BigInt(termsHash) !== 0n);
  if (receipt !== undefined) check("receipt", launch !== null);
  // No log to read (a node with a short log range) is not a failed record; a record that does not hash is.
  if (bytes === null) skipped.push("termsFrozen", "supplyCap", "controller");
  else check("termsFrozen", terms !== null);
  check(
    "decimals",
    passes(
      () => readContract(client, { ...t, functionName: "decimals" }),
      (v) => v === 18,
    ),
  );
  if (terms !== null) {
    check(
      "supplyCap",
      passes(
        async () =>
          Promise.all([
            readContract(client, { ...t, functionName: "totalSupply" }),
            readContract(client, { ...t, functionName: "maxBalanceLimit" }),
            readContract(client, { ...t, functionName: "capEnd" }),
          ]),
        ([supply, cap, end]) =>
          supply === terms.totalSupply &&
          cap === terms.capAmount &&
          // A launch with no cap stores no end; one with a cap, an end after its trading start.
          (terms.capSecs === 0) === (end === 0n),
      ),
    );
    check(
      "controller",
      passes(
        () => readContract(client, { ...t, functionName: "controller" }),
        (v) => isAddressEqual(v, terms.capController),
      ),
    );
  } else if (bytes !== null) {
    check("supplyCap", false);
    check("controller", false);
  }
  check(
    "factory",
    passes(
      () => readContract(client, { ...t, functionName: "factory" }),
      (v) => isAddressEqual(v, a.factory),
    ),
  );
  // An owner or mint function would answer; BankrLaunchToken has neither, so each probe must revert or return nothing.
  for (const data of OWNER_PROBES) {
    check(
      `noOwnerSurface:${data}`,
      call(client, { to: token, data: `${data}${"00".repeat(64)}` }).then(
        (r) => r.data === undefined || r.data === "0x",
        (err: unknown) => {
          if (isRevert(err)) return true;
          throw err;
        },
      ),
    );
  }

  if (launch === null) {
    skipped.push("rewardHook", "metadataUri", "prediction");
  } else {
    const l = launch;
    check(
      "rewardHook",
      passes(
        () => readContract(client, { ...t, functionName: "rewardHook" }),
        (v) => isAddressEqual(v, l.distributor),
      ),
    );
    // Only a launch with no metadata admin fixes its link; a named admin may replace it and hand the role on.
    if (l.metadataAdmin !== null) skipped.push("metadataUri");
    else
      check(
        "metadataUri",
        passes(
          async () =>
            Promise.all([
              readContract(client, { ...t, functionName: "metadataUri" }),
              readContract(client, { ...t, functionName: "metadataAdmin" }),
            ]),
          ([uri, admin]) =>
            uri === l.metadataUri && isAddressEqual(admin, zeroAddress),
        ),
      );
    check(
      "prediction",
      terms === null
        ? "skipped"
        : predictionCheck(ctx, token, l.launcher, receipt!, terms),
    );
  }

  const results = await Promise.all(checks.map(([, pass]) => pass));
  const withOutcome = (outcome: Outcome) =>
    checks.filter((_, i) => results[i] === outcome).map(([name]) => name);
  const failures = withOutcome(false);
  skipped.push(...withOutcome("skipped"));
  return { ok: failures.length === 0, failures, skipped };
}

/**
 * The address the launch's own calldata gives under its frozen terms, with the suite as it stood at the launch block.
 * Skipped when the launch was not a direct factory call (a Safe or a multicall) or the node lacks that state.
 */
async function predictionCheck(
  ctx: Suite4InvariantContext,
  token: Address,
  launcher: Address,
  receipt: TransactionReceipt,
  terms: CoinTerms,
): Promise<Outcome> {
  let params;
  try {
    const tx = await getTransaction(ctx.client, {
      hash: receipt.transactionHash,
    });
    if (!tx.to || !isAddressEqual(tx.to, ctx.addresses.factory))
      return "skipped";
    const decoded = decodeFunctionData({
      abi: bankrLaunchFactoryAbi,
      data: tx.input,
    });
    if (decoded.functionName !== "launch") return "skipped";
    params = decoded.args[0];
  } catch {
    return "skipped";
  }
  try {
    const suite = await readLivePointers(
      ctx.client,
      ctx.addresses.factory,
      receipt.blockNumber - 1n,
    );
    return isAddressEqual(
      predictToken(suite, { ...params, terms }, launcher, params.salt),
      token,
    );
  } catch (err) {
    if (isRevert(err)) return false;
    return "skipped";
  }
}
