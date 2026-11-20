import { describe, expect, test } from "bun:test";
import { getAddress, parseEther, parseUnits } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { CHAINS } from "./chains/index.js";

// examples/pad-authorize-route.ts is what a launchpad operator copies: its dev-buy cap has to hold for every quote,
// whatever its decimals. The example builds its handler at import, so it gets a throwaway signer key first.
process.env.PAD_SIGNER_KEY ??= generatePrivateKey();
const { devBuyWithinCap } = await import("../examples/pad-authorize-route.js");

const WETH = getAddress(CHAINS.base.quotes.WETH.address);
const USDC = getAddress(CHAINS.base.quotes.USDC.address);
const OTHER = getAddress("0x00000000000000000000000000000000000000aa");

const launch = (quote: `0x${string}`, erc20: bigint, native = 0n) => ({
  nativeDevBuy: native,
  params: { quote, devBuyAmountIn: erc20 },
});

describe("the pad authorize example's dev-buy cap", () => {
  test("a launch with no dev buy passes on any quote", () => {
    for (const quote of [WETH, USDC, OTHER])
      expect(devBuyWithinCap(launch(quote, 0n)), quote).toBe(true);
  });

  test("WETH is capped at 0.1, paid natively or as the token", () => {
    expect(devBuyWithinCap(launch(WETH, 0n, parseEther("0.1")))).toBe(true);
    expect(devBuyWithinCap(launch(WETH, 0n, parseEther("0.1") + 1n))).toBe(
      false,
    );
    expect(devBuyWithinCap(launch(WETH, parseEther("0.1")))).toBe(true);
    expect(devBuyWithinCap(launch(WETH, parseEther("0.11")))).toBe(false);
  });

  test("USDC is capped in its own six decimals: $250 passes, a cent more does not", () => {
    expect(devBuyWithinCap(launch(USDC, parseUnits("250", 6)))).toBe(true);
    expect(devBuyWithinCap(launch(USDC, parseUnits("250.01", 6)))).toBe(false);
    // One figure for every quote was no cap here: 10^17 base units of USDC is $100 billion.
    expect(devBuyWithinCap(launch(USDC, 10n ** 17n))).toBe(false);
  });

  test("a dev buy on a quote the pad set no cap for is refused, never waved through", () => {
    expect(devBuyWithinCap(launch(OTHER, 1n))).toBe(false);
  });
});
