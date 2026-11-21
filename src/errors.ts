import type { Hex } from "viem";
import type { LaunchChain } from "./chains/index.js";

/** Which part of a launch failed: the client setup, a refused input, the chain, or the Bankr API. */
export type LaunchSdkErrorKind = "config" | "refused" | "execution" | "api";

// One row per code: its kind and its fixed message. Messages never carry upstream text, which rides on `cause`.
const ERROR_SPEC = {
  PROVIDER_NOT_DEPLOYED: {
    kind: "config",
    message:
      "The launch provider is not deployed on this chain in this SDK version.",
  },
  UNSUPPORTED_CHAIN: {
    kind: "config",
    message: "Unsupported chain: use one of the launch chains in CHAINS.",
  },
  RPC_REQUIRED: {
    kind: "config",
    message:
      "This chain has no usable public RPC: pass an rpcUrl or a publicClient.",
  },
  WALLET_REQUIRED: {
    kind: "config",
    message: "This action signs a transaction: pass a walletClient.",
  },
  API_KEY_IN_BROWSER: {
    kind: "config",
    message:
      "Keys must stay on a server: sign on your server, and use remoteAuthorizer in the browser.",
  },
  INDEX_NOT_ON_FORK: {
    kind: "config",
    message:
      "Fees owed and claim all come from Bankr's API, which indexes Bankr's live contracts only: on a fork, read and claim one launch with fees.get and fees.buildClaim.",
  },
  PAUSED: {
    kind: "refused",
    message: "New launches are paused on this chain.",
  },
  LAUNCHPAD_GATED: {
    kind: "refused",
    message: "Only Bankr's own launchpad (id 0) can launch on this chain.",
  },
  UNKNOWN_LAUNCHPAD: {
    kind: "refused",
    message: "No launchpad with this id is registered on this chain.",
  },
  LAUNCHPAD_PAUSED: {
    kind: "refused",
    message: "This launchpad has paused new launches.",
  },
  AUTHORIZATION_REQUIRED: {
    kind: "refused",
    message:
      "This launchpad signs its launches, and this launch has no signature from it.",
  },
  PRICE_ATTESTATION_REQUIRED: {
    kind: "refused",
    message:
      "This quote is priced by Bankr's signed attestation, which a launch from this SDK version does not carry: pair with another quote token.",
  },
  QUOTE_NOT_ALLOWED: {
    kind: "refused",
    message: "This quote token is not allowed on this chain or launchpad.",
  },
  CURVE_NOT_ALLOWED: {
    kind: "refused",
    message:
      "This launchpad does not allow this launch curve: its operator decides which curves and liquidity bands launch on it.",
  },
  EXTENSION_NOT_ALLOWED: {
    kind: "refused",
    message:
      "This launch's extension is not allowed on this chain or launchpad.",
  },
  EXTENSION_OUT_OF_BOUNDS: {
    kind: "refused",
    message:
      "A parameter of the launch's extension is outside the bound its contract holds it to.",
  },
  DEV_BUY_UNAVAILABLE: {
    kind: "refused",
    message: "A dev buy is not available for this quote token on this chain.",
  },
  INVALID_PARAMS: {
    kind: "refused",
    message: "The launch parameters are invalid.",
  },
  INVALID_PERCENT: {
    kind: "refused",
    message:
      "A percentage, pips or bps value is negative, not a number, above 100 %, or more precise than its unit (4 decimal places for pips, 2 for bps).",
  },
  FEE_OUT_OF_BOUNDS: {
    kind: "refused",
    message:
      "The trading fee schedule is outside the protocol's or this launchpad's bounds.",
  },
  SPLIT_OUT_OF_BOUNDS: {
    kind: "refused",
    message:
      "A holders, auto-liquidity, buyback or referrer share is outside the protocol's or this launchpad's bounds.",
  },
  VESTING_OUT_OF_BOUNDS: {
    kind: "refused",
    message:
      "The vesting share or schedule is outside the protocol's or this launchpad's bounds.",
  },
  OUTSIDE_LAUNCHPAD_RANGE: {
    kind: "refused",
    message:
      "A launch term is outside this launchpad's range: `detail` names the term and the range in force.",
  },
  NOT_ALLOWED_BY_LAUNCHPAD: {
    kind: "refused",
    message:
      "This launchpad does not allow one of this launch's features: `detail` names it.",
  },
  HARD_BOUND: {
    kind: "refused",
    message: "One of the launch's numbers is outside what a pool can run on.",
  },
  OPTION_FOR_FEATURE_OFF: {
    kind: "refused",
    message:
      "The launch names an option for a feature it leaves off: drop the option, or turn the feature on.",
  },
  CLAIM_OPERATOR_REQUIRED: {
    kind: "refused",
    message:
      "A fee recipient is a contract with restricted claims and no claim operator named: after a takeover only it, or its operator, could withdraw its balance.",
  },
  LAUNCH_REFUSED: {
    kind: "refused",
    message: "The chain's launch check refuses this launch: see `detail`.",
  },
  CREATOR_CAP_EXCEEDED: {
    kind: "refused",
    message:
      "The dev buy exceeds 2% of supply, or vesting exceeds the 50% cap.",
  },
  LAUNCHER_IS_FORWARDER: {
    kind: "refused",
    message:
      "The launcher is a public forwarder contract: launch from an account you control.",
  },
  LAUNCHER_MISMATCH: {
    kind: "refused",
    message:
      "The sending account is not the launcher this launch was planned for.",
  },
  FEE_RECIPIENT_CANNOT_CLAIM: {
    kind: "refused",
    message: "The fee recipient cannot claim from the fee ledger.",
  },
  NOT_A_LAUNCH: {
    kind: "refused",
    message:
      "This token was not launched through the Bankr contracts this client is on.",
  },
  NOT_A_BENEFICIARY: {
    kind: "refused",
    message: "This account holds no share of the launch's fee bucket.",
  },
  CLAIM_NOT_ALLOWED: {
    kind: "refused",
    message:
      "The sender may not push this account its fees: the account restricts who may claim for it, or it collects its own share.",
  },
  NO_VESTING: {
    kind: "refused",
    message: "This launch has no vesting schedule this account can release.",
  },
  NOT_METADATA_ADMIN: {
    kind: "refused",
    message:
      "This account cannot change the token's metadata link or its metadata admin.",
  },
  INVALID_LAUNCHPAD_CONFIG: {
    kind: "refused",
    message:
      "This launchpad change breaks a rule of the launchpad registry (payees, shares, fee bounds, policy, vanity, metadata or operator).",
  },
  INVALID_SETTINGS: {
    kind: "refused",
    message:
      "This owner change breaks a rule of the settings contract, the factory or the launchpad registry.",
  },
  SIMULATION_REVERTED: {
    kind: "execution",
    message: "The launch transaction reverted in simulation.",
  },
  POOL_ALREADY_INITIALIZED: {
    kind: "execution",
    message:
      "The predicted token or pool already exists: re-plan with a fresh salt.",
  },
  START_TICK_CHANGED: {
    kind: "execution",
    message:
      "The quote's price moved the start tick out of the factory's bounds: re-plan the launch.",
  },
  PREDICTION_MISMATCH: {
    kind: "execution",
    message: "The predicted token address does not match the factory's.",
  },
  VANITY_UNAVAILABLE: {
    kind: "execution",
    message:
      "No salt giving this launchpad's vanity suffix was found within plan()'s bounded search (2^20 tries): mine one with mineVanitySalt and a larger maxTries, then pass it as `salt`.",
  },
  AUTHORIZATION_INVALID: {
    kind: "execution",
    message:
      "The launchpad's authorization is invalid, expired or already used: re-plan the launch.",
  },
  LAUNCHPAD_TERMS_CHANGED: {
    kind: "execution",
    message:
      "The launchpad's payees or shares changed after planning: review its new terms and re-plan.",
  },
  TERMS_CHANGED: {
    kind: "execution",
    message:
      "The terms this launch would freeze, or its token address, changed after planning: plan again.",
  },
  RECEIPT_MISSING_LAUNCH: {
    kind: "execution",
    message: "The receipt holds no launch from this chain's Bankr factory.",
  },
  RECEIPT_MISSING_LAUNCHPAD: {
    kind: "execution",
    message:
      "The receipt holds no launchpad registration from the Bankr launchpad registry's address.",
  },
  TRANSACTION_REVERTED: {
    kind: "execution",
    message:
      "A transaction sent for this launch reverted on-chain: re-plan before retrying.",
  },
  API_ERROR: { kind: "api", message: "The Bankr API request failed." },
  RATE_LIMITED: {
    kind: "api",
    message: "The Bankr API rate limit was hit: retry later.",
  },
  // The API's own code and sentence (HTTP 503): its index of a chain is behind, and a retry can succeed.
  INDEX_UNAVAILABLE: {
    kind: "api",
    message:
      "Bankr's index of this chain is not available right now. Try again shortly.",
  },
} as const satisfies Record<
  string,
  { kind: LaunchSdkErrorKind; message: string }
