import { describe, expect, test } from "bun:test";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import { bsc, mainnet } from "viem/chains";
import { BANKR_V4_LAUNCH_ADDRESSES } from "./addresses.js";
import { createBankrApi, type FetchLike } from "./api.js";
import { CHAINS, LAUNCH_CHAINS } from "./chains/index.js";
import { createLaunchClient, type LaunchClient } from "./client.js";
import { erc20SlotsFor } from "./data/erc20Slots.js";
import { isLaunchSdkError, launchSdkError } from "./errors.js";
import { KNOB } from "./launch/settings.js";
import { FakeChain } from "./__internal__/fakeRpc.js";
import {
  FAKE_TOKENS_PER_UNIT,
  installContracts,
  type ContractsFixture,
} from "./__internal__/fakeContracts.js";
import { launchLogs } from "./__internal__/fakeLaunchReceipt.js";
import {
  FRESH_PAD_ID,
  freshContractsState,
} from "./__internal__/fakeContractsState.js";

// Ethereum and BNB Chain: Bankr's contracts are live there and Bankr's apps, API and launch index are not. The SDK
// reads, plans and launches on them like anywhere, and says plainly that there is no index to read.

const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN: Address = "0x1234567890abcdef1234567890abcdef12345678";
const TX_HASH: Hex = `0x${"ab".repeat(32)}`;
const NOT_COVERED =
  "Bankr's launch index does not cover this chain. Read from the chain with client.launchInfo and client.contracts().";

/** A fetch that counts its calls: an index read on an unindexed chain must never reach it. */
function countingFetch(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(String(url));
    return Response.json({ launches: [], nextCursor: null });
  };
  return { fetch, calls };
}

async function notCovered(
  promise: Promise<unknown>,
  chain: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, "INDEX_NOT_COVERED"), String(thrown)).toBe(
    true,
  );
  const err = thrown as { message: string; chain: string; name: string };
  expect(err.message).toBe(NOT_COVERED);
  expect(err.chain).toBe(chain);
  expect(err.name).toBe("LaunchConfigError");
}

describe("the chain table: Ethereum and BNB Chain", () => {
  test("they follow the chains Bankr indexes, and only they are unindexed", () => {
    expect([...LAUNCH_CHAINS]).toEqual([
      "base",
      "robinhood",
      "arbitrum",
      "arc",
      "ethereum",
      "bnb",
    ]);
    expect(LAUNCH_CHAINS.filter((c) => !CHAINS[c].indexed)).toEqual([
      "ethereum",
      "bnb",
    ]);
    expect(CHAINS.ethereum.chainId).toBe(1);
    expect(CHAINS.ethereum.viemChain.id).toBe(mainnet.id);
    expect(CHAINS.bnb.chainId).toBe(56);
    expect(CHAINS.bnb.viemChain.id).toBe(bsc.id);
  });

  test("both are live: each has its record, on its own chain id", () => {
    for (const chain of ["ethereum", "bnb"] as const) {
      const record = BANKR_V4_LAUNCH_ADDRESSES[chain];
      expect(record.chainId, chain).toBe(CHAINS[chain].chainId);
      expect(
        createLaunchClient({ chain, rpcUrl: "http://127.0.0.1:1" }).provider
          .addresses,
      ).toEqual(record);
    }
  });

  test("named quotes: WETH and USDC on Ethereum; WBNB, USDT and USDC on BNB Chain, the two dollars with 18 decimals", () => {
    expect(CHAINS.ethereum.quotes).toEqual({
      WETH: {
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        decimals: 18,
      },
      USDC: {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        decimals: 6,
      },
    });
    expect(CHAINS.bnb.quotes).toEqual({
      WBNB: {
        address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        decimals: 18,
      },
      USDT: {
        address: "0x55d398326f99059ff775485246999027b3197955",
        decimals: 18,
      },
      USDC: {
        address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
        decimals: 18,
      },
    });
    expect(CHAINS.ethereum.defaultQuote).toBe("WETH");
    expect(CHAINS.bnb.defaultQuote).toBe("WBNB");
  });

  test("gas is ETH and BNB, the wrapped native token takes a native dev buy, and holders are paid in the quote", () => {
    expect(CHAINS.ethereum.gasToken).toBe("ETH");
    expect(CHAINS.bnb.gasToken).toBe("BNB");
    for (const chain of ["ethereum", "bnb"] as const) {
      expect(CHAINS[chain].nativeDevBuy, chain).toBe(true);
      expect(CHAINS[chain].holderPayout, chain).toBe("quote");
      // A public RPC serves both, within limits a client is warned of.
      expect(CHAINS[chain].rpcRequired, chain).toBe(false);
      expect(CHAINS[chain].rpcRecommended, chain).toBe(true);
    }
  });

  test("dev-buy slots: BNB Chain's dollars keep the plain BEP-20 layout, not Circle's", () => {
    for (const symbol of ["USDT", "USDC"] as const)
      expect(
        erc20SlotsFor("bnb", CHAINS.bnb.quotes[symbol].address),
        symbol,
      ).toEqual({ balances: 1, allowances: 2 });
    expect(
      erc20SlotsFor("ethereum", CHAINS.ethereum.quotes.USDC.address),
    ).toEqual({ balances: 9, allowances: 10 });
  });
});

