#!/usr/bin/env node

/**
 * Unified Runner release helper.
 *
 * `publish` runs inside the CLI release workflow, from a clean checkout of the exact source being
 * published, before prepare-cli-release rewrites the manifest. It either reuses an existing
 * immutable tag (verified against the registry, never overwritten) or builds, offline-smokes, and
 * pushes the CLI-matched Runner image, then re-reads the registry to verify what landed.
 *
 * `resolve` is read-only: it verifies that a CLI release (npm `gitHead`) and its Runner image
 * (registry labels, digest-verified) agree on channel, version, and source, and emits the release
 * record a deployment may act on. Any incomplete or contradictory release fails closed. Because
 * npm processes a publish asynchronously, the exact-version metadata lookup allows one small
 * bounded wait for the not-yet-visible E404; every other lookup failure stays immediately fatal.
 *
 * Credentials (gcloud access token) live only in process memory; the release record written to
 * `--output` holds no secrets and must live outside the source checkout.
 */

import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHANNEL_CONFIG } from "../channel-config.mjs";
import { runOfflineSmoke } from "../e2e/runner-toolchain/offline-smoke.mjs";
import { compareReleaseVersions } from "../release-versions.mjs";
import { classifyPublishedMetadataLookup } from "../resolve-staging-release.mjs";
import { buildRunnerImage, resolveBuildVersion } from "./build-image.mjs";
import {
  lookupRunnerTag,
  parseGarRepository,
  readGcloudAccessToken,
  runLocalCommand,
  verifyRunnerIdentity,
} from "./gar.mjs";
import {
  assertChannel,
  assertChannelVersion,
  assertFullSha,
  formatReleaseRecord,
  readReleaseRecord,
  writeReleaseRecord,
} from "./release-record.mjs";
import { collectSourceTrust } from "./source-trust.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

const DOCKER_TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
const SMOKE_PREFIX = "opentag-runner-release";
const NPM_METADATA_WAIT_DEADLINE_MS = 5 * 60 * 1000;
const NPM_METADATA_WAIT_INTERVAL_MS = 15_000;

const defaultSleep = (milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds));

function defaultNpmView(args) {
  const result = spawnSync("npm", ["view", ...args], { encoding: "utf8", timeout: 60_000 });
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ""),
  };
}

function assertOutputOutsideCheckout(output, repositoryRoot) {
  const resolved = resolve(output);
  const root = resolve(repositoryRoot);
  if (resolved === root || resolved.startsWith(`${root}${sep}`)) {
    throw new Error("--output must be a path outside the source checkout");
  }
  return resolved;
}

async function dockerTransfer({ verb, reference, runCommand }) {
  const result = await runCommand("docker", [verb, reference], { timeoutMs: DOCKER_TRANSFER_TIMEOUT_MS });
  if (result.status !== 0) {
    throw new Error(`docker ${verb} ${reference} failed with status ${result.status}`);
  }
}

function assertPublishSource({ source, sourceSha, channel, version }) {
  if (source.sourceSha !== sourceSha) {
    throw new Error(`--source-sha ${sourceSha} does not match HEAD ${source.sourceSha}`);
  }
  if (source.sourceDirty) {
    throw new Error("source tree is dirty; publish requires a clean checkout of the exact release source");
  }
  resolveBuildVersion({ channel, requestedVersion: version, sourceVersion: source.cliVersion });
}

/**
 * Publishes (or reuses) the Runner image for a CLI release and returns the release record.
 * The immutable tag is the release version; an existing tag is verified and reused, never
 * overwritten.
 */
