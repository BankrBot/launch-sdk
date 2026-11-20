import {
  getAddress,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { getCode, readContract } from "viem/actions";
import { bankrFeeLedgerAbi, bankrLaunchFactoryAbi } from "./abis/suite3.js";
import type { ProviderAddresses } from "./addresses.js";
import type { LaunchChain } from "./chains/index.js";
import { LaunchRefusedError } from "./errors.js";
import { PAD_TREASURY_MARKER } from "./launchpad.js";
import type { EarlierLivePointers } from "./predict.js";
import type { ReadClient } from "./providers/types.js";

const SAFE_ABI = [
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** BnkrHolderLeg.references: the price references in force, which a BNKR swap replaces (founder 11-05). */
export const HOLDER_LEG_REFERENCES_ABI = [
  {
    type: "function",
    name: "references",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

/** The holder leg's references read live: the record's `referenceOracle` is the go-live one, and isSuite reads the leg. */
export function readLegReferences(
  client: ReadClient,
  holderLeg: Address,
): Promise<Address> {
  return readContract(client, {
    address: holderLeg,
    abi: HOLDER_LEG_REFERENCES_ABI,
    functionName: "references",
  });
}

/** pools.fun's FEES_TO_HOLDERS marker: it and the 15 addresses after it are never a payee (the factory's sentinel family). */
export const FEES_TO_HOLDERS: Address =
  "0x968b0c1e896FB1DdB2042957Fc0614c67AB7FFc2";
const SENTINEL_SPAN = 15n;

/** The factory's `_isSentinel`: the FEES_TO_HOLDERS family and the pads' treasury marker, routing markers no one can claim as. */
export const isSentinel = (a: Address): boolean => {
  const n = BigInt(a);
  const base = BigInt(FEES_TO_HOLDERS);
  return (
    (n >= base && n <= base + SENTINEL_SPAN) ||
    n === BigInt(PAD_TREASURY_MARKER)
  );
};

/**
 * `value` as a checksummed, non-zero address (`zeroOk`: zero too); `INVALID_PARAMS` otherwise, with a `detail` naming
 * `what` when given. A mixed-case spelling must match its EIP-55 checksum; an all-lower or all-upper one carries none.
 */
export function requireAddress(
  value: unknown,
  chain?: LaunchChain,
  what?: string,
  zeroOk = false,
): Address {
  function refuse(problem: string, named = what): never {
    throw new LaunchRefusedError("INVALID_PARAMS", {
      chain,
      detail: named === undefined ? undefined : `${named} ${problem}.`,
    });
  }

  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    refuse("is not an address");
  }
  // A mistyped digit breaks the checksum; re-checksumming it would encode an address nobody controls.
  const oneCase = /^0x[\dA-F]{40}$/.test(value) ? value.toLowerCase() : value;
  if (!isAddress(oneCase)) {
    refuse(
      "does not match its EIP-55 checksum; check for a typo",
      what ?? "The address",
    );
  }
  if (!zeroOk && isAddressEqual(value, zeroAddress)) {
    refuse("is the zero address");
  }
  return getAddress(value);
}

/** A 23-byte `0xef0100 ‖ address` delegation designator: an EIP-7702 wallet, not a contract. */
export const isDelegatedEoa = (code: Hex | undefined): boolean =>
  code !== undefined &&
  code.length === 48 &&
  code.toLowerCase().startsWith("0xef0100");

export const hasCode = (code: Hex | undefined): boolean =>
  code !== undefined && code !== "0x";

async function isSafe(client: ReadClient, address: Address): Promise<boolean> {
  try {
    const threshold = await readContract(client, {
      address,
      abi: SAFE_ABI,
      functionName: "getThreshold",
    });
    return threshold > 0n;
  } catch {
    return false;
  }
}

/** Every suite contract and the pool manager: the factory's `_isSuite`, which none of a launch's payees may be, and
 *  the suite's CREATE3 factory, which `isSuite` does not hold and could never collect either (NS-18 FACTORY-3).
 *  `references` is the holder leg's, read live (readLegReferences). */
export function suiteContracts(
  a: Pick<
    ProviderAddresses,
    | "factory"
    | "holderRewardsDeployer"
    | "launchpadRegistry"
    | "holderLeg"
    | "claimsRedeemer"
    | "presetDeployer"
    | "create3Factory"
  >,
  live: Pick<
    EarlierLivePointers,
    | "hook"
    | "ledger"
    | "locker"
    | "tokenDeployer"
    | "vestingEscrowImpl"
    | "buyback"
    | "poolManager"
  >,
  references: Address,
): Address[] {
  return [
    a.factory,
    live.hook,
    live.ledger,
    live.locker,
    a.holderRewardsDeployer,
    live.tokenDeployer,
    live.vestingEscrowImpl,
    a.launchpadRegistry,
    a.holderLeg,
    live.buyback,
    live.poolManager,
    a.claimsRedeemer,
    a.presetDeployer,
    a.create3Factory,
    references,
  ].filter((x) => !isAddressEqual(x, zeroAddress));
}

/** Why an open contract payee is refused (round 9 RSEC-1). */
export const RESTRICT_CONTRACT_FIRST =
  "The contract lets anyone claim for it: restrict it first (it calls the fee ledger's setClaimRestricted(true), ideally in its constructor), since a stranger's settle moves its share where collectFees never returns it.";

/**
 * Whether `account` may be named as a payee whatever it does with its share: an EOA, an EIP-7702 wallet, a Safe, or a
 * contract that turned "anyone can claim" off on `ledger` (Q9). An open contract that accounts by `collectFees`'
 * return value loses its share to a stranger's `settle`, which lands it in a pull balance instead (round 9 RSEC-1).
 */
export async function namedPayeeOk(
  client: ReadClient,
  ledger: Address,
  account: Address,
): Promise<{ contract: boolean; ok: boolean }> {
  const code = await getCode(client, { address: account });
  if (!hasCode(code) || isDelegatedEoa(code))
    return { contract: false, ok: true };
  if (await isSafe(client, account)) return { contract: false, ok: true };
  const restricted = await readContract(client, {
    address: ledger,
    abi: bankrFeeLedgerAbi,
    functionName: "claimRestricted",
    args: [account],
  });
  return { contract: true, ok: restricted };
}

/** Why an open contract recipient is refused at launch: the factory's `OpenContractFeeRecipient`. */
export const RESTRICT_OR_WAIVE =
  "The recipient is a contract that lets anyone claim for it. It restricts its claims first (it calls the fee ledger's setClaimRestricted(true)), or the launch sets allowOpenCodeFeeRecipients, which waives the rule for every recipient.";

/** Why a Bankr launch contract is refused as a recipient: the factory's `isSuite` holds every one, and none can claim. */
const BANKR_LAUNCH_CONTRACT =
  "A Bankr launch contract (the factory, ledger, hook or another of Bankr's own contracts, a launched token, its vesting escrow or holder distributor) can never claim fees.";

/** Why a launch's `quote` is refused as its recipient: the ledger's `InvalidBeneficiary` for a pool's own currency,
 *  which the launch's open-code waiver does not lift. */
const QUOTE_TOKEN_RECIPIENT =
  "The recipient is this launch's quote token, and a token's own contract could never collect its share, whatever the launch waives. Use a wallet address.";

/**
 * The claim-capability refusal: `FEE_RECIPIENT_CANNOT_CLAIM` for a recipient the factory refuses (the sentinel
 * family, any of `deadEnds`, anything its `isSuite` holds) and for a contract that may never call the ledger's
 * `collectFees` (a passive split wallet strands its share). An EOA, an EIP-7702 wallet and a Safe can claim;
 * `allowContract` admits a contract only once it restricted its claim policy on `ledger` (round 9 RSEC-1).
 * `launch`: the factory also holds a launch's own recipients, a Safe included, to restricted claims unless `allowOpen`.
 */
export async function refuseUnclaimableRecipient(
  client: ReadClient,
  chain: LaunchChain,
  recipient: Address,
  deadEnds: readonly Address[],
  allowContract: boolean,
  ledger: Address,
  factory: Address,
  launch?: { allowOpen: boolean; quote: Address },
): Promise<void> {
  const refuse = (detail?: string): never => {
    throw new LaunchRefusedError("FEE_RECIPIENT_CANNOT_CLAIM", {
      chain,
      detail,
    });
  };
  if (launch && isAddressEqual(launch.quote, recipient))
    refuse(QUOTE_TOKEN_RECIPIENT);
  if (
    isSentinel(recipient) ||
    deadEnds.some((d) => isAddressEqual(d, recipient))
  ) {
    refuse();
  }
  const code = await getCode(client, { address: recipient });
  if (!hasCode(code) || isDelegatedEoa(code)) return;
  const [suite, safe] = await Promise.all([
    readContract(client, {
      address: factory,
      abi: bankrLaunchFactoryAbi,
      functionName: "isSuite",
      args: [recipient],
    }),
    isSafe(client, recipient),
  ]);
  if (suite) refuse(BANKR_LAUNCH_CONTRACT);
  if (safe && !launch) return;
  if (!safe && !allowContract) refuse();
  if (launch?.allowOpen) return;
  const restricted = await readContract(client, {
    address: ledger,
    abi: bankrFeeLedgerAbi,
    functionName: "claimRestricted",
    args: [recipient],
  });
  if (!restricted) refuse(launch ? RESTRICT_OR_WAIVE : RESTRICT_CONTRACT_FIRST);
}
