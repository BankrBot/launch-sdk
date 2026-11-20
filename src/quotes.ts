import {
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
} from "viem";
import { readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchpadRegistryAbi,
} from "./abis/suite3.js";
import type { ChainCapabilities } from "./chains/index.js";
import { LaunchRefusedError } from "./errors.js";
import { requireRegisteredPad } from "./launchpad.js";
import type { DevBuyKind, QuoteToken, ReadClient } from "./providers/types.js";

// IBankrLaunchFactory.PricingMode { NONE, CHAINLINK, SIGNED }. SIGNED quotes need Bankr's price attestation, which
// only the prepare endpoint (API mode) carries.
const PRICING = ["none", "chainlink", "signed"] as const;

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

/** The factory's and the pad's live view of one quote. */
export interface QuoteState {
  /** In the factory's registry (`quoteEntry(quote).allowed`). */
  listed: boolean;
  /** Allowed by the pad: every quote, listed or not, while the pad names none. */
  padAllows: boolean;
  pricing: (typeof PRICING)[number];
  /** A listed quote's pricing decimals; an unlisted one's own `decimals()`, null when it cannot be read or is above
   *  {@link MAX_QUOTE_DECIMALS}. */
  decimals: number | null;
}

export async function readQuoteState(
  client: ReadClient,
  i: {
    factory: Address;
    registry: Address;
    quote: Address;
    launchpadId: bigint;
  },
): Promise<QuoteState> {
  const f = { address: i.factory, abi: bankrLaunchFactoryAbi } as const;
  const [entry, pricing, padAllows] = await Promise.all([
    readContract(client, { ...f, functionName: "quoteEntry", args: [i.quote] }),
    readContract(client, {
      ...f,
      functionName: "quotePricing",
      args: [i.quote],
    }),
    readContract(client, {
      address: i.registry,
      abi: bankrLaunchpadRegistryAbi,
      functionName: "isQuoteAllowed",
      args: [i.launchpadId, i.quote],
    }),
  ]);
  // Any-quote pairing: a quote the factory does not list has no pricing record, so its decimals are its own, and only
  // an integer up to MAX_QUOTE_DECIMALS counts (round 9 F1: viem decodes a uint8 unbounded).
  const decimals = entry.allowed
    ? pricing.decimals
    : await readContract(client, {
        address: i.quote,
        abi: erc20Abi,
        functionName: "decimals",
      }).then(
        (d) =>
          Number.isInteger(Number(d)) &&
          Number(d) >= 0 &&
          Number(d) <= MAX_QUOTE_DECIMALS
            ? Number(d)
            : null,
        () => null,
      );
  return {
    listed: entry.allowed,
    padAllows,
    pricing: PRICING[pricing.mode] ?? "none",
    decimals,
  };
}

/** How a dev buy on `quote` is funded: native only on WETH where the chain pays gas in ETH. */
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

/** Every quote the chain's factory allows and prices and pad `launchpadId` accepts, majors first; `UNKNOWN_LAUNCHPAD`
 *  for a pad the registry never registered (it would read as allowing every quote). */
export async function readQuotes(
  client: ReadClient,
  caps: ChainCapabilities,
  i: {
    factory: Address;
    registry: Address;
    weth: Address;
    launchpadId: bigint;
  },
): Promise<QuoteToken[]> {
  const [list] = await Promise.all([
    readContract(client, {
      address: i.factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "quoteList",
    }),
    requireRegisteredPad(client, i.registry, i.launchpadId, caps.chain),
  ]);
  const refs = list.map((q) => resolveQuote(caps, q));
  const states = await Promise.all(
    refs.map((r) => readQuoteState(client, { ...i, quote: r.address })),
  );
  return refs
    .map((r, n) => ({ r, s: states[n]! }))
    .filter(({ s }) => s.listed && s.padAllows && s.pricing !== "none")
    .map(({ r, s }) => quoteToken(caps, r, s, i.weth))
    .sort((a, b) => Number(b.symbol !== null) - Number(a.symbol !== null));
}