export async function publishRunnerRelease({
  image,
  channel,
  version,
  sourceSha,
  output,
  repositoryRoot = REPO_ROOT,
  fetchImpl,
  runCommand = runLocalCommand,
  readSource = collectSourceTrust,
  build = buildRunnerImage,
  smoke = runOfflineSmoke,
}) {
  const repository = parseGarRepository(image);
  assertChannel(channel);
  assertChannelVersion(channel, version);
  assertFullSha(sourceSha, "--source-sha");
  const outputPath = assertOutputOutsideCheckout(output, repositoryRoot);
  assertPublishSource({ source: readSource(repositoryRoot), sourceSha, channel, version });

  const accessToken = await readGcloudAccessToken({ runCommand });
  const expected = { channel, version, sourceSha };
  const existing = await lookupRunnerTag({ repository, tag: version, accessToken, fetchImpl });
  let digest;
  if (existing.present) {
    await verifyRunnerIdentity({ repository, root: existing, expected, accessToken, fetchImpl });
    const pinned = `${image}@${existing.digest}`;
    await dockerTransfer({ verb: "pull", reference: pinned, runCommand });
    await smoke({ image: pinned, prefix: SMOKE_PREFIX });
    digest = existing.digest;
  } else {
    const tag = `${image}:${version}`;
    const built = await build({ repositoryRoot, channel, version, allowDirty: false, tag });
    if (built.architecture !== "amd64") {
      throw new Error(`the built Runner image architecture is ${built.architecture ?? "?"}, expected amd64`);
    }
    await smoke({ image: tag, prefix: SMOKE_PREFIX });
    await dockerTransfer({ verb: "push", reference: tag, runCommand });
    const published = await lookupRunnerTag({ repository, tag: version, accessToken, fetchImpl });
    if (!published.present) {
      throw new Error(`the pushed tag ${tag} is not readable back from the registry`);
    }
    await verifyRunnerIdentity({ repository, root: published, expected, accessToken, fetchImpl });
    digest = published.digest;
  }

  const record = formatReleaseRecord({ channel, version, sourceSha, repository: image, digest });
  await writeReleaseRecord(outputPath, record);
  return { ...record, reused: existing.present };
}

/** npm publish processing can briefly hide a just-published version; only that exact E404 retries. */
function isNpmVersionNotFound(result) {
  return result.status !== 0 && /\bE404\b/.test(result.stderr);
}

async function lookupNpmGitHead({ npmView, packageName, version, sleep, deadlineMs, intervalMs, now }) {
  const args = [`${packageName}@${version}`, "version", "gitHead", "--json"];
  const deadline = now() + deadlineMs;
  let result = await npmView(args);
  while (isNpmVersionNotFound(result)) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
    result = await npmView(args);
  }
  return assertFullSha(classifyPublishedMetadataLookup({ ...result, expectedVersion: version }).gitHead, "npm gitHead");
}

/** One public registry read instead of a subprocess per historical release. */
async function readNpmVersions(packageName) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`npm registry metadata failed with status ${response.status}`);
  const packument = await response.json();
  if (!packument?.versions || typeof packument.versions !== "object") {
    throw new Error("npm registry metadata is missing versions");
  }
  return Object.values(packument.versions);
}

/** Highest channel-valid published version whose npm gitHead is the requested source SHA. */
async function findVersionForSourceSha({ npmVersions, packageName, channel, sourceSha }) {
  const entries = await npmVersions(packageName);
  const versions = entries
    .filter((entry) => entry?.gitHead === sourceSha)
    .map((entry) => assertChannelVersion(channel, entry.version, `published ${channel} version`));
  const version = versions.sort(compareReleaseVersions).at(-1);
  if (!version) throw new Error(`no published ${channel} version of ${packageName} has gitHead ${sourceSha}`);
  return version;
}

function assertMetadataMatches({ metadata, channel, image, version }) {
  if (metadata.channel !== channel) {
    throw new Error(`release metadata channel is "${metadata.channel}", expected "${channel}"`);
  }
  if (metadata.repository !== image) {
    throw new Error(`release metadata image repository is "${metadata.repository}", expected "${image}"`);
  }
  if (version && metadata.version !== version) {
    throw new Error(`release metadata version is "${metadata.version}", expected "${version}"`);
  }
}

/**
 * Verifies a published release for deployment. npm gitHead, registry labels, and any supplied
 * metadata/source-sha must all agree on the exact source; the registry tag must exist with a
 * verified digest. Never picks a "latest" from a different source.
 */
