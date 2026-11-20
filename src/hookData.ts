import {
  concatHex,
  getAddress,
  isAddress,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { LaunchRefusedError } from "./errors.js";

// What a router passes the Bankr hook as a swap's hookData, vendored from core's bankr-v4 hookData.ts (the contracts'
// HookData.sol); src/__internal__ holds the encoder byte-equal to core's. Pure: viem only.

/** The prefix that marks Bankr's fields; without it the whole hookData is the extension's own data. */
export const HOOKDATA_MAGIC: Hex = "0xba7c4a7c";
/** flags & 1: a sell skips the extension's post-swap call (its quoted fee is still paid); a buy never does. */
export const HOOKDATA_SKIP_AFTER_SWAP = 1;
/** flags & 2: `n(1) ‖ n × currency(20)` follow, the currencies outside the pool's pair the route holds a delta in. */
export const HOOKDATA_ROUTE_CURRENCIES = 2;
/** flags & 4: `referrer(20)` follows, paid the launch's referrer slice of the fee where it has one. */
export const HOOKDATA_REFERRER = 4;
/** flags & 8: `keepGas(3)` follows. It asks this pool for its holders' wake and names the gas the sender keeps for
 *  the rest of its route, which the wake and the buyback fill both leave free. */
export const HOOKDATA_HOLDERS_WAKE = 8;
/** The hook's caps: past either the swap reverts `MalformedHookData`. */
export const HOOKDATA_MAX_ROUTE_CURRENCIES = 16;
export const HOOKDATA_MAX_EXT_DATA_BYTES = 2_048;
/** The most gas a wake request can say it keeps: three bytes. */
export const HOOKDATA_MAX_KEEP_GAS = 0xffffff;

/** One Bankr pool's wake request: the gas its sender keeps for the hops after it (`holdersWakeRequest` sizes it). */
export interface HoldersWakeRequest {
  keepGas: number;
}

export interface HookDataInput {
  /** Off by default: on a route of several hops it would drop the extension's action on a sell. */
  skipAfterSwap?: boolean;
  /** Currencies outside the pool's own pair the route holds a delta in during the unlock; at most 16. */
  routeCurrencies?: readonly Address[];
  /** Paid the launch's referrer slice (nothing on a launch without one), as a pull balance in the fee ledger. */
  referrer?: Address;
  /** The wake request, 0 kept included; omitted or null does not ask. */
  holdersWake?: HoldersWakeRequest | null;
  /** Handed to the pool's extension as it is; at most 2,048 bytes. */
  extData?: Hex;
}

const invalid = (detail: string): never => {
  throw new LaunchRefusedError("INVALID_PARAMS", { detail });
};

/**
 * A swap's hookData for one Bankr pool: `[magic ‖ flags ‖ (n ‖ currencies)? ‖ referrer? ‖ keepGas?] ‖ extData`, or
 * `0x` with nothing to say (what every other router sends). `INVALID_PARAMS` for a field the hook would revert on.
 */
export function encodeHookData(i: HookDataInput = {}): Hex {
  const pins = i.routeCurrencies ?? [];
  const extData = i.extData ?? "0x";
  if (!/^0x([0-9a-fA-F]{2})*$/u.test(extData))
    invalid("extData must be whole bytes of hex.");
  if (pins.length > HOOKDATA_MAX_ROUTE_CURRENCIES)
    invalid(
      `A swap can pin at most ${HOOKDATA_MAX_ROUTE_CURRENCIES} route currencies.`,
    );
  if ((extData.length - 2) / 2 > HOOKDATA_MAX_EXT_DATA_BYTES)
    invalid("extData can be at most 2,048 bytes.");
  if (!pins.every((c) => isAddress(c)))
    invalid("Each route currency must be an address.");
  const referrer = i.referrer;
  if (
    referrer !== undefined &&
    (!isAddress(referrer) || BigInt(referrer) === 0n)
  )
    invalid("The referrer must be a non-zero address.");
  const wake = i.holdersWake ?? null;
  if (
    wake &&
    (!Number.isInteger(wake.keepGas) ||
      wake.keepGas < 0 ||
      wake.keepGas > HOOKDATA_MAX_KEEP_GAS)
  )
    invalid("The kept gas must be a whole number from 0 to 16,777,215.");
  if (
    !i.skipAfterSwap &&
    pins.length === 0 &&
    !referrer &&
    !wake &&
    extData === "0x"
  )
    return "0x";
  const flags =
    (i.skipAfterSwap ? HOOKDATA_SKIP_AFTER_SWAP : 0) |
    (pins.length > 0 ? HOOKDATA_ROUTE_CURRENCIES : 0) |
    (referrer ? HOOKDATA_REFERRER : 0) |
    (wake ? HOOKDATA_HOLDERS_WAKE : 0);
  const parts: Hex[] = [HOOKDATA_MAGIC, numberToHex(flags, { size: 1 })];
  if (pins.length > 0) {
    parts.push(numberToHex(pins.length, { size: 1 }));
    for (const c of pins) parts.push(getAddress(c));
  }
  if (referrer) parts.push(getAddress(referrer));
  if (wake) parts.push(numberToHex(wake.keepGas, { size: 3 }));
  parts.push(extData);
  return concatHex(parts).toLowerCase() as Hex;
}
