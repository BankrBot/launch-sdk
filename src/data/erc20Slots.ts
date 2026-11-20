import type { Address } from "viem";
import type { LaunchChain } from "../chains/index.js";

/** Storage slots of an ERC-20's `_balances` and `_allowances` mappings. */
export interface Erc20Slots {
  /** `null`: the token reports the account's native balance (Arc's USDC), so there is no slot to write. */
  readonly balances: number | null;
  readonly allowances: number;
}

/**
 * Where each ERC-20 dev-buy quote keeps balances and allowances, keyed by lowercase address, so a simulation can
 * assume a pending approval (a Safe or ERC-4337 `approve + launch` batch) through an `eth_call` state override.
 * Vendored from Bankr's probed table; a quote without a row has no override.
 */
export const ERC20_DEV_BUY_SLOTS: {
  readonly [C in LaunchChain]: Readonly<Record<Address, Erc20Slots>>;
} = Object.freeze({
  arbitrum: Object.freeze({
    // Native USDC (Circle FiatTokenV2_2).
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": {
      balances: 9,
      allowances: 10,
    },
  }),
  arc: Object.freeze({
    // USDC predeploy: balances are the native (gas) balance, allowances at slot 10.
    "0x3600000000000000000000000000000000000000": {
      balances: null,
      allowances: 10,
    },
  }),
  base: Object.freeze({
    // Native USDC (Circle FiatTokenV2_2).
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
      balances: 9,
      allowances: 10,
    },
  }),
  // WETH dev buys are native; USDG has none.
  robinhood: Object.freeze({}),
  ethereum: Object.freeze({
    // Native USDC (Circle FiatTokenV2_2).
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
      balances: 9,
      allowances: 10,
    },
  }),
  // WBNB dev buys are native. Binance-Peg USDT and USDC keep the plain BEP-20 layout, not Circle's: probed on chain
  // with an `eth_call` state override (2026-11-20).
  bnb: Object.freeze({
    "0x55d398326f99059ff775485246999027b3197955": {
      balances: 1,
      allowances: 2,
    },
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": {
      balances: 1,
      allowances: 2,
    },
  }),
});

/** The slots for `quote` on `chain`, or undefined when none are pinned. */
export function erc20SlotsFor(
  chain: LaunchChain,
  quote: Address,
): Erc20Slots | undefined {
  return ERC20_DEV_BUY_SLOTS[chain][quote.toLowerCase() as Address];
}
