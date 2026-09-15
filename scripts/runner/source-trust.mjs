import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_CONFIG } from "../channel-config.mjs";
import { prepareCliRelease } from "../prepare-cli-release.mjs";
import { RUNNER_PINS } from "./pins.mjs";

function git(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

export function collectSourceTrust(repositoryRoot) {
  const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const porcelain = git(repositoryRoot, ["status", "--porcelain"]);
  const cliManifest = JSON.parse(readFileSync(join(repositoryRoot, "apps/cli/package.json"), "utf8"));
  return {
    sourceSha,
    sourceDirty: porcelain.length > 0,
    cliVersion: cliManifest.version,
    cliPackageName: cliManifest.name,
    contextTreeVersion: cliManifest.dependencies["@first-tree-ai/context-tree"],
  };
}

export async function applyReleaseCoordinate({ channel, version, manifest }) {
  const directory = mkdtempSync(join(tmpdir(), "opentag-runner-release-"));
  const manifestPath = join(directory, "package.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    const prepared = await prepareCliRelease({ channel, version, manifestPath, buildInfoPath: undefined });
    return { prepared, manifestPath, directory };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function assertCleanBuildAllowed({ sourceDirty, allowDirty }) {
  if (sourceDirty && allowDirty !== true) {
    throw new Error("source tree is dirty; pass --allow-dirty for a development image, or build from a clean tree");
  }
}

export function buildIdentityRecord({ channel, version, source, imageId, allowDirty = false }) {
  assertCleanBuildAllowed({ sourceDirty: source.sourceDirty, allowDirty });
  const channelConfig = CHANNEL_CONFIG[channel];
  if (!channelConfig) throw new Error(`unknown channel ${channel}`);
  return {
    schemaVersion: 1,
    channel,
    version,
    sourceSha: source.sourceSha,
    sourceDirty: source.sourceDirty,
    cliPackageName: channelConfig.packageName,
    cliBinName: channelConfig.binName,
    nodeVersion: RUNNER_PINS.nodeVersion,
    pnpmVersion: RUNNER_PINS.pnpmVersion,
    piPackage: RUNNER_PINS.piPackage,
    piVersion: RUNNER_PINS.piVersion,
    contextTreeVersion: source.contextTreeVersion,
    toolLock: {
      node: RUNNER_PINS.nodeVersion,
      pnpm: RUNNER_PINS.pnpmVersion,
      piPackage: RUNNER_PINS.piPackage,
      piVersion: RUNNER_PINS.piVersion,
      git: RUNNER_PINS.git.debian,
      gh: RUNNER_PINS.gh.version,
    },
    ...(imageId ? { imageId } : {}),
  };
}
