import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
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

  // The SDK knows one contract set per chain, so nothing that ships says which: no identifier, message or comment
  // (comments reach `dist/` in the .js and .d.ts files). The contracts' own ABI names are theirs to keep.
  test("nothing in shipped source names an old contract set, the contracts' own ABI names aside", () => {
    const ABI_NAMES =
      /\b(?:_?isSuite|setSuite|SuiteAlreadySet|SuiteUnset|SuiteAddrs)\b/g;
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [i, line] of lines.entries())
        if (/suite/i.test(line.replace(ABI_NAMES, "")))
          offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});

// Comments and test titles are all a reader sees of how the code was made, so neither may carry the labels of an
// internal review or an old contract-set name. Patterns are written so their own source does not match them.
const LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[Rr]ound [0-9]/, "a review round"],
  [/\b(?:RSEC|ISO|ADM|OPS|REG|NS|FD|CA-OFF|GAS|FACTORY)-[0-9]/, "a finding id"],
  [/\bR[0-9]+-[0-9A-Z]|\bFF[0-9]|\bQ[0-9]\b|\bF[0-9]\b/, "a finding id"],
  [/\b[Aa]udit (?:r[0-9]|[A-Z]+-)/, "an audit label"],
  [/\b[Ii]nternal round|\b[A-Z][0-9]'s review/, "a review round"],
  [
    /\b[Dd]eparture [0-9]|\b[Pp]lan item|\bH[0-9]{1,2}\b|\bP[0-9][a-z]\b/,
    "a plan reference",
  ],
  [/\b[Ff]inding [0-9]|\b[Ll]ive-fork finding/, "a finding reference"],
  [/\b[Dd]ecision [0-9]|\b[Bb]atch [A-Z]\b/, "a decision or batch label"],
  [/\b[Ff]ounder|\bruling\b/, "a person's decision"],
  [/\b[Ss]uites?\b/, "an old contract-set name"],
  [/§|\bdesign (?:note|section)\b/, "a design-doc reference"],
  [/\B#[0-9]{4}\b/, "a pull request number"],
];
const ABI_NAMES =
  /\b(?:_?isSuite|setSuite|SuiteAlreadySet|SuiteUnset|SuiteAddrs)\b/g;

/** Every .ts file the export ships, by its own test or fake status: shipped source, tests, hand-written fakes. */
function exportedTs(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("abis/"))
    .filter((f) => {
      const parts = f.split(/[\\/]/);
      if (!parts.includes("__internal__")) return true;
      return (
        /^fake\w+\.ts$/.test(parts[parts.length - 1] ?? "") &&
        parts.length === 2
      );
    })
    .map((f) => join(SRC, f));
}

/** The comment text and test titles of a file, each with its line; code tokens are not scanned. */
function proseOf(file: string): Array<{ line: number; text: string }> {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = new Map<number, { line: number; text: string }>();
  const add = (pos: number, end: number) => {
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
    out.set(pos, { line, text: text.slice(pos, end) });
  };
  const visit = (node: ts.Node) => {
    for (const r of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ])
      add(r.pos, r.end);
    if (ts.isCallExpression(node)) {
      let callee = node.expression;
      while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
      const title = node.arguments[0];
      if (
        ts.isIdentifier(callee) &&
        /^(?:describe|test|it)$/.test(callee.text) &&
        title &&
        (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))
      )
        add(title.getStart(sf), title.getEnd());
    }
    // getChildren reaches every token, so a comment after a comma or brace is some token's leading trivia.
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return [...out.values()];
}

describe("exported wording", () => {
  test("no comment or test title in an exported file carries an internal review label or an old contract-set name", () => {
    const files = exportedTs();
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files)
      for (const { line, text } of proseOf(file)) {
        // Wording about the tests themselves ("test suite", "parity suite") is allowed.
        const prose = text
          .replace(ABI_NAMES, "")
          .replace(/\b(?:test|parity|spec) suites?\b/gi, "");
        for (const [re, why] of LABELS)
          if (re.test(prose))
            offenders.push(
              `${relative(SRC, file)}:${line}: ${why}: ${prose.trim().slice(0, 100)}`,
            );
      }
    expect(offenders).toEqual([]);
  });
});
