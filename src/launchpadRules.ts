import type { LaunchChain } from "./chains/index.js";
import { LaunchRefusedError, type CodeOfKind } from "./errors.js";
import { BANKR_LAUNCHPAD_ID } from "./launchpad.js";
import type { Vanity } from "./salt.js";

// BankrLaunchpadRegistry's checks on an operator's call, without the chain: the SDK refuses what the registry would
// revert before anyone signs, as INVALID_LAUNCHPAD_CONFIG with a detail naming the rule.

const MIN_VANITY_NIBBLES = 4;
const MAX_VANITY_NIBBLES = 6;

const isUint = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;

function refuse(
  chain: LaunchChain,
  code: CodeOfKind<"refused">,
  detail: string,
): never {
  throw new LaunchRefusedError(code, { chain, detail });
}

function invalid(chain: LaunchChain, detail: string): never {
  refuse(chain, "INVALID_LAUNCHPAD_CONFIG", detail);
}

/** The low `nibbles` hex digits. */
export const vanityMask = (nibbles: number): number => 16 ** nibbles - 1;

/** A suffix as `0x…`, padded to its nibbles. */
export const vanityHex = (v: Vanity): string =>
  `0x${v.suffix.toString(16).padStart(v.nibbles, "0")}`;

/** `setVanity`'s shape: 0 nibbles (none) or 4–6, id 0 aside, and a suffix that fits them. */
export function checkPadVanity(
  id: bigint,
  v: Vanity,
  chain: LaunchChain,
): Vanity {
  if (typeof v !== "object" || v === null) {
    refuse(chain, "INVALID_PARAMS", "A vanity is { suffix, nibbles }.");
  }
  const { suffix, nibbles } = v;
  if (
    !isUint(nibbles, MAX_VANITY_NIBBLES) ||
    !isUint(suffix, vanityMask(nibbles))
  ) {
    invalid(
      chain,
      `A vanity is a suffix of at most ${MAX_VANITY_NIBBLES} hex digits that fits its nibbles (0 nibbles: none).`,
    );
  }
  if (
    id !== BANKR_LAUNCHPAD_ID &&
    nibbles !== 0 &&
    nibbles < MIN_VANITY_NIBBLES
  ) {
    invalid(
      chain,
      `A launchpad's suffix is ${MIN_VANITY_NIBBLES} to ${MAX_VANITY_NIBBLES} hex digits, or none.`,
    );
  }
  return { suffix, nibbles };
}