describe("Bankr's launch index does not cover them", () => {
  test("the error is one code with one plain sentence", () => {
    const err = launchSdkError("INDEX_NOT_COVERED", { chain: "bnb" });
    expect(err.message).toBe(NOT_COVERED);
    expect(err.message).not.toMatch(/\d{3}|not yet|soon|coming/i);
  });

  test("createBankrApi: every call that names such a chain is refused before any request", async () => {
    for (const chain of ["ethereum", "bnb"] as const) {
      const { fetch, calls } = countingFetch();
      const api = createBankrApi({ fetch });
      await notCovered(api.launches({ chain }), chain);
      await notCovered(api.launch(chain, TOKEN), chain);
      await notCovered(api.launchpadStats(chain, 1n), chain);
      await notCovered(api.register(chain, TX_HASH), chain);
      await notCovered(api.accountFees(chain, LAUNCHER), chain);
      await notCovered(api.allLaunches({ chain }).next(), chain);
      expect(calls).toEqual([]);
      // A read that names no chain is the index's own, across the chains it covers.
      await api.launches();
      expect(calls).toHaveLength(1);
    }
  });

  test("a client's index reads and its owed fees are refused the same way; its chain reads are not", async () => {
    for (const chain of ["ethereum", "bnb"] as const) {
      const { fetch, calls } = countingFetch();
      const fake = new FakeChain(chain === "bnb" ? bsc : mainnet);
      const client: LaunchClient = createLaunchClient({
        chain,
        publicClient: fake.publicClient(),
        api: { fetch },
      });
      const { index } = client;
      await notCovered(index.launches(), chain);
      await notCovered(index.all().next(), chain);
      await notCovered(index.launch(TOKEN), chain);
      await notCovered(index.builder("mypad"), chain);
      await notCovered(index.launchpadStats(1n), chain);
      await notCovered(index.register(TX_HASH), chain);
      await notCovered(client.fees.getOwed(LAUNCHER), chain);
      await notCovered(client.fees.buildClaimAll(LAUNCHER), chain);
      expect(calls).toEqual([]);
      expect(typeof client.contracts().settings.pad).toBe("function");
    }
  });
});

