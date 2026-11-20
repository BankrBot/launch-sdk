import { isHex, type Address, type Hex } from "viem";
import { launchParamsFromJson, launchParamsToJson } from "./abiJson.js";
import type { LaunchChain } from "./chains/index.js";
import { LaunchApiError, isLaunchSdkError } from "./errors.js";
import type { AnyLaunchParams, LaunchAuthorization } from "./terms.js";

// Third-party pads with a signer: the client's `authorizer` option and its browser half, `remoteAuthorizer`.
// The server half (signing with the pad signer's key, and its HTTP handler) is in `@bankr/launch-sdk/server`.

/** What a pad's authorizer is asked to sign: one launch's exact terms on one chain's registry. */
export interface AuthorizationRequest {
  chain: LaunchChain;
  chainId: number;
  registry: Address;
  factory: Address;
  launchpadId: bigint;
  launcher: Address;
  /** The final terms; `deadline`, `devBuyMinOut` and the signatures are blanked in what is signed. A suite 4
   *  launch's carry `options`, with both pins. */
  params: AnyLaunchParams;
  /** `msg.value`: a native dev buy, folded into the signed terms. */
  nativeDevBuy: bigint;
  /** `factory.hashLaunchTerms(params, launcher, nativeDevBuy)`, computed locally. An authorizer should recompute it. */
  paramsHash: Hex;
  /** The pad's signer the signature must recover to. */
  signer: Address;
}

/** Signs `request` with the pad's signer: `{ nonce, deadline, signature }`, one-use and expiring. */
export type Authorizer = (
  request: AuthorizationRequest,
) => Promise<LaunchAuthorization>;

/** An authorization request as JSON: bigints as decimal strings, params field for field. */
export function authorizationRequestToJson(r: AuthorizationRequest) {
  return {
    chain: r.chain,
    chainId: r.chainId,
    registry: r.registry,
    factory: r.factory,
    launchpadId: r.launchpadId.toString(),
    launcher: r.launcher,
    params: launchParamsToJson(r.params),
    nativeDevBuy: r.nativeDevBuy.toString(),
    paramsHash: r.paramsHash,
    signer: r.signer,
  };
}

const DECIMAL = /^\d+$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** A `{ nonce, deadline, signature }` reply checked for shape; null when it is anything else. */
export function parseAuthorization(value: unknown): LaunchAuthorization | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const deadline =
    typeof v.deadline === "bigint"
      ? v.deadline
      : typeof v.deadline === "string" && DECIMAL.test(v.deadline)
        ? BigInt(v.deadline)
        : null;
  if (
    typeof v.nonce !== "string" ||
    !BYTES32.test(v.nonce) ||
    deadline === null ||
    typeof v.signature !== "string" ||
    !isHex(v.signature, { strict: true }) ||
    v.signature.length < 4
  ) {
    return null;
  }
  return {
    nonce: v.nonce.toLowerCase() as Hex,
    deadline,
    signature: v.signature as Hex,
  };
}

/** The request JSON back into an {@link AuthorizationRequest}; throws a TypeError naming the first bad field. */
export function authorizationRequestFromJson(value: unknown): Omit<
  AuthorizationRequest,
  "chain" | "paramsHash" | "signer"
> & {
  chain: string;
} {
  if (typeof value !== "object" || value === null)
    throw new TypeError("invalid request");
  const v = value as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof v[k] !== "string") throw new TypeError(`invalid ${k}`);
    return v[k] as string;
  };
  const uint = (k: string) => {
    const s = str(k);
    if (!DECIMAL.test(s)) throw new TypeError(`invalid ${k}`);
    return BigInt(s);
  };
  if (typeof v.chainId !== "number" || !Number.isSafeInteger(v.chainId))
    throw new TypeError("invalid chainId");
  return {
    chain: str("chain"),
    chainId: v.chainId,
    registry: str("registry") as Address,
    factory: str("factory") as Address,
    launchpadId: uint("launchpadId"),
    launcher: str("launcher") as Address,
    params: launchParamsFromJson(v.params),
    nativeDevBuy: uint("nativeDevBuy"),
  };
}

/**
 * An authorizer for the browser: POSTs each request as JSON to your pad's endpoint (`createAuthorizeHandler` from
 * `@bankr/launch-sdk/server`), which checks your user and signs with the pad signer's key server-side. `init`
 * carries your session auth or CSRF header. A failed or malformed reply is `API_ERROR`.
 */
export function remoteAuthorizer(
  url: string,
  init: RequestInit = {},
  options: {
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  } = {},
): Authorizer {
  return async (request) => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    let body: unknown;
    let ok = false;
    try {
      const res = await (options.fetch ?? globalThis.fetch)(url, {
        ...init,
        method: "POST",
        headers,
        body: JSON.stringify(authorizationRequestToJson(request)),
      });
      ok = res.ok;
      body = await res.json().catch(() => undefined);
    } catch (cause) {
      if (isLaunchSdkError(cause)) throw cause;
      throw new LaunchApiError("API_ERROR", { chain: request.chain, cause });
    }
    const auth = ok ? parseAuthorization(body) : null;
    if (auth === null) {
      throw new LaunchApiError("API_ERROR", {
        chain: request.chain,
        cause: new TypeError(
          "The authorizer did not return { nonce, deadline, signature }",
        ),
      });
    }
    return auth;
  };
}
