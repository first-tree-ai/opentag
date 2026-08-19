#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const noticePath = resolve(projectRoot, "apps/cli/THIRD_PARTY_NOTICES");
const bundledPackages = [
  { name: "commander", consumerManifest: "apps/cli/package.json" },
  {
    name: "pino",
    consumerManifest: "packages/client/package.json",
    bundledDependencies: [
      "@pinojs/redact",
      "atomic-sleep",
      "on-exit-leak-free",
      "pino-std-serializers",
      "quick-format-unescaped",
      "safe-stable-stringify",
      "sonic-boom",
      "thread-stream",
    ],
  },
  { name: "ws", consumerManifest: "apps/cli/package.json" },
  { name: "zod", consumerManifest: "packages/shared/package.json" },
];

async function readLicense(packageDirectory) {
  for (const filename of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    try {
      return (await readFile(resolve(packageDirectory, filename), "utf8")).trimEnd();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error(`no license file found in ${packageDirectory}`);
}

function repositoryUrl(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  return value?.replace(/^git\+/, "").replace(/\.git$/, "") ?? "unknown";
}

async function findPackageManifest(packageRequire, packageName) {
  let directory = dirname(packageRequire.resolve(packageName));
  for (;;) {
    const manifestPath = resolve(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.name === packageName) {
        return { manifest, manifestPath };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`could not locate package manifest for ${packageName}`);
    }
    directory = parent;
  }
}

export async function generateThirdPartyNotices() {
  const sections = [];
  for (const bundledPackage of bundledPackages) {
    const consumerPath = resolve(projectRoot, bundledPackage.consumerManifest);
    const packageRequire = createRequire(pathToFileURL(consumerPath));
    const rootPackage = await findPackageManifest(packageRequire, bundledPackage.name);
    await appendNotice(sections, rootPackage);
    const dependencyRequire = createRequire(pathToFileURL(rootPackage.manifestPath));
    for (const dependency of bundledPackage.bundledDependencies ?? []) {
      await appendNotice(sections, await findPackageManifest(dependencyRequire, dependency));
    }
  }

  return `OpenTag Third-Party Notices\n\nThis distribution includes source code from the following packages.\n\n${sections.join("\n\n---\n\n")}\n`;
}

async function appendNotice(sections, { manifest, manifestPath }) {
  const license = await readLicense(dirname(manifestPath));
  sections.push(
    `## ${manifest.name}@${manifest.version}\n\nSource: ${repositoryUrl(manifest.repository)}\nLicense: ${manifest.license}\n\n${license}`,
  );
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  const generated = await generateThirdPartyNotices();
  if (mode === "--write") {
    await writeFile(noticePath, generated);
    console.log(`Wrote ${noticePath}`);
    return;
  }
  if (mode !== "--check") {
    throw new Error("usage: third-party-notices.mjs [--check|--write]");
  }

  const committed = await readFile(noticePath, "utf8");
  if (committed !== generated) {
    throw new Error(
      "apps/cli/THIRD_PARTY_NOTICES does not match bundled dependency versions and licenses; run pnpm notices:write",
    );
  }
  console.log("Verified CLI third-party notices");
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(`[third-party-notices] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
