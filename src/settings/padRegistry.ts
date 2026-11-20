import {
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  stringToBytes,
  zeroAddress,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import { LaunchExecutionError } from "../errors.js";
import { checkPadVanity, vanityHex, vanityMask } from "../launchpadRules.js";
import type { Vanity } from "../salt.js";
import { BANKR_PAD, MAX_UINT64, type SettingsKit } from "./context.js";
import type { LaunchpadAdmin } from "./launchpads.js";
import { payeeTerms, refuseRejectedPayees } from "./padChanges.js";
import type { SettingsReaders } from "./readers.js";
import { newPayeesProblem } from "./rules.js";

type PadRegistryBuilders = Pick<
  LaunchpadAdmin,
  | "register"
  | "launchpadIdFromReceipt"
  | "setSigner"
  | "setVanity"
  | "setMetadataUri"
  | "setPaused"
  | "transferOperator"
  | "acceptOperator"
>;

/** `vanityOwner`'s id for a suffix Bankr revoked and holds until it names the pad that may take it. */
const VANITY_HELD = MAX_UINT64;

/** A pad's identity in the launchpad registry, each change from its operator (Bankr's pad: the registry's owner). */
export function padRegistryBuilders(
  kit: SettingsKit,
  r: SettingsReaders,
): PadRegistryBuilders {
  const { client, registry, addresses: a, padRule } = kit;
  const toRegistry = async (id: bigint, data: Hex) =>
    kit.call(await kit.registryOperator(id), a.launchpadRegistry, data);

  async function checkUri(uri: unknown): Promise<string> {
    if (typeof uri !== "string") kit.invalid("A metadata URI is a string.");
    const most = await readContract(client, {
      ...registry,
      functionName: "maxPadUriBytes",
    });
    if (stringToBytes(uri).length > most)
      padRule(`A launchpad's link is at most ${most} bytes.`);
    return uri;
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
      padRule(
        owner === VANITY_HELD
          ? `${vanityHex(v)} ends in ${vanityHex(t)}, which Bankr's registry holds.`
          : `${vanityHex(v)} is not free: launchpad ${owner} owns ${vanityHex(t)}.`,
      );
    });
  }

  return {
    async register(input) {
      const from = kit.address(input?.operator, "The operator");
      const signer =
        input.signer === undefined
          ? zeroAddress
          : kit.address(input.signer, "The signer", true);
      const terms = payeeTerms(kit, input.payees, undefined, false);
      const [uri, bond, protocol, limits] = await Promise.all([
        checkUri(input.metadataUri ?? ""),
        readContract(client, {
          ...registry,
          functionName: "registrationBondWei",
        }),
        r.protocol(),
        r.limits(),
      ]);
      const problem = newPayeesProblem(
        terms,
        protocol.maxPadPayees,
        limits.padShareBps.max,
      );
      if (problem) padRule(problem);
      await refuseRejectedPayees(kit, terms.payees, padRule);
      return {
        ...kit.call(
          from,
          a.launchpadRegistry,
          encodeFunctionData({
            abi: registry.abi,
            functionName: "register",
            args: [signer, terms.payees, terms.steadySharesWad, uri],
          }),
        ),
        value: bond,
      };
    },

    launchpadIdFromReceipt(receipt) {
      const ids = parseEventLogs({
        abi: registry.abi,
        eventName: "LaunchpadRegistered",
        logs: receipt.logs.filter((log) => !log.removed),
        strict: true,
      })
        .filter((log) => isAddressEqual(log.address, a.launchpadRegistry))
        .map((log) => log.args.id);
      if (ids.length !== 1) {
        throw new LaunchExecutionError("RECEIPT_MISSING_LAUNCHPAD", {
          chain: kit.chain,
          transactionHash: receipt.transactionHash,
        });
      }
      return ids[0]!;
    },
    async setSigner(id, signer) {
      const n = kit.requireId(id);
      const s =
        signer === null ? zeroAddress : kit.address(signer, "The signer", true);
      return toRegistry(
        n,
        encodeFunctionData({
          abi: registry.abi,
          functionName: "setSigner",
          args: [n, s],
        }),
      );
    },

    async setVanity(id, vanity) {
      const n = kit.requireId(id);
      const next = checkPadVanity(n, vanity, kit.chain);
      const [tx] = await Promise.all([
        toRegistry(
          n,
          encodeFunctionData({
            abi: registry.abi,
            functionName: "setVanity",
            args: [n, next],
          }),
        ),
        refuseTakenVanity(n, next),
      ]);
      return tx;
    },

    async setMetadataUri(id, uri) {
      const n = kit.requireId(id);
      const u = await checkUri(uri);
      return toRegistry(
        n,
        encodeFunctionData({
          abi: registry.abi,
          functionName: "setMetadataUri",
          args: [n, u],
        }),
      );
    },

    async setPaused(id, paused) {
      const n = kit.requireId(id);
      const p = kit.flag(paused, "paused");
      return toRegistry(
        n,
        encodeFunctionData({
          abi: registry.abi,
          functionName: "setPaused",
          args: [n, p],
        }),
      );
    },

    async transferOperator(id, next) {
      const n = kit.requireId(id);
      if (n === BANKR_PAD)
        padRule(
          "Bankr's launchpad (id 0) does not take a new operator: it moves with the registry's ownership.",
        );
      const to = kit.address(next, "The new operator");
      return toRegistry(
        n,
        encodeFunctionData({
          abi: registry.abi,
          functionName: "transferOperator",
          args: [n, to],
        }),
      );
    },

    async acceptOperator(id) {
      const n = kit.requireId(id);
      await kit.requireRegistered(n);
      const pad = await readContract(client, {
        ...registry,
        functionName: "getLaunchpad",
        args: [n],
      });
      if (isAddressEqual(pad.pendingOperator, zeroAddress))
        padRule(
          "No operator handover is pending on this launchpad: its operator sends transferOperator first.",
        );
      return kit.call(
        pad.pendingOperator,
        a.launchpadRegistry,
        encodeFunctionData({
          abi: registry.abi,
          functionName: "acceptOperator",
          args: [n],
        }),
      );
    },
  };
}
