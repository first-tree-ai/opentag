/**
 * The unified Runner release record shared by `release.mjs` and `deploy.mjs`.
 *
 * A record is the only handoff between publication and deployment: `{schemaVersion, channel,
 * version, sourceSha, image}` where `image` is the digest-pinned `<repository>@sha256:<digest>`.
 * Parsing is fail-closed — unknown keys, a wrong channel, or a malformed digest reject the record
 * instead of letting a deployment guess at a partially written release.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseStableVersion, parseStagingVersion } from "../release-versions.mjs";

export const RELEASE_SCHEMA_VERSION = 1;
export const RELEASE_CHANNELS = Object.freeze(["staging", "prod"]);
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const RECORD_KEYS = Object.freeze(["schemaVersion", "channel", "version", "sourceSha", "image"]);

export function assertChannel(channel, label = "channel") {
  if (!RELEASE_CHANNELS.includes(channel)) {
    throw new Error(`${label} must be one of ${RELEASE_CHANNELS.join(", ")}, got "${channel ?? ""}"`);
  }
  return channel;
}

export function assertChannelVersion(channel, version, label = "version") {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${label} is required`);
  }
  if (channel === "staging") {
    parseStagingVersion(version, label);
  } else {
    parseStableVersion(version, label);
  }
  return version;
}

export function assertFullSha(value, label) {
  if (typeof value !== "string" || !FULL_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full 40-character commit SHA`);
  }
  return value;
}

export const GAR_HOST_PATTERN = /^[a-z0-9-]+-docker\.pkg\.dev$/;

/** A GAR project/repository/image path, without a tag, digest, or URL syntax. */
export function parseGarRepository(image) {
  const [host, ...segments] = typeof image === "string" ? image.split("/") : [];
  if (
    !GAR_HOST_PATTERN.test(host ?? "") ||
    segments.length < 3 ||
    segments.some((part) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part))
  ) {
    throw new Error("--image must be an untagged Artifact Registry *-docker.pkg.dev/project/repository/image");
  }
  return { host, path: segments.join("/"), repository: image };
}

function parseRecordImage(image, label) {
  if (typeof image !== "string") {
    throw new Error(`${label} image must be a digest-pinned reference`);
  }
  const at = image.lastIndexOf("@");
  const repository = at === -1 ? "" : image.slice(0, at);
  const digest = at === -1 ? "" : image.slice(at + 1);
  if (repository.length === 0 || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`${label} image must be <repository>@sha256:<digest>, got "${image}"`);
  }
  parseGarRepository(repository);
  return { repository, digest };
}

/**
 * Validates an unknown value as a release record. Returns the normalized record with the image
 * split into repository and digest. Anything incomplete or surprising rejects.
 */
export function parseReleaseRecord(value, label = "release record") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unknown = Object.keys(value).filter((key) => !RECORD_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.sort().join(", ")}`);
  }
  if (value.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    throw new Error(`${label} schemaVersion must be ${RELEASE_SCHEMA_VERSION}`);
  }
  const channel = assertChannel(value.channel, `${label} channel`);
  const version = assertChannelVersion(channel, value.version, `${label} version`);
  const sourceSha = assertFullSha(value.sourceSha, `${label} sourceSha`);
  const { repository, digest } = parseRecordImage(value.image, label);
  return { schemaVersion: RELEASE_SCHEMA_VERSION, channel, version, sourceSha, repository, digest, image: value.image };
}

export function formatReleaseRecord({ channel, version, sourceSha, repository, digest }) {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`registry digest must be sha256:<64 hex>, got "${digest ?? ""}"`);
  }
  return { schemaVersion: RELEASE_SCHEMA_VERSION, channel, version, sourceSha, image: `${repository}@${digest}` };
}

export async function readReleaseRecord(path, label = "release record") {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read from ${path}: ${error instanceof Error ? error.message : error}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} at ${path} is not valid JSON`);
  }
  return parseReleaseRecord(value, label);
}

/** Writes the canonical five-key record; the file holds no credentials and no source metadata. */
export async function writeReleaseRecord(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
