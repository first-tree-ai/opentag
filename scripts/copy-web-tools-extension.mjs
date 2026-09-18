#!/usr/bin/env node

/**
 * Ship the trusted web tools extension with the bundled CLI.
 *
 * `apps/cli` bundles `@opentag/client`, so the extension resolves relative to the CLI's own
 * built entry points (`dist/index.mjs` and `dist/cli/index.mjs`). The client build emits
 * `dist/pi-extensions/web-tools.mjs`; this step copies that exact artifact next to both CLI
 * entries so npm tarballs and portable artifacts carry it and the built runtime resolves it
 * without an environment override. Missing source is a hard failure, never a silent skip.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const source = join(repositoryRoot, "packages", "client", "dist", "pi-extensions", "web-tools.mjs");

if (!existsSync(source)) {
  console.error("web tools extension artifact is missing; build @opentag/client before building apps/cli");
  process.exit(1);
}

for (const relativeDestination of ["dist/pi-extensions/web-tools.mjs", "dist/cli/pi-extensions/web-tools.mjs"]) {
  const destination = join(repositoryRoot, "apps", "cli", ...relativeDestination.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}
