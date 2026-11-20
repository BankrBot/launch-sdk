import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import type { ChainCapabilities } from "./chains/index.js";
import { LaunchRefusedError } from "./errors.js";
import type { DevBuyKind, QuoteToken } from "./providers/types.js";

/** The most decimals an unlisted quote may have: MAX_QUOTE_SUPPLY is 1e36, and a larger one is not an ERC-20 a launch
 *  can price or display. */
export const MAX_QUOTE_DECIMALS = 36;

/** A quote as the launch input names it, before the chain is read. */
export interface QuoteRef {
  address: Address;
  symbol: string | null;
}

/** The quote `input` names: a named major, any address, or the chain's default. `QUOTE_NOT_ALLOWED` otherwise. */
export function resolveQuote(
  caps: ChainCapabilities,
  input: string | undefined,
): QuoteRef {
  const majors = caps.quotes as Readonly<Record<string, { address: Address }>>;
  const wanted = input ?? caps.defaultQuote;
  const named = majors[wanted];
  if (named) return { address: getAddress(named.address), symbol: wanted };
  if (typeof wanted === "string" && isAddress(wanted, { strict: false })) {
    const address = getAddress(wanted);
    const symbol =
      Object.keys(majors).find((s) =>
        isAddressEqual(majors[s]!.address, address),
      ) ?? null;
    return { address, symbol };
  }
  throw new LaunchRefusedError("QUOTE_NOT_ALLOWED", { chain: caps.chain });
}

/** The chain's live view of one quote. */
export interface QuoteState {
  /** Bankr lists the quote on this chain (`settings.quoteTerms(quote).allowed`). */
  listed: boolean;
  /** PricingMode { NONE, CHAINLINK, SIGNED }. A SIGNED quote needs Bankr's price attestation. */
  pricing: "none" | "chainlink" | "signed";
  /** A listed quote's pricing decimals; an unlisted one's own `decimals()`. */
  decimals: number | null;
}

/** How a dev buy on `quote` is funded: native only on the wrapped native token (WETH, WBNB), and never on Arc. */
export function devBuyKind(
  caps: ChainCapabilities,
  quote: Address,
  weth: Address,
): DevBuyKind {
  return caps.nativeDevBuy && isAddressEqual(quote, weth) ? "native" : "erc20";
}

export function quoteToken(
  caps: ChainCapabilities,
  ref: QuoteRef,
  state: QuoteState,
  weth: Address,
): QuoteToken {
  const def = (caps.quotes as Readonly<Record<string, { address: Address }>>)[
    caps.defaultQuote
  ]!;
  return {
    symbol: ref.symbol,
    address: ref.address,
    decimals: state.decimals ?? 0,
    isDefault: isAddressEqual(def.address, ref.address),
    listed: state.listed,
    pricing: !state.listed
      ? "unpriced"
      : state.pricing === "signed"
        ? "signed"
        : "chainlink",
    devBuy: devBuyKind(caps, ref.address, weth),
  };
}
