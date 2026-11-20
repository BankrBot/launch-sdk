import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { getBlock, readContract } from "viem/actions";
import { bankrLaunchTokenAbi as suite4TokenAbi } from "./abis/generated.js";
import { bankrLaunchTokenAbi } from "./abis/suite3.js";
import { MAX_METADATA_URI_BYTES } from "./economics.js";
import { LaunchRefusedError } from "./errors.js";
import { requireLaunch, type SuiteReadContext } from "./lens.js";
import type { UnsignedTx } from "./providers/types.js";
import { requireAddress } from "./recipient.js";
import { buildCallTx } from "./tx.js";

/** Whether a launch trades yet, by the chain's own clock ({@link readTradingStatus}). */
export interface TradingStatus {
  token: Address;
  /** The Unix second trading opens: the launch's own, or its scheduled start. Nobody can move it. */
  startTime: number;
  /** The latest block's timestamp, the clock the token and the hook hold the start to. */
  blockTime: number;
  /** Swaps and wallet transfers run from `startTime` on; before it only the launch's own contracts move the token. */
  started: boolean;
  /** 0 once trading has started. */
  secondsUntilStart: number;
}

/** A launch's trading start against the latest block. `NOT_A_LAUNCH` for a token this factory never launched. */
export async function readTradingStatus(
  ctx: SuiteReadContext,
  token: unknown,
): Promise<TradingStatus> {
  const [info, block] = await Promise.all([
    requireLaunch(ctx, token),
    getBlock(ctx.client, { blockTag: "latest" }),
  ]);
  const blockTime = Number(block.timestamp);
  const left = Math.max(0, info.tradingStart - blockTime);
  return {
    token: info.token,
    startTime: info.tradingStart,
    blockTime,
    started: left === 0,
    secondsUntilStart: left,
  };
}

/** A launched token's metadata link and who may replace it. */
export interface TokenMetadataState {
  token: Address;
  metadataUri: string;
  /** Null: the link is fixed for good (launched with no admin, or the admin renounced). */
  admin: Address | null;
  /** The account the admin offered the role to, until it accepts or the offer is withdrawn. */
  pendingAdmin: Address | null;
}

/**
 * The token's one role, named at launch (`metadataAdmin`): it replaces the metadata link and nothing else. It never
 * follows a fee recipient change or a community takeover. Each builder returns an unsigned transaction for `account`
 * and refuses `NOT_METADATA_ADMIN` when the token would revert it.
 */
export interface LaunchMetadataAdmin {
  /** `NOT_A_LAUNCH` for a token this chain's factory never launched. */
  get(token: Address): Promise<TokenMetadataState>;
  /** `setMetadataUri(metadataUri)`: at most the token's own limit in UTF-8 bytes (2,048 on the earlier contracts);
   *  the name and symbol never change. */
  buildSetUri(
    token: Address,
    account: Address,
    metadataUri: string,
  ): Promise<UnsignedTx>;
  /**
   * `transferMetadataAdmin(to)`: the first of two steps. `account` keeps the role until `to` accepts
   * ({@link LaunchMetadataAdmin.buildAccept}); `null` withdraws a pending offer.
   */
  buildTransfer(
    token: Address,
    account: Address,
    to: Address | null,
  ): Promise<UnsignedTx>;
  /** `acceptMetadataAdmin()`: `account` takes the role it was offered. */
  buildAccept(token: Address, account: Address): Promise<UnsignedTx>;
  /** `renounceMetadataAdmin()`: fixes the link for good. There is no way back. */
  buildRenounce(token: Address, account: Address): Promise<UnsignedTx>;
}

const orNull = (a: Address): Address | null =>
  isAddressEqual(a, zeroAddress) ? null : getAddress(a);

