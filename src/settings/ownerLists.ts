import {
  BaseError,
  ContractFunctionZeroDataError,
  encodeFunctionData,
  erc20Abi,
  isHex,
  size,
  zeroAddress,
  zeroHash,
  type Hex,
} from "viem";
import { readContract } from "viem/actions";
import type { UnsignedTx } from "../providers/types.js";
import { isContractRevert } from "../simulate.js";
import { MAX_UINT64, type SettingsKit } from "./context.js";
import { presetId } from "./names.js";
import type { OwnerSettingsAdmin } from "./owner.js";
import type { SettingsReaders } from "./readers.js";
import {
  PRICING_MODE,
  presetRecordProblem,
  quoteTermsProblem,
  type PresetRecord,
  type PricingModeName,
  type QuoteTerms,
} from "./rules.js";

type OwnerListBuilders = Pick<
  OwnerSettingsAdmin,
  | "setQuote"
  | "removeQuote"
  | "setPriceSigner"
  | "setSequencerUptimeFeed"
  | "setPreset"
  | "setExtensionAllowed"
  | "setBnkrPairWaiver"
>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A call to an address with no code, or none of the function: viem's "returned no data". */
const isNoData = (error: unknown): boolean =>
  error instanceof BaseError &&
  error.walk((e) => e instanceof ContractFunctionZeroDataError) instanceof
    ContractFunctionZeroDataError;

function hash32(kit: SettingsKit, value: unknown, what: string): Hex {
  return isHex(value) && size(value) === 32
    ? value
    : kit.invalid(`${what} is 32 bytes of hex.`);
}

/** The owner's lists: quotes and their pricing, preset records, the extension allowlist, the BNKR-pair waiver. */
export function ownerListBuilders(
  kit: SettingsKit,
  r: SettingsReaders,
): OwnerListBuilders {
  const { client, ownerRule } = kit;
  const abi = r.s.abi;
  const send = async (data: Hex): Promise<UnsignedTx> =>
    kit.call(await kit.owner(), kit.addresses.settings, data);

  return {
    async setQuote(quote, changes) {
      const q = kit.address(quote, "The quote");
      if (!isRecord(changes))
        kit.invalid(
          "setQuote takes { pricing, maxPriceAge, feed, compoundFloor, compoundCap, quoteActivation, quotePaid }, any of them.",
        );
      const was = await r.quoteTerms(q);
      const pricing = changes.pricing;
      // Own names only: "constructor" is a key of every object.
      const mode =
        pricing === undefined
          ? was.mode
          : typeof pricing === "string" && Object.hasOwn(PRICING_MODE, pricing)
            ? PRICING_MODE[pricing as PricingModeName]
            : kit.invalid('pricing is "none", "chainlink" or "signed".');
      const amount = (
        key: "compoundFloor" | "compoundCap" | "quoteActivation",
      ) =>
        changes[key] === undefined
          ? was[key]
          : kit.uint(changes[key], 2n ** 128n - 1n, key);
      // A row that was never listed has no decimals yet: the contract holds a priced row to the token's own.
      const decimals =
        changes.decimals !== undefined
          ? Number(kit.uint(changes.decimals, 255n, "decimals"))
          : was.allowed
            ? was.decimals
            : await readContract(client, {
                address: q,
                abi: erc20Abi,
                functionName: "decimals",
              }).catch((cause: unknown) =>
                // A failed request is thrown as it came; only a token with no answer is the caller's to fix.
                isContractRevert(cause) || isNoData(cause)
                  ? kit.invalid(
                      `${q} does not answer decimals(): check the quote's address, or name its decimals in the change.`,
                    )
                  : Promise.reject(cause),
              );
      const next: QuoteTerms = {
        allowed: true,
        mode,
        decimals,
        maxPriceAge:
          changes.maxPriceAge === undefined
            ? was.maxPriceAge
            : Number(
                kit.uint(changes.maxPriceAge, 0xffff_ffffn, "maxPriceAge"),
              ),
        feed:
          changes.feed === undefined
            ? was.feed
            : changes.feed === null
              ? zeroAddress
              : kit.address(changes.feed, "The feed", true),
        compoundFloor: amount("compoundFloor"),
        compoundCap: amount("compoundCap"),
        quoteActivation: amount("quoteActivation"),
        quotePaid:
          changes.quotePaid === undefined
            ? was.quotePaid
            : kit.flag(changes.quotePaid, "quotePaid"),
      };
      const problem = quoteTermsProblem(next);
      if (problem) ownerRule(problem);
      return send(
        encodeFunctionData({ abi, functionName: "setQuote", args: [q, next] }),
      );
    },

    async removeQuote(quote) {
      const q = kit.address(quote, "The quote");
      if (!(await r.quoteTerms(q)).allowed)
        ownerRule("This quote is not listed.");
      return send(
        encodeFunctionData({ abi, functionName: "removeQuote", args: [q] }),
      );
    },

    setPriceSigner: async (signer) =>
      send(
        encodeFunctionData({
          abi,
          functionName: "setPriceSigner",
          args: [
            signer === null
              ? zeroAddress
              : kit.address(signer, "The price signer", true),
          ],
        }),
      ),

    setSequencerUptimeFeed: async (feed, graceSecs) =>
      send(
        encodeFunctionData({
          abi,
          functionName: "setSequencerUptimeFeed",
          args: [
            feed === null ? zeroAddress : kit.address(feed, "The feed", true),
            Number(kit.uint(graceSecs, 0xffff_ffffn, "graceSecs")),
          ],
        }),
      ),

    async setPreset(preset, record) {
      const id =
        presetId(preset) ?? kit.invalid(`${String(preset)} is not a preset.`);
      const next: PresetRecord =
        record === null
          ? {
              deployer: zeroAddress,
              deployerCodeHash: zeroHash,
              creationCodeHash: zeroHash,
              selfPayee: false,
              active: false,
            }
          : {
              deployer: kit.address(record?.deployer, "The deployer", true),
              deployerCodeHash: hash32(
                kit,
                record.deployerCodeHash,
                "deployerCodeHash",
              ),
              creationCodeHash: hash32(
                kit,
                record.creationCodeHash,
                "creationCodeHash",
              ),
              selfPayee: kit.flag(record.selfPayee, "selfPayee"),
              active: kit.flag(record.active, "active"),
            };
      const problem = presetRecordProblem(next);
      if (problem) ownerRule(problem);
      return send(
        encodeFunctionData({
          abi,
          functionName: "setPreset",
          args: [id, next],
        }),
      );
    },

    setExtensionAllowed: async (key, allowed) =>
      send(
        encodeFunctionData({
          abi,
          functionName: "setExtensionAllowed",
          args: [hash32(kit, key, "The key"), kit.flag(allowed, "allowed")],
        }),
      ),

    async setBnkrPairWaiver(pad, waived) {
      const id = pad === "template" ? MAX_UINT64 : kit.requireId(pad);
      if (pad !== "template") await kit.requireRegistered(id);
      return send(
        encodeFunctionData({
          abi,
          functionName: "setBnkrPairWaiver",
          args: [id, kit.flag(waived, "waived")],
        }),
      );
    },
  };
}
