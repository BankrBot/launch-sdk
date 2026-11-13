import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  RawContractError,
  decodeFunctionData,
  isAddressEqual,
  zeroAddress,
  type Address,
  type TransactionReceipt,
} from "viem";
import { call, getTransaction, readContract } from "viem/actions";
import {
  bankrHookLensAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
} from "./abis/generated.js";
import { CAP_BPS } from "./economics.js";
import {
  HOOK_LENS_FRAGMENT,
  readLaunchInfo,
  type SuiteReadContext,
} from "./lens.js";
import { predictToken, readLiveSuite } from "./predict.js";
import { parseLaunchReceipt } from "./receipt.js";
import { requireAddress } from "./recipient.js";

/**
 * The outcome of {@link verifyTokenInvariants}. `failures` and `skipped` name checks: `totalSupply`, `rewardHook`,
 * `poolRegistered`, `prediction` and so on.
 */
export interface InvariantReport {
  /** No check failed. Checks in `skipped` did not run: pass the launch receipt for the full set. */
  ok: boolean;
  failures: string[];
  /**
   * Checks that need the launch's receipt (its supply, URI and calldata), a launch call this node cannot decode, and
   * `metadataUri` for a launch that named a metadata admin, which may replace the link.
   */
  skipped: string[];
}

type Outcome = boolean | "skipped";

/** A contract answering with a revert or no data: a failed check. Anything else (the RPC) is thrown. */
function isRevert(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof RawContractError ||
        e instanceof ExecutionRevertedError,
    ) !== null
  );
}

async function passes<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  onRevert: Outcome = false,
): Promise<Outcome> {
  try {
    return ok(await read());
  } catch (err) {
    if (isRevert(err)) return onRevert;
    throw err;
  }
}

// Selectors an owned or mintable token would answer: owner(), mint(address,uint256), the OZ AccessControl probe.
const OWNER_PROBES = ["0x8da5cb5b", "0x40c10f19", "0x91d14854"] as const;

/**
 * Holds a token to what a launch through this chain's v4 factory guarantees. Every check is a read; any revert
 * fails it. Without a receipt: registered with the factory and its pool on the hook, 18 decimals, a supply in range
 * with the 2 % wallet cap sized from it, the factory and cap controller of record, the reward hook is the launch's
 * distributor, and no owner or mint surface answers. With the receipt: the logged supply, the logged URI with no
 * metadata admin when the launch named none, and the address the factory's CREATE2 gives the launch's calldata (when
 * the launch called the factory directly).
 */
export async function verifyTokenInvariants(
  ctx: SuiteReadContext,
  tokenInput: Address,
  receipt?: TransactionReceipt,
): Promise<InvariantReport> {
  const token = requireAddress(tokenInput, ctx.chain.chain);
  const a = ctx.addresses;
  const { client } = ctx;
  const info = await readLaunchInfo(ctx, token);
  let launch: ReturnType<typeof parseLaunchReceipt> | null = null;
  if (receipt !== undefined) {
    try {
      launch = parseLaunchReceipt(a, ctx.chain.chain, receipt, token);
    } catch {
      launch = null;
    }
  }
  const checks: [string, Promise<Outcome>][] = [];
  const check = (name: string, pass: Promise<Outcome> | Outcome) =>
    checks.push([name, Promise.resolve(pass)]);
  const t = { address: token, abi: bankrLaunchTokenAbi } as const;

  check("registered", info !== null);
  if (receipt !== undefined) check("receipt", launch !== null);
  check(
    "decimals",
    passes(
      () => readContract(client, { ...t, functionName: "decimals" }),
      (v) => v === 18,
    ),
  );
  check(
    "supplyCap",
    passes(
      async () =>
        Promise.all([
          readContract(client, { ...t, functionName: "totalSupply" }),
          readContract(client, { ...t, functionName: "maxBalanceLimit" }),
        ]),
      ([supply, cap]) =>
        supply >= 10n ** 18n &&
        supply <= 100_000_000_000n * 10n ** 18n &&
        cap === (supply * BigInt(CAP_BPS)) / 10_000n,
    ),
  );
  check(
    "factory",
    passes(
      () => readContract(client, { ...t, functionName: "factory" }),
      (v) => isAddressEqual(v, a.factory),
    ),
  );
  check(
    "controller",
    passes(
      async () =>
        Promise.all([
          readContract(client, { ...t, functionName: "controller" }),
          readContract(client, {
            address: a.factory,
            abi: bankrLaunchFactoryAbi,
            functionName: "capController",
          }),
        ]),
      ([mine, factory]) => isAddressEqual(mine, factory),
    ),
  );
  check(
    "rewardHook",
    info === null
      ? false
      : passes(
          () => readContract(client, { ...t, functionName: "rewardHook" }),
          (v) => isAddressEqual(v, info.distributor),
        ),
  );
  check(
    "poolRegistered",
    info === null
      ? false
      : passes(
          async () => {
            const lens = await readContract(client, {
              address: info.hook,
              abi: HOOK_LENS_FRAGMENT,
              functionName: "hookLens",
            });
            return readContract(client, {
              address: lens,
              abi: bankrHookLensAbi,
              functionName: "poolConfig",
              args: [info.poolId],
            });
          },
          (c) => c.registered && isAddressEqual(c.token, token),
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

  const skipped: string[] = [];
  if (launch === null) {
    skipped.push("totalSupply", "metadataUri", "prediction");
  } else {
    const l = launch;
    check(
      "totalSupply",
      passes(
        () => readContract(client, { ...t, functionName: "totalSupply" }),
        (v) => v === l.totalSupply,
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
    check("prediction", predictionCheck(ctx, token, l.launcher, receipt!));
  }

  const results = await Promise.all(checks.map(([, pass]) => pass));
  const withOutcome = (outcome: Outcome) =>
    checks.filter((_, i) => results[i] === outcome).map(([name]) => name);
  const failures = withOutcome(false);
  skipped.push(...withOutcome("skipped"));
  return { ok: failures.length === 0, failures, skipped };
}

/**
 * The address the launch's own calldata gives with the suite as it stood at the launch block, locally and from the
 * factory. Skipped when the launch was not a direct factory call (a Safe or a multicall) or the node lacks that state.
 */
async function predictionCheck(
  ctx: SuiteReadContext,
  token: Address,
  launcher: Address,
  receipt: TransactionReceipt,
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
  const before = receipt.blockNumber - 1n;
  try {
    const [suite, onChain] = await Promise.all([
      readLiveSuite(ctx.client, ctx.addresses.factory, before),
      readContract(ctx.client, {
        address: ctx.addresses.factory,
        abi: bankrLaunchFactoryAbi,
        functionName: "computeTokenAddress",
        args: [launcher, params.salt, params],
        blockNumber: before,
      }),
    ]);
    const local = predictToken(suite, params, launcher, params.salt);
    return isAddressEqual(local, token) && isAddressEqual(onChain, token);
  } catch (err) {
    if (isRevert(err)) return false;
    return "skipped";
  }
}
