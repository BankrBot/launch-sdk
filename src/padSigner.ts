import {
  isAddressEqual,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { BANKR_V4_ADDRESSES } from "./addresses.js";
import { refuseInBrowser } from "./api.js";
import {
  authorizationRequestFromJson,
  type AuthorizationRequest,
  type Authorizer,
} from "./authorizer.js";
import { CHAINS, isLaunchChain, type LaunchChain } from "./chains/index.js";
import { LaunchConfigError } from "./errors.js";
import { randomSalt } from "./salt.js";
import { MAX_BODY_BYTES, isJsonRequest, json, readBody } from "./serverHttp.js";
import {
  launchAuthorizationTypedData,
  launchTermsHash,
  type AnyLaunchParams,
  type LaunchAuthorization,
} from "./terms.js";

// A third-party launchpad's signer, server side: it signs the exact terms of each launch it admits (EIP-712
// LaunchAuthorization, domain "Bankr Launchpads" on the chain's registry). The key never leaves this server.

/** The pad's signer: a viem `LocalAccount` (a KMS- or HSM-backed one included) whose address is the pad's `signer`. */
export type PadSigner = Pick<LocalAccount, "address" | "signTypedData">;

const DEFAULT_DEADLINE_SECONDS = 600;

export interface SignLaunchAuthorizationInput {
  /** The pad signer's account. */
  account: PadSigner;
  chainId: number;
  registry: Address;
  launchpadId: bigint;
  launcher: Address;
  /** A suite 4 launch's carry `options`: its pins are part of what is signed. */
  params: AnyLaunchParams;
  /** `msg.value` of the launch (a native dev buy); folded into the signed terms. */
  nativeDevBuy: bigint;
  /** One-use; default 32 random bytes. */
  nonce?: Hex;
  /** Unix seconds; default `deadlineSeconds` from now. */
  deadline?: bigint;
  /** Default 600. */
  deadlineSeconds?: number;
}

/** Signs one launch's terms; the terms hash is computed here from `params`, never taken from the caller. */
export async function signLaunchAuthorization(
  i: SignLaunchAuthorizationInput,
): Promise<LaunchAuthorization & { paramsHash: Hex }> {
  const paramsHash = launchTermsHash(i.params, i.launcher, i.nativeDevBuy);
  const nonce = i.nonce ?? randomSalt();
  const deadline =
    i.deadline ??
    BigInt(
      Math.floor(Date.now() / 1000) +
        (i.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS),
    );
  const signature = await i.account.signTypedData(
    launchAuthorizationTypedData({
      chainId: i.chainId,
      registry: i.registry,
      launchpadId: i.launchpadId,
      launcher: i.launcher,
      paramsHash,
      nonce,
      deadline,
    }),
  );
  return { nonce, deadline, signature, paramsHash };
}

export interface PadAuthorizerOptions {
  /** The pad signer's account. */
  account: PadSigner;
  deadlineSeconds?: number;
  /** Your admission policy over the terms (who may launch, what economics); throw to refuse. */
  authorize?: (request: AuthorizationRequest) => void | Promise<void>;
}

/**
 * An `authorizer` for a client on the pad's own server: it recomputes the terms hash, checks the pad's signer is this
 * one, runs `authorize`, and signs. Pass it as `createLaunchClient({ authorizer })`.
 */
export function padAuthorizer(o: PadAuthorizerOptions): Authorizer {
  refuseInBrowser();
  return async (request) => {
    if (!isAddressEqual(request.signer, o.account.address)) {
      throw new TypeError("this pad's signer is not the authorizer's account");
    }
    await o.authorize?.(request);
    const { nonce, deadline, signature } = await signLaunchAuthorization({
      ...request,
      account: o.account,
      deadlineSeconds: o.deadlineSeconds,
    });
    return { nonce, deadline, signature };
  };
}

export interface AuthorizeHandlerOptions {
  /** The pad signer's account. */
  account: PadSigner;
  chain: LaunchChain;
  launchpadId: bigint;
  /** The chain's launchpad registry; default the SDK's record (required while the chain has none). */
  registry?: Address;
  /**
   * Required, with no default allow: authenticate the end user and apply your pad's admission policy to the terms
   * before your key signs. Throw to refuse: a thrown `Response` is returned as is, anything else becomes a 403.
   */
  authorize: (
    req: Request,
    request: AuthorizationRequest,
  ) => void | Promise<void>;
  deadlineSeconds?: number;
  /** Sees every failed signing for your logs; the response never carries details. */
  onError?: (error: unknown) => void;
}

/**
 * A `(Request) => Promise<Response>` route that signs launch authorizations for your pad; browsers reach it with
 * `remoteAuthorizer(url)`. It accepts POST only, an `application/json` body of at most 16 KiB, refuses another chain,
 * registry or pad, recomputes the terms hash from the posted params, runs `authorize`, then answers
 * `{ nonce, deadline, signature, paramsHash }`. Throws `API_KEY_IN_BROWSER` in a browser.
 */
export function createAuthorizeHandler(
  o: AuthorizeHandlerOptions,
): (req: Request) => Promise<Response> {
  refuseInBrowser();
  if (typeof o?.authorize !== "function") {
    throw new TypeError(
      "createAuthorizeHandler needs an authorize function: there is no default allow",
    );
  }
  if (!isLaunchChain(o.chain)) throw new LaunchConfigError("UNSUPPORTED_CHAIN");
  const registry = o.registry ?? BANKR_V4_ADDRESSES[o.chain]?.launchpadRegistry;
  if (!registry)
    throw new LaunchConfigError("PROVIDER_NOT_DEPLOYED", {
      chain: o.chain,
      detail: `Bankr's suite on ${o.chain} is not in this SDK version yet: pass the launchpad registry's address as \`registry\`.`,
    });
  const chainId = CHAINS[o.chain].chainId;

  return async function authorizeHandler(req: Request): Promise<Response> {
    if (req.method !== "POST")
      return json(405, { error: "Use POST." }, { allow: "POST" });
    if (!isJsonRequest(req))
      return json(415, { error: "Send the request as JSON." });
    const text = await readBody(req.clone(), MAX_BODY_BYTES);
    if (text === null)
      return json(413, { error: "The request body is too large." });
    let request: AuthorizationRequest;
    try {
      const r = authorizationRequestFromJson(JSON.parse(text));
      if (
        r.chain !== o.chain ||
        r.chainId !== chainId ||
        !isAddressEqual(r.registry, registry) ||
        r.launchpadId !== o.launchpadId ||
        r.params.launchpadId !== o.launchpadId
      ) {
        throw new TypeError("another chain, registry or pad");
      }
      request = {
        ...r,
        chain: o.chain,
        paramsHash: launchTermsHash(r.params, r.launcher, r.nativeDevBuy),
        signer: o.account.address,
      };
    } catch {
      return json(400, {
        error: "The body must be this pad's launch authorization request.",
      });
    }
    try {
      await o.authorize(req, request);
    } catch (denied) {
      if (denied instanceof Response) return denied;
      return json(403, { error: "Not authorized." });
    }
    try {
      const a = await signLaunchAuthorization({
        ...request,
        account: o.account,
        deadlineSeconds: o.deadlineSeconds,
      });
      return json(200, {
        nonce: a.nonce,
        deadline: a.deadline.toString(),
        signature: a.signature,
        paramsHash: a.paramsHash,
      });
    } catch (err) {
      o.onError?.(err);
      return json(500, { error: "Could not sign the launch right now." });
    }
  };
}
