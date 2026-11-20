import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Abi } from "viem";
import {
  EXTENSION_PRESETS,
  LAUNCH_OPTION_BITS,
  PAD_FLAGS,
  SETTINGS_KNOBS,
} from "./knobs.js";
import * as generated from "./settings.js";
import manifest from "./settingsManifest.json";

/** Core's manifest convention: sha256 of the value's 2-space JSON and a newline. */
const sha256 = (value: unknown): string =>
  `0x${new Bun.CryptoHasher("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex")}`;

const functions = (abi: Abi) =>
  new Set(abi.flatMap((e) => (e.type === "function" ? [e.name] : [])));

describe("generated settings ABIs match their manifest (edit only via scripts/gen-settings-abis.ts)", () => {
  test("every export hashes to settingsManifest.abis, and nothing is missing or extra", () => {
    const exported = Object.entries(generated);
    expect(exported.map(([n]) => n).sort()).toEqual(
      Object.keys(manifest.abis).sort(),
    );
    for (const [name, abi] of exported)
      expect(sha256(abi), name).toBe(
        manifest.abis[name as keyof typeof manifest.abis],
      );
  });

  test("the module header names its source and solc, so every regen shows up in the diff", async () => {
    const head = (await Bun.file(join(import.meta.dir, "settings.ts")).text())
      .split("\n")
      .slice(0, 3)
      .join("\n");
    expect(head).toContain(manifest.source);
    expect(head).toContain(manifest.solc);
  });

  test("the knob table hashes to the manifest: ids run from 0 with no gap, every bit and id is its own", () => {
    const table = {
      knobs: SETTINGS_KNOBS.map((k) => ({
        ...k,
        hardMin: k.hardMin.toString(),
        hardMax: k.hardMax.toString(),
      })),
      flags: PAD_FLAGS,
      options: LAUNCH_OPTION_BITS,
      presets: EXTENSION_PRESETS,
    };
    expect(sha256(table)).toBe(manifest.knobTable);
    expect<number[]>(SETTINGS_KNOBS.map((k) => k.id)).toEqual(
      SETTINGS_KNOBS.map((_, i) => i),
    );
    for (const k of SETTINGS_KNOBS)
      expect(k.hardMin <= k.hardMax, k.name).toBe(true);
    expect(new Set(SETTINGS_KNOBS.map((k) => k.name)).size).toBe(
      SETTINGS_KNOBS.length,
    );
    expect(new Set(PAD_FLAGS.map((f) => f.bit)).size).toBe(PAD_FLAGS.length);
    expect(EXTENSION_PRESETS.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  test("the setters, reads and events the builders use are on the vendored ABIs", () => {
    const settings = functions(generated.bankrLaunchSettingsAbi);
    for (const n of [
      "configure",
      "setKnobs",
      "setProtocolTerms",
      "setLimits",
      "padConfig",
      "resolve",
      "hardBounds",
    ])
      expect(settings.has(n), n).toBe(true);
    const factory = functions(generated.bankrLaunchFactoryAbi);
    for (const n of [
      "setHolderLeg",
      "setHook",
      "setTreasury",
      "termsHashOf",
      "settings",
    ])
      expect(factory.has(n), n).toBe(true);
    expect(
      generated.bankrLaunchFactoryAbi.some(
        (e) => e.type === "event" && e.name === "CoinTermsFrozen",
      ),
    ).toBe(true);
    const lens = functions(generated.bankrTermsLensAbi);
    expect(lens.has("coinTerms") && lens.has("coinTermsMatch")).toBe(true);
    const leg = functions(generated.bnkrHolderLegAbi);
    for (const n of ["legTerms", "routes", "converts", "poke"])
      expect(leg.has(n), n).toBe(true);
  });
});