describe("a launch on BNB Chain", () => {
  const USDT = getAddress(CHAINS.bnb.quotes.USDT.address);
  const WBNB = getAddress(CHAINS.bnb.quotes.WBNB.address);

  /** Fake contracts on chain 56 with an open launchpad that takes a dev buy of up to 2 %. */
  function fixture(quote: Address): ContractsFixture {
    const state = freshContractsState({ chainId: 56 });
    const ranges = [...state.pad!.ranges];
    ranges[KNOB.devBuyMaxBps] = { min: 0n, max: 200n, dflt: 200n };
    state.pad = { ...state.pad!, ranges };
    if (quote === USDT)
      // A dollar a unit with 18 decimals, as config/bnb.json lists it: compound amounts of $250 and $500.
      state.quote = {
        ...state.quote,
        terms: {
          ...state.quote.terms,
          decimals: 18,
          compoundFloor: parseEther("250"),
          compoundCap: parseEther("500"),
          quoteActivation: parseEther("2.5"),
        },
        feedPriceUsdE18: 10n ** 18n,
        totalSupply: 10n ** 27n,
      };
    return installContracts(new FakeChain(bsc), {
      state,
      padId: FRESH_PAD_ID,
      quote,
      weth: WBNB,
    });
  }

  function client(f: ContractsFixture, fetch?: FetchLike): LaunchClient<"bnb"> {
    f.fake.onSend = (tx) => launchLogs(f, tx);
    return createLaunchClient({
      chain: "bnb",
      addresses: f.deployment,
      fork: true,
      publicClient: f.fake.publicClient(),
      walletClient: f.fake.walletClient(LAUNCHER),
      ...(fetch ? { api: { fetch } } : {}),
    });
  }

  const input = (f: ContractsFixture) => ({
    name: "BNB Coin",
    symbol: "BNBC",
    metadataUri: "ipfs://bafy-bnb",
    launcher: LAUNCHER,
    launchpadId: f.padId,
  });

  test("the default quote is WBNB, and a dev buy on it is paid in BNB", async () => {
    const f = fixture(WBNB);
    const plan = await client(f).plan({
      ...input(f),
      devBuy: { amount: parseEther("0.5") },
    });
    expect(plan.quote).toMatchObject({
      symbol: "WBNB",
      address: WBNB,
      decimals: 18,
      isDefault: true,
      devBuy: "native",
    });
    expect(plan.value).toBe(parseEther("0.5"));
    expect(plan.approvals).toEqual([]);
  });

  test("a dev buy in USDT is sized in its 18 decimals, approved and pulled as an ERC-20", async () => {
    const f = fixture(USDT);
    const amount = parseEther("25"); // $25: 25e18 base units, not 25e6
    f.fake.setErc20Balance(USDT, LAUNCHER, amount);
    const c = client(f);
    const plan = await c.plan({
      ...input(f),
      quote: "USDT",
      devBuy: { amount },
    });
    expect(plan.quote).toMatchObject({
      symbol: "USDT",
      decimals: 18,
      devBuy: "erc20",
    });
    expect(plan.value).toBe(0n);
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]!.to.toLowerCase()).toBe(USDT.toLowerCase());
    const result = await c.launch({
      ...input(f),
      quote: "USDT",
      devBuy: { amount },
    });
    expect(result.chain).toBe("bnb");
    expect(result.quote).toBe(USDT);
    expect(result.devBuyOut).toBe(amount * FAKE_TOKENS_PER_UNIT);
  });

  test("with `api` set the launch still lands: registration is skipped, not attempted and not failed", async () => {
    const f = fixture(WBNB);
    const { fetch, calls } = countingFetch();
    f.fake.onSend = (tx) => {
      f.fake.blockNumber += 10n;
      return launchLogs(f, tx);
    };
    const c = createLaunchClient({
      chain: "bnb",
      addresses: f.deployment,
      fork: true,
      publicClient: f.fake.publicClient(),
      walletClient: f.fake.walletClient(LAUNCHER),
      api: { fetch },
    });
    const result = await c.launch(input(f));
    expect(result.token).toBeDefined();
    expect("registration" in result).toBe(false);
    expect(calls).toEqual([]);
  });
});
