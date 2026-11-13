import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import pkg from "../package.json";

const PKG_ROOT = join(import.meta.dir, "..");
const SRC = join(PKG_ROOT, "src");

/** Files that ship: everything under src/ except tests and the monorepo-only parity suite. */
function shippedSources(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => !f.split(/[\\/]/).includes("__internal__"))
    .map((f) => join(SRC, f));
}

// Statement-anchored: ABI string literals such as `name: "from"` must not read as imports.
const SPECIFIER =
  /^\s*(?:import|export)\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm;

describe("package manifest", () => {
  test("zero runtime dependencies; viem is a ^2 peer and a dev dependency", () => {
    const manifest = pkg as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.bundleDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ viem: pkg.peerDependencies.viem });
    expect(pkg.peerDependencies.viem).toMatch(/^\^2\.\d+\.\d+$/);
    expect(pkg.devDependencies.viem).toBe(pkg.peerDependencies.viem);
  });

  test("ESM on Node >= 22 with exactly the root and ./server entries", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.engines).toEqual({ node: ">=22" });
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./package.json",
      "./server",
    ]);
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(pkg.exports["./server"]).toEqual({
      types: "./dist/server.d.ts",
      import: "./dist/server.js",
    });
    expect(pkg.sideEffects).toBe(false);
  });

  test("the build's compiler is a declared dev dependency, so a standalone install can build", () => {
    // The public repo installs only this manifest; no monorepo root hoists tsc there.
    expect(pkg.scripts.build).toMatch(/^tsc\s/);
    const devDeps: Record<string, string> = pkg.devDependencies;
    expect(devDeps.typescript).toMatch(/^\^5\.\d+\.\d+$/);
  });

  test("public MIT package pointing at BankrBot/launch-sdk", () => {
    expect(pkg.name).toBe("@bankr/launch-sdk");
    expect(pkg.license).toBe("MIT");
    expect(readFileSync(join(PKG_ROOT, "LICENSE"), "utf8")).toStartWith(
      "MIT License",
    );
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.repository.url).toBe(
      "git+https://github.com/BankrBot/launch-sdk.git",
    );
    expect((pkg as Record<string, unknown>).private).toBeUndefined();
  });
});

describe("shipped source", () => {
  test("imports only relative .js modules and viem (no workspace packages, no node: builtins)", () => {
    const files = shippedSources();
    expect(files.length).toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const file of files) {
      for (const [, a, b] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
        const spec = a ?? b ?? "";
        const relativeOk = /^\.\.?\//.test(spec) && spec.endsWith(".js");
        const viemOk = spec === "viem" || spec.startsWith("viem/");
        if (!relativeOk && !viemOk)
          offenders.push(`${relative(PKG_ROOT, file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
