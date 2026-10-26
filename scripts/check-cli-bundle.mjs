#!/usr/bin/env node

/**
 * Fail the CLI build when a workspace package stays external in the bundle.
 *
 * The Cloud Runner image ships `apps/cli/dist` alone (`scripts/runner/assemble-runtime.mjs`), so a
 * bare `@opentag/...` import left in that bundle is a production `ERR_MODULE_NOT_FOUND`. tsdown
 * externalizes a workspace package it cannot resolve and only warns, which is how
 * `@opentag/mcp-presets` reached a Runner image whose build step never built it: the warning scrolled
 * past, and the artifact looked complete.
 *
 * The check intersects the bundle's bare imports with this package's `workspace:` dependencies, so it
 * names exactly the packages that must be inlined and cannot trip over prose that happens to look
 * like an import. A published dependency is meant to stay external — its own `dependencies` entry
 * ships beside `dist` — and is not a workspace range.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanBarePackageImports } from "./runner/runtime-closure.mjs";

/** Package names this manifest expects the bundler to inline: its `workspace:` dependencies. */
export function workspaceDependencyNames(manifest) {
  const names = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === "string" && range.startsWith("workspace:")) names.push(name);
    }
  }
  return names.sort();
}

/** Workspace packages that a shipped `dist` still imports by name instead of carrying inline. */
export function leakedWorkspaceImports({ distDirectory, manifestPath }) {
  const expected = new Set(workspaceDependencyNames(JSON.parse(readFileSync(manifestPath, "utf8"))));
  return scanBarePackageImports(distDirectory).filter((name) => expected.has(name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "cli");
  const leaked = leakedWorkspaceImports({
    distDirectory: join(cliRoot, "dist"),
    manifestPath: join(cliRoot, "package.json"),
  });
  if (leaked.length > 0) {
    console.error(
      `apps/cli/dist imports these workspace packages instead of bundling them: ${leaked.join(", ")}. ` +
        "Build them before building apps/cli, so the bundler can resolve and inline them.",
    );
    process.exit(1);
  }
}
