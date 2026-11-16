import { describe, expect, test } from "bun:test";
import {
  LAUNCH_SDK_ERROR_CODES,
  LaunchApiError,
  LaunchConfigError,
  LaunchExecutionError,
  LaunchRefusedError,
  LaunchSdkError,
  isLaunchSdkError,
  launchSdkError,
  type LaunchSdkErrorCode,
} from "./errors.js";

// The SDK's code list (H15 contract §5); a new code is an additive minor, a removed one is a major.
const PLAN_CODES: readonly LaunchSdkErrorCode[] = [
  "PROVIDER_NOT_DEPLOYED",
  "UNSUPPORTED_CHAIN",
  "RPC_REQUIRED",
  "WALLET_REQUIRED",
  "API_KEY_IN_BROWSER",
  "PAUSED",
  "LAUNCHPAD_GATED",
  "UNKNOWN_LAUNCHPAD",
  "LAUNCHPAD_PAUSED",
  "AUTHORIZATION_REQUIRED",
  "PRICE_ATTESTATION_REQUIRED",
  "QUOTE_NOT_ALLOWED",
  "CURVE_NOT_ALLOWED",
  "EXTENSION_NOT_ALLOWED",
  "EXTENSION_OUT_OF_BOUNDS",
  "DEV_BUY_UNAVAILABLE",
  "INVALID_PARAMS",
  "INVALID_PERCENT",
  "FEE_OUT_OF_BOUNDS",
  "SPLIT_OUT_OF_BOUNDS",
  "VESTING_OUT_OF_BOUNDS",
  "BUILDER_LANE_NOT_ALLOWED",
  // Suite 4: the launch check's refusals carry their own arguments in `detail`.
  "OUTSIDE_LAUNCHPAD_RANGE",
  "NOT_ALLOWED_BY_LAUNCHPAD",
  "HARD_BOUND",
  "OPTION_FOR_FEATURE_OFF",
  "CLAIM_OPERATOR_REQUIRED",
  "LAUNCH_REFUSED",
  "CREATOR_CAP_EXCEEDED",
  "LAUNCHER_IS_FORWARDER",
  "LAUNCHER_MISMATCH",
  "FEE_RECIPIENT_CANNOT_CLAIM",
  "NOT_A_LAUNCH",
  "NOT_A_BENEFICIARY",
  "CLAIM_NOT_ALLOWED",
  "NO_VESTING",
  "NOT_METADATA_ADMIN",
  "INVALID_LAUNCHPAD_CONFIG",
  "INVALID_SETTINGS",
  "SIMULATION_REVERTED",
  "POOL_ALREADY_INITIALIZED",
  "START_TICK_CHANGED",
  "PREDICTION_MISMATCH",
  "VANITY_UNAVAILABLE",
  "AUTHORIZATION_INVALID",
  "LAUNCHPAD_TERMS_CHANGED",
  "TERMS_CHANGED",
  "STALE_POLICY",
  "RECEIPT_MISSING_LAUNCH",
  "RECEIPT_MISSING_LAUNCHPAD",
  "TRANSACTION_REVERTED",
  "API_KEY_OVERPRIVILEGED",
  "API_ERROR",
  "RATE_LIMITED",
];

const SUBCLASSES = [
  LaunchConfigError,
  LaunchRefusedError,
  LaunchExecutionError,
  LaunchApiError,
] as const;

