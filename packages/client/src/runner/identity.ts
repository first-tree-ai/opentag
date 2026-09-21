import {
  RUNNER_IDENTITY_SCHEMA_VERSION,
  type RunnerChannel,
  type RunnerIdentity,
  type RunnerToolLock,
} from "./types.js";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STAGING_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-staging\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/i;

function fail(message: string): never {
  throw new Error(message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChannel(value: unknown): RunnerChannel {
  if (value === "dev" || value === "staging" || value === "prod") return value;
  fail(`channel must be dev, staging, or prod, got ${JSON.stringify(value)}`);
}

function parseToolLock(value: unknown): RunnerToolLock {
  if (!isRecord(value)) fail("toolLock must be an object");
  const git = value.git === undefined ? undefined : requireString(value.git, "toolLock.git");
  const gh = value.gh === undefined ? undefined : requireString(value.gh, "toolLock.gh");
  return {
    node: requireString(value.node, "toolLock.node"),
    piPackage: requireString(value.piPackage, "toolLock.piPackage"),
    piVersion: requireString(value.piVersion, "toolLock.piVersion"),
    pnpm: requireString(value.pnpm, "toolLock.pnpm"),
    ...(git ? { git } : {}),
    ...(gh ? { gh } : {}),
  };
}

/** Client 0.0.0 is a private workspace coordinate and is never the Runner version. */
export function assertRunnerVersionIsNotClientPlaceholder(version: string): void {
  if (version === "0.0.0") fail("Runner version must share the CLI release coordinate, not private Client 0.0.0");
}

export function assertRunnerReleaseVersion(channel: RunnerChannel, sourceVersion: string, version: string): string {
  if (!STABLE_VERSION.test(sourceVersion)) fail(`source version must be stable, got "${sourceVersion}"`);
  assertRunnerVersionIsNotClientPlaceholder(version);
  if (channel === "prod") {
    if (version !== sourceVersion) fail(`production version ${version} must match source version ${sourceVersion}`);
    return version;
  }
  if (channel === "staging") {
    const source = STABLE_VERSION.exec(sourceVersion);
    if (!source) fail(`source version must be stable, got "${sourceVersion}"`);
    const expectedPrefix = `${source[1]}.${source[2]}.${Number(source[3]) + 1}-staging.`;
    if (!version.startsWith(expectedPrefix) || !STAGING_VERSION.test(version)) {
      fail(`staging version must match ${expectedPrefix}<run>.<attempt>, got "${version}"`);
    }
    return version;
  }
  if (version !== sourceVersion) fail(`dev version ${version} must match source version ${sourceVersion}`);
  return version;
}

export function parseRunnerIdentity(value: unknown): RunnerIdentity {
  if (!isRecord(value)) fail("runner identity must be an object");
  if (value.schemaVersion !== RUNNER_IDENTITY_SCHEMA_VERSION) {
    fail(`runner identity schemaVersion must be ${RUNNER_IDENTITY_SCHEMA_VERSION}`);
  }
  const channel = parseChannel(value.channel);
  const version = requireString(value.version, "version");
  assertRunnerVersionIsNotClientPlaceholder(version);
  const sourceSha = requireString(value.sourceSha, "sourceSha");
  if (!SHA.test(sourceSha)) fail(`sourceSha must be a 40-character git SHA, got "${sourceSha}"`);
  if (typeof value.sourceDirty !== "boolean") fail("sourceDirty must be a boolean");
  const identity: RunnerIdentity = {
    schemaVersion: RUNNER_IDENTITY_SCHEMA_VERSION,
    channel,
    version,
    sourceSha: sourceSha.toLowerCase(),
    sourceDirty: value.sourceDirty,
    cliPackageName: requireString(value.cliPackageName, "cliPackageName"),
    nodeVersion: requireString(value.nodeVersion, "nodeVersion"),
    pnpmVersion: requireString(value.pnpmVersion, "pnpmVersion"),
    piPackage: requireString(value.piPackage, "piPackage"),
    piVersion: requireString(value.piVersion, "piVersion"),
    contextTreeVersion: requireString(value.contextTreeVersion, "contextTreeVersion"),
    toolLock: parseToolLock(value.toolLock),
    ...(typeof value.imageId === "string" && value.imageId.length > 0 ? { imageId: value.imageId } : {}),
  };
  if (identity.toolLock.piPackage !== identity.piPackage || identity.toolLock.piVersion !== identity.piVersion) {
    fail("toolLock Pi coordinates must match identity Pi coordinates");
  }
  return identity;
}

export function createRunnerIdentity(input: RunnerIdentity): RunnerIdentity {
  return parseRunnerIdentity(input);
}
