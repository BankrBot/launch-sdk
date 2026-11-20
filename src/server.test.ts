import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isLaunchSdkError } from "./errors.js";
import * as root from "./index.js";
import * as server from "./server.js";
import { createAuthorizeHandler, padAuthorizer } from "./server.js";

// A throwaway key for signing tests only.
const signer = privateKeyToAccount(`0x${"42".repeat(32)}`);
const REGISTRY = getAddress("0x0000000000000000000000000000000000008008");

const post = (body: unknown, headers?: HeadersInit) =>
  new Request("https://pad.example/api/launch/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A handler that counts what reaches `authorize`: nothing malformed, oversized or of another type may. */
function handler() {
  const seen = { authorized: 0 };
  const handle = createAuthorizeHandler({
    account: signer,
    chain: "base",
    launchpadId: 7n,
    registry: REGISTRY,
    authorize: () => void seen.authorized++,
  });
  return { handle, seen };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function inBrowser<T>(fn: () => T): T {
  Object.assign(globalThis, { window: {}, document: {} });
  try {
    return fn();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
}

describe("the server entry", () => {
  test("re-exports the root API and adds the helpers that hold a launchpad signer's key", () => {
    const added = Object.keys(server).filter((k) => !(k in root));
    expect(added.sort()).toEqual([
      "createAuthorizeHandler",
      "padAuthorizer",
      "signLaunchAuthorization",
    ]);
    for (const name of Object.keys(root))
      expect(name in server, name).toBe(true);
  });

  test("API_KEY_IN_BROWSER: the handler and padAuthorizer refuse to run in a browser", () => {
    const makers: (() => unknown)[] = [
      () =>
        createAuthorizeHandler({
          account: signer,
          chain: "base",
          launchpadId: 7n,
          authorize: () => {},
        }),
      () => padAuthorizer({ account: signer }),
    ];
    for (const make of makers) {
      const err = thrownBy(() => inBrowser(make));
      expect(isLaunchSdkError(err, "API_KEY_IN_BROWSER")).toBe(true);
      expect(thrownBy(make)).toBeUndefined();
    }
  });
});

describe("createAuthorizeHandler: what reaches the key", () => {
  test("only POST, a body that is this pad's request, and at most 16 KiB", async () => {
    const { handle, seen } = handler();
    const get = await handle(new Request("https://pad.example/a"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await handle(post("{not json"))).status).toBe(400);
    expect((await handle(post("[1,2]"))).status).toBe(400);
    expect((await handle(post({ name: "x".repeat(17 * 1024) }))).status).toBe(
      413,
    );
    // The limit counts bytes: 6,000 three-byte characters are about 18 KB.
    expect((await handle(post({ name: "€".repeat(6_000) }))).status).toBe(413);
    expect(seen.authorized).toBe(0);
  });

  test("only application/json: a text/plain or form body (a CORS-simple request, no preflight) is a 415", async () => {
    const { handle, seen } = handler();
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
    ]) {
      const res = await handle(post({}, { "content-type": type }));
      expect(res.status, type).toBe(415);
    }
    // The type is matched whatever its case or charset: this body is JSON, just not a request.
    const charset = await handle(
      post({}, { "content-type": "Application/JSON; charset=utf-8" }),
    );
    expect(charset.status).toBe(400);
    expect(seen.authorized).toBe(0);
  });

  test("a streamed body with no Content-Length is cut off past 16 KiB, before authorize runs", async () => {
    const { handle, seen } = handler();
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 10 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request("https://pad.example/api/launch/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    expect((await handle(req)).status).toBe(413);
    expect(pulled).toBeLessThan(64 * 1024);
    expect(seen.authorized).toBe(0);
  });
});
