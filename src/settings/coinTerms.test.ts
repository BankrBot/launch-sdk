import { describe, expect, test } from "bun:test";
import {
  encodeAbiParameters,
  getAbiItem,
  keccak256,
  zeroAddress,
  zeroHash,
  type Abi,
  type AbiParameter,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { eventLog } from "../__internal__/fakeRpc.js";
import { FakeSettings, SUITE, at } from "../__internal__/fakeSettings.js";
import { bankrLaunchTokenAbi } from "../abis/generated.js";
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

  test("a range scans those blocks, in the chain's log windows", async () => {
    const { suite, coins } = setup();
    suite.chain.blockNumber = 5_000n;
    suite.chain.addLog(
      frozenLog(at(0x71), termsOf({ launchpadId: 9n }).bytes),
      2_500n,
    );
    suite.chain.addLog(frozenLog(), 4_100n);
    const record = await coins.frozen(TOKEN, {
      fromBlock: 10n,
      toBlock: 5_000n,
    });
    expect(record?.terms.totalSupply).toBe(10n ** 29n);
    // 2,000 blocks a request on Base
    expect(suite.chain.logRequests[0]).toEqual({
      fromBlock: 10n,
      toBlock: 2_009n,
    });
    suite.chain.logRequests.length = 0;
    expect(
      (await coins.frozen(TOKEN, { fromBlock: 4_100n, toBlock: 4_100n }))
        ?.token,
    ).toBe(TOKEN);
    expect(suite.chain.logRequests).toEqual([
      { fromBlock: 4_100n, toBlock: 4_100n },
    ]);
    expect(
      await coins.frozen(TOKEN, { fromBlock: 4_101n, toBlock: 5_000n }),
    ).toBeNull();
  });

  test("a range is both of its ends, and no longer than the scan covers", async () => {
    const { suite, coins } = setup();
    suite.chain.blockNumber = 5_000_000n;
    suite.chain.addLog(frozenLog(), 4_100n);
    // One end alone would fall back on a scan from the deploy block, or to the head: the scan that expires.
    for (const half of [{ fromBlock: 4_100n }, { toBlock: 4_100n }])
      expect(await code(coins.frozen(TOKEN, half as never))).toBe(
        "INVALID_PARAMS",
      );
    expect(suite.chain.logRequests).toEqual([]);
    expect(
      await code(coins.frozen(TOKEN, { fromBlock: 10n, toBlock: 5_000_000n })),
    ).toBe("INVALID_PARAMS");
  });
});

