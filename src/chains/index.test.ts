import { describe, expect, test } from "bun:test";
import {
  BANKR_V4_LAUNCH_ADDRESSES,
  BANKR_V4_CAP_EXCLUSIONS,
} from "../addresses.js";
import { isLaunchSdkError } from "../errors.js";
import {
  CHAINS,
  EIP_7825_MAX_TX_GAS,
  LAUNCH_CHAINS,
  getChain,
  isLaunchChain,
} from "./index.js";

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code as "PAUSED"), code).toBe(true);
}

describe("CHAINS capability table", () => {
  test("the six chains, keyed by their own name: the four Bankr indexes, then Ethereum and BNB Chain", () => {
    expect([...LAUNCH_CHAINS]).toEqual([
      "base",
      "robinhood",
      "arbitrum",
      "arc",
      "ethereum",
      "bnb",
    ]);
    expect(LAUNCH_CHAINS.filter((c) => CHAINS[c].indexed)).toEqual([
      "base",
      "robinhood",
      "arbitrum",
      "arc",
    ]);
    for (const chain of LAUNCH_CHAINS) {
      expect(CHAINS[chain].chain).toBe(chain);
      expect(CHAINS[chain].venue).toBe("uniswap_v4");
      expect(CHAINS[chain].viemChain.id).toBe(CHAINS[chain].chainId);
    }
    expect(LAUNCH_CHAINS.map((c) => CHAINS[c].chainId)).toEqual([
      8453, 4663, 42161, 5042, 1, 56,
    ]);
  });

  test("named majors per chain; Arc is USDC-only, pays gas in USDC and has no native dev buy", () => {
    expect(Object.keys(CHAINS.base.quotes)).toEqual(["WETH", "USDC"]);
    expect(Object.keys(CHAINS.robinhood.quotes)).toEqual(["WETH", "USDG"]);
    expect(Object.keys(CHAINS.arbitrum.quotes)).toEqual(["WETH", "USDC"]);
    expect(Object.keys(CHAINS.arc.quotes)).toEqual(["USDC"]);
    expect(CHAINS.arc.defaultQuote).toBe("USDC");
    expect(CHAINS.arc.gasToken).toBe("USDC");
    expect(CHAINS.arc.nativeDevBuy).toBe(false);
    for (const chain of ["base", "robinhood", "arbitrum"] as const) {
      expect(CHAINS[chain].defaultQuote).toBe("WETH");
      expect(CHAINS[chain].nativeDevBuy).toBe(true);
    }
  });

  test("FD-23: holders' half of Bankr's slice pays BNKR on Base and Robinhood, the quote on Arbitrum and Arc", () => {
    expect(CHAINS.base.holderPayout).toBe("bnkr");
    expect(CHAINS.robinhood.holderPayout).toBe("bnkr");
    expect(CHAINS.arbitrum.holderPayout).toBe("quote");
    expect(CHAINS.arc.holderPayout).toBe("quote");
  });

  test("gas ceilings: 2^24 on Base, Arc, Ethereum and BNB Chain, Nitro's 32M on Arbitrum and Robinhood", () => {
    for (const chain of ["base", "arc", "ethereum", "bnb"] as const)
      expect(CHAINS[chain].maxTxGas, chain).toBe(EIP_7825_MAX_TX_GAS);
    expect(CHAINS.arbitrum.maxTxGas).toBe(32_000_000n);
    expect(CHAINS.robinhood.maxTxGas).toBe(32_000_000n);
  });

  test("a chain is live by its record alone: every chain has one, and the capability table carries no flag beside it", () => {
    for (const chain of LAUNCH_CHAINS) {
      expect("deployed" in CHAINS[chain], chain).toBe(false);
      expect(BANKR_V4_LAUNCH_ADDRESSES[chain].chainId, chain).toBe(
        CHAINS[chain].chainId,
      );
      expect(Object.isFrozen(BANKR_V4_LAUNCH_ADDRESSES[chain]), chain).toBe(
        true,
      );
    }
  });

  test("every chain has a config; only Base's and Robinhood's list cap exclusions", () => {
    for (const chain of LAUNCH_CHAINS) {
      expect(BANKR_V4_CAP_EXCLUSIONS[chain], chain).toBeDefined();
    }
    for (const chain of ["arc", "arbitrum", "ethereum", "bnb"] as const)
      expect(BANKR_V4_CAP_EXCLUSIONS[chain], chain).toEqual([]);
    expect(BANKR_V4_CAP_EXCLUSIONS.base.length).toBe(7);
  });

  test("the table is frozen", () => {
    expect(Object.isFrozen(CHAINS)).toBe(true);
    for (const chain of LAUNCH_CHAINS) {
      expect(Object.isFrozen(CHAINS[chain])).toBe(true);
      expect(Object.isFrozen(CHAINS[chain].quotes)).toBe(true);
    }
  });

  test("getChain and isLaunchChain refuse anything else", () => {
    expect(isLaunchChain("base")).toBe(true);
    for (const v of ["polygon", "mainnet", "bsc", "BASE", "", null, 8453])
      expect(isLaunchChain(v)).toBe(false);
    expectCode(() => getChain("polygon"), "UNSUPPORTED_CHAIN");
  });
});
