#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCliPackSmoke } from "./cli-pack-smoke.mjs";

async function main() {
  const rootManifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve("apps/cli/package.json"), "utf8"));
  const binaries = Object.keys(manifest.bin ?? {});

  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || binaries.length !== 1) {
    throw new Error("apps/cli/package.json must declare a name, version, and exactly one binary");
  }
  if (manifest.engines?.node !== rootManifest.engines?.node) {
    throw new Error("the CLI and root Node.js engine ranges must match");
  }

  await runCliPackSmoke({
    channel: "source",
    expectedName: manifest.name,
    expectedVersion: manifest.version,
    expectedBinary: binaries[0],
  });
}

main().catch((error) => {
  console.error(`[node-compat-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
