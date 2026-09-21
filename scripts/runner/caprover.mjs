/**
 * Minimal CapRover API client for the unified Runner deployment helper.
 *
 * Authentication is password login against `/api/v2/login`; the returned `data.token` is
 * replayed as the `x-captain-auth` header with `x-namespace: captain`. Password and token stay in
 * process memory and never appear in errors or output. Redirects are never followed.
 *
 * The update endpoint replaces the full app definition, so mutation sends a safelisted copy of the
 * current configuration. Read-only response metadata is excluded from the update payload.
 */

export const CAPROVER_NAMESPACE = "captain";
export const EXPECTED_SERVER_IMAGE_REPOSITORY = "ghcr.io/first-tree-ai/opentag";

const STATUS_OK = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Fields the CapRover appDefinitions/update endpoint accepts; copied through verbatim. */
export const APP_DEFINITION_SAFELIST = Object.freeze([
  "appName",
  "projectId",
  "description",
  "captainDefinitionRelativeFilePath",
  "tags",
  "instanceCount",
  "preDeployFunction",
  "serviceUpdateOverride",
  "notExposeAsWebApp",
  "containerHttpPort",
  "httpAuth",
  "appDeployTokenConfig",
  "customNginxConfig",
  "redirectDomain",
  "forceSsl",
  "websocketSupport",
  "nodeId",
  "appPushWebhook",
  "ports",
  "volumes",
  "envVars",
]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Parses an HTTPS origin. Plain HTTP is only ever accepted for an explicitly injected loopback
 * test seam; production configuration is always HTTPS.
 */
export function parseSecureOrigin(value, label, { allowLoopbackHttp = false } = {}) {
  let url;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${label} must be an HTTPS origin, got an unparseable value`);
  }
  const loopbackHttp = allowLoopbackHttp && url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`${label} must be a bare origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

async function readEnvelope(response, label) {
  if (response.status !== 200) {
    throw new Error(`CapRover ${label} failed with HTTP status ${response.status}`);
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`CapRover ${label} returned a non-JSON response`);
  }
  if (envelope?.status !== STATUS_OK) {
    const code = typeof envelope?.status === "number" ? envelope.status : "unknown";
    throw new Error(`CapRover ${label} was rejected with API status ${code}`);
  }
  return envelope.data;
}

/** Logs in with the password and returns the API session token. */
export async function caproverLogin({ server, password, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchImpl(`${server}/api/v2/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-namespace": CAPROVER_NAMESPACE },
      body: JSON.stringify({ password }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`CapRover login could not reach ${new URL(server).host}`, { cause: error });
  }
  const data = await readEnvelope(response, "login");
  const token = typeof data?.token === "string" && data.token.length > 0 ? data.token : null;
  if (!token) {
    throw new Error("CapRover login succeeded without returning an auth token");
  }
  return token;
}

async function caproverApi({ server, token, method, path, body, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchImpl(`${server}${path}`, {
      method,
      headers: {
        "x-captain-auth": token,
        "x-namespace": CAPROVER_NAMESPACE,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`CapRover ${path} could not be reached`, { cause: error });
  }
  return readEnvelope(response, path);
}

/** Selects exactly one app definition by name; zero or ambiguous matches fail. */
export async function getAppDefinition({ server, token, appName, fetchImpl = fetch }) {
  const data = await caproverApi({ server, token, method: "GET", path: "/api/v2/user/apps/appDefinitions", fetchImpl });
  const definitions = Array.isArray(data?.appDefinitions) ? data.appDefinitions : null;
  if (!definitions) {
    throw new Error("CapRover returned no app definition list");
  }
  const matches = definitions.filter((definition) => definition?.appName === appName);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `CapRover app "${appName}" was not found`
        : `CapRover app "${appName}" matched ${matches.length} definitions`,
    );
  }
  return matches[0];
}

/**
 * Reads whether the app is mid-build. The answer must be a definite boolean — an unknown build
 * state fails closed because mutating configuration under a running build is exactly the race this
 * check exists to prevent.
 */
export async function getAppBuildState({ server, token, appName, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const data = await caproverApi({
    server,
    token,
    method: "GET",
    path: `/api/v2/user/apps/appData/${encodeURIComponent(appName)}`,
    fetchImpl,
    timeoutMs,
  });
  if (typeof data?.isAppBuilding !== "boolean") {
    throw new Error("CapRover did not report a usable app build state; refusing to assume the app is idle");
  }
  return data.isAppBuilding;
}

export async function updateAppDefinition({ server, token, definition, fetchImpl = fetch }) {
  await caproverApi({
    server,
    token,
    method: "POST",
    path: "/api/v2/user/apps/appDefinitions/update",
    body: definition,
    fetchImpl,
  });
}

/** Reads env vars into a Map; duplicate keys are a configuration fault and reject. */
export function readEnvVars(definition) {
  const entries = definition?.envVars;
  if (entries === undefined || entries === null) {
    return new Map();
  }
  if (!Array.isArray(entries)) {
    throw new Error("CapRover app envVars is not an array");
  }
  const map = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== "string" || entry.key.length === 0) {
      throw new Error("CapRover app envVars contains an entry without a key");
    }
    if (map.has(entry.key)) {
      throw new Error(`CapRover app has a duplicate env key: ${entry.key}`);
    }
    map.set(entry.key, entry.value === undefined || entry.value === null ? "" : String(entry.value));
  }
  return map;
}

/**
 * Proves the app is the environment this release targets: channel, public origin, and Cloud
 * identities + Runner enabled. Anything else rejects before any mutation is considered.
 */
export function assertRunnerEnvironment({ envVars, channel, publicUrl }) {
  const environment = envVars.get("OPENTAG_ENV");
  if (environment !== channel) {
    throw new Error(`app OPENTAG_ENV is "${environment ?? "(unset)"}", expected the release channel "${channel}"`);
  }
  const actualUrl = envVars.get("OPENTAG_PUBLIC_URL");
  if (actualUrl !== publicUrl) {
    throw new Error(`app OPENTAG_PUBLIC_URL is "${actualUrl ?? "(unset)"}", expected "${publicUrl}"`);
  }
  if (envVars.get("OPENTAG_CLOUD_IDENTITIES_ENABLED") !== "true") {
    throw new Error('app OPENTAG_CLOUD_IDENTITIES_ENABLED must be "true" before the Runner target can change');
  }
  if (envVars.get("OPENTAG_CLOUD_RUNNER_ENABLED") !== "true") {
    throw new Error('app OPENTAG_CLOUD_RUNNER_ENABLED must be "true" before the Runner target can change');
  }
}

/**
 * The deployed Server image must be exactly `ghcr.io/first-tree-ai/opentag:<server-revision>`
 * with an optional `@sha256:` digest suffix — the immutable per-commit coordinate the Server
 * deploy produced.
 */
export function assertServerImage({ deployedImageName, serverRevision }) {
  const value = typeof deployedImageName === "string" ? deployedImageName : "";
  const at = value.indexOf("@");
  const base = at === -1 ? value : value.slice(0, at);
  const expected = `${EXPECTED_SERVER_IMAGE_REPOSITORY}:${serverRevision}`;
  if (base !== expected) {
    throw new Error(`app deployed image is "${value || "(unset)"}", expected ${expected} (optional @sha256 digest)`);
  }
  if (at !== -1 && !DIGEST_PATTERN.test(value.slice(at + 1))) {
    throw new Error(`app deployed image digest suffix is malformed: "${value}"`);
  }
}

/** Reads the image of the deployed version, excluding historical and pending versions. */
export function deployedImageOf(definition) {
  const versions = Array.isArray(definition?.versions) ? definition.versions : [];
  const matches = versions.filter((entry) => entry.version === definition.deployedVersion);
  if (!Number.isInteger(definition?.deployedVersion) || matches.length !== 1) {
    throw new Error("CapRover did not report exactly one deployed app version");
  }
  return matches[0].deployedImageName;
}

/** Copies accepted update fields, excluding read-only app response metadata. */
export function snapshotAppDefinition(definition) {
  const snapshot = {};
  for (const key of APP_DEFINITION_SAFELIST) {
    if (key in definition) {
      snapshot[key] = structuredClone(definition[key]);
    }
  }
  return snapshot;
}
