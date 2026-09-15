import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStableVersion, parseStagingVersion } from "../release-versions.mjs";
import { runProcess } from "./async-process.mjs";
import { stageRunnerBuildContext } from "./build-context.mjs";
import { registerTempDir } from "./cleanup.mjs";
import { nodeImageReference, RUNNER_PINS } from "./pins.mjs";
import { assertCleanBuildAllowed, buildIdentityRecord, collectSourceTrust } from "./source-trust.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");

function fail(message) {
  throw new Error(message);
}

const DOCKER_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

async function docker(args, options = {}) {
  const result = await runProcess("docker", args, { timeoutMs: options.timeoutMs ?? DOCKER_BUILD_TIMEOUT_MS });
  if (!options.allowFailure && result.status !== 0) {
    fail(`docker ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

export function resolveBuildVersion({ channel, requestedVersion, sourceVersion }) {
  if (channel === "staging") {
    if (!requestedVersion) fail("staging builds require an externally resolved --version");
    parseStagingVersion(requestedVersion, "staging version");
    const source = parseStableVersion(sourceVersion, "source version");
    const expectedPrefix = `${source.major}.${source.minor}.${source.patch + 1}-staging.`;
    if (!requestedVersion.startsWith(expectedPrefix)) {
      fail(`staging version must match ${expectedPrefix}<run>.<attempt>, got "${requestedVersion}"`);
    }
    return requestedVersion;
  }
  if (channel === "prod") {
    const version = requestedVersion ?? sourceVersion;
    parseStableVersion(version, "production version");
    if (version !== sourceVersion) fail(`production version ${version} must match source version ${sourceVersion}`);
    return version;
  }
  if (channel === "dev") {
    const version = requestedVersion ?? sourceVersion;
    if (version !== sourceVersion) fail(`dev version ${version} must match CLI source version ${sourceVersion}`);
    return version;
  }
  fail(`channel must be dev, staging, or prod, got "${channel}"`);
}

export async function buildRunnerImage({
  repositoryRoot = REPO_ROOT,
  channel,
  version: requestedVersion,
  allowDirty = false,
  tag = "opentag-runner:local",
  dockerCommand = docker,
}) {
  const source = collectSourceTrust(repositoryRoot);
  assertCleanBuildAllowed({ sourceDirty: source.sourceDirty, allowDirty });
  const version = resolveBuildVersion({ channel, requestedVersion, sourceVersion: source.cliVersion });
  const identity = buildIdentityRecord({ channel, version, source, allowDirty });
  const staging = mkdtempSync(join(tmpdir(), "opentag-runner-context-"));
  const unregisterStaging = registerTempDir(staging);
  try {
    const context = stageRunnerBuildContext({ sourceRoot: repositoryRoot, destination: staging, identity });
    writeFileSync(join(context, "runner-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
    const result = await dockerCommand([
      "build",
      "--platform",
      RUNNER_PINS.image.platform,
      "--file",
      join(SCRIPT_DIR, "Dockerfile"),
      "--tag",
      tag,
      "--build-arg",
      `NODE_IMAGE=${nodeImageReference()}`,
      "--build-arg",
      `PNPM_VERSION=${RUNNER_PINS.pnpmVersion}`,
      "--build-arg",
      `RUNNER_CHANNEL=${channel}`,
      "--build-arg",
      `RUNNER_VERSION=${version}`,
      "--label",
      `org.opencontainers.image.revision=${source.sourceSha}`,
      "--label",
      `org.opentag.runner.version=${version}`,
      "--label",
      `org.opentag.runner.channel=${channel}`,
      "--label",
      `org.opentag.runner.source.dirty=${source.sourceDirty ? "true" : "false"}`,
      context,
    ]);
    const inspect = await dockerCommand(["image", "inspect", "--format", "{{.Id}} {{.Architecture}} {{.Size}}", tag]);
    const [imageId, architecture, size] = inspect.stdout.trim().split(/\s+/);
    return {
      identity: { ...identity, imageId },
      tag,
      imageId,
      architecture,
      size,
      stdout: result.stdout,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    unregisterStaging();
  }
}
