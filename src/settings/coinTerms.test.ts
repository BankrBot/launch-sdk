import { describe, expect, test } from "bun:test";
import {
  encodeAbiParameters,
  getAbiItem,
  keccak256,
  zeroAddress,
  zeroHash,
  type AbiParameter,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { eventLog } from "../__internal__/fakeRpc.js";
import { FakeSettings, SUITE, at } from "../__internal__/fakeSettings.js";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchSettingsAbi,
} from "../abis/settings.js";
import { isLaunchSdkError } from "../errors.js";
import { createCoinTermsReads, decodeCoinTerms } from "./coinTerms.js";
import type { CoinTerms } from "./settingsTypes.js";

const COIN_TERMS = getAbiItem({ abi: bankrLaunchSettingsAbi, name: "resolve" })
  .outputs[0];

/** A struct of zeros in the ABI's own shape: what a test then names a few words of. */
function zeros(p: AbiParameter): unknown {
  if (p.type === "tuple")
    return Object.fromEntries(
      (p as { components: readonly AbiParameter[] }).components.map((c) => [
        c.name,
        zeros(c),
      ]),
    );
  if (p.type === "address") return zeroAddress;
  if (p.type === "bool") return false;
  if (p.type === "bytes32") return zeroHash;
  const bits = Number(p.type.replace(/^u?int/, ""));
  return bits <= 48 ? 0 : 0n;
}

const TOKEN = at(0x70);
const POOL = `0x${"0b".repeat(32)}` as const;
const termsOf = (
  change: Partial<CoinTerms>,
): { terms: CoinTerms; bytes: Hex } => {
  const terms = { ...(zeros(COIN_TERMS) as CoinTerms), ...change };
  return { terms, bytes: encodeAbiParameters([COIN_TERMS], [terms]) };
};
const RECORD = termsOf({
  launchpadId: 3n,
  quote: at(0xe7),
  holderLeg: at(0xd1),
  legId: 1,
  totalSupply: 10n ** 29n,
  capSecs: 86_400,
  takeover: true,
  ctoNotice: 172_800,
});
const frozenLog = (
  token = TOKEN,
  bytes = RECORD.bytes,
  emitter = SUITE.factory,
) => ({
  ...eventLog(
    bankrLaunchFactoryAbi,
    "CoinTermsFrozen",
    {
      token,
      poolId: POOL,
      termsHash: keccak256(bytes),
      resolvedHash: `0x${"0c".repeat(32)}`,
      terms: bytes,
    },
    emitter,
  ),
  removed: false,
});
const receipt = (logs: unknown[]) =>
  ({
    logs,
    transactionHash: `0x${"aa".repeat(32)}`,
  }) as unknown as TransactionReceipt;

const setup = () => {
  const suite = new FakeSettings();
  suite.termsHashes.set(TOKEN.toLowerCase(), keccak256(RECORD.bytes));
  return { suite, coins: createCoinTermsReads(suite.context()) };
};
const code = async (run: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof run === "function" ? run() : run);
  } catch (err) {
    return isLaunchSdkError(err) ? err.code : String(err);
  }
  return null;
};

