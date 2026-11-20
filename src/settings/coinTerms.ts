import {
  decodeAbiParameters,
  getAbiItem,
  isAddressEqual,
  isHex,
  keccak256,
  parseEventLogs,
  zeroHash,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
  bankrTermsLensAbi,
} from "../abis/settings.js";
import {
  LaunchConfigError,
  LaunchExecutionError,
  LaunchRefusedError,
} from "../errors.js";
import {
  settingsKit,
  type SettingsContext,
  type SettingsKit,
} from "./context.js";
import {
  MAX_SCAN_WINDOWS,
  findFrozenLog,
  logWindows,
  scanFrozenLog,
  type FrozenLogArgs,
} from "./frozenLog.js";
import type { CoinTerms } from "./settingsTypes.js";

// A coin's terms are resolved once, stored in the coin's own contracts, hashed and logged: no setter reaches them
// afterwards. The record is the factory's CoinTermsFrozen log; its hash is the coin's fingerprint.

/** A coin's frozen record, as the factory logged it at launch. */
export interface FrozenCoinTerms {
  token: Address;
  poolId: Hex;
  /** The coin's fingerprint: `keccak256` of the logged terms, which the factory stores (`termsHashOf`). */
  termsHash: Hex;
  /** What `resolve` returned for the launch: the hash a launch pins. It differs by the words the factory fills in. */
  resolvedHash: Hex;
  terms: CoinTerms;
  /** `abi.encode(CoinTerms)` as logged: what `verify` hands the lens. */
  termsBytes: Hex;
}

/** The fingerprint check of one coin. */
export interface CoinTermsCheck {
  /** Both hold: this is the coin's record, and the coin still is what it says. */
  ok: boolean;
  /** The record's bytes hash to the fingerprint the factory stored at launch. */
  hashMatches: boolean;
  /** Every store of the coin (hook, ledger, token, escrow, distributor) still holds what the record says. */
  storesMatch: boolean;
  /** `factory.termsHashOf(token)`; null for an address this factory never launched. */
  fingerprint: Hex | null;
}

export interface CoinTermsReads {
  /** The record in a launch receipt, paired by the factory's address and the token, never by log position; the
   *  only record when `token` is not given. `RECEIPT_MISSING_LAUNCH` without one. No RPC. */
  fromReceipt(receipt: TransactionReceipt, token?: Address): FrozenCoinTerms;
  /**
   * The coin's record, from the factory's log of its launch; null for an address this factory never launched. With
   * no `range` the launch's block is found from the token's trading start, however long ago it was: one log request
   * for a coin that traded from launch, a walk back for one that scheduled its start. It throws where the node
   * serves no log for a coin the factory did launch. A `range`, both ends, scans those blocks instead, in the
   * chain's log windows (null when they hold none): pass the launch's block for both to read it in one request.
   */
  frozen(
    token: Address,
    range?: { fromBlock: bigint; toBlock: bigint },
  ): Promise<FrozenCoinTerms | null>;
  /** The coin's fingerprint; null for an address this factory never launched. */
  fingerprint(token: Address): Promise<Hex | null>;
  /** What the coin's own contracts hold now, rebuilt by the lens. The numbers that only gated the launch, and the
   *  launch's own split and vest numbers, read zero here: take those from the frozen record. */
  stored(token: Address): Promise<CoinTerms>;
  /** Holds a record (or its `termsBytes`) to the coin: its hash against the factory's, and every word against the
   *  coin's stores. */
  verify(
    token: Address,
    record: FrozenCoinTerms | Hex,
  ): Promise<CoinTermsCheck>;
}

const COIN_TERMS = getAbiItem({ abi: bankrLaunchSettingsAbi, name: "resolve" })
  .outputs[0];

/** `abi.encode(CoinTerms)`, the `terms` bytes of `CoinTermsFrozen`, as the struct. */
export function decodeCoinTerms(terms: Hex): CoinTerms {
  return decodeAbiParameters([COIN_TERMS], terms)[0];
}

