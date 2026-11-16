import {
  bytesToHex,
  hexToBytes,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import type { LaunchChain } from "./chains/index.js";
import { LaunchExecutionError } from "./errors.js";
import { BANKR_PAD_VANITY } from "./launchpad.js";
import {
  cloneInitCode,
  predictToken,
  tokenInitCode,
  type LiveSuite,
  type Suite4LiveSuite,
  type TokenIdentity,
} from "./predict.js";

// The launch salt and the pad's vanity rule, vendored from core's bankr-v4 saltMining.ts. A salt is single-use and
// binds to its launcher: whoever sees one before it is mined can take the token address and revert the launch.

interface WebCrypto {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function webCrypto(): WebCrypto {
  // Looked up per call: Node >= 22 and browsers have Web Crypto; a runtime without it fails here, not at import.
  const c = (globalThis as { crypto?: WebCrypto }).crypto;
  if (!c) throw new TypeError("Web Crypto is unavailable in this runtime");
  return c;
}

/** 32 crypto-random bytes as a launch `salt`. Every plan draws a fresh one. */
export function randomSalt(): Hex {
  return bytesToHex(webCrypto().getRandomValues(new Uint8Array(32)));
}

/** A pad's `Vanity`: the token's last `nibbles` hex digits must be `suffix` (0 nibbles = none). */
export interface Vanity {
  suffix: number;
  nibbles: number;
}

/** What a launch's token address must satisfy on its pad: its own suffix, and never Bankr's `…ba3` elsewhere. */
export interface VanityRule {
  want: Vanity | null;
  avoidBa3: boolean;
}

export function vanityRule(launchpadId: bigint, vanity: Vanity): VanityRule {
  return {
    want: vanity.nibbles > 0 ? vanity : null,
    avoidBa3: launchpadId !== 0n,
  };
}

/** `plan()`'s bound: at most 2^20 tries (each hashes ~5 KB). A 5- or 6-digit suffix often needs more: mine it with
 *  {@link mineVanitySalt} and a larger `maxTries` (off the UI thread), then pass it as `salt`. */
export const VANITY_MAX_TRIES = 1 << 20;
const YIELD_EVERY = 512;

/** 16 × the expected tries, so P(no match) = e^-16 for `…ba3`, capped at {@link VANITY_MAX_TRIES}. */
export function vanityMaxTries(rule: VanityRule): number {
  const n = rule.want?.nibbles ?? 1;
  return Math.min(16 * 16 ** n, VANITY_MAX_TRIES);
}

const lowNibbles = (h: Uint8Array, n: number): number => {
  let v = 0;
  for (let k = 0; k < Math.ceil(n / 2); k++) v += h[31 - k]! * 256 ** k;
  return v % 16 ** n;
};

/** Whether a CREATE2 hash (its low 20 bytes are the address) satisfies `rule`. */
export function vanityMatches(h: Uint8Array, rule: VanityRule): boolean {
  if (rule.want && lowNibbles(h, rule.want.nibbles) !== rule.want.suffix) {
    return false;
  }
  return !(
    rule.avoidBa3 &&
    lowNibbles(h, BANKR_PAD_VANITY.nibbles) === BANKR_PAD_VANITY.suffix
  );
}

/** Whether `address` satisfies `rule`. */
export function addressMatchesVanity(
  address: Address,
  rule: VanityRule,
): boolean {
  return vanityMatches(
    hexToBytes(`0x${address.slice(2).padStart(64, "0")}`),
    rule,
  );
}

function bumpCounter(salt: Uint8Array): void {
  for (let k = 31; k >= 24; k--) {
    salt[k] = (salt[k]! + 1) & 0xff;
    if (salt[k] !== 0) return;
  }
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface MinedSalt {
  salt: Hex;
  token: Address;
  tries: number;
}

/**
 * Mines a salt whose token satisfies `rule`: 24 random bytes ‖ a uint64 counter. Each try re-derives the escrow
 * (its address sits in the token's initcode) and hashes the initcode, yielding to the event loop every 512 tries.
 * Always bounded: null when `maxTries` (a positive whole number; `plan()` uses {@link vanityMaxTries}) run out.
 */
export async function mineVanitySalt(i: {
  suite: LiveSuite | Suite4LiveSuite;
  identity: TokenIdentity;
  launcher: Address;
  rule: VanityRule;
  maxTries?: number;
  /** 24 bytes; tests only. */
  base?: Hex;
}): Promise<MinedSalt | null> {
  const salt = new Uint8Array(32);
  if (i.base) salt.set(hexToBytes(i.base), 0);
  else webCrypto().getRandomValues(salt.subarray(0, 24));
  const pre = new Uint8Array(52); // launcher ‖ salt
  pre.set(toBytes(i.launcher), 0);

  // 0xff ‖ tokenDeployer ‖ deployerSalt ‖ initHash, and the escrow's own CREATE2 from the factory.
  const addrPre = new Uint8Array(85);
  addrPre[0] = 0xff;
  addrPre.set(toBytes(i.suite.tokenDeployer), 1);
  const escrowPre = new Uint8Array(85);
  escrowPre[0] = 0xff;
  escrowPre.set(toBytes(i.suite.factory), 1);
  escrowPre.set(
    keccak256(cloneInitCode(i.suite.vestingEscrowImpl), "bytes"),
    53,
  );
  const init = hexToBytes(
    tokenInitCode(i.suite, i.identity, `0x${"00".repeat(20)}`),
  );
  // The escrow is element 5 of the trailing address[], with the buyback, 0xdEaD and the launch's own after it.
  const escrowAt =
    init.length - 32 * (i.identity.capExclusions.length + 3) + 12;

  const maxTries = i.maxTries ?? vanityMaxTries(i.rule);
  if (!Number.isSafeInteger(maxTries) || maxTries < 1) {
    throw new RangeError("maxTries must be a positive whole number");
  }
  for (let t = 0; t < maxTries; t++) {
    if (t > 0 && t % YIELD_EVERY === 0) await nextTask();
    pre.set(salt, 20);
    const s = keccak256(pre, "bytes");
    escrowPre.set(s, 21);
    init.set(keccak256(escrowPre, "bytes").subarray(12), escrowAt);
    addrPre.set(s, 21);
    addrPre.set(keccak256(init, "bytes"), 53);
    if (vanityMatches(keccak256(addrPre, "bytes"), i.rule)) {
      const mined = bytesToHex(salt);
      return {
        salt: mined,
        token: predictToken(i.suite, i.identity, i.launcher, mined),
        tries: t + 1,
      };
    }
    bumpCounter(salt);
  }
  return null;
}

/** `VANITY_UNAVAILABLE` with what the pad wants and how to supply a salt instead. */
export function vanityUnavailable(
  chain: LaunchChain,
  launchpadId: bigint,
  rule: VanityRule,
): LaunchExecutionError {
  const want = rule.want;
  const suffix = want
    ? `end in …${want.suffix.toString(16).padStart(want.nibbles, "0")}`
    : `avoid Bankr's …${BANKR_PAD_VANITY.suffix.toString(16)}`;
  return new LaunchExecutionError("VANITY_UNAVAILABLE", {
    chain,
    detail: `Launchpad ${launchpadId}'s tokens must ${suffix}, and ${vanityMaxTries(rule)} tries found no salt. Mine one with mineVanitySalt and a larger maxTries (or any CREATE2 miner over predictToken) for this launcher, name, symbol, metadata URI and metadata admin, then pass it as \`salt\`.`,
  });
}
