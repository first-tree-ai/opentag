#!/usr/bin/env node

/**
 * Ship the trusted web tools extension with the bundled CLI.
 *
 * `apps/cli` bundles `@opentag/client`, so the extension resolves relative to the CLI's own
 * built entry points (`dist/index.mjs` and `dist/cli/index.mjs`). The client build emits
 * `dist/pi-extensions/web-tools.mjs` with its source map beside it; this step copies both next to
 * each CLI entry so npm tarballs and portable artifacts carry them and the built runtime resolves
 * the extension without an environment override. The map travels with the module because the
 * module ends in a `sourceMappingURL` footer and the CLI enables source maps at startup: a footer
 * that points at nothing is a broken artifact. A missing source, module or map, is a hard failure,
 * never a silent skip.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_TOOLS_EXTENSION_FILES = ["web-tools.mjs", "web-tools.mjs.map"];
export const WEB_TOOLS_EXTENSION_DESTINATIONS = ["dist/pi-extensions", "dist/cli/pi-extensions"];

/**
 * Copy the extension module and its map from the client build into every CLI destination.
 *
 * Throws before copying anything when either artifact is missing, so a partial copy can never
 * leave one destination with a module whose map is absent.
 */
export function copyWebToolsExtension({ sourceDirectory, cliRoot }) {
  const missing = WEB_TOOLS_EXTENSION_FILES.filter((file) => !existsSync(join(sourceDirectory, file)));
  if (missing.length > 0) {
    throw new Error(
      `web tools extension artifact is missing (${missing.join(", ")}); build @opentag/client before building apps/cli`,
    );
  }
  const copied = [];
  for (const relativeDestination of WEB_TOOLS_EXTENSION_DESTINATIONS) {
    const destinationDirectory = join(cliRoot, ...relativeDestination.split("/"));
    mkdirSync(destinationDirectory, { recursive: true });
    for (const file of WEB_TOOLS_EXTENSION_FILES) {
      const destination = join(destinationDirectory, file);
      cpSync(join(sourceDirectory, file), destination);
      copied.push(destination);
    }
  }
  return copied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    copyWebToolsExtension({
      sourceDirectory: join(repositoryRoot, "packages", "client", "dist", "pi-extensions"),
      cliRoot: join(repositoryRoot, "apps", "cli"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
