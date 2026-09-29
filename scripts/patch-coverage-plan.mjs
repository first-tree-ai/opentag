import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureMergeBaseChangedPaths } from "./patch-diff.mjs";
import { isSupportedSourcePath } from "./unit-coverage-gate.mjs";

export function requiresPatchCoverage(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path)) {
    throw new Error("Changed paths must be an array of nonempty strings");
  }
  return paths.some(isSupportedSourcePath);
}

export function main() {
  const paths = captureMergeBaseChangedPaths({ baseSha: process.env.BASE_SHA });
  const required = requiresPatchCoverage(paths);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `required=${required}\n`);
  console.log(
    required ? "Patch coverage requires fresh measurement." : "Patch coverage: no coverable source files changed.",
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
