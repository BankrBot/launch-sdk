import {
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { readContract } from "viem/actions";
import {
  bankrLaunchFactoryAbi,
  bankrLaunchpadRegistryAbi,
} from "./abis/suite3.js";
import { ANY_CURVE } from "./curve.js";
import { padAllowsCurve } from "./curveDetail.js";
import { curveKey, type CurveKeyInput } from "./curveInput.js";
import {
  LaunchExecutionError,
  LaunchRefusedError,
  type CodeOfKind,
} from "./errors.js";
import {
  BANKR_LAUNCHPAD_ID,
  PAD_TREASURY_MARKER,
  requireRegisteredPad,
  type Launchpad,
  type LaunchpadFeeBounds,
  type LaunchpadPolicy,
} from "./launchpad.js";
import {
  checkPadFeeBounds,
  checkPadMetadataUri,
  checkPadVanity,
  mergePadPolicy,
  padPayeeTerms,
  requireFlag,
  requirePadAddress,
  vanityHex,
  vanityMask,
} from "./launchpadRules.js";
import type { SuiteReadContext } from "./lens.js";
import type { UnsignedTx } from "./providers/types.js";
import {
  RESTRICT_CONTRACT_FIRST,
  isSentinel,
  namedPayeeOk,
  requireAddress,
} from "./recipient.js";
import type { Vanity } from "./salt.js";
import { buildCallTx } from "./tx.js";

// The launchpad registry's operator calls as unsigned transactions, from the account the registry requires. The
// rules a call breaks are refused first (launchpadRules.ts); the ones that need the chain are read here.

const MAX_UINT64 = 2n ** 64n - 1n;
/** `vanityOwner`'s id for a suffix Bankr revoked and holds until it names the pad that may take it. */
const VANITY_HELD = MAX_UINT64;

/** A pad payee and its share of each fee's remainder: what is left after Bankr's slice and any referrer. */
export interface LaunchpadPayee {
  address: Address;
  /** 0–9,500 bps of the remainder; every payee's together at most 9,500 (95 %). */
  shareBps: number;
}

/** A payee for `setPayees`. Any `decayShareBps` (or `decayAutoLpBps`) turns the pad's decay split on. */
export interface LaunchpadPayeeWithDecay extends LaunchpadPayee {
  /** Its share of the decay window's surplus above the steady fee, 0–9,500 bps (together at most 9,500); default 0. */
  decayShareBps?: number;
}

/** {@link LaunchpadOperations.register}. */
export interface RegisterLaunchpadInput {
  /** The account that sends the registration and becomes the pad's operator: an EOA or a Safe. */
  operator: Address;
  /** Signs every launch on the pad. Omitted or the zero address: an open pad, launched without an authorization. */
  signer?: Address;
  /** 1–4 distinct payees. A new pad has no decay split; `setPayees` turns one on. */
  payees: readonly LaunchpadPayee[];
  /** The pad's branding, at most 2,048 bytes. Default empty. */
  metadataUri?: string;
}

/** {@link LaunchpadOperations.setPayees}. */
export interface SetPayeesOptions {
  /**
   * Auto-LP's bps (0–10,000) of the decay surplus the payees leave; the creator takes the rest. Setting it turns
   * the decay split on (default 0 when a payee's `decayShareBps` turns it on).
   */
  decayAutoLpBps?: number;
}

/** {@link LaunchpadOperations.setPolicy}. */
export interface SetPolicyOptions {
  /**
   * The policy the change was meant for, e.g. `client.launchpad(id).policy` as read when it was built. A live policy
   * that differs throws `STALE_POLICY`: rebuild a queued setPolicy this way before it runs. Each field is compared by
   * its decimal or `true`/`false` spelling, so a base stored as JSON (bigints as strings or numbers) still matches.
   */
  expectBasePolicy?: LaunchpadPolicy;
}

/**
 * A launchpad's operator transactions, unsigned: the operator's wallet or Safe sends each one; the SDK sends nothing.
 * Every call is checked against the registry's rules first (`INVALID_LAUNCHPAD_CONFIG` with a `detail`, or
 * `UNKNOWN_LAUNCHPAD`) and comes from the account the registry requires: the pad's live operator (id 0's is the
 * registry owner), or, for `acceptOperator`, its pending operator. Changes reach future launches only.
 */
export interface LaunchpadOperations {
  /**
   * `register`: a new pad, operated by `operator`. Its value is the registry's live `registrationBondWei`, paid to
   * Bankr's treasury and never refunded. Read the new id with `launchpadIdFromReceipt`.
   */
  register(input: RegisterLaunchpadInput): Promise<UnsignedTx>;
  /**
   * The id in a mined `register` receipt, from the registry's address; `RECEIPT_MISSING_LAUNCHPAD` otherwise. The
   * registry has that address on every chain and a receipt names none, so pass a receipt from this client's chain.
   */
  launchpadIdFromReceipt(receipt: TransactionReceipt): bigint;
  /** One set of bounds for buy and sell, inside the protocol's. Not on Bankr's pad (id 0). */
  setFeeBounds(id: bigint, bounds: LaunchpadFeeBounds): Promise<UnsignedTx>;
  /**
   * `changes` merged over the pad's live policy, then checked whole. The transaction carries the whole policy as read
   * now, so a second one built before this lands undoes it: make every change in one call.
   */
  setPolicy(
    id: bigint,
    changes: Partial<LaunchpadPolicy>,
    options?: SetPolicyOptions,
  ): Promise<UnsignedTx>;
  /**
   * The suffix every token on the pad ends in: 4–6 hex digits (`nibbles`), or `nibbles: 0` for none. Refused when
   * another pad owns it or one of its tails; a longer owned suffix that ends in it is caught on-chain only.
   */
  setVanity(id: bigint, vanity: Vanity): Promise<UnsignedTx>;
  /** The pad's launch signer; the zero address makes the pad open (on id 0, it stops every launch). */
  setSigner(id: bigint, signer: Address): Promise<UnsignedTx>;
  /** Replaces the payees and the decay split together. Not on Bankr's pad (id 0). */
  setPayees(
    id: bigint,
    payees: readonly LaunchpadPayeeWithDecay[],
    options?: SetPayeesOptions,
  ): Promise<UnsignedTx>;
  setMetadataUri(id: bigint, uri: string): Promise<UnsignedTx>;
  setPaused(id: bigint, paused: boolean): Promise<UnsignedTx>;
  /** Narrows the pad to listed quotes (none listed: every factory quote); allowing needs a quote the factory allows. */
  setQuoteAllowed(
    id: bigint,
    quote: Address,
    allowed: boolean,
  ): Promise<UnsignedTx>;
  /**
   * Allows or refuses one curve on the pad: a built-in (on until refused), a launcher's own bands (off until listed),
   * or `"any"` bands a launcher defines (off until allowed). Bands the pad admits still meet the pool's own rules.
   */
  setCurveAllowed(
    id: bigint,
    curve: CurveKeyInput,
    allowed: boolean,
  ): Promise<UnsignedTx>;
  /**
   * Whether a launch with `curve` passes the pad's key now: a built-in it left on, bands it listed, or any bands
   * when it is open to them. `"any"` reads that last switch alone.
   */
  isCurveAllowed(id: bigint, curve: CurveKeyInput): Promise<boolean>;
  /** Starts a two-step handover to `next`, who sends `acceptOperator`. Not on id 0: it moves with the registry. */
  transferOperator(id: bigint, next: Address): Promise<UnsignedTx>;
  /** From the pending operator a `transferOperator` named. */
  acceptOperator(id: bigint): Promise<UnsignedTx>;
}

/**
 * The registry's `setCurveAllowed(launchpadId, key, allowed)` from the pad's `operator`, with no chain read
 * (`client.launchpads.setCurveAllowed` reads the live operator). `INVALID_PARAMS` for a key no launch could carry.
 */
export function buildSetCurveAllowed(i: {
  chainId: number;
  registry: Address;
  operator: Address;
  launchpadId: bigint;
  curve: CurveKeyInput;
  allowed: boolean;
}): UnsignedTx {
  const key = curveKey(i.curve, (detail) => {
    throw new LaunchRefusedError("INVALID_PARAMS", { detail });
  });
  return buildCallTx(
    i.chainId,
    i.operator,
    i.registry,
    encodeFunctionData({
      abi: bankrLaunchpadRegistryAbi,
      functionName: "setCurveAllowed",
      args: [i.launchpadId, key, i.allowed],
    }),
  );
}

/** The launchpad namespace for one chain's suite: no wallet needed, and it works on any chain with a record. */
export function createLaunchpads(ctx: SuiteReadContext): LaunchpadOperations {
  const { addresses: a, client } = ctx;
  const chain = ctx.chain.chain;
  const abi = bankrLaunchpadRegistryAbi;
  const registry = { address: a.launchpadRegistry, abi } as const;

  function refuse(code: CodeOfKind<"refused">, detail?: string): never {
    throw new LaunchRefusedError(code, { chain, detail });
  }

  function invalid(detail: string): never {
    refuse("INVALID_LAUNCHPAD_CONFIG", detail);
  }

  const call = (from: Address, data: Hex) =>
    buildCallTx(ctx.chain.chainId, from, a.launchpadRegistry, data);

  const requireId = (id: unknown): bigint =>
    typeof id === "bigint" && id >= 0n && id <= MAX_UINT64
      ? id
      : refuse("INVALID_PARAMS", "A launchpad id is a bigint, such as 1n.");

  /** Id 0's payees and fee bounds move together, through Bankr's preset; it changes operator only with the registry. */
  const notBankrPad = (id: bigint, what: string): void => {
    if (id === BANKR_LAUNCHPAD_ID) {
      invalid(`Bankr's launchpad (id 0) does not take ${what}.`);
    }
  };

  const requireSigner = (value: unknown): Address =>
    requireAddress(value, chain, "The signer", true);

  /** The pad's live configuration; `UNKNOWN_LAUNCHPAD` past the last registered id. */
  async function readLive(id: bigint): Promise<Launchpad> {
    const count = await readContract(client, {
      ...registry,
      functionName: "launchpadCount",
    });
    if (id > count) refuse("UNKNOWN_LAUNCHPAD");
    return readContract(client, {
      ...registry,
      functionName: "getLaunchpad",
      args: [id],
    });
  }

  /** An operator call on pad `id`, from its live operator (id 0's is the registry owner). */
  async function fromOperator(id: bigint, data: Hex): Promise<UnsignedTx> {
    const pad = await readLive(id);
    return call(pad.operator, data);
  }

  /**
   * The factory refuses a suite contract, a launched token or a routing marker as a pad payee at every launch
   * (`LaunchpadPayeeRejected`), so such a pad could never launch; the treasury marker alone is a payee a pad may name.
   */
  async function refuseRejectedPayees(
    payees: readonly Address[],
  ): Promise<void> {
    const rejected = await Promise.all(
      payees.map(async (p) =>
        isAddressEqual(p, PAD_TREASURY_MARKER)
          ? false
          : isSentinel(p) ||
            readContract(client, {
              address: a.factory,
              abi: bankrLaunchFactoryAbi,
              functionName: "isSuite",
              args: [p],
            }),
      ),
    );
    const bad = payees.find((_, i) => rejected[i]);
    if (bad) {
      invalid(
        `${bad} cannot be a payee: the factory refuses a Bankr suite contract, a launched token or a routing marker, so no launch on the pad would go through.`,
      );
    }
    // Round 9 RSEC-1: as a fee recipient, a contract payee is a Safe, a 7702 wallet or restricted (Q9).
    const named = await Promise.all(
      payees.map((p) =>
        isAddressEqual(p, PAD_TREASURY_MARKER)
          ? { contract: false, ok: true }
          : namedPayeeOk(client, a.ledger, p),
      ),
    );
    const open = payees.find((_, i) => !named[i]!.ok);
    if (open) invalid(`Payee ${open}: ${RESTRICT_CONTRACT_FIRST}`);
  }

  /** `_setVanity`'s prefix-free test on the suffix and its tails; the pad's own old suffix is released first. */
  async function refuseTakenVanity(id: bigint, v: Vanity): Promise<void> {
    const tails = Array.from({ length: v.nibbles }, (_, i) => ({
      suffix: v.suffix & vanityMask(i + 1),
      nibbles: i + 1,
    }));
    const owners = await Promise.all(
      tails.map((t) =>
        readContract(client, {
          ...registry,
          functionName: "vanityOwner",
          args: [t.suffix, t.nibbles],
        }),
      ),
    );
    tails.forEach((t, i) => {
      const [owned, owner] = owners[i]!;
      // A held suffix is its designee's to take, which only the registry knows; a held tail is taken.
      const free =
        !owned ||
        owner === id ||
        (owner === VANITY_HELD && t.nibbles === v.nibbles);
      if (free) return;
      invalid(
        owner === VANITY_HELD
          ? `${vanityHex(v)} ends in ${vanityHex(t)}, which Bankr's registry holds.`
          : `${vanityHex(v)} is not free: launchpad ${owner} owns ${vanityHex(t)}.`,
      );
    });
  }

  return {
    async register(input) {
      const from = requireAddress(input?.operator, chain, "The operator");
      const signer =
        input.signer === undefined ? zeroAddress : requireSigner(input.signer);
      const uri = checkPadMetadataUri(input.metadataUri ?? "", chain);
      const t = padPayeeTerms(input.payees, undefined, false, chain);
      const [bond] = await Promise.all([
        readContract(client, {
          ...registry,
          functionName: "registrationBondWei",
        }),
        refuseRejectedPayees(t.payees),
      ]);
      return {
        ...call(
          from,
          encodeFunctionData({
            abi,
            functionName: "register",
            args: [signer, t.payees, t.steadySharesWad, uri],
          }),
        ),
        value: bond,
      };
    },

    launchpadIdFromReceipt(receipt) {
      const ids = parseEventLogs({
        abi,
        eventName: "LaunchpadRegistered",
        logs: receipt.logs.filter((log) => !log.removed),
        strict: true,
      })
        .filter((log) => isAddressEqual(log.address, a.launchpadRegistry))
        .map((log) => log.args.id);
      if (ids.length !== 1) {
        throw new LaunchExecutionError("RECEIPT_MISSING_LAUNCHPAD", {
          chain,
          transactionHash: receipt.transactionHash,
        });
      }
      return ids[0]!;
    },

    async setFeeBounds(id, bounds) {
      const n = requireId(id);
      notBankrPad(n, "new fee bounds");
      const b = checkPadFeeBounds(bounds, chain);
      return fromOperator(
        n,
        encodeFunctionData({ abi, functionName: "setFeeBounds", args: [n, b] }),
      );
    },

    async setPolicy(id, changes, options = {}) {
      const n = requireId(id);
      const want: unknown = options.expectBasePolicy;
      if (
        want !== undefined &&
        (typeof want !== "object" || want === null || Array.isArray(want))
      ) {
        refuse(
          "INVALID_PARAMS",
          "expectBasePolicy is a LaunchpadPolicy, such as client.launchpad(id).policy.",
        );
      }
      const pad = await readLive(n);
      const live = pad.policy as Readonly<Record<string, unknown>>;
      if (
        want !== undefined &&
        !Object.keys(live).every(
          (k) =>
            String(live[k]) === String((want as Record<string, unknown>)[k]),
        )
      ) {
        throw new LaunchExecutionError("STALE_POLICY", { chain });
      }
      const policy = mergePadPolicy(pad.policy, changes, chain);
      return call(
        pad.operator,
        encodeFunctionData({
          abi,
          functionName: "setPolicy",
          args: [n, policy],
        }),
      );
    },

    async setVanity(id, v) {
      const n = requireId(id);
      const next = checkPadVanity(n, v, chain);
      const pad = await readLive(n);
      await refuseTakenVanity(n, next);
      return call(
        pad.operator,
        encodeFunctionData({ abi, functionName: "setVanity", args: [n, next] }),
      );
    },

    async setSigner(id, signer) {
      const n = requireId(id);
      const s = requireSigner(signer);
      return fromOperator(
        n,
        encodeFunctionData({ abi, functionName: "setSigner", args: [n, s] }),
      );
    },

    async setPayees(id, payees, options = {}) {
      const n = requireId(id);
      notBankrPad(n, "new payees");
      const t = padPayeeTerms(payees, options.decayAutoLpBps, true, chain);
      const pad = await readLive(n);
      await refuseRejectedPayees(t.payees);
      return call(
        pad.operator,
        encodeFunctionData({
          abi,
          functionName: "setPayees",
          args: [n, t.payees, t.steadySharesWad, t.decay],
        }),
      );
    },

    async setMetadataUri(id, uri) {
      const n = requireId(id);
      const u = checkPadMetadataUri(uri, chain);
      return fromOperator(
        n,
        encodeFunctionData({
          abi,
          functionName: "setMetadataUri",
          args: [n, u],
        }),
      );
    },

    async setPaused(id, paused) {
      const n = requireId(id);
      const p = requireFlag(paused, "paused", chain);
      return fromOperator(
        n,
        encodeFunctionData({ abi, functionName: "setPaused", args: [n, p] }),
      );
    },

    async setQuoteAllowed(id, quote, allowed) {
      const n = requireId(id);
      const q = requireAddress(quote, chain, "The quote");
      const on = requireFlag(allowed, "allowed", chain);
      // Any pad but Bankr's may name any quote (any-quote pairing); id 0 names only the factory's.
      const [pad, entry] = await Promise.all([
        readLive(n),
        on && n === BANKR_LAUNCHPAD_ID
          ? readContract(client, {
              address: a.factory,
              abi: bankrLaunchFactoryAbi,
              functionName: "quoteEntry",
              args: [q],
            })
          : null,
      ]);
      if (entry && !entry.allowed) {
        invalid("A launchpad can allow only a quote the factory allows.");
      }
      return call(
        pad.operator,
        encodeFunctionData({
          abi,
          functionName: "setQuoteAllowed",
          args: [n, q, on],
        }),
      );
    },

    async setCurveAllowed(id, curve, allowed) {
      const n = requireId(id);
      const key = curveKey(curve, (detail) => refuse("INVALID_PARAMS", detail));
      const on = requireFlag(allowed, "allowed", chain);
      const pad = await readLive(n);
      return buildSetCurveAllowed({
        chainId: ctx.chain.chainId,
        registry: a.launchpadRegistry,
        operator: pad.operator,
        launchpadId: n,
        curve: key,
        allowed: on,
      });
    },

    async isCurveAllowed(id, curve) {
      const n = requireId(id);
      const key = curveKey(curve, (detail) => refuse("INVALID_PARAMS", detail));
      const read = (k: bigint) =>
        readContract(client, {
          ...registry,
          functionName: "isCurveAllowed",
          args: [n, k],
        });
      // The registry answers for any id; an unregistered one is refused here, as every other read does.
      const [, listed, anyBands] = await Promise.all([
        requireRegisteredPad(client, a.launchpadRegistry, n, chain),
        read(key),
        key === ANY_CURVE ? false : read(ANY_CURVE),
      ]);
      return padAllowsCurve(key, { listed, anyBands });
    },

    async transferOperator(id, next) {
      const n = requireId(id);
      notBankrPad(n, "a new operator: it moves with the registry's ownership");
      const to = requirePadAddress(next, "The new operator", chain);
      return fromOperator(
        n,
        encodeFunctionData({
          abi,
          functionName: "transferOperator",
          args: [n, to],
        }),
      );
    },

    async acceptOperator(id) {
      const n = requireId(id);
      const pad = await readLive(n);
      if (isAddressEqual(pad.pendingOperator, zeroAddress)) {
        invalid(
          "No operator handover is pending on this launchpad: its operator sends transferOperator first.",
        );
      }
      return call(
        pad.pendingOperator,
        encodeFunctionData({ abi, functionName: "acceptOperator", args: [n] }),
      );
    },
  };
}
