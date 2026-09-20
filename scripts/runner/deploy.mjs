#!/usr/bin/env node

/**
 * Unified Runner deployment helper for CapRover-hosted environments.
 *
 * `check` is strictly read-only: it proves the app is the exact environment a verified release
 * targets — channel, public origin, Cloud identities + Runner enabled, no ongoing build, and the
 * deployed Server image at the requested revision — and that the responding Server proves that
 * revision on /readyz. `apply` then changes only OPENTAG_CLOUD_RUNNER_IMAGE and
 * OPENTAG_CLOUD_RUNNER_VERSION, together, in one full-definition update built from a safelisted
 * copy of the current configuration, and waits (bounded) until /readyz proves the responding
 * Server adopted the exact Runner target. No force termination, no instance deletion, no
 * provisioning, no database access, and no rollback of arbitrary concurrent state on failure.
 *
 * The CapRover password comes from Secret Manager via gcloud (WIF credentials the workflow
 * configures) and, like the session token, exists only in process memory. Output carries only
 * source/target Runner image+version and non-secret hashes.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  APP_DEFINITION_SAFELIST,
  assertRunnerEnvironment,
  assertServerImage,
  caproverLogin,
  deployedImageOf,
  getAppBuildState,
  getAppDefinition,
  parseSecureOrigin,
  readEnvVars,
  snapshotAppDefinition,
  updateAppDefinition,
} from "./caprover.mjs";
import { runLocalCommand } from "./gar.mjs";
import { assertFullSha, readReleaseRecord } from "./release-record.mjs";

export const RUNNER_IMAGE_KEY = "OPENTAG_CLOUD_RUNNER_IMAGE";
export const RUNNER_VERSION_KEY = "OPENTAG_CLOUD_RUNNER_VERSION";

const SECRET_NAME_PATTERN =
  /^projects\/[a-z0-9][a-z0-9-]{4,28}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/(latest|[1-9]\d*)$/;
const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PASSWORD_TIMEOUT_MS = 60_000;
const READYZ_TIMEOUT_MS = 10_000;

const defaultSleep = (milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds));

/** Matches the Server's readyz `x-opentag-runner-target` proof exactly. */
export function runnerTargetHash({ image, version }) {
  return createHash("sha256")
    .update(JSON.stringify([image, version]))
    .digest("hex");
}

