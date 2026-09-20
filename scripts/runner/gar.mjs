/**
 * Read-only Google Artifact Registry access for the unified Runner release.
 *
 * Authentication is a short-lived `gcloud auth print-access-token` access token held only in
 * process memory and sent as HTTP Basic `oauth2accesstoken`. Every response is verified against
 * its digest before parsing: the tag manifest against Docker-Content-Digest, and any child
 * manifest or config blob against the digest that named it. Config blobs may redirect once within
 * the same HTTPS origin, without forwarding credentials. Only HTTP 404 means "absent"; every other non-200 is an
 * inconclusive registry answer and fails the run rather than inviting an overwrite.
 */

import { createHash } from "node:crypto";
import { runProcess } from "./async-process.mjs";
import { DIGEST_PATTERN } from "./release-record.mjs";

export { GAR_HOST_PATTERN, parseGarRepository } from "./release-record.mjs";

export const RUNNER_LABELS = Object.freeze({
  revision: "org.opencontainers.image.revision",
  version: "org.opentag.runner.version",
  channel: "org.opentag.runner.channel",
  sourceDirty: "org.opentag.runner.source.dirty",
});

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function sha256Of(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function authorizationHeader(accessToken) {
  return `Basic ${Buffer.from(`oauth2accesstoken:${accessToken}`).toString("base64")}`;
}

async function readBody(response, label) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the ${MAX_RESPONSE_BYTES}-byte bound`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the ${MAX_RESPONSE_BYTES}-byte bound`);
  }
  return buffer;
}

/**
 * One bounded request, allowing one same-origin config-blob redirect without credentials.
 */
async function garRequest({ host, path, accessToken, accept, label, fetchImpl, timeoutMs, allowBlobRedirect = false }) {
  let response;
  const url = `https://${host}/v2/${path}`;
  const signal = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: authorizationHeader(accessToken), ...(accept ? { accept } : {}) },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    throw new Error(`${label} could not reach ${host}`, { cause: error });
  }
  if (allowBlobRedirect && [302, 307].includes(response.status)) {
    const location = response.headers.get("location");
    const target = location ? new URL(location, url) : null;
    if (!target || target.origin !== `https://${host}` || target.username || target.password || target.hash) {
      throw new Error(`${label} returned an unsafe blob redirect`);
    }
    try {
      response = await fetchImpl(target.href, { method: "GET", redirect: "manual", signal });
    } catch {
      throw new Error(`${label} blob redirect could not be read`);
    }
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `${label} returned an unexpected redirect (status ${response.status}); credentials were not followed`,
    );
  }
  return response;
}

/**
 * Resolves a tag to its verified root manifest. Returns `{present: false}` only on a definitive
 * 404; any other non-200 (401/403/429/5xx) throws so a transient or auth failure can never be
 * misread as absence and trigger an overwrite.
 */
export async function lookupRunnerTag({ repository, tag, accessToken, fetchImpl = fetch, timeoutMs }) {
  const response = await garRequest({
    host: repository.host,
    path: `${repository.path}/manifests/${encodeURIComponent(tag)}`,
    accessToken,
    accept: MANIFEST_ACCEPT,
    label: `registry lookup of ${repository.repository}:${tag}`,
    fetchImpl,
    timeoutMs,
  });
  if (response.status === 404) {
    return { present: false };
  }
  if (response.status !== 200) {
    throw new Error(
      `registry lookup of ${repository.repository}:${tag} was inconclusive with status ${response.status}`,
    );
  }
  const digest = response.headers.get("docker-content-digest") ?? "";
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`registry returned no usable Docker-Content-Digest for ${repository.repository}:${tag}`);
  }
  const bytes = await readBody(response, "registry manifest");
  if (sha256Of(bytes) !== digest) {
    throw new Error(`downloaded manifest bytes do not match ${digest}; the registry response was corrupted`);
  }
  return { present: true, digest, bytes, contentType: response.headers.get("content-type") };
}

