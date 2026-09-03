#!/usr/bin/env node

/**
 * Assembles a real portable app from the already-built release-channel CLI and exercises it end to
 * end without any network. The embedded dependency graph is materialized from the frozen install,
 * verified, and the relocated Context Tree CLI is run with an isolated home and no NODE_PATH. This
 * is the portable gate behind the CLI Pack Smoke CI job for staging and production.
 */

import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAppTemplate, getPortableChannelConfig, validateChannelVersion } from "./build-portable.mjs";
import { runContextTreeRuntimeProbe, verifyPortableDependencyGraph } from "./runtime-dependencies.mjs";

function fail(message) {
  throw new Error(message);
}

function printHelp() {
  console.log("Usage: node scripts/portable/smoke-portable-app.mjs --channel staging|prod --version <version>");
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--channel") options.channel = next();
    else if (arg === "--version") options.version = next();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!options.channel) fail("--channel is required");
  if (!options.version) fail("--version is required");
  return options;
}

export async function smokePortableApp({ channel, version }) {
  const channelConfig = getPortableChannelConfig(channel);
  validateChannelVersion(channel, version);
  const template = await createAppTemplate({ channelConfig, version });
  try {
    const summary = verifyPortableDependencyGraph(template.appDir);
    runContextTreeRuntimeProbe({
      appDir: template.appDir,
      homeDir: join(template.root, "context-tree-home"),
      nodePath: process.execPath,
      probeOpenTag: true,
    });
    console.log(
      `[portable smoke] ${channel} ${version}: ${summary.packageCount} dependency package(s) embedded; ` +
        "Context Tree runs from the relocated app",
    );
  } finally {
    await rm(template.root, { force: true, recursive: true });
  }
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  smokePortableApp(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[portable smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