describe("LaunchSdkError hierarchy", () => {
  test("carries exactly the plan's codes, each once", () => {
    expect([...LAUNCH_SDK_ERROR_CODES].sort()).toEqual([...PLAN_CODES].sort());
    expect(new Set(LAUNCH_SDK_ERROR_CODES).size).toBe(
      LAUNCH_SDK_ERROR_CODES.length,
    );
  });

  test("every code builds exactly one subclass, with a fixed non-empty message", () => {
    for (const code of LAUNCH_SDK_ERROR_CODES) {
      const err = launchSdkError(code);
      expect(err, code).toBeInstanceOf(LaunchSdkError);
      expect(err, code).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.message.length, code).toBeGreaterThan(10);
      expect(
        SUBCLASSES.filter((C) => err instanceof C),
        code,
      ).toHaveLength(1);
      expect(err.name).toBe(err.constructor.name);
    }
  });

  test("codes land in the category the plan's refusal model implies", () => {
    expect(launchSdkError("PROVIDER_NOT_DEPLOYED")).toBeInstanceOf(
      LaunchConfigError,
    );
    expect(launchSdkError("RPC_REQUIRED")).toBeInstanceOf(LaunchConfigError);
    expect(launchSdkError("QUOTE_NOT_ALLOWED")).toBeInstanceOf(
      LaunchRefusedError,
    );
    expect(launchSdkError("AUTHORIZATION_REQUIRED")).toBeInstanceOf(
      LaunchRefusedError,
    );
    expect(launchSdkError("CURVE_NOT_ALLOWED")).toBeInstanceOf(
      LaunchRefusedError,
    );
    expect(launchSdkError("FEE_OUT_OF_BOUNDS")).toBeInstanceOf(
      LaunchRefusedError,
    );
    expect(launchSdkError("AUTHORIZATION_INVALID")).toBeInstanceOf(
      LaunchExecutionError,
    );
    expect(launchSdkError("START_TICK_CHANGED")).toBeInstanceOf(
      LaunchExecutionError,
    );
    expect(launchSdkError("RATE_LIMITED")).toBeInstanceOf(LaunchApiError);
  });

  test("no B20 or keeper code survives the move to the v4 hook", () => {
    for (const gone of [
      "B20_NOT_ACTIVATED",
      "KEEPER_NOT_LIVE",
      "NOT_FEE_RECIPIENT",
      "NO_HOLDER_REWARDS",
    ]) {
      expect(
        (LAUNCH_SDK_ERROR_CODES as readonly string[]).includes(gone),
        gone,
      ).toBe(false);
    }
  });

  test("a bounds refusal carries the SDK's own detail, in its JSON too", () => {
    const err = new LaunchRefusedError("SPLIT_OUT_OF_BOUNDS", {
      chain: "base",
      detail: "The referrer share can be at most 5% of the fee.",
    });
    expect(err.detail).toContain("5%");
    expect(err.toJSON().detail).toBe(err.detail);
    expect(launchSdkError("PAUSED").toJSON()).not.toHaveProperty("detail");
  });

  test("a subclass refuses a code from another category", () => {
    expect(
      () => new LaunchConfigError("RATE_LIMITED" as "RPC_REQUIRED"),
    ).toThrow(TypeError);
  });

  test("upstream errors ride on `cause`, never in the message", () => {
    const upstream = new Error(
      "execution reverted: secret-rpc.example/key=abc",
    );
    const err = new LaunchExecutionError("SIMULATION_REVERTED", {
      cause: upstream,
      chain: "arbitrum",
    });
    expect(err.cause).toBe(upstream);
    expect(err.message).not.toContain("secret-rpc");
    expect(err.chain).toBe("arbitrum");
    expect(launchSdkError("SIMULATION_REVERTED").message).toBe(err.message);
  });

  test("toJSON is sanitized: code, kind, message and chain, no cause or stack", () => {
    const err = new LaunchApiError("API_ERROR", {
      cause: new Error("upstream 500 body"),
      chain: "base",
    });
    const json = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(json).toEqual({
      name: "LaunchApiError",
      code: "API_ERROR",
      kind: "api",
      message: err.message,
      chain: "base",
    });
  });

  test("a mined transaction's hash rides on the error and its JSON", () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    const err = launchSdkError("TRANSACTION_REVERTED", {
      chain: "arbitrum",
      transactionHash: hash,
    });
    expect(err).toBeInstanceOf(LaunchExecutionError);
    expect(err.transactionHash).toBe(hash);
    expect(err.toJSON()).toEqual({
      name: "LaunchExecutionError",
      code: "TRANSACTION_REVERTED",
      kind: "execution",
      message: err.message,
      chain: "arbitrum",
      transactionHash: hash,
    });
    expect(launchSdkError("PAUSED").transactionHash).toBeUndefined();
  });

  test("isLaunchSdkError matches by brand, so a second SDK copy's errors still match", () => {
    const err = launchSdkError("PAUSED", { chain: "arc" });
    expect(isLaunchSdkError(err)).toBe(true);
    expect(isLaunchSdkError(err, "PAUSED")).toBe(true);
    expect(isLaunchSdkError(err, "INVALID_PARAMS")).toBe(false);
    expect(isLaunchSdkError(new Error("PAUSED"))).toBe(false);
    expect(isLaunchSdkError({ code: "PAUSED" })).toBe(false);
    expect(isLaunchSdkError(null)).toBe(false);

    // Same brand, different class identity (another installed copy of the SDK).
    const foreign = Object.assign(new Error("x"), { code: "PAUSED" });
    Object.defineProperty(foreign, Symbol.for("@bankr/launch-sdk/error"), {
      value: true,
    });
    expect(foreign instanceof LaunchSdkError).toBe(false);
    expect(isLaunchSdkError(foreign, "PAUSED")).toBe(true);
  });
});
