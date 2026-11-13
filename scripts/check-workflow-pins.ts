#!/usr/bin/env bun
/**
 * Pre-commit + CI guard: every remote action in `.github/workflows/` and the local
 * composite actions under `.github/actions/` must be pinned to a full commit SHA with
 * its release in a comment (`owner/repo@<40 hex> # vX.Y.Z`).
 *
 * GitHub refuses a tag-pinned run before any job starts (a `startup_failure` with no
 * log), so that workflow can't report its own failure; this check can.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A line scan, not a YAML parse: a quoted ref, or a `uses:` line inside a `run: |`
// block, is flagged too. Neither occurs in the repo; unquote the ref if one does.
const USES = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*(\S+)[ \t]*(.*)$/gm;
const PINNED_REF = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const RELEASE_COMMENT = /^# v\d+\.\d+\.\d+$/;

/** Returns `file: ref comment` for each remote `uses:` that isn't SHA-pinned with a release comment. */
export function findUnpinned(file: string, text: string): string[] {
  return [...text.matchAll(USES)]
    .map(([, ref = "", comment = ""]) => ({ ref, comment: comment.trim() }))
    .filter(({ ref }) => !ref.startsWith("./"))
    .filter(
      ({ ref, comment }) =>
        !PINNED_REF.test(ref) || !RELEASE_COMMENT.test(comment),
    )
    .map(({ ref, comment }) => `${file}: ${ref} ${comment}`.trim());
}

export function workflowFiles(root: string): string[] {
  const workflows = join(root, ".github/workflows");
  const actions = join(root, ".github/actions");
  return [
    ...readdirSync(workflows)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(".github/workflows", name)),
    ...readdirSync(actions, { recursive: true })
      .map(String)
      .filter((name) => /(^|\/)action\.ya?ml$/.test(name))
      .map((name) => join(".github/actions", name)),
  ];
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const unpinned = workflowFiles(root).flatMap((file) =>
    findUnpinned(file, readFileSync(join(root, file), "utf8")),
  );
  if (unpinned.length > 0) {
    console.error(
      "Error: every action must be pinned to a full commit SHA with its release in a comment,",
    );
    console.error("e.g. `uses: actions/checkout@<40-hex sha> # v5.1.0`:");
    for (const line of unpinned) console.error(`  ${line}`);
    process.exit(1);
  }
}
