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
import { getBlockNumber, getLogs, readContract } from "viem/actions";
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
import { MAX_SCAN_WINDOWS } from "../owed.js";
import {
  settingsKit,
  type SettingsContext,
  type SettingsKit,
} from "./context.js";
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
   * The coin's record, found in the factory's logs; null when the range holds none. The scan runs from
   * `fromBlock` (default the suite's deploy block) to `toBlock` (default the head) in the chain's log windows:
   * pass the launch's block for both to read it in one request.
   */
  frozen(
    token: Address,
    range?: { fromBlock?: bigint; toBlock?: bigint },
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

type FrozenArgs = {
  token: Address;
  poolId: Hex;
  termsHash: Hex;
  resolvedHash: Hex;
  terms: Hex;
};

/** A decoded log as the record; throws when the logged terms do not hash to the logged fingerprint. */
function recordOf(args: FrozenArgs): FrozenCoinTerms {
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

const SCAN_CONCURRENCY = 4;

/** A coin's frozen terms and their fingerprint check, for one chain's suite. */
export function createCoinTermsReads(ctx: SettingsContext): CoinTermsReads {
  const kit: SettingsKit = settingsKit(ctx);
  const { client, factory, addresses: a, chain } = kit;
  const token = (value: unknown): Address => kit.address(value, "The token");

  function lens() {
    if (!a.termsLens)
      throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
        chain,
        detail:
          "This read needs the suite's terms lens: pass addresses.termsLens.",
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

    async frozen(of, range = {}) {
      const t = token(of);
      const to = range.toBlock ?? (await getBlockNumber(client));
      const from =
        range.fromBlock ??
        (a.blockNumber === undefined
          ? kit.invalid(
              "Pass fromBlock (the launch's block, or the suite's deploy block): these addresses carry no deploy block.",
            )
          : BigInt(a.blockNumber));
      const span = BigInt(ctx.chain.maxLogRange);
      if (to >= from && (to - from) / span + 1n > BigInt(MAX_SCAN_WINDOWS))
        kit.invalid(
          "The range is too long to scan: pass the launch's block as fromBlock and toBlock.",
        );
      const windows: [bigint, bigint][] = [];
      for (let s = from; s <= to; s += span)
        windows.push([s, s + span - 1n < to ? s + span - 1n : to]);
      for (let i = 0; i < windows.length; i += SCAN_CONCURRENCY) {
        const logs = await Promise.all(
          windows.slice(i, i + SCAN_CONCURRENCY).map(([fromBlock, toBlock]) =>
            getLogs(client, {
              address: a.factory,
              event: getAbiItem({
                abi: bankrLaunchFactoryAbi,
                name: "CoinTermsFrozen",
              }),
              args: { token: t },
              fromBlock,
              toBlock,
              strict: true,
            }),
          ),
        );
        const found = logs.flat().find((log) => !log.removed);
        if (found) return recordOf(found.args);
      }
      return null;
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
