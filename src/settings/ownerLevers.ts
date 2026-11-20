import {
  encodeFunctionData,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { getCode, readContract } from "viem/actions";
import { bankrFeeLedgerAbi, bankrLaunchSettingsAbi } from "../abis/settings.js";
import { vanityHex, vanityMask } from "../launchpadRules.js";
import type { UnsignedTx } from "../providers/types.js";
import { hasCode } from "../recipient.js";
import type { Vanity } from "../salt.js";
import {
  MAX_UINT64,
  settingsKit,
  type SettingsContext,
  type SettingsKit,
} from "./context.js";

/**
 * The owner's levers on the factory and the launchpad registry, unsigned. The factory's come from its owner, the
 * registry's from the registry's own owner: one key unless the two ownerships are moved apart, and Bankr's pad
 * answers to both, so move them together. A broken rule is `INVALID_SETTINGS` with a `detail`.
 */
export interface OwnerLeversAdmin {
  /** A new hook generation for future launches; pools stay on the generation they launched on. */
  setHook(hook: Address): Promise<UnsignedTx>;
  /** A new holder leg generation for future launches. A coin keeps the leg of its launch, and a leg is named
   *  once: there is no way back to an earlier one. */
  setHolderLeg(leg: Address): Promise<UnsignedTx>;
  /** Bankr's half of future quotes' buckets, the bond payee and the ledger's protocol sink, at once. */
  setTreasury(treasury: Address): Promise<UnsignedTx>;
  /** Pauses or resumes every new launch. Holder-leg conversions go on. */
  setPaused(paused: boolean): Promise<UnsignedTx>;
  /** On: only Bankr's own pad launches. Off: every pad launches under its own rules. */
  setLaunchGated(gated: boolean): Promise<UnsignedTx>;
  /** Starts the factory's two-step handover; `next` sends `acceptOwnership`. It carries the settings contract.
   *  null cancels a pending handover: the owner stays. */
  transferOwnership(next: Address | null): Promise<UnsignedTx>;
  /** From the factory's pending owner. */
  acceptOwnership(): Promise<UnsignedTx>;
  /** The bond a new launchpad pays; 0 is free registration. */
  setRegistrationBond(wei: bigint): Promise<UnsignedTx>;
  /** The longest link a launchpad may store, in bytes. A stored link stands. */
  setMaxPadUriBytes(bytes: number): Promise<UnsignedTx>;
  /** Signs every launch on Bankr's pad; null refuses them all. */
  setBankrSigner(signer: Address | null): Promise<UnsignedTx>;
  /** The verified badge: an off-chain mark with no effect on chain. */
  setVerified(id: bigint, verified: boolean): Promise<UnsignedTx>;
  /** Takes a pad's suffix away. The registry holds it until `assignVanity` names the pad that may take it. */
  revokeVanity(id: bigint): Promise<UnsignedTx>;
  /** Lets pad `id` alone claim a held suffix, through its own `setVanity`. The suffix is the one revoked, of
   *  any length a pad held: Bankr's own has three digits. */
  assignVanity(vanity: Vanity, id: bigint): Promise<UnsignedTx>;
  /** Starts the registry's own two-step handover; it carries Bankr's pad's registry levers. null cancels a
   *  pending one. */
  transferRegistryOwnership(next: Address | null): Promise<UnsignedTx>;
  /** From the registry's pending owner. */
  acceptRegistryOwnership(): Promise<UnsignedTx>;
}

/** The owner's factory and registry levers for one chain's contracts. */
export function createOwnerLeversAdmin(ctx: SettingsContext): OwnerLeversAdmin {
  const kit: SettingsKit = settingsKit(ctx);
  const { client, factory, registry, addresses: a, ownerRule } = kit;
  const toFactory = async (data: Hex) =>
    kit.call(await kit.owner(), a.factory, data);
  const toRegistry = async (data: Hex) =>
    kit.call(await kit.registryOwner(), a.launchpadRegistry, data);

  async function contract(value: unknown, what: string): Promise<Address> {
    const at = kit.address(value, what);
    if (!hasCode(await getCode(client, { address: at })))
      ownerRule(`${what} has no code at ${at}.`);
    return at;
  }

  /** Ownable2Step takes the zero address as "nobody pending": the way to call a handover off. */
  const nextOwner = (next: Address | null): Address =>
    next === null ? zeroAddress : kit.address(next, "The new owner");

  /** The pending owner of `target`, which alone may accept; refused when none is pending. */
  async function pending(of: "factory" | "registry"): Promise<Address> {
    const who =
      of === "factory"
        ? await readContract(client, {
            ...factory,
            functionName: "pendingOwner",
          })
        : await readContract(client, {
            ...registry,
            functionName: "pendingOwner",
          });
    if (isAddressEqual(who, zeroAddress))
      ownerRule(
        "No ownership handover is pending: the owner sends the transfer first.",
      );
    return who;
  }

  return {
    setHook: async (hook) =>
      toFactory(
        encodeFunctionData({
          abi: factory.abi,
          functionName: "setHook",
          args: [await contract(hook, "The hook")],
        }),
      ),

    async setHolderLeg(leg) {
      const at = await contract(leg, "The holder leg");
      const id = await readContract(client, {
        address: a.ledger,
        abi: bankrFeeLedgerAbi,
        functionName: "legIdOf",
        args: [at],
      });
      if (id !== 0)
        ownerRule(
          `This leg is the ledger's leg ${id} already: a leg is named once. Deploy a new generation to name.`,
        );
      return toFactory(
        encodeFunctionData({
          abi: factory.abi,
          functionName: "setHolderLeg",
          args: [at],
        }),
      );
    },

    async setTreasury(treasury) {
      const to = kit.address(treasury, "The treasury");
      const [ours, named] = await Promise.all([
        readContract(client, {
          ...factory,
          functionName: "isSuite",
          args: [to],
        }),
        readContract(client, {
          address: a.settings,
          abi: bankrLaunchSettingsAbi,
          functionName: "namedAs",
          args: [to],
        }),
      ]);
      if (ours || (named & 1n) !== 0n)
        ownerRule(
          "The treasury is never one of Bankr's launch contracts or a quote ever listed: nothing could spend what is pushed there.",
        );
      return toFactory(
        encodeFunctionData({
          abi: factory.abi,
          functionName: "setTreasury",
          args: [to],
        }),
      );
    },

    setPaused: async (paused) =>
      toFactory(
        encodeFunctionData({
          abi: factory.abi,
          functionName: "setPaused",
          args: [kit.flag(paused, "paused")],
        }),
      ),

    setLaunchGated: async (gated) =>
      toFactory(
        encodeFunctionData({
          abi: factory.abi,
          functionName: "setLaunchGated",
          args: [kit.flag(gated, "gated")],
        }),
      ),

    transferOwnership: async (next) =>
      toFactory(
        encodeFunctionData({
          abi: factory.abi,
          functionName: "transferOwnership",
          args: [nextOwner(next)],
        }),
      ),

    acceptOwnership: async () =>
      kit.call(
        await pending("factory"),
        a.factory,
        encodeFunctionData({
          abi: factory.abi,
          functionName: "acceptOwnership",
        }),
      ),

    setRegistrationBond: async (wei) =>
      toRegistry(
        encodeFunctionData({
          abi: registry.abi,
          functionName: "setRegistrationBond",
          args: [kit.uint(wei, 2n ** 256n - 1n, "The bond")],
        }),
      ),

    setMaxPadUriBytes: async (bytes) =>
      toRegistry(
        encodeFunctionData({
          abi: registry.abi,
          functionName: "setMaxPadUriBytes",
          args: [Number(kit.uint(bytes, 0xffff_ffffn, "The byte limit"))],
        }),
      ),

    setBankrSigner: async (signer) =>
      toRegistry(
        encodeFunctionData({
          abi: registry.abi,
          functionName: "setBankrSigner",
          args: [
            signer === null
              ? zeroAddress
              : kit.address(signer, "Bankr's signer", true),
          ],
        }),
      ),

    async setVerified(id, verified) {
      const n = kit.requireId(id);
      await kit.requireRegistered(n);
      return toRegistry(
        encodeFunctionData({
          abi: registry.abi,
          functionName: "setVerified",
          args: [n, kit.flag(verified, "verified")],
        }),
      );
    },

    async revokeVanity(id) {
      const n = kit.requireId(id);
      await kit.requireRegistered(n);
      const pad = await readContract(client, {
        ...registry,
        functionName: "getLaunchpad",
        args: [n],
      });
      if (pad.vanity.nibbles === 0)
        ownerRule("This launchpad has no vanity suffix to revoke.");
      return toRegistry(
        encodeFunctionData({
          abi: registry.abi,
          functionName: "revokeVanity",
          args: [n],
        }),
      );
    },

    async assignVanity(vanity, id) {
      const n = kit.requireId(id);
      // Any length a pad held, Bankr's three digits included: the registry asks only that the suffix is held.
      if (typeof vanity !== "object" || vanity === null)
        kit.invalid("A vanity is { suffix, nibbles }.");
      const nibbles = Number(kit.uint(vanity.nibbles, 6n, "nibbles"));
      const v: Vanity = {
        nibbles,
        suffix: Number(
          kit.uint(vanity.suffix, BigInt(vanityMask(nibbles)), "suffix"),
        ),
      };
      const [, [owned, owner]] = await Promise.all([
        kit.requireRegistered(n),
        readContract(client, {
          ...registry,
          functionName: "vanityOwner",
          args: [v.suffix, v.nibbles],
        }),
      ]);
      if (!owned || owner !== MAX_UINT64)
        ownerRule(
          `${vanityHex(v)} is not a suffix the registry holds: only a revoked suffix is assigned.`,
        );
      return toRegistry(
        encodeFunctionData({
          abi: registry.abi,
          functionName: "assignVanity",
          args: [v.suffix, v.nibbles, n],
        }),
      );
    },

    transferRegistryOwnership: async (next) =>
      toRegistry(
        encodeFunctionData({
          abi: registry.abi,
          functionName: "transferOwnership",
          args: [nextOwner(next)],
        }),
      ),

    acceptRegistryOwnership: async () =>
      kit.call(
        await pending("registry"),
        a.launchpadRegistry,
        encodeFunctionData({
          abi: registry.abi,
          functionName: "acceptOwnership",
        }),
      ),
  };
}