/** A decoded log as the record; throws when the logged terms do not hash to the logged fingerprint. */
function recordOf(args: FrozenLogArgs): FrozenCoinTerms {
  if (keccak256(args.terms) !== args.termsHash)
    throw new RangeError(
      "CoinTermsFrozen: the logged terms are not termsHash's",
    );
  return {
    token: args.token,
    poolId: args.poolId,
    termsHash: args.termsHash,
    resolvedHash: args.resolvedHash,
    terms: decodeCoinTerms(args.terms),
    termsBytes: args.terms,
  };
}

/** A coin's frozen terms and their fingerprint check, for one chain's contracts. */
export function createCoinTermsReads(ctx: SettingsContext): CoinTermsReads {
  const kit: SettingsKit = settingsKit(ctx);
  const { client, factory, addresses: a, chain } = kit;
  const token = (value: unknown): Address => kit.address(value, "The token");

  function lens() {
    if (!a.termsLens)
      throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
        chain,
        detail: "This read needs the terms lens: pass addresses.termsLens.",
      });
    return { address: a.termsLens, abi: bankrTermsLensAbi } as const;
  }

  async function fingerprint(of: Address): Promise<Hex | null> {
    const hash = await readContract(client, {
      ...factory,
      functionName: "termsHashOf",
      args: [of],
    });
    return hash === zeroHash ? null : hash;
  }

  return {
    fromReceipt(receipt, of) {
      const want = of === undefined ? undefined : token(of);
      const records = parseEventLogs({
        abi: bankrLaunchFactoryAbi,
        eventName: "CoinTermsFrozen",
        logs: receipt.logs.filter((log) => !log.removed),
        strict: true,
      })
        .filter((log) => isAddressEqual(log.address, a.factory))
        .filter((log) => !want || isAddressEqual(log.args.token, want));
      if (records.length !== 1)
        throw new LaunchExecutionError("RECEIPT_MISSING_LAUNCH", {
          chain,
          transactionHash: receipt.transactionHash,
        });
      return recordOf(records[0]!.args);
    },

    async frozen(of, range) {
      const t = token(of);
      const span = BigInt(ctx.chain.maxLogRange);
      const log = { factory: a.factory, token: t };
      if (range !== undefined) {
        const { fromBlock: from, toBlock: to } = range;
        if (typeof from !== "bigint" || typeof to !== "bigint")
          return kit.invalid(
            "A range is both fromBlock and toBlock: the launch's block for both reads it in one request.",
          );
        if (to >= from && (to - from) / span + 1n > BigInt(MAX_SCAN_WINDOWS))
          kit.invalid(
            "The range is too long to scan: pass the launch's block as fromBlock and toBlock.",
          );
        const found = await scanFrozenLog(
          client,
          log,
          logWindows(from, to, span),
        );
        return found && recordOf(found);
      }
      if ((await fingerprint(t)) === null) return null;
      const search = await findFrozenLog(client, {
        ...log,
        maxLogRange: ctx.chain.maxLogRange,
        deployBlock: a.blockNumber,
      });
      if (search.found) return recordOf(search.found);
      if (!search.walked)
        kit.invalid(
          "This coin's trading start was scheduled further ahead of its launch than the search walks back: pass the launch's block as fromBlock and toBlock.",
        );
      // The factory holds the coin's fingerprint, so its launch logged the record: the gap is the node's.
      throw new RangeError(
        "CoinTermsFrozen: the node serves no log for a coin the factory launched",
      );
    },

    fingerprint: async (of) => fingerprint(token(of)),

    async stored(of) {
      const t = token(of);
      const [hash, l] = [await fingerprint(t), lens()];
      if (hash === null)
        throw new LaunchRefusedError("NOT_A_LAUNCH", { chain });
      return readContract(client, {
        ...l,
        functionName: "coinTerms",
        args: [t],
      });
    },

    async verify(of, record) {
      const t = token(of);
      const bytes = typeof record === "string" ? record : record?.termsBytes;
      if (!isHex(bytes))
        kit.invalid("A record is a FrozenCoinTerms, or its termsBytes.");
      const [hash, storesMatch] = await Promise.all([
        fingerprint(t),
        readContract(client, {
          ...lens(),
          functionName: "coinTermsMatch",
          args: [t, bytes],
        }),
      ]);
      const hashMatches = hash !== null && keccak256(bytes) === hash;
      return {
        ok: hashMatches && storesMatch,
        hashMatches,
        storesMatch,
        fingerprint: hash,
      };
    },
  };
}