>;

type ErrorSpec = typeof ERROR_SPEC;

export type LaunchSdkErrorCode = keyof ErrorSpec;

/** The codes of one kind, e.g. `CodeOfKind<"api">` = `"API_KEY_OVERPRIVILEGED" | "API_ERROR" | "RATE_LIMITED"`. */
export type CodeOfKind<K extends LaunchSdkErrorKind> = {
  [C in LaunchSdkErrorCode]: ErrorSpec[C]["kind"] extends K ? C : never;
}[LaunchSdkErrorCode];

/** Every error code, in declaration order. New codes are additive minors; removing one is a major. */
export const LAUNCH_SDK_ERROR_CODES = Object.freeze(
  Object.keys(ERROR_SPEC) as LaunchSdkErrorCode[],
);

export interface LaunchSdkErrorOptions {
  /** The upstream error (RPC, revert, HTTP); kept off `message` and out of `toJSON()`. */
  cause?: unknown;
  /** The launch chain the error concerns, when there is one. */
  chain?: LaunchChain;
  /** The mined transaction the error concerns (a reverted approval or launch), when there is one. */
  transactionHash?: Hex;
  /** The SDK's own sentence naming the bound or field that failed; never upstream text. Safe to show. */
  detail?: string;
}

export interface LaunchSdkErrorJson {
  name: string;
  code: LaunchSdkErrorCode;
  kind: LaunchSdkErrorKind;
  message: string;
  chain?: LaunchChain;
  transactionHash?: Hex;
  detail?: string;
}

