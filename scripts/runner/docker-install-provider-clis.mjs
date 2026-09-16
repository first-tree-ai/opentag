#!/usr/bin/env node

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Buffer, writeRootOwnedFile } from "./install-tools.mjs";

const RUNTIME_BIN = "/opt/opentag/tools/bin";

export async function installCatalogProviderClis({ dest, catalogModulePath, runtimeBin = RUNTIME_BIN }) {
  const client = await import(pathToFileURL(catalogModulePath).href);
  const fetcher = client.createProviderCliFetcher();
  const plans = client.linuxAmd64ProviderCliPlans();
  // Native executables keep their upstream basename in a root-owned internal directory so the
  // reviewed catalog version patterns (`Using slack v...`) match their actual output. The
  // user-facing command in tools/bin stays the managed launcher.
  const internalDir = join(dest, "internal");
  const runtimeInternal = join(runtimeBin, "internal");
  for (const plan of plans) {
    const archive = await fetcher({
      url: plan.artifact.url,
      maxBytes: plan.artifact.archiveBytes,
      timeoutMs: 120_000,
    });
    if (archive.byteLength !== plan.artifact.archiveBytes) {
      throw new Error(`${plan.command} archive size mismatch`);
    }
    if (sha256Buffer(archive) !== plan.artifact.sha256) {
      throw new Error(`${plan.command} archive digest mismatch`);
    }
    const extracted = client.extractProviderCliExecutable(archive, {
      expectedExecutable: plan.artifact.executablePath,
      maxExtractedBytes: plan.artifact.maxExtractedBytes,
      maxExecutableBytes: plan.artifact.executableBytes,
    });
    if (sha256Buffer(extracted.content) !== plan.artifact.executableSha256) {
      throw new Error(`${plan.command} executable digest mismatch`);
    }
    writeRootOwnedFile(join(internalDir, plan.command), extracted.content);
    const launcher = client.renderProviderCliLauncher(plan.entry, {
      kind: "managed",
      artifactId: plan.artifact.executableSha256,
      version: plan.version,
      targetPath: join(runtimeInternal, plan.command),
      fingerprint: `v1:${plan.artifact.executableSha256}`,
    });
    writeRootOwnedFile(join(dest, plan.command), launcher);
  }
  return plans;
}

async function main() {
  const dest = process.argv[2];
  const catalogModulePath = process.argv[3];
  if (!dest || !catalogModulePath) throw new Error("usage: docker-install-provider-clis.mjs <dest> <catalog-module>");
  await installCatalogProviderClis({ dest, catalogModulePath });
}

const isProcessEntry = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isProcessEntry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