async function fetchVerifiedJson({ repository, digest, accessToken, kind, fetchImpl, timeoutMs }) {
  const response = await garRequest({
    host: repository.host,
    path: `${repository.path}/${kind}/${encodeURIComponent(digest)}`,
    accessToken,
    accept: kind === "manifests" ? MANIFEST_ACCEPT : undefined,
    allowBlobRedirect: kind === "blobs",
    label: `registry ${kind} fetch of ${digest.slice(0, 19)}…`,
    fetchImpl,
    timeoutMs,
  });
  if (response.status !== 200) {
    throw new Error(`registry ${kind} fetch of ${digest.slice(0, 19)}… failed with status ${response.status}`);
  }
  const bytes = await readBody(response, `registry ${kind}`);
  if (sha256Of(bytes) !== digest) {
    throw new Error(`downloaded ${kind} bytes do not match ${digest}; the registry response was corrupted`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`registry ${kind} ${digest.slice(0, 19)}… is not valid JSON`);
  }
}

function isIndex(document, contentType) {
  if (INDEX_MEDIA_TYPES.has(document?.mediaType)) return true;
  if (document?.mediaType) return false;
  return INDEX_MEDIA_TYPES.has((contentType ?? "").split(";")[0].trim());
}

function selectLinuxAmd64Entry(index) {
  const entries = Array.isArray(index.manifests) ? index.manifests : [];
  const matches = entries.filter(
    (entry) => entry?.platform?.os === "linux" && entry?.platform?.architecture === "amd64",
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one linux/amd64 manifest in the image index, found ${matches.length}`);
  }
  const digest = matches[0].digest ?? "";
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error("the linux/amd64 index entry has no usable digest");
  }
  return digest;
}

function assertRunnerLabels(labels, expected) {
  const actual = labels ?? {};
  const checks = [
    [RUNNER_LABELS.channel, expected.channel],
    [RUNNER_LABELS.version, expected.version],
    [RUNNER_LABELS.revision, expected.sourceSha],
    [RUNNER_LABELS.sourceDirty, "false"],
  ];
  for (const [label, wanted] of checks) {
    if (actual[label] !== wanted) {
      throw new Error(`published image label ${label} is "${actual[label] ?? "(unset)"}", expected "${wanted}"`);
    }
  }
}

function assertImageConfig(config, expected) {
  if (config?.architecture !== "amd64" || config?.os !== "linux") {
    throw new Error(
      `published image platform is ${config?.os ?? "?"}/${config?.architecture ?? "?"}, expected linux/amd64`,
    );
  }
  assertRunnerLabels(config?.config?.Labels, expected);
}

/**
 * Verifies a present tag end to end: walks an OCI index or a single manifest to the image config
 * and proves the exact release identity — channel, version, source SHA, clean source, and
 * linux/amd64 — from digest-verified bytes. Returns the verified root digest.
 */
export async function verifyRunnerIdentity({ repository, root, expected, accessToken, fetchImpl = fetch, timeoutMs }) {
  let document;
  try {
    document = JSON.parse(Buffer.from(root.bytes).toString("utf8"));
  } catch {
    throw new Error(`registry manifest for ${repository.repository} is not valid JSON`);
  }
  let manifest = document;
  if (isIndex(document, root.contentType)) {
    manifest = await fetchVerifiedJson({
      repository,
      digest: selectLinuxAmd64Entry(document),
      accessToken,
      kind: "manifests",
      fetchImpl,
      timeoutMs,
    });
  }
  if (manifest?.schemaVersion !== 2 || !DIGEST_PATTERN.test(manifest?.config?.digest ?? "")) {
    throw new Error("the published image has no usable schema-2 manifest config digest");
  }
  const config = await fetchVerifiedJson({
    repository,
    digest: manifest.config.digest,
    accessToken,
    kind: "blobs",
    fetchImpl,
    timeoutMs,
  });
  assertImageConfig(config, expected);
  return { digest: root.digest };
}

/**
 * Runs `gcloud auth print-access-token`. The token only ever exists in process memory; it is never
 * written to disk, never an argument, and never included in an error message.
 */
export async function readGcloudAccessToken({ runCommand, timeoutMs = 30_000 }) {
  const result = await runCommand("gcloud", ["auth", "print-access-token"], { timeoutMs });
  if (result.status !== 0) {
    throw new Error(`gcloud auth print-access-token failed with status ${result.status}; no token was read`);
  }
  const token = (result.stdout ?? "").trim();
  if (token.length === 0 || /\s/.test(token)) {
    throw new Error("gcloud auth print-access-token returned no usable token");
  }
  return token;
}

/** Default command runner: async, interruptible, output captured in memory only. */
export async function runLocalCommand(command, args, options = {}) {
  const result = await runProcess(command, args, { timeoutMs: options.timeoutMs ?? 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
