import { readContract } from "viem/actions";
import type { UnsignedTx } from "../providers/types.js";
import type { SettingsKit } from "./context.js";
import type { SettingsReaders } from "./readers.js";
import { payeeLimitBreach } from "./rules.js";

// The owner's two payee limits (the payee count in the protocol terms, the pad-share limit) are held at every
// launch as they stand: a pad whose stored payees are over a new value cannot launch until it sets them again.
// Nothing clamps a share list, so the owner sees which pads a change stops before signing it.

/** A launchpad an owner change would stop from launching until its operator sets its payees again. */
export interface StoppedPad {
  id: bigint;
  /** Over the payee count, or over the share its payees may take together (steady or decay). */
  reason: "payeeCount" | "payeeShare";
  payees: number;
  /** Its stored payees were already over the limits in force, so the change stops nothing new there. */
  alreadyStopped: boolean;
}

/** An owner change that can stop pads: the transaction, and the pads it would stop. Bankr's pad is id 0. */
export interface SettingsChange {
  tx: UnsignedTx;
  stoppedPads: StoppedPad[];
}

export interface PayeeLimits {
  maxPadPayees: number;
  padShareMaxBps: bigint;
}

// Reads per round: a client that batches folds a round into one multicall.
const CHUNK = 100;

/** Every registered pad, Bankr's included, whose stored payees a launch would refuse under `next`. */
export async function padsStoppedBy(
  kit: SettingsKit,
  r: SettingsReaders,
  next: PayeeLimits,
  now: PayeeLimits,
): Promise<StoppedPad[]> {
  // A change that moves neither limit stops nothing and reads nothing.
  if (
    next.maxPadPayees === now.maxPadPayees &&
    next.padShareMaxBps === now.padShareMaxBps
  )
    return [];
  const count = await readContract(kit.client, {
    ...kit.registry,
    functionName: "launchpadCount",
  });
  const stopped: StoppedPad[] = [];
  for (let from = 0n; from <= count; from += BigInt(CHUNK)) {
    const ids = Array.from(
      {
        length: Number(
          count - from + 1n < BigInt(CHUNK) ? count - from + 1n : BigInt(CHUNK),
        ),
      },
      (_, i) => from + BigInt(i),
    );
    const terms = await Promise.all(
      ids.map((id) =>
        readContract(kit.client, {
          ...r.s,
          functionName: "payeesOf",
          args: [id],
        }),
      ),
    );
    ids.forEach((id, i) => {
      const t = terms[i]!;
      const reason = payeeLimitBreach(
        t,
        next.maxPadPayees,
        next.padShareMaxBps,
      );
      if (reason === null) return;
      stopped.push({
        id,
        reason,
        payees: t.payees.length,
        alreadyStopped:
          payeeLimitBreach(t, now.maxPadPayees, now.padShareMaxBps) !== null,
      });
    });
  }
  return stopped;
}