export async function resolveRunnerRelease({
  image,
  channel,
  version,
  sourceSha,
  metadata: metadataPath,
  output,
  repositoryRoot = REPO_ROOT,
  fetchImpl,
  runCommand = runLocalCommand,
  npmView = defaultNpmView,
  npmVersions = readNpmVersions,
  sleep = defaultSleep,
  deadlineMs = NPM_METADATA_WAIT_DEADLINE_MS,
  intervalMs = NPM_METADATA_WAIT_INTERVAL_MS,
  now = Date.now,
}) {
  const repository = parseGarRepository(image);
  assertChannel(channel);
  if (version) assertChannelVersion(channel, version);
  if (sourceSha) assertFullSha(sourceSha, "--source-sha");
  const outputPath = assertOutputOutsideCheckout(output, repositoryRoot);
  if (!version && !sourceSha && !metadataPath) {
    throw new Error("resolve requires --version, --source-sha, or --metadata");
  }
  const metadata = metadataPath ? await readReleaseRecord(metadataPath, "release metadata") : null;
  if (metadata) assertMetadataMatches({ metadata, channel, image, version });

  const packageName = CHANNEL_CONFIG[channel].packageName;
  const targetVersion =
    version ?? metadata?.version ?? (await findVersionForSourceSha({ npmVersions, packageName, channel, sourceSha }));
  const gitHead = await lookupNpmGitHead({
    npmView,
    packageName,
    version: targetVersion,
    sleep,
    deadlineMs,
    intervalMs,
    now,
  });
  if (sourceSha && gitHead !== sourceSha) {
    throw new Error(`npm gitHead for ${packageName}@${targetVersion} is ${gitHead}, expected ${sourceSha}`);
  }
  if (metadata && gitHead !== metadata.sourceSha) {
    throw new Error(
      `npm gitHead for ${packageName}@${targetVersion} is ${gitHead}, expected release metadata source ${metadata.sourceSha}`,
    );
  }

  const accessToken = await readGcloudAccessToken({ runCommand });
  const tag = await lookupRunnerTag({ repository, tag: targetVersion, accessToken, fetchImpl });
  if (!tag.present) {
    throw new Error(`release is incomplete: ${image}:${targetVersion} is not published in the registry`);
  }
  await verifyRunnerIdentity({
    repository,
    root: tag,
    expected: { channel, version: targetVersion, sourceSha: gitHead },
    accessToken,
    fetchImpl,
  });
  if (metadata && tag.digest !== metadata.digest) {
    throw new Error(`registry digest ${tag.digest} does not match release metadata digest ${metadata.digest}`);
  }

  const record = formatReleaseRecord({
    channel,
    version: targetVersion,
    sourceSha: gitHead,
    repository: image,
    digest: tag.digest,
  });
  await writeReleaseRecord(outputPath, record);
  return record;
}

const COMMAND_OPTIONS = Object.freeze({
  publish: { required: ["image", "channel", "version", "source-sha", "output"], optional: [] },
  resolve: { required: ["image", "channel", "output"], optional: ["version", "source-sha", "metadata"] },
});

export function parseReleaseArgv(argv) {
  const command = argv[0];
  const spec = COMMAND_OPTIONS[command];
  if (!spec) {
    throw new Error(`usage: release.mjs <publish|resolve> --image <repo> --channel <staging|prod> [options]`);
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--") || !allowed.has(key.slice(2))) {
      throw new Error(`unknown argument "${key ?? ""}" for ${command}`);
    }
    const name = key.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    if (options[name] !== undefined) {
      throw new Error(`duplicate argument ${key}`);
    }
    options[name] = value;
    index += 1;
  }
  for (const name of spec.required) {
    if (options[name] === undefined) {
      throw new Error(`--${name} is required for ${command}`);
    }
  }
  return { command, options };
}

export async function writeGithubOutput(record) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  await appendFile(path, `image=${record.image}\nversion=${record.version}\nsource_sha=${record.sourceSha}\n`);
}

async function main(argv) {
  const { command, options } = parseReleaseArgv(argv);
  const record =
    command === "publish"
      ? await publishRunnerRelease({
          image: options.image,
          channel: options.channel,
          version: options.version,
          sourceSha: options["source-sha"],
          output: options.output,
        })
      : await resolveRunnerRelease({
          image: options.image,
          channel: options.channel,
          version: options.version,
          sourceSha: options["source-sha"],
          metadata: options.metadata,
          output: options.output,
        });
  await writeGithubOutput(record);
  console.log(JSON.stringify(record));
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[runner-release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