// With no range the launch's block is found from the token's own trading start. The chain here is 50 million blocks
// past the deploy block, twelve times what a scan from that block could cover.
describe("a coin's frozen terms, found from its trading start", () => {
  const HEAD = 50_000_000n;
  const LAUNCH = 30_000_001n;
  /** Block reads the changing-pace chain may cost: finding the exact block took 19. */
  const READS = 17;
  /** One full window that starts at or within half a window before `block`: `block` and what shares its second. */
  const expectWindowAt = (
    w: { fromBlock: bigint; toBlock: bigint },
    block: bigint,
  ) => {
    expect(w.toBlock - w.fromBlock).toBe(1_999n);
    expect(w.fromBlock).toBeLessThanOrEqual(block);
    expect(block - w.fromBlock).toBeLessThanOrEqual(1_000n);
  };
  /** A chain with `perSecond` blocks a second from block 0, and the coin's token trading from `start`. */
  const chain = (o: { perSecond?: bigint; start?: bigint } = {}) => {
    const s = setup();
    const { suite } = s;
    const perSecond = o.perSecond ?? 0n;
    const time = (n: bigint) =>
      perSecond === 0n ? 1_000_000n + 2n * n : 1_000_000n + n / perSecond;
    suite.chain.blockNumber = HEAD;
    suite.chain.blockTime = time;
    suite.chain.contract(TOKEN, bankrLaunchTokenAbi as Abi, {
      tradingStart: o.start ?? time(LAUNCH),
    });
    suite.chain.addLog(frozenLog(), LAUNCH);
    return { ...s, time };
  };

  test("a coin that traded from launch: one log request at the start's block, after a handful of block reads", async () => {
    const { suite, coins } = chain();
    const record = await coins.frozen(TOKEN);
    expect(record?.token).toBe(TOKEN);
    expect(record?.termsBytes).toBe(RECORD.bytes);
    expect(suite.chain.logRequests).toHaveLength(1);
    expectWindowAt(suite.chain.logRequests[0]!, LAUNCH);
    expect(suite.chain.blockRequests.length).toBeLessThanOrEqual(8);
  });

  test("it does not depend on the chain's age: the same reads a billion blocks on", async () => {
    const { suite, coins } = chain();
    suite.chain.blockNumber = 1_000_000_000n;
    expect((await coins.frozen(TOKEN))?.token).toBe(TOKEN);
    expect(suite.chain.logRequests).toHaveLength(1);
    expect(suite.chain.blockRequests.length).toBeLessThanOrEqual(8);
  });

  test("several blocks a second: the launch is a few blocks after the first of its second", async () => {
    const { suite, coins } = chain({ perSecond: 4n });
    expect((await coins.frozen(TOKEN))?.token).toBe(TOKEN);
    expect(suite.chain.logRequests).toHaveLength(1);
    expectWindowAt(suite.chain.logRequests[0]!, LAUNCH);
  });

  test("uneven block times still land on the block: the halving bounds the search", async () => {
    const s = setup();
    // A chain that stalled for a day at block 20,000,000, then ran at four times the pace.
    const time = (n: bigint) =>
      n < 20_000_000n
        ? 1_000_000n + 2n * n
        : 41_086_400n + (n - 20_000_000n) / 2n;
    s.suite.chain.blockNumber = HEAD;
    s.suite.chain.blockTime = time;
    s.suite.chain.contract(TOKEN, bankrLaunchTokenAbi as Abi, {
      tradingStart: time(LAUNCH),
    });
    s.suite.chain.addLog(frozenLog(), LAUNCH);
    expect((await s.coins.frozen(TOKEN))?.token).toBe(TOKEN);
    expect(s.suite.chain.logRequests).toHaveLength(1);
    expectWindowAt(s.suite.chain.logRequests[0]!, LAUNCH);
    // At most two reads a halving of 50 million blocks.
    expect(s.suite.chain.blockRequests.length).toBeLessThanOrEqual(54);
  });

  test("the search stops at a window's precision: a chain whose pace keeps changing costs no reads past that", async () => {
    const s = setup();
    // The pace flips between one and three seconds a block every half a million blocks.
    const time = (n: bigint) => {
      const [era, rest] = [n / 1_000_000n, n % 1_000_000n];
      const within = rest < 500_000n ? rest : 500_000n + (rest - 500_000n) * 3n;
      return 1_000_000n + era * 2_000_000n + within;
    };
    const launch = 30_250_123n;
    s.suite.chain.blockNumber = HEAD;
    s.suite.chain.blockTime = time;
    s.suite.chain.contract(TOKEN, bankrLaunchTokenAbi as Abi, {
      tradingStart: time(launch),
    });
    s.suite.chain.addLog(frozenLog(), launch);
    expect((await s.coins.frozen(TOKEN))?.token).toBe(TOKEN);
    expect(s.suite.chain.logRequests).toHaveLength(1);
    expectWindowAt(s.suite.chain.logRequests[0]!, launch);
    expect(s.suite.chain.blockRequests.length).toBeLessThanOrEqual(READS);
  });

  test("a scheduled start: the record is found by walking back from the start, as far as the coin's own delay", async () => {
    // Three days ahead on a 2 s chain: 129,600 blocks, 65 windows back.
    const { suite, coins, time } = chain();
    suite.chain.contract(TOKEN, bankrLaunchTokenAbi as Abi, {
      tradingStart: time(LAUNCH) + 259_200n,
    });
    expect((await coins.frozen(TOKEN))?.token).toBe(TOKEN);
    const asked = suite.chain.logRequests;
    expectWindowAt(asked[0]!, LAUNCH + 129_600n);
    expect(asked.length).toBeGreaterThan(60);
    expect(asked.length).toBeLessThanOrEqual(1 + 68);
    // Four windows a round: the round that finds it reads at most three windows further back.
    expect(asked.every((r) => r.fromBlock >= LAUNCH - 8_000n)).toBe(true);
  });

  test("a start still ahead of the chain's clock: the walk starts at the head", async () => {
    const { suite, coins, time } = chain();
    suite.chain.blockNumber = LAUNCH + 500n;
    suite.chain.contract(TOKEN, bankrLaunchTokenAbi as Abi, {
      tradingStart: time(LAUNCH) + 86_400n,
    });
    expect((await coins.frozen(TOKEN))?.token).toBe(TOKEN);
    // The last window of the chain, in one request.
    expect(suite.chain.logRequests).toEqual([
      { fromBlock: LAUNCH - 1_499n, toBlock: LAUNCH + 500n },
    ]);
  });

  test("an address the factory never launched is null without a log request; addresses with no deploy block still find a coin", async () => {
    const { suite, coins } = chain();
    expect(await coins.frozen(at(0x72))).toBeNull();
    expect(suite.chain.logRequests).toEqual([]);
    // A coin the factory did launch whose log the node does not hold is the node's gap, never "not launched".
    const lost = at(0x73);
    suite.termsHashes.set(lost.toLowerCase(), keccak256(RECORD.bytes));
    suite.chain.contract(lost, bankrLaunchTokenAbi as Abi, {
      tradingStart: 1_000_000n + 2n * 2_000n,
    });
    expect(await code(coins.frozen(lost))).toContain("serves no log");
    const addresses = { ...SUITE, blockNumber: undefined };
    const bare = createCoinTermsReads({ ...suite.context(), addresses });
    expect((await bare.frozen(TOKEN))?.token).toBe(TOKEN);
  });

  test("a start scheduled further ahead than the walk covers is refused, and names the range to pass", async () => {
    // 2,000 windows of 2,000 blocks: 92 days on a 2 s chain. This coin scheduled 100.
    const { suite, coins, time } = chain();
    suite.chain.contract(TOKEN, bankrLaunchTokenAbi as Abi, {
      tradingStart: time(LAUNCH) + 8_640_000n,
    });
    let thrown: unknown;
    try {
      await coins.frozen(TOKEN);
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "INVALID_PARAMS")).toBe(true);
    expect((thrown as { detail?: string }).detail).toContain("fromBlock");
    expect(suite.chain.logRequests).toHaveLength(2_000);
    expect(
      (await coins.frozen(TOKEN, { fromBlock: LAUNCH, toBlock: LAUNCH }))
        ?.token,
    ).toBe(TOKEN);
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