describe("a coin's frozen terms", () => {
  test("the record is 91 words and decodes to the struct it was encoded from", () => {
    expect((RECORD.bytes.length - 2) / 64).toBe(91);
    expect(decodeCoinTerms(RECORD.bytes)).toEqual(RECORD.terms);
  });

  test("a receipt's record is paired by the factory's address and the token, never by position", () => {
    const { coins } = setup();
    const other = termsOf({ launchpadId: 9n });
    const logs = [
      frozenLog(TOKEN, other.bytes, at(0x99)), // a look-alike from another contract
      frozenLog(at(0x71), other.bytes), // another coin of the same transaction
      frozenLog(),
    ];
    const record = coins.fromReceipt(receipt(logs), TOKEN);
    expect(record.token).toBe(TOKEN);
    expect(record.poolId).toBe(POOL);
    expect(record.termsHash).toBe(keccak256(RECORD.bytes));
    expect(record.terms.launchpadId).toBe(3n);
    expect(record.terms.takeover).toBe(true);
    expect(record.termsBytes).toBe(RECORD.bytes);
    // with two records and no token named, there is no single launch to read
    expect(() => coins.fromReceipt(receipt(logs))).toThrow();
    expect(coins.fromReceipt(receipt([frozenLog()])).token).toBe(TOKEN);
    expect(() =>
      coins.fromReceipt(
        receipt([frozenLog(TOKEN, other.bytes, at(0x99))]),
        TOKEN,
      ),
    ).toThrow();
  });

  test("the record is found in the factory's logs, in the chain's log windows", async () => {
    const { suite, coins } = setup();
    suite.chain.blockNumber = 5_000n;
    suite.chain.addLog(
      frozenLog(at(0x71), termsOf({ launchpadId: 9n }).bytes),
      2_500n,
    );
    suite.chain.addLog(frozenLog(), 4_100n);
    const record = await coins.frozen(TOKEN);
    expect(record?.terms.totalSupply).toBe(10n ** 29n);
    // from the suite's deploy block, 2,000 blocks a request on Base
    expect(suite.chain.logRequests[0]).toEqual({
      fromBlock: 10n,
      toBlock: 2_009n,
    });
    expect(await coins.frozen(at(0x72))).toBeNull();
    suite.chain.logRequests.length = 0;
    expect(
      (await coins.frozen(TOKEN, { fromBlock: 4_100n, toBlock: 4_100n }))
        ?.token,
    ).toBe(TOKEN);
    expect(suite.chain.logRequests).toEqual([
      { fromBlock: 4_100n, toBlock: 4_100n },
    ]);
    expect(await coins.frozen(TOKEN, { fromBlock: 4_101n })).toBeNull();
  });

  test("a range too long to scan, or no start block at all, is refused", async () => {
    const { suite } = setup();
    suite.chain.blockNumber = 5_000_000n;
    const coins = createCoinTermsReads(suite.context());
    expect(await code(coins.frozen(TOKEN))).toBe("INVALID_PARAMS");
    const addresses = { ...SUITE, blockNumber: undefined };
    const bare = createCoinTermsReads({ ...suite.context(), addresses });
    expect(await code(bare.frozen(TOKEN))).toBe("INVALID_PARAMS");
  });
});

describe("the fingerprint check", () => {
  test("the fingerprint is the factory's hash; a stranger has none", async () => {
    const { coins } = setup();
    expect(await coins.fingerprint(TOKEN)).toBe(keccak256(RECORD.bytes));
    expect(await coins.fingerprint(at(0x72))).toBeNull();
  });

  test("a record holds when its bytes hash to the fingerprint and the coin's stores still say so", async () => {
    const { suite, coins } = setup();
    const record = coins.fromReceipt(receipt([frozenLog()]));
    expect(await coins.verify(TOKEN, record)).toEqual({
      ok: true,
      hashMatches: true,
      storesMatch: true,
      fingerprint: keccak256(RECORD.bytes),
    });
    expect((await coins.verify(TOKEN, RECORD.bytes)).ok).toBe(true);
    // another coin's record: neither the hash nor the stores
    const other = termsOf({ launchpadId: 9n }).bytes;
    expect(await coins.verify(TOKEN, other)).toMatchObject({
      ok: false,
      hashMatches: false,
      storesMatch: false,
    });
    // the right record over a coin whose stores moved: the lens says no
    suite.storesHold.set(TOKEN.toLowerCase(), false);
    expect(await coins.verify(TOKEN, record)).toMatchObject({
      ok: false,
      hashMatches: true,
      storesMatch: false,
    });
    expect(await coins.verify(at(0x72), RECORD.bytes)).toMatchObject({
      ok: false,
      fingerprint: null,
    });
    expect(await code(coins.verify(TOKEN, {} as never))).toBe("INVALID_PARAMS");
  });

  test("the stored terms are the lens's; they need its address, and a launched coin", async () => {
    const { suite, coins } = setup();
    suite.storedTerms.set(TOKEN.toLowerCase(), RECORD.terms);
    expect((await coins.stored(TOKEN)).capSecs).toBe(86_400);
    expect(await code(coins.stored(at(0x72)))).toBe("NOT_A_LAUNCH");
    const addresses = { ...SUITE, termsLens: undefined };
    const noLens = createCoinTermsReads({ ...suite.context(), addresses });
    expect(await code(noLens.stored(TOKEN))).toBe("PROVIDER_NOT_DEPLOYED");
    expect(await code(noLens.verify(TOKEN, RECORD.bytes))).toBe(
      "PROVIDER_NOT_DEPLOYED",
    );
  });
});
