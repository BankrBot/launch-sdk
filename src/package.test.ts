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

  // Which contract set a client is on is the SDK's business. A sentence it can show a caller (a message, a detail)
  // says "suite" only where the caller chose the earlier contracts, or is told the option that reaches them.
  test("no sentence the SDK can show a caller says suite, the `suite: 3` paths aside", () => {
    const allowed = (file: string, text: string) =>
      /suite: 3/.test(text) ||
      SUITE_3_ONLY.some(([f, has]) => file === f && text.includes(has));
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const name = relative(SRC, file);
      if (name.startsWith("abis")) continue;
      for (const text of proseLiterals(readFileSync(file, "utf8")))
        if (/suite/i.test(text) && !allowed(name, text))
          offenders.push(`${name}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the scan reads sentences and nothing else: no comment, name, path or template expression", () => {
    const source = [
      'import { x } from "./suite4/plan.js";',
      "// a suite in a comment",
      "/* another suite */",
      'const name = "isSuite";',
      "const said = `Launches on ${suite ? `the ${chain} suite` : chain} are closed.`;",
      "const quoted = 'it\\'s a suite here';",
    ].join("\n");
    expect(proseLiterals(source)).toEqual([
      "the   suite",
      "Launches on   are closed.",
      "it's a suite here",
    ]);
  });
});

/** Sentences a `suite: 3` client alone reaches, by file and a phrase of theirs. */
const SUITE_3_ONLY: ReadonlyArray<readonly [file: string, has: string]> = [
  // An option of the latest contracts named on a client that asked for the earlier ones.
  ["normalize.ts", "this chain's suite takes no such option"],
  // A caller's range with one end; the frozen-terms lookup removes the fallback and this sentence with it.
  ["settings/coinTerms.ts", "the suite's deploy block"],
];

/** Every string and template literal with a space in it (a sentence, not a name or a path), comments left out. */
function proseLiterals(source: string): string[] {
  const found: string[] = [];
  // What the scanner is inside, innermost last: a literal (its quote and its text so far), or a template's `${ }`.
  const inside: Array<{ quote: string; text: string }> = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const top = inside.at(-1);
    if (top === undefined || top.quote === "{") {
      const skipTo = source.startsWith("//", i)
        ? source.indexOf("\n", i)
        : source.startsWith("/*", i)
          ? source.indexOf("*/", i) + 1
          : i;
      if (skipTo < i) break;
      if (skipTo > i) i = skipTo;
      else if (c === '"' || c === "'" || c === "`")
        inside.push({ quote: c, text: "" });
      else if (c === "{" && top) inside.push({ quote: "{", text: "" });
      else if (c === "}" && top) inside.pop();
    } else if (c === "\\") top.text += source[++i] ?? "";
    else if (c === top.quote) {
      inside.pop();
      if (top.text.includes(" ")) found.push(top.text);
    } else if (top.quote === "`" && source.startsWith("${", i)) {
      inside.push({ quote: "{", text: "" });
      top.text += " ";
      i++;
    } else top.text += c;
  }
  return found;
}