function requiredEnv(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be configured`);
  }
  return value.trim();
}

/** Reads and validates deployment configuration from the process environment. */
export function readDeployConfig(environment, { allowLoopbackHttp = false } = {}) {
  const server = parseSecureOrigin(requiredEnv(environment, "CAPROVER_SERVER"), "CAPROVER_SERVER", {
    allowLoopbackHttp,
  });
  const publicUrl = parseSecureOrigin(requiredEnv(environment, "OPENTAG_PUBLIC_URL"), "OPENTAG_PUBLIC_URL", {
    allowLoopbackHttp,
  });
  const app = requiredEnv(environment, "CAPROVER_APP");
  if (!APP_NAME_PATTERN.test(app)) {
    throw new Error("CAPROVER_APP must be a lowercase CapRover app name");
  }
  const passwordSecret = requiredEnv(environment, "CAPROVER_PASSWORD_SECRET");
  if (!SECRET_NAME_PATTERN.test(passwordSecret)) {
    throw new Error("CAPROVER_PASSWORD_SECRET must be projects/<project>/secrets/<secret>/versions/<version>");
  }
  return { server, app, passwordSecret, publicUrl };
}

/** The secret value is stdout: it is never an argument, never logged, never in an error. */
async function readCaproverPassword({ secret, runCommand }) {
  const result = await runCommand("gcloud", ["secrets", "versions", "access", secret], {
    timeoutMs: PASSWORD_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`gcloud could not read the CapRover password secret (status ${result.status})`);
  }
  const password = (result.stdout ?? "").replace(/\r?\n$/, "");
  if (password.length === 0) {
    throw new Error("the CapRover password secret is empty");
  }
  return password;
}

/**
 * One bounded /readyz probe. `ok` requires HTTP 200, the exact Server revision header, and — when
 * `requireRunner` — the exact Runner target hash. Unreachable is a soft failure the bounded wait
 * can retry, never a success.
 */
export async function probeReady({
  publicUrl,
  serverRevision,
  runnerHash,
  requireRunner = false,
  fetchImpl = fetch,
  timeoutMs = READYZ_TIMEOUT_MS,
}) {
  let response;
  try {
    response = await fetchImpl(`${publicUrl}/readyz`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: 0, revision: null, runner: null };
  }
  const revision = response.headers.get("x-opentag-revision");
  const runner = response.headers.get("x-opentag-runner-target");
  const runnerOk = !requireRunner || runner === runnerHash;
  return {
    ok: response.status === 200 && revision === serverRevision && runnerOk,
    status: response.status,
    revision,
    runner,
  };
}

async function readState({ server, token, appName, fetchImpl }) {
  const definition = await getAppDefinition({ server, token, appName, fetchImpl });
  const isBuilding = await getAppBuildState({ server, token, appName, fetchImpl });
  return { definition, snapshot: snapshotAppDefinition(definition), envVars: readEnvVars(definition), isBuilding };
}

/** Every read-only gate a release must pass before a mutation is even considered. */
function validateState({ state, release, serverRevision, publicUrl }) {
  if (state.isBuilding) {
    throw new Error("CapRover reports an ongoing app build; wait for it to finish before changing the Runner target");
  }
  assertRunnerEnvironment({ envVars: state.envVars, channel: release.channel, publicUrl });
  assertServerImage({ deployedImageName: deployedImageOf(state.definition), serverRevision });
  return { image: state.envVars.get(RUNNER_IMAGE_KEY) ?? null, version: state.envVars.get(RUNNER_VERSION_KEY) ?? null };
}

function assertReadyGate(probe, serverRevision) {
  if (!probe.ok) {
    throw new Error(
      `readyz gate failed: status ${probe.status}, x-opentag-revision "${probe.revision ?? "(none)"}", ` +
        `expected status 200 at revision ${serverRevision}`,
    );
  }
}

function withRunnerEnv(envVars, release) {
  const setValue = (entries, key, value) => {
    const index = entries.findIndex((entry) => entry?.key === key);
    if (index === -1) return [...entries, { key, value }];
    return entries.map((entry, position) => (position === index ? { key, value } : entry));
  };
  const base = Array.isArray(envVars) ? envVars : [];
  return setValue(setValue(base, RUNNER_IMAGE_KEY, release.image), RUNNER_VERSION_KEY, release.version);
}

/** Post-update proof that only the two Runner keys changed and every other field survived. */
function assertPreserved(before, after) {
  for (const key of APP_DEFINITION_SAFELIST) {
    if (key !== "envVars" && !isDeepStrictEqual(before[key], after[key])) {
      throw new Error(`post-update verification failed: CapRover changed the "${key}" field`);
    }
  }
  const beforeEnv = readEnvVars(before);
  const afterEnv = readEnvVars(after);
  for (const [key, value] of beforeEnv) {
    if (key !== RUNNER_IMAGE_KEY && key !== RUNNER_VERSION_KEY && afterEnv.get(key) !== value) {
      throw new Error(`post-update verification failed: env ${key} was not preserved`);
    }
  }
  for (const key of afterEnv.keys()) {
    if (!beforeEnv.has(key) && key !== RUNNER_IMAGE_KEY && key !== RUNNER_VERSION_KEY) {
      throw new Error(`post-update verification failed: env ${key} appeared unexpectedly`);
    }
  }
}

/**
 * One update attempt, never blindly retried: if the response is lost or rejected, the observed
 * Runner state is reported and the run fails so a human — not a retry loop — decides.
 */
async function applyUpdate({ server, token, appName, fetchImpl, next }) {
  try {
    await updateAppDefinition({ server, token, definition: next, fetchImpl });
  } catch (error) {
    let observed = "(unreadable)";
    try {
      const after = await readState({ server, token, appName, fetchImpl });
      observed = `image=${after.envVars.get(RUNNER_IMAGE_KEY) ?? "(unset)"} version=${after.envVars.get(RUNNER_VERSION_KEY) ?? "(unset)"}`;
    } catch {
      // Best effort only; the original failure is what matters.
    }
    throw new Error(
      `Runner update failed and was not retried (${error instanceof Error ? error.message : error}); ` +
        `observed Runner after failure: ${observed}`,
    );
  }
}

/** Bounded wait until the responding Server proves both its revision and the new Runner target. */
export async function waitForRunnerTarget({
  publicUrl,
  serverRevision,
  runnerHash,
  fetchImpl = fetch,
  sleep = defaultSleep,
  deadlineMs = 300_000,
  intervalMs = 5_000,
  requireRunner = true,
  now = Date.now,
}) {
  const deadline = now() + deadlineMs;
  const attempts = Math.max(1, Math.ceil(deadlineMs / intervalMs));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    last = await probeReady({
      publicUrl,
      serverRevision,
      runnerHash,
      requireRunner,
      fetchImpl,
      timeoutMs: Math.max(1, Math.min(READYZ_TIMEOUT_MS, remaining)),
    });
    if (last.ok) return last;
    const remainingAfterProbe = deadline - now();
    if (remainingAfterProbe <= 0) break;
    if (attempt < attempts) await sleep(Math.min(intervalMs, remainingAfterProbe));
  }
  throw new Error(
    `the Server did not prove the new Runner target within ${Math.round(deadlineMs / 1000)}s ` +
      `(last readyz status ${last?.status ?? 0}, revision "${last?.revision ?? "(none)"}", runner target ${last?.runner ?? "(none)"})`,
  );
}

function buildSummary({ mode, app, release, serverRevision, runnerHash, extra }) {
  return {
    mode,
    app,
    channel: release.channel,
    version: release.version,
    serverRevision,
    targetRunner: { image: release.image, version: release.version },
    runnerTarget: runnerHash,
    ...extra,
  };
}

/**
 * Runs the deployment gate (`check`) or the gated Runner switch (`apply`). Returns the non-secret
 * summary that is also what the CLI prints.
 */
export async function runDeploy({
  mode,
  release,
  serverRevision,
  config,
  fetchImpl = fetch,
  runCommand = runLocalCommand,
  sleep = defaultSleep,
  deadlineMs = 300_000,
  intervalMs = 5_000,
}) {
  assertFullSha(serverRevision, "--server-revision");
  const runnerHash = runnerTargetHash({ image: release.image, version: release.version });
  const password = await readCaproverPassword({ secret: config.passwordSecret, runCommand });
  const token = await caproverLogin({ server: config.server, password, fetchImpl });
  const context = { server: config.server, token, appName: config.app, fetchImpl };

  const initial = await readState(context);
  const current = validateState({ state: initial, release, serverRevision, publicUrl: config.publicUrl });
  if (mode === "apply") {
    await waitForRunnerTarget({
      publicUrl: config.publicUrl,
      serverRevision,
      fetchImpl,
      sleep,
      deadlineMs,
      intervalMs,
      requireRunner: false,
    });
  } else {
    assertReadyGate(await probeReady({ publicUrl: config.publicUrl, serverRevision, fetchImpl }), serverRevision);
  }

  const alreadyAtTarget = current.image === release.image && current.version === release.version;
  if (mode === "check") {
    return buildSummary({
      mode,
      app: config.app,
      release,
      serverRevision,
      runnerHash,
      extra: { currentRunner: current, alreadyAtTarget },
    });
  }

  if (!alreadyAtTarget) {
    const fresh = await readState(context);
    validateState({ state: fresh, release, serverRevision, publicUrl: config.publicUrl });
    if (!isDeepStrictEqual(fresh.snapshot, initial.snapshot)) {
      throw new Error("the app configuration changed between validation and update; aborting without mutating");
    }
    await applyUpdate({
      ...context,
      next: { ...fresh.snapshot, envVars: withRunnerEnv(fresh.snapshot.envVars, release) },
    });
    const after = await readState(context);
    if (
      after.envVars.get(RUNNER_IMAGE_KEY) !== release.image ||
      after.envVars.get(RUNNER_VERSION_KEY) !== release.version
    ) {
      throw new Error("post-update verification failed: the Runner target did not land exactly");
    }
    assertPreserved(fresh.snapshot, after.snapshot);
  }
  await waitForRunnerTarget({
    publicUrl: config.publicUrl,
    serverRevision,
    runnerHash,
    fetchImpl,
    sleep,
    deadlineMs,
    intervalMs,
  });
  return buildSummary({
    mode,
    app: config.app,
    release,
    serverRevision,
    runnerHash,
    extra: { previousRunner: current, updated: !alreadyAtTarget, active: true },
  });
}

export function parseDeployArgv(argv) {
  const mode = argv[0];
  if (mode !== "check" && mode !== "apply") {
    throw new Error("usage: deploy.mjs <check|apply> --release <verified JSON> --server-revision <40hex>");
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== "--release" && key !== "--server-revision") {
      throw new Error(`unknown argument "${key ?? ""}"`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    const name = key.slice(2);
    if (options[name] !== undefined) {
      throw new Error(`duplicate argument ${key}`);
    }
    options[name] = value;
    index += 1;
  }
  if (!options.release || !options["server-revision"]) {
    throw new Error("--release and --server-revision are required");
  }
  return { mode, options };
}

async function main(argv) {
  const { mode, options } = parseDeployArgv(argv);
  const release = await readReleaseRecord(options.release, "release");
  const summary = await runDeploy({
    mode,
    release,
    serverRevision: options["server-revision"],
    config: readDeployConfig(process.env),
  });
  console.log(JSON.stringify(summary));
}

const isProcessEntry =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isProcessEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[runner-deploy] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
