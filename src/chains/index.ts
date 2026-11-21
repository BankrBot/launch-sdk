import type { Address, Chain } from "viem";
import {
  arbitrum as viemArbitrum,
  arc as viemArc,
  base as viemBase,
  bsc as viemBnb,
  mainnet as viemEthereum,
  robinhood as viemRobinhood,
} from "viem/chains";
import { LaunchConfigError } from "../errors.js";

/**
 * Every chain the SDK launches on, each covered by Bankr's launch index: the chains Bankr's own apps launch on
 * (core's `BANKR_V4_CHAINS`), then Ethereum and BNB Chain. New chains arrive as additive minors.
 */
export const LAUNCH_CHAINS = Object.freeze([
  "base",
  "robinhood",
  "arbitrum",
  "arc",
  "ethereum",
  "bnb",
] as const);

export type LaunchChain = (typeof LAUNCH_CHAINS)[number];

export interface LaunchChainIds {
  base: 8453;
  robinhood: 4663;
  arbitrum: 42161;
  arc: 5042;
  ethereum: 1;
  bnb: 56;
}

/**
 * The quotes the SDK names per chain: the majors only. Any other quote the chain's factory allows and prices is
 * passed by address (`LaunchInput.quote`).
 */
export interface QuoteFor {
  base: "WETH" | "USDC";
  robinhood: "WETH" | "USDG";
  arbitrum: "WETH" | "USDC";
  arc: "USDC";
  ethereum: "WETH" | "USDC";
  bnb: "WBNB" | "USDT" | "USDC";
}

export type QuoteSymbol<C extends LaunchChain = LaunchChain> = QuoteFor[C];

/** A named quote's address and decimals. Read the decimals: BNB Chain's USDT and USDC have 18, not 6. */
export interface QuoteAddress {
  readonly address: Address;
  readonly decimals: number;
}

/** A chain's named majors, keyed by symbol (distributive, so one chain's map is a `ChainCapabilities`'s too). */
export type QuoteMap<C extends LaunchChain = LaunchChain> =
  C extends LaunchChain ? { readonly [S in QuoteFor[C]]: QuoteAddress } : never;

/** What Bankr's contracts support on a chain and how the SDK talks to it. */
export interface ChainCapabilities<C extends LaunchChain = LaunchChain> {
  readonly chain: C;
  readonly chainId: LaunchChainIds[C];
  readonly viemChain: Chain;
  /** Every launch is one Uniswap v4 pool behind Bankr's hook. */
  readonly venue: "uniswap_v4";
  /** Gas is paid in USDC on Arc (18-dp native balance) and in BNB on BNB Chain. */
  readonly gasToken: "ETH" | "USDC" | "BNB";
  /** The named majors, keyed by symbol. */
  readonly quotes: QuoteMap<C>;
  readonly defaultQuote: QuoteFor[C];
  /** Whether a dev buy quoted in the wrapped native token (WETH, WBNB) may be paid in the native gas token
   *  (`msg.value`). False on Arc. */
  readonly nativeDevBuy: boolean;
  /**
   * The asset the coin holders' half of Bankr's slice pays in: BNKR where BNKR trades (Base, Robinhood), the
   * quote elsewhere until it is listed there. A per-chain setting on the holder leg, so read it as a default.
   */
  readonly holderPayout: "bnkr" | "quote";
  /** Per-transaction gas ceiling the chain's RPC enforces (EIP-7825's 2^24 on Base, Arc, Ethereum and BNB Chain). */
  readonly maxTxGas: bigint;
  /** The widest `eth_getLogs` block range to request: Bankr's indexer's window. */
  readonly maxLogRange: number;
  /** Blocks before a launch is treated as final: Bankr's indexer's depth. */
  readonly confirmations: number;
  /** No usable public RPC: the client needs an `rpcUrl` or `publicClient`. */
  readonly rpcRequired: boolean;
  /** The public RPC works but is limited (shallow history, rate limits): pass an `rpcUrl`. */
  readonly rpcRecommended: boolean;
}

export type ChainTable = { readonly [C in LaunchChain]: ChainCapabilities<C> };

const freezeChain = <C extends LaunchChain>(
  c: ChainCapabilities<C>,
): ChainCapabilities<C> => {
  Object.freeze(c.quotes);
  return Object.freeze(c);
};

/** EIP-7825's per-transaction gas cap (2^24): Base, Arc, Ethereum and BNB Chain's ceiling. */
export const EIP_7825_MAX_TX_GAS = 16_777_216n;

