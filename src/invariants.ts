import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  RawContractError,
} from "viem";

/**
 * The outcome of `client.verifyTokenInvariants`. `failures` and `skipped` name checks: `totalSupply`, `rewardHook`,
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

export type Outcome = boolean | "skipped";

/** A contract answering with a revert or no data: a failed check. Anything else (the RPC) is thrown. */
export function isRevert(err: unknown): boolean {
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

export async function passes<T>(
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
export const OWNER_PROBES = ["0x8da5cb5b", "0x40c10f19", "0x91d14854"] as const;