/** The metadata admin namespace for one chain's suite. */
export function createMetadataAdmin(
  ctx: SuiteReadContext,
): LaunchMetadataAdmin {
  const chain = ctx.chain.chain;
  const { client } = ctx;
  const refuse = (detail: string): never => {
    throw new LaunchRefusedError("NOT_METADATA_ADMIN", { chain, detail });
  };

  /** The launch's token and `account`, which must hold the role now. */
  async function asAdmin(token: unknown, account: unknown) {
    const who = requireAddress(account, chain);
    const info = await requireLaunch(ctx, token);
    if (info.metadataAdmin === null)
      refuse("The token's metadata link is fixed: it has no metadata admin.");
    else if (!isAddressEqual(info.metadataAdmin, who))
      refuse("Another account is the token's metadata admin.");
    return { token: info.token, who };
  }

  const tx = (from: Address, token: Address, data: Hex) =>
    buildCallTx(ctx.chain.chainId, from, token, data);

  return {
    async get(token) {
      const info = await requireLaunch(ctx, token);
      const t = { address: info.token, abi: bankrLaunchTokenAbi } as const;
      const [metadataUri, pending] = await Promise.all([
        readContract(client, { ...t, functionName: "metadataUri" }),
        readContract(client, { ...t, functionName: "pendingMetadataAdmin" }),
      ]);
      return {
        token: info.token,
        metadataUri,
        admin: info.metadataAdmin,
        pendingAdmin: orNull(pending),
      };
    },

    async buildSetUri(token, account, metadataUri) {
      const tooLong = (max: number) =>
        new LaunchRefusedError("INVALID_PARAMS", {
          chain,
          detail: `The metadata link can be at most ${max.toLocaleString("en-US")} bytes.`,
        });
      // The token counts bytes, not characters (MetadataTooLong). Suite 3 compiles the limit in; a suite 4 token
      // holds the one its launch froze, under the constant or over it.
      const on4 = ctx.addresses.settings !== undefined;
      if (typeof metadataUri !== "string")
        throw new LaunchRefusedError("INVALID_PARAMS", {
          chain,
          detail: "The metadata link is a string.",
        });
      const bytes = stringToBytes(metadataUri).length;
      if (!on4 && bytes > MAX_METADATA_URI_BYTES)
        throw tooLong(MAX_METADATA_URI_BYTES);
      const a = await asAdmin(token, account);
      if (on4) {
        const max = await readContract(client, {
          address: a.token,
          abi: suite4TokenAbi,
          functionName: "metadataMaxBytes",
        });
        if (bytes > max) throw tooLong(max);
      }
      return tx(
        a.who,
        a.token,
        encodeFunctionData({
          abi: bankrLaunchTokenAbi,
          functionName: "setMetadataUri",
          args: [metadataUri],
        }),
      );
    },

    async buildTransfer(token, account, to) {
      // The zero address is how the token withdraws an offer: only an explicit null asks for that.
      const next =
        to === null ? zeroAddress : requireAddress(to, chain, "The new admin");
      const a = await asAdmin(token, account);
      return tx(
        a.who,
        a.token,
        encodeFunctionData({
          abi: bankrLaunchTokenAbi,
          functionName: "transferMetadataAdmin",
          args: [next],
        }),
      );
    },

    async buildAccept(token, account) {
      const who = requireAddress(account, chain);
      const info = await requireLaunch(ctx, token);
      const pending = await readContract(client, {
        address: info.token,
        abi: bankrLaunchTokenAbi,
        functionName: "pendingMetadataAdmin",
      });
      if (!isAddressEqual(pending, who))
        refuse("The metadata admin has not offered the role to this account.");
      return tx(
        who,
        info.token,
        encodeFunctionData({
          abi: bankrLaunchTokenAbi,
          functionName: "acceptMetadataAdmin",
        }),
      );
    },

    async buildRenounce(token, account) {
      const a = await asAdmin(token, account);
      return tx(
        a.who,
        a.token,
        encodeFunctionData({
          abi: bankrLaunchTokenAbi,
          functionName: "renounceMetadataAdmin",
        }),
      );
    },
  };
}
