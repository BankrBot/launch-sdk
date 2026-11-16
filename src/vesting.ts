import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  type Address,
} from "viem";
import { readContract } from "viem/actions";
import { creatorVestingEscrowAbi } from "./abis/suite3.js";
import { LaunchRefusedError } from "./errors.js";
import { requireLaunch, type SuiteReadContext } from "./lens.js";
import type { UnsignedTx } from "./providers/types.js";
import { requireAddress } from "./recipient.js";
import { buildCallTx } from "./tx.js";

/** One schedule on a launch's vesting escrow. */
export interface VestingSchedule {
  beneficiary: Address;
  /**
   * `creator`: a pull schedule, released only by its beneficiary's own call. `holders`: the vest-to-holders push
   * schedule, whose beneficiary is the launch's distributor and which anyone releases.
   */
  role: "creator" | "holders";
  push: boolean;
  total: bigint;
  released: bigint;
  cliffSeconds: bigint;
  durationSeconds: bigint;
  /** What `buildRelease` (creator) or `buildReleaseToHolders` (holders) would move now. */
  releasable: bigint;
}

/** A launch's vesting: its escrow and every schedule on it. */
export interface VestingState {
  token: Address;
  /** Null when the launch did not vest. */
  escrow: Address | null;
  vestingStart: bigint | null;
  schedules: VestingSchedule[];
}

/** Vesting after launch: the creator's pull schedule (365-day linear, 30-day cliff) and the holders' push schedule. */
export interface LaunchVesting {
  /** `NOT_A_LAUNCH` for a token this chain's factory never launched. */
  get(token: Address): Promise<VestingState>;
  /** `release(0)`: everything vested on `account`'s pull schedule, paid to `account`, which sends it. */
  buildRelease(token: Address, account: Address): Promise<UnsignedTx>;
  /** `releaseFor(distributor)`: pushes the holders' vested slice to the launch's distributor; `account` is any sender. */
  buildReleaseToHolders(token: Address, account: Address): Promise<UnsignedTx>;
}

type Schedule = Omit<VestingSchedule, "releasable">;

/** The vesting namespace for one chain's suite. */
export function createVesting(ctx: SuiteReadContext): LaunchVesting {
  const chain = ctx.chain.chain;
  const { client } = ctx;
  const noVesting = (): never => {
    throw new LaunchRefusedError("NO_VESTING", { chain });
  };

  async function schedulesOf(escrow: Address): Promise<Schedule[]> {
    const count = await readContract(client, {
      address: escrow,
      abi: creatorVestingEscrowAbi,
      functionName: "scheduleCount",
    });
    const rows = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        readContract(client, {
          address: escrow,
          abi: creatorVestingEscrowAbi,
          functionName: "scheduleOf",
          args: [BigInt(i)],
        }),
      ),
    );
    return rows.map(
      ([beneficiary, total, released, cliff, duration, push]) => ({
        beneficiary: getAddress(beneficiary),
        role: push ? "holders" : "creator",
        push,
        total,
        released,
        cliffSeconds: cliff,
        durationSeconds: duration,
      }),
    );
  }

  async function escrowAndSchedules(token: unknown) {
    const info = await requireLaunch(ctx, token);
    if (info.escrow === null) return noVesting();
    return { escrow: info.escrow, schedules: await schedulesOf(info.escrow) };
  }

  const read = (
    escrow: Address,
    functionName: "computeAvailableVestedAmount" | "computePushableAmount",
    beneficiary: Address,
  ) =>
    readContract(client, {
      address: escrow,
      abi: creatorVestingEscrowAbi,
      functionName,
      args: [beneficiary],
    });

  return {
    async get(token) {
      const info = await requireLaunch(ctx, token);
      const escrow = info.escrow;
      if (escrow === null) {
        return {
          token: info.token,
          escrow: null,
          vestingStart: null,
          schedules: [],
        };
      }
      const [vestingStart, schedules] = await Promise.all([
        readContract(client, {
          address: escrow,
          abi: creatorVestingEscrowAbi,
          functionName: "vestingStart",
        }),
        schedulesOf(escrow),
      ]);
      // `computeAvailableVestedAmount` spans both kinds; a pull release pays only the pull part.
      const releasable = await Promise.all(
        schedules.map(async (s) => {
          const pushable = await read(
            escrow,
            "computePushableAmount",
            s.beneficiary,
          );
          if (s.push) return pushable;
          const all = await read(
            escrow,
            "computeAvailableVestedAmount",
            s.beneficiary,
          );
          return all - pushable;
        }),
      );
      return {
        token: info.token,
        escrow,
        vestingStart,
        schedules: schedules.map((s, i) => ({
          ...s,
          releasable: releasable[i]!,
        })),
      };
    },

    async buildRelease(token, account) {
      const who = requireAddress(account, chain);
      const { escrow, schedules } = await escrowAndSchedules(token);
      if (!schedules.some((s) => !s.push && isAddressEqual(s.beneficiary, who)))
        noVesting();
      return buildCallTx(
        ctx.chain.chainId,
        who,
        escrow,
        encodeFunctionData({
          abi: creatorVestingEscrowAbi,
          functionName: "release",
          args: [0n],
        }),
      );
    },

    async buildReleaseToHolders(token, account) {
      const who = requireAddress(account, chain);
      const { escrow, schedules } = await escrowAndSchedules(token);
      // The factory writes at most one push schedule, to the launch's own distributor.
      const push = schedules.find((s) => s.push);
      if (push === undefined) return noVesting();
      return buildCallTx(
        ctx.chain.chainId,
        who,
        escrow,
        encodeFunctionData({
          abi: creatorVestingEscrowAbi,
          functionName: "releaseFor",
          args: [push.beneficiary],
        }),
      );
    },
  };
}
