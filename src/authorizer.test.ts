import { describe, expect, test } from "bun:test";
import { getAddress, recoverTypedDataAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { launchParamsFromJson, launchParamsToJson } from "./abiJson.js";
import { remoteAuthorizer, type AuthorizationRequest } from "./authorizer.js";
import { isLaunchSdkError } from "./errors.js";
import { buildLaunchParams } from "./normalize.js";
import {
  createAuthorizeHandler,
  padAuthorizer,
  signLaunchAuthorization,
} from "./server.js";
import { launchAuthorizationTypedData, launchTermsHash } from "./terms.js";

// A throwaway key for signing tests only.
const PAD_KEY = `0x${"42".repeat(32)}` as const;
const signer = privateKeyToAccount(PAD_KEY);
const REGISTRY = getAddress("0x0000000000000000000000000000000000008008");
const LAUNCHER = getAddress("0x1111111111111111111111111111111111111111");
const PARTNER = getAddress("0x3333333333333333333333333333333333333333");
const ADMIN = getAddress("0x4444444444444444444444444444444444444444");

const params = buildLaunchParams({
  name: "Pad Launch",
  symbol: "PAD",
  metadataUri: "ipfs://pad",
  metadataAdmin: ADMIN,
  salt: `0x${"ab".repeat(32)}`,
  quote: "0x4200000000000000000000000000000000000006",
  capExclusions: [],
  startTick: -200_000,
  deadline: 1_900_000_000n,
  economics: {
    buy: { startPips: 500, steadyPips: 500, decaySecs: 0 },
    sell: { startPips: 500, steadyPips: 500, decaySecs: 0 },
    referrerBps: 0,
    holdersBps: 1_000,
    autoLpBps: 3_000,
    buybackBps: 0,
    vestToHoldersBps: 0,
    vestToHoldersCliff: 0n,
    vestToHoldersDuration: 0n,
  },
  launchpadId: 7n,
  maxOperatorShareBps: 1_000,
  operatorPayeesHash: `0x${"cd".repeat(32)}`,
  feeRecipients: [
    { recipient: LAUNCHER, shareBps: 7_000 },
    { recipient: PARTNER, shareBps: 3_000 },
  ],
  allowOpenCodeFeeRecipients: true,
  vestingRecipient: LAUNCHER,
  vestBps: 0,
  allowCodeVestingRecipient: false,
  devBuyAmountIn: 0n,
  startTime: 1_900_003_600,
});

const request: AuthorizationRequest = {
  chain: "base",
  chainId: 8453,
  registry: REGISTRY,
  factory: getAddress("0x0000000000000000000000000000000000008003"),
  launchpadId: 7n,
  launcher: LAUNCHER,
  params,
  nativeDevBuy: 10n ** 15n,
  paramsHash: launchTermsHash(params, LAUNCHER, 10n ** 15n),
  signer: signer.address,
};

describe("LaunchParams over JSON", () => {
  test("round-trips every field; bigints travel as decimal strings", () => {
    const json = launchParamsToJson(params) as Record<string, unknown>;
    expect(json.deadline).toBe("1900000000");
    expect(json.launchpadId).toBe("7");
    expect(json.startTime).toBe("1900003600");
    expect(json.metadataAdmin).toBe(ADMIN);
    expect(json.feeRecipients).toEqual([
      { recipient: LAUNCHER, shareBps: 7_000 },
      { recipient: PARTNER, shareBps: 3_000 },
    ]);
    expect(launchParamsFromJson(JSON.parse(JSON.stringify(json)))).toEqual(
      params,
    );
  });

  test("names the first bad field and refuses unknown ones", () => {
    const json = launchParamsToJson(params) as Record<string, unknown>;
    expect(() => launchParamsFromJson({ ...json, vestBps: 70_000 })).toThrow(
      "params.vestBps",
    );
    expect(() => launchParamsFromJson({ ...json, quote: "0xnope" })).toThrow(
      "params.quote",
    );
    expect(() => launchParamsFromJson({ ...json, extra: 1 })).toThrow(
      TypeError,
    );
    const split = [
      { recipient: LAUNCHER, shareBps: 7_000 },
      { recipient: PARTNER, shareBps: 70_000 },
    ];
    expect(() =>
      launchParamsFromJson({ ...json, feeRecipients: split }),
    ).toThrow("params.feeRecipients[1].shareBps");
    expect(() => launchParamsFromJson({ ...json, startTime: -1 })).toThrow(
      "params.startTime",
    );
  });
});

describe("pad signer (server)", () => {
  test("signLaunchAuthorization signs the recomputed terms hash for the pad's id on its registry", async () => {
    const a = await signLaunchAuthorization({
      ...request,
      account: signer,
      nonce: `0x${"01".repeat(32)}`,
      deadline: 2_000_000_000n,
    });
    expect(a.paramsHash).toBe(request.paramsHash);
    const recovered = await recoverTypedDataAddress({
      ...launchAuthorizationTypedData({
        chainId: 8453,
        registry: REGISTRY,
        launchpadId: 7n,
        launcher: LAUNCHER,
        paramsHash: a.paramsHash,
        nonce: a.nonce,
        deadline: a.deadline,
      }),
      signature: a.signature,
    });
    expect(recovered).toBe(signer.address);
  });

  test("padAuthorizer runs the policy and refuses another pad's signer", async () => {
    const seen: AuthorizationRequest[] = [];
    const auth = padAuthorizer({
      account: signer,
      authorize: (r) => void seen.push(r),
    });
    const a = await auth(request);
    expect(seen).toHaveLength(1);
    expect(a.signature).toMatch(/^0x[0-9a-f]{130}$/);
    await expect(auth({ ...request, signer: zeroAddress })).rejects.toThrow(
      TypeError,
    );
    const deny = padAuthorizer({
      account: signer,
      authorize: () => Promise.reject(new Error("not this one")),
    });
    await expect(deny(request)).rejects.toThrow("not this one");
  });

  test("createAuthorizeHandler + remoteAuthorizer: the browser's request is checked, authorized and signed", async () => {
    const authorized: AuthorizationRequest[] = [];
    const handler = createAuthorizeHandler({
      account: signer,
      chain: "base",
      launchpadId: 7n,
      registry: REGISTRY,
      authorize: (_req, r) => void authorized.push(r),
    });
    const remote = remoteAuthorizer(
      "https://pad.example/authorize",
      {},
      {
        fetch: (input, init) => handler(new Request(input, init)),
      },
    );
    const a = await remote(request);
    expect(authorized[0]!.paramsHash).toBe(request.paramsHash);
    expect(authorized[0]!.params).toEqual(params);
    expect(a.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));

    // Another pad, a forged registry or a refused user never reaches the key.
    let thrown: unknown;
    try {
      await remote({
        ...request,
        launchpadId: 8n,
        params: { ...params, launchpadId: 8n },
      });
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "API_ERROR")).toBe(true);
    const denied = createAuthorizeHandler({
      account: signer,
      chain: "base",
      launchpadId: 7n,
      registry: REGISTRY,
      authorize: () => {
        throw new Response("nope", { status: 401 });
      },
    });
    const res = await denied(
      new Request("https://pad.example/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          launchpadId: "7",
          nativeDevBuy: "0",
          params: launchParamsToJson(params),
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(
      (await handler(new Request("https://pad.example/authorize"))).status,
    ).toBe(405);
  });

  test("the widest launch, a 2,048-byte link and ten recipients, fits the handler's body limit and is signed", async () => {
    const wide = {
      ...params,
      name: "N".repeat(100),
      metadataUri: `ipfs://${"a".repeat(2_041)}`,
      feeRecipients: Array.from({ length: 10 }, (_, i) => ({
        recipient: getAddress(`0x${(0xa0 + i).toString(16).repeat(20)}`),
        shareBps: 1_000,
      })),
    };
    const authorized: AuthorizationRequest[] = [];
    const handler = createAuthorizeHandler({
      account: signer,
      chain: "base",
      launchpadId: 7n,
      registry: REGISTRY,
      authorize: (_req, r) => void authorized.push(r),
    });
    const remote = remoteAuthorizer(
      "https://pad.example/authorize",
      {},
      { fetch: (input, init) => handler(new Request(input, init)) },
    );
    const a = await remote({
      ...request,
      params: wide,
      paramsHash: launchTermsHash(wide, LAUNCHER, 10n ** 15n),
    });
    expect(a.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(authorized[0]!.params).toEqual(wide);
  });

  test("the handler needs an authorize callback and a registry", () => {
    expect(() =>
      createAuthorizeHandler({
        account: signer,
        chain: "base",
        launchpadId: 7n,
      } as never),
    ).toThrow(TypeError);
    let thrown: unknown;
    try {
      createAuthorizeHandler({
        account: signer,
        chain: "robinhood",
        launchpadId: 7n,
        authorize: () => {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(isLaunchSdkError(thrown, "PROVIDER_NOT_DEPLOYED")).toBe(true);
    expect((thrown as { detail?: string }).detail).toContain("`registry`");
    // Base's registry defaults to the shipped record's.
    expect(() =>
      createAuthorizeHandler({
        account: signer,
        chain: "base",
        launchpadId: 7n,
        authorize: () => {},
      }),
    ).not.toThrow();
  });
});