// Registry-global so `isLaunchSdkError` recognises errors from a second installed copy of the SDK.
const BRAND = Symbol.for("@bankr/launch-sdk/error");

/**
 * Base of every error the SDK throws. `message` is fixed per `code`; branch on `code`, not on text.
 * Construct through a subclass or {@link launchSdkError}.
 */
export abstract class LaunchSdkError<
  C extends LaunchSdkErrorCode = LaunchSdkErrorCode,
> extends Error {
  readonly code: C;
  readonly kind: LaunchSdkErrorKind;
  readonly chain: LaunchChain | undefined;
  readonly transactionHash: Hex | undefined;
  readonly detail: string | undefined;

  protected constructor(
    code: C,
    expectedKind: LaunchSdkErrorKind,
    options: LaunchSdkErrorOptions = {},
  ) {
    const spec: { kind: LaunchSdkErrorKind; message: string } | undefined =
      ERROR_SPEC[code];
    if (spec?.kind !== expectedKind) {
      throw new TypeError(
        `${String(code)} is not a ${expectedKind} error code`,
      );
    }
    super(
      spec.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.kind = spec.kind;
    this.chain = options.chain;
    this.transactionHash = options.transactionHash;
    this.detail = options.detail;
    Object.defineProperty(this, BRAND, { value: true });
  }

  /** Safe to log or return over HTTP: no `cause`, no stack. */
  toJSON(): LaunchSdkErrorJson {
    return {
      name: this.name,
      code: this.code,
      kind: this.kind,
      message: this.message,
      ...(this.chain === undefined ? {} : { chain: this.chain }),
      ...(this.transactionHash === undefined
        ? {}
        : { transactionHash: this.transactionHash }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

/** Client setup: an unsupported or undeployed chain, a missing RPC or wallet, a key in a browser. */
export class LaunchConfigError extends LaunchSdkError<CodeOfKind<"config">> {
  override readonly name = "LaunchConfigError";

  constructor(code: CodeOfKind<"config">, options?: LaunchSdkErrorOptions) {
    super(code, "config", options);
  }
}

/** A launch the SDK refuses before anything is signed (inputs, chain state, launchpad bounds). */
export class LaunchRefusedError extends LaunchSdkError<CodeOfKind<"refused">> {
  override readonly name = "LaunchRefusedError";

  constructor(code: CodeOfKind<"refused">, options?: LaunchSdkErrorOptions) {
    super(code, "refused", options);
  }
}

/** A simulation, transaction or receipt that did not produce the planned launch. */
export class LaunchExecutionError extends LaunchSdkError<
  CodeOfKind<"execution">
> {
  override readonly name = "LaunchExecutionError";

  constructor(code: CodeOfKind<"execution">, options?: LaunchSdkErrorOptions) {
    super(code, "execution", options);
  }
}

/** A Bankr API failure. */
export class LaunchApiError extends LaunchSdkError<CodeOfKind<"api">> {
  override readonly name = "LaunchApiError";

  constructor(code: CodeOfKind<"api">, options?: LaunchSdkErrorOptions) {
    super(code, "api", options);
  }
}

/** Builds the subclass that owns `code`. */
export function launchSdkError<C extends LaunchSdkErrorCode>(
  code: C,
  options?: LaunchSdkErrorOptions,
): LaunchSdkError<C> {
  const kind: LaunchSdkErrorKind = ERROR_SPEC[code].kind;
  const err =
    kind === "config"
      ? new LaunchConfigError(code as CodeOfKind<"config">, options)
      : kind === "refused"
        ? new LaunchRefusedError(code as CodeOfKind<"refused">, options)
        : kind === "execution"
          ? new LaunchExecutionError(code as CodeOfKind<"execution">, options)
          : new LaunchApiError(code as CodeOfKind<"api">, options);
  return err as LaunchSdkError as LaunchSdkError<C>;
}

/** True for any SDK error (optionally with `code`), including one thrown by another installed copy. */
export function isLaunchSdkError<C extends LaunchSdkErrorCode>(
  value: unknown,
  code?: C,
): value is LaunchSdkError<C> {
  if (typeof value !== "object" || value === null) return false;
  if (Reflect.get(value, BRAND) !== true) return false;
  return code === undefined || Reflect.get(value, "code") === code;
}
