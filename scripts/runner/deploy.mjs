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
 * Server adopted the exact Runner target. If the app is still building when `apply` starts — the
 * Server deploy's own build may not have finished yet — `apply` waits (bounded) for it, then
 * re-reads a fresh snapshot and applies every gate to that; `check` stays fail-fast.
 * Every read rides out (bounded) a CapRover API that is briefly unreachable while the app
 * restarts; the update itself is sent once and never retried.
 * No force termination, no instance deletion, no
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
  CaproverUnreachableError,
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

/**
 * Bounded retry for a read-only CapRover observation. Only a request that never reached CapRover is
 * retried; an answer that fails a gate is the caller's to handle. Every read goes through this;
 * the update itself never does: a lost write is not a lost read. The helper exists for the windows
 * right after a redeploy and right after the update, when CapRover restarts the app and its API is
 * briefly unreachable while nothing about the app is yet known.
 *
 * The same discipline as `waitForAppIdle`: every attempt receives the deadline so its requests are
 * capped to the remaining budget, the sleep between attempts never crosses the deadline, and an
 * answer that arrives after the deadline is rejected rather than returned — an expired observation
 * must never authorize what follows it.
 */
async function whileUnreachable(operation, { sleep, deadlineMs, intervalMs, now = Date.now, label }) {
  const deadline = now() + deadlineMs;
  const seconds = Math.round(deadlineMs / 1000);
  let last = null;
  const deadlineError = (summary) =>
    new Error(
      `${summary} while ${label}${last === null ? "" : ` (last failure: ${last.message})`}`,
      last === null ? undefined : { cause: last },
    );
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    let result;
    try {
      result = await operation({ deadline, now });
    } catch (error) {
      if (!(error instanceof CaproverUnreachableError)) throw error;
      last = error;
      const remainingAfterFailure = deadline - now();
      if (remainingAfterFailure <= 0) break;
      await sleep(Math.min(intervalMs, remainingAfterFailure));
      continue;
    }
    // The requests were budgeted to the remaining time, but the clock is rechecked anyway: a late
    // answer is not an observation the deadline authorized.
    if (deadline - now() > 0) return result;
    throw deadlineError(`CapRover answered only after the ${seconds}s budget expired`);
  }
  throw deadlineError(`CapRover stayed unreachable for ${seconds}s`);
}

/**
 * Reads the app definition and build state. Under a `deadline`, each request is capped to the time
 * left before it — measured just before that request, so the second read cannot inherit the budget
 * the first one already spent.
 */
async function readState({ server, token, appName, fetchImpl, deadline = null, now = Date.now }) {
  const timeoutMs = () => (deadline === null ? undefined : Math.max(1, deadline - now()));
  const definition = await getAppDefinition({ server, token, appName, fetchImpl, timeoutMs: timeoutMs() });
  const isBuilding = await getAppBuildState({ server, token, appName, fetchImpl, timeoutMs: timeoutMs() });
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
 * Bounded wait until CapRover reports a definite `false` build state. An answer that is not a
 * definite `false` remains fatal through getAppBuildState; a poll that never reached CapRover is a
 * soft failure this wait retries, the same contract `probeReady` has, because the redeploy that
 * precedes this wait is exactly when the API is briefly unreachable. A build that never finishes,
 * and an API that stays unreachable, both fail at the deadline. Every poll is authorized against
 * the remaining budget and its request timeout is capped to that budget, so a slow poll can never
 * extend the wait — or authorize an update — past its deadline.
 */
export async function waitForAppIdle({
  server,
  token,
  appName,
  fetchImpl = fetch,
  sleep = defaultSleep,
  deadlineMs = 300_000,
  intervalMs = 5_000,
  now = Date.now,
}) {
  const deadline = now() + deadlineMs;
  const seconds = Math.round(deadlineMs / 1000);
  let unreachable = null;
  const deadlineError = () =>
    unreachable === null
      ? new Error(`CapRover reports an ongoing app build that did not finish within ${seconds}s`)
      : new Error(`CapRover stayed unreachable for ${seconds}s (last failure: ${unreachable.message})`, {
          cause: unreachable,
        });
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw deadlineError();
    let stillBuilding;
    try {
      stillBuilding = await getAppBuildState({
        server,
        token,
        appName,
        fetchImpl,
        timeoutMs: Math.max(1, remaining),
      });
      unreachable = null;
    } catch (error) {
      if (!(error instanceof CaproverUnreachableError)) throw error;
      unreachable = error;
      const remainingAfterFailure = deadline - now();
      if (remainingAfterFailure <= 0) throw deadlineError();
      await sleep(Math.min(intervalMs, remainingAfterFailure));
      continue;
    }
    // The request is budgeted to the remaining time, but a clock still cannot be trusted to have
    // moved predictably: never report idle success after the deadline, even if the poll says so.
    if (deadline - now() <= 0) throw deadlineError();
    if (!stillBuilding) return;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
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
  now = Date.now,
}) {
  assertFullSha(serverRevision, "--server-revision");
  const runnerHash = runnerTargetHash({ image: release.image, version: release.version });
  const password = await readCaproverPassword({ secret: config.passwordSecret, runCommand });
  const token = await caproverLogin({ server: config.server, password, fetchImpl });
  const context = { server: config.server, token, appName: config.app, fetchImpl };
  const observe = (label) =>
    whileUnreachable((budget) => readState({ ...context, ...budget }), { sleep, deadlineMs, intervalMs, now, label });

  // The Server's own redeploy has just restarted the app behind CapRover, so the first look at it
  // is the one most likely to find the API unreachable. It observes; it does not mutate.
  let initial = await observe("reading the app state");
  if (mode === "apply" && initial.isBuilding) {
    // The Server deploy's own CapRover build can still be running when apply starts; only apply
    // waits for it (bounded), then every gate below runs against a fresh post-build snapshot.
    await waitForAppIdle({ ...context, fetchImpl, sleep, deadlineMs, intervalMs, now });
    initial = await observe("re-reading the app state after its build");
  }
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
      now,
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
    // The readyz gate has just passed, which is when CapRover finishes the Server swap and reloads
    // its proxy, so this read is as exposed as the first one. It is still only a read: retrying it
    // cannot lose a write, and the update below is decided on whatever snapshot it finally returns.
    const fresh = await observe("re-reading the app state before the update");
    validateState({ state: fresh, release, serverRevision, publicUrl: config.publicUrl });
    if (!isDeepStrictEqual(fresh.snapshot, initial.snapshot)) {
      throw new Error("the app configuration changed between validation and update; aborting without mutating");
    }
    await applyUpdate({
      ...context,
      next: { ...fresh.snapshot, envVars: withRunnerEnv(fresh.snapshot.envVars, release) },
    });
    // The update itself restarts the app behind CapRover, so the verification read lands in the
    // same unreachable window. The update was sent exactly once; only its verification retries.
    const after = await observe("verifying the app state after the update");
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
    now,
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
