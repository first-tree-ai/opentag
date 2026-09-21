/**
 * Captures the pull-request patch for the changed-line coverage gate.
 *
 * A large pull request's patch can exceed the default ~1 MiB spawn buffer, so git's stdout
 * streams straight into a private temporary file and is
 * read back for the evaluator: no Node buffer holds the diff while git runs, there is no raised
 * or unbounded maxBuffer, git failures stay fail closed, and the temporary file is always
 * removed. The merge-base comparison (`<base>...HEAD`) is exactly the one the gate has always
 * enforced.
 */

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/;

export function captureMergeBaseDiff({ baseSha, repositoryRoot = process.cwd() }) {
  if (typeof baseSha !== "string" || !FULL_SHA.test(baseSha)) {
    throw new Error("A full 40-character base SHA is required to compare the pull request");
  }
  const directory = mkdtempSync(join(tmpdir(), "opentag-patch-diff-"));
  try {
    const diffPath = join(directory, "patch.diff");
    const descriptor = openSync(diffPath, "w");
    let result;
    try {
      result = spawnSync("git", ["diff", "--unified=0", "--no-color", "--find-renames", `${baseSha}...HEAD`], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", descriptor, "pipe"],
      });
    } finally {
      closeSync(descriptor);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
      throw new Error(`git diff ${baseSha}...HEAD failed${detail ? `: ${detail}` : ` with exit ${result.status}`}`);
    }
    return readFileSync(diffPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