// maxLogRange and confirmations mirror Bankr's bankr_v4 indexer (workers' chain params). A chain is live once its
// record is in `BANKR_V4_LAUNCH_ADDRESSES`: no flag here says so a second time.
export const CHAINS: ChainTable = Object.freeze({
  base: freezeChain({
    chain: "base",
    chainId: 8453,
    viemChain: viemBase,
    venue: "uniswap_v4",
    gasToken: "ETH",
    quotes: {
      WETH: {
        address: "0x4200000000000000000000000000000000000006",
        decimals: 18,
      },
      USDC: {
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
      },
    },
    defaultQuote: "WETH",
    nativeDevBuy: true,
    holderPayout: "bnkr",
    maxTxGas: EIP_7825_MAX_TX_GAS,
    maxLogRange: 2_000,
    confirmations: 20,
    rpcRequired: false,
    rpcRecommended: false,
  }),
  robinhood: freezeChain({
    chain: "robinhood",
    chainId: 4663,
    viemChain: viemRobinhood,
    venue: "uniswap_v4",
    gasToken: "ETH",
    quotes: {
      WETH: {
        address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
        decimals: 18,
      },
      USDG: {
        address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        decimals: 6,
      },
    },
    defaultQuote: "WETH",
    nativeDevBuy: true,
    holderPayout: "bnkr",
    maxTxGas: 32_000_000n,
    maxLogRange: 2_000,
    confirmations: 100,
    rpcRequired: false,
    rpcRecommended: true,
  }),
  arbitrum: freezeChain({
    chain: "arbitrum",
    chainId: 42161,
    viemChain: viemArbitrum,
    venue: "uniswap_v4",
    gasToken: "ETH",
    quotes: {
      WETH: {
        address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        decimals: 18,
      },
      USDC: {
        address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        decimals: 6,
      },
    },
    defaultQuote: "WETH",
    nativeDevBuy: true,
    holderPayout: "quote",
    maxTxGas: 32_000_000n,
    maxLogRange: 2_000,
    confirmations: 20,
    rpcRequired: false,
    rpcRecommended: false,
  }),
  arc: freezeChain({
    chain: "arc",
    chainId: 5042,
    viemChain: viemArc,
    venue: "uniswap_v4",
    gasToken: "USDC",
    quotes: {
      USDC: {
        address: "0x3600000000000000000000000000000000000000",
        decimals: 6,
      },
    },
    defaultQuote: "USDC",
    nativeDevBuy: false,
    holderPayout: "quote",
    maxTxGas: EIP_7825_MAX_TX_GAS,
    maxLogRange: 10_000,
    confirmations: 2,
    rpcRequired: true,
    rpcRecommended: false,
  }),
  // Ethereum's and BNB Chain's maxTxGas is each chain config's (`config/<chain>.json`).
  ethereum: freezeChain({
    chain: "ethereum",
    chainId: 1,
    viemChain: viemEthereum,
    venue: "uniswap_v4",
    gasToken: "ETH",
    quotes: {
      WETH: {
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        decimals: 18,
      },
      USDC: {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        decimals: 6,
      },
    },
    defaultQuote: "WETH",
    nativeDevBuy: true,
    holderPayout: "quote",
    maxTxGas: EIP_7825_MAX_TX_GAS,
    maxLogRange: 2_000,
    // Three epochs: finalized by then.
    confirmations: 96,
    rpcRequired: false,
    rpcRecommended: true,
  }),
  bnb: freezeChain({
    chain: "bnb",
    chainId: 56,
    viemChain: viemBnb,
    venue: "uniswap_v4",
    gasToken: "BNB",
    quotes: {
      WBNB: {
        address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        decimals: 18,
      },
      // Binance-Peg tokens: 18 decimals, unlike USDT and USDC elsewhere.
      USDT: {
        address: "0x55d398326f99059ff775485246999027b3197955",
        decimals: 18,
      },
      USDC: {
        address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
        decimals: 18,
      },
    },
    defaultQuote: "WBNB",
    nativeDevBuy: true,
    holderPayout: "quote",
    maxTxGas: EIP_7825_MAX_TX_GAS,
    // The cap of viem's default RPC (56.rpc.thirdweb.com).
    maxLogRange: 1_000,
    // About 9 seconds at 0.45 s blocks.
    confirmations: 20,
    rpcRequired: false,
    rpcRecommended: true,
  }),
});

export function isLaunchChain(value: unknown): value is LaunchChain {
  return (LAUNCH_CHAINS as readonly unknown[]).includes(value);
}

/** The capability row for `chain`; throws `UNSUPPORTED_CHAIN` for anything outside {@link LAUNCH_CHAINS}. */
export function getChain<C extends LaunchChain>(chain: C): ChainCapabilities<C>;
export function getChain(chain: string): ChainCapabilities;
export function getChain(chain: string): ChainCapabilities {
  if (!isLaunchChain(chain)) throw new LaunchConfigError("UNSUPPORTED_CHAIN");
  return CHAINS[chain];
}
