import { describe, expect, test } from "bun:test";
import {
  BANKR_V4_EARLIER_ADDRESSES,
  BANKR_V4_LAUNCH_ADDRESSES,
  BANKR_V4_CAP_EXCLUSIONS,
  requireCapExclusions,
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
  test("the four v4 chains, keyed by their own name", () => {
    expect([...LAUNCH_CHAINS]).toEqual([
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
      8453, 4663, 42161, 5042,
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

  test("gas ceilings: EIP-7825's 2^24 on Base and Arc, Nitro's 32M on Arbitrum and Robinhood", () => {
    expect(CHAINS.base.maxTxGas).toBe(EIP_7825_MAX_TX_GAS);
    expect(CHAINS.arc.maxTxGas).toBe(EIP_7825_MAX_TX_GAS);
    expect(CHAINS.arbitrum.maxTxGas).toBe(32_000_000n);
    expect(CHAINS.robinhood.maxTxGas).toBe(32_000_000n);
  });

  test("the earlier contracts are on Base alone, and only Base is `deployed`; the latest are on every chain", () => {
    for (const chain of LAUNCH_CHAINS) {
      expect(CHAINS[chain].deployed, chain).toBe(chain === "base");
      expect(BANKR_V4_EARLIER_ADDRESSES[chain] === null, chain).toBe(
        chain !== "base",
      );
      expect(BANKR_V4_LAUNCH_ADDRESSES[chain]?.chainId, chain).toBe(
        CHAINS[chain].chainId,
      );
      expect(Object.isFrozen(BANKR_V4_LAUNCH_ADDRESSES[chain]), chain).toBe(
        true,
      );
    }
    expect(BANKR_V4_EARLIER_ADDRESSES.base?.chainId).toBe(CHAINS.base.chainId);
    expect(Object.isFrozen(BANKR_V4_EARLIER_ADDRESSES.base)).toBe(true);
  });

  test("every chain has a suite config; Arbitrum's and Arc's list no cap exclusions", () => {
    for (const chain of LAUNCH_CHAINS) {
      expect(BANKR_V4_CAP_EXCLUSIONS[chain], chain).toBeDefined();
    }
    expect(requireCapExclusions("arc")).toEqual([]);
    expect(requireCapExclusions("arbitrum")).toEqual([]);
    expect(requireCapExclusions("base").length).toBe(7);
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
    for (const v of ["ethereum", "BASE", "", null, 8453])
      expect(isLaunchChain(v)).toBe(false);
    expectCode(() => getChain("ethereum"), "UNSUPPORTED_CHAIN");
  });
});
