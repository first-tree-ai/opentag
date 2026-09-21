#!/usr/bin/env node
/**
 * E3 Cloud Runner acceptance: Session-owned Sandbox -> real Cloud Run Instance -> native sandbox
 * -> Pi acceptance. This command NEVER treats local Docker or a local process as the native
 * Cloud path: Docker is used only for the disposable Postgres the Server needs (the established
 * fixture pattern), and the run fails closed when any real Cloud input is missing.
 *
 * The parent supplies every environment/account input and approves the cloud writes:
 *   --project / OPENTAG_E3_PROJECT                 GCP project id
 *   --region / OPENTAG_E3_REGION                   Cloud Run region (e.g. us-west1)
 *   --service-account / OPENTAG_E3_SERVICE_ACCOUNT Instance service account email
 *   --image / OPENTAG_E3_IMAGE                     Digest-pinned Runner image (name@sha256:…)
 *   --backend-origin / OPENTAG_E3_BACKEND_ORIGIN   Public HTTPS origin Runners dial back to.
 *                                                  For a loopback acceptance this must reach the
 *                                                  harness Server — the operator supplies a
 *                                                  reachable origin (e.g. a tunnel); the harness
 *                                                  never invents one.
 *   --vpc-network / OPENTAG_E3_VPC_NETWORK         Direct VPC network (required)
 *   --vpc-subnet / OPENTAG_E3_VPC_SUBNET           Direct VPC subnetwork (required)
 *   --execution-tag / OPENTAG_E3_EXECUTION_TAG     Network execution tag (required)
 *   OPENTAG_E3_GCP_ACCESS_TOKEN                    Short-lived access token for Cloud Admin calls
 *                                                  (env only, never argv, never a credential file)
 *   --mode offline|real                            Acceptance mode (default offline)
 *   --pi-config-dir PATH --provider deepseek       Real mode only: isolated Pi config source;
 *                                                  only whitelisted documents are forwarded,
 *                                                  per-request, never persisted by the Server.
 *   OPENTAG_E3_ARTIFACTS                           Artifact directory (created if missing)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2Binding, gitState, loadShared, readCliVersion } from "../cloud-computer/cloud-identities-data.mjs";
import { createCloudIdentitiesFixture } from "../cloud-computer/cloud-identities-fixture.mjs";
import { cloudIdentityHeaders, record, requestJson } from "../cloud-computer/cloud-identities-net.mjs";
import { createStepper, sleep } from "../cloud-computer/common.mjs";
import { preparePiInput } from "./credential-input.mjs";

const HELP = `OpenTag E3 Cloud Runner acceptance

Usage:
  node scripts/e2e/cloud-computer.mjs cloud-runner [options]

Required (flag or OPENTAG_E3_* env):
  --project ID              GCP project id
  --region REGION           Cloud Run region
  --service-account EMAIL   Instance service account
  --image NAME@sha256:...   Digest-pinned Runner image (exact, never a tag)
  --backend-origin ORIGIN   HTTPS origin the Runner dials back to
  --vpc-network NAME        Direct VPC network
  --vpc-subnet NAME         Direct VPC subnetwork
  --execution-tag NAME      Network execution tag
  --storage-base URI        Owned GCS prefix (gs://bucket/prefix), required by E5 persistence

Environment:
  OPENTAG_E3_GCP_ACCESS_TOKEN   Short-lived Cloud Admin token (required, env only)
  OPENTAG_E3_ARTIFACTS          Artifact directory
  OPENTAG_E3_READY_TIMEOUT_MS   Runner-ready deadline (default 600000)

Options:
  --mode offline|real                       Acceptance mode (default: offline)
  --pi-config-dir PATH --provider deepseek  Real mode: isolated Pi config to forward per-request

This command will not:
  - Treat local Docker/local processes as the native Cloud path (Postgres-only Docker use)
  - Read credentials outside the explicitly supplied Pi config or shell out to gcloud
  - Commit or push source changes; retain temporary model configuration after cleanup
`;

const REQUIRED_INPUTS = [
  "project",
  "region",
  "serviceAccount",
  "image",
  "backendOrigin",
  "vpcNetwork",
  "vpcSubnet",
  "executionTag",
  "storageBase",
];

/**
 * Only substitutions this harness actually performs. The shared E2 list also describes forged
 * repair codes, fake machine credentials and db-only resource ownership; E3 never injects those,
 * and its Instances are real Cloud allocations, so importing that list would forge the receipt.
 */
export const E3_SUBSTITUTIONS = Object.freeze([
  {
    name: "fixture-slack-binding",
    scope: "E3 acceptance",
    detail: "SQL-inserted Slack installation + IM binding with dummy encrypted credentials. No OAuth or Slack HTTP.",
  },
  {
    name: "local-channel-target-url",
    scope: "E3 acceptance",
    detail: "OPENTAG_PORTABLE_DOWNLOAD_BASE_URL points at loopback so the Server never polls dl.opentag.build.",
  },
]);

function parseArgs(argv, env) {
  const values = {
    project: env.OPENTAG_E3_PROJECT,
    region: env.OPENTAG_E3_REGION,
    serviceAccount: env.OPENTAG_E3_SERVICE_ACCOUNT,
    image: env.OPENTAG_E3_IMAGE,
    backendOrigin: env.OPENTAG_E3_BACKEND_ORIGIN,
    vpcNetwork: env.OPENTAG_E3_VPC_NETWORK,
    vpcSubnet: env.OPENTAG_E3_VPC_SUBNET,
    executionTag: env.OPENTAG_E3_EXECUTION_TAG,
    storageBase: env.OPENTAG_E3_STORAGE_BASE,
    mode: "offline",
    provider: undefined,
    piConfigDir: undefined,
  };
  const flags = {
    "--project": "project",
    "--region": "region",
    "--service-account": "serviceAccount",
    "--image": "image",
    "--backend-origin": "backendOrigin",
    "--vpc-network": "vpcNetwork",
    "--vpc-subnet": "vpcSubnet",
    "--execution-tag": "executionTag",
    "--storage-base": "storageBase",
    "--mode": "mode",
    "--provider": "provider",
    "--pi-config-dir": "piConfigDir",
  };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    const key = flags[token];
    if (!key) throw new Error(`Unknown option: ${token}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    values[key] = value;
  }
  if (values.mode !== "offline" && values.mode !== "real") throw new Error("--mode must be offline or real");
  return { values };
}

function failUsage(message) {
  process.stderr.write(`${message}\n\n${HELP}\n`);
  return 2;
}

export async function main(argv, { createFixture = createCloudIdentitiesFixture } = {}) {
  const { help, values } = parseArgs(argv, process.env);
  if (help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const accessToken = process.env.OPENTAG_E3_GCP_ACCESS_TOKEN;
  const invalid = invalidInputs(values, accessToken);
  if (invalid) return failUsage(invalid);
  const readyTimeout = Number(process.env.OPENTAG_E3_READY_TIMEOUT_MS ?? 600_000);
  if (!Number.isSafeInteger(readyTimeout) || readyTimeout < 1 || readyTimeout > 1_800_000) {
    return failUsage("OPENTAG_E3_READY_TIMEOUT_MS must be an integer between 1 and 1800000");
  }
  const repositoryRoot = process.cwd(),
    shared = await loadShared(repositoryRoot),
    cliVersion = await readCliVersion(repositoryRoot);
  const artifactDirectory = process.env.OPENTAG_E3_ARTIFACTS ?? join(tmpdir(), `opentag-e3-${Date.now()}`);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const assertions = [],
    secrets = [accessToken];
  const redact = (text) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), String(text));
  const { step, steps } = createStepper(redact);
  const allocations = [];
  const summary = {
    command: "cloud-runner",
    mode: values.mode,
    cloud: { project: values.project, region: values.region, image: values.image },
    git: await gitState(repositoryRoot),
    substitutions: E3_SUBSTITUTIONS.map((e) => e.name),
    steps,
    assertions,
    allocations,
    outcome: "failed",
  };
  let receiptQueue = Promise.resolve();
  const receipt = () => {
    receiptQueue = receiptQueue
      .catch(() => {
        summary.artifactError = true;
      })
      .then(() =>
        // Serialize at write time so a later write records an earlier write failure as
        // `artifactError` instead of writing a stale summary.
        writeFile(join(artifactDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 }),
      );
    return receiptQueue;
  };
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let fixture, api, piInput;
  const fail = (message) => {
    throw new Error(message);
  };
  try {
    if (values.mode === "real") piInput = await preparePiInput({ repositoryRoot, source: values.piConfigDir, secrets });
    fixture = await step("disposable Server and Postgres", () =>
      createFixture({
        repositoryRoot,
        artifactDirectory,
        port: process.env.OPENTAG_E3_PORT,
        serverEnv: {
          OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
          OPENTAG_CLOUD_STORAGE_BASE: values.storageBase,
          OPENTAG_CLOUD_RUNNER_VERSION: cliVersion,
          OPENTAG_CLOUD_RUNNER_IMAGE: values.image,
          OPENTAG_CLOUD_RUNNER_PROJECT: values.project,
          OPENTAG_CLOUD_RUNNER_REGION: values.region,
          OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: values.serviceAccount,
          OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: values.backendOrigin,
          OPENTAG_CLOUD_RUNNER_VPC_NETWORK: values.vpcNetwork,
          OPENTAG_CLOUD_RUNNER_VPC_SUBNET: values.vpcSubnet,
          OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: values.executionTag,
          OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN: accessToken,
        },
      }),
    );
    fixture.secrets.push(...secrets);
    const signed = await fixture.signIn(fixture.accounts[0].email);
    api = async (method, path, body, cleanup = false) => {
      const response = await requestJson({
        baseUrl: fixture.baseUrl,
        cookies: signed.cookies,
        method,
        path,
        body,
        headers: cloudIdentityHeaders(),
        timeoutMs: 20 * 60_000,
        ...(!cleanup ? { signal: stopping.signal } : {}),
      });
      if (!response.ok) fail(`API ${method} failed with HTTP ${response.status}`);
      return response.body;
    };
    const cloud = await api("PUT", "/api/v1/computers/cloud", {});
    const agent = await api("POST", shared.HTTP_PATHS.accountAgents, {
      name: `e3-${Date.now().toString(36)}`,
      displayName: "E3 Cloud Pi",
      runtimeProvider: "pi",
      computerId: cloud.computerId,
    });
    const binding = e2Binding("e3", agent.id, fixture.encryptionKey);
    await fixture.postgres.psql(binding.sql);
    for (const channelId of ["C0E3SESSIONA", "C0E3SESSIONB"]) {
      const sandbox = await api("POST", shared.HTTP_PATHS.accountSandboxes, {
        imBindingId: binding.bindingId,
        channelId,
        conversationKind: "channel",
        kind: "channel",
      });
      // This fixture is always dev and each newly-created Sandbox starts at generation zero.
      // Record the expected target BEFORE start can allocate it, even if the response is lost.
      const expectedId = `ot-d-${sandbox.sandboxId.replaceAll("-", "")}-1`;
      allocations.push({
        sandboxId: sandbox.sandboxId,
        sessionId: sandbox.sessionId,
        expectedResourceName: `projects/${values.project}/locations/${values.region}/instances/${expectedId}`,
        cleanup: "pending",
      });
    }
    await receipt();
    await step("allocate two Session-owned Cloud Instances", () =>
      allComplete(
        allocations.map(async (allocation) => {
          const current = await api("POST", shared.accountSandboxRunnerStartPath(allocation.sandboxId), {});
          Object.assign(allocation, {
            resourceName: current.currentResourceName,
            resourceUid: current.currentResourceUid,
            generation: current.environmentGeneration,
          });
          await receipt();
        }),
      ),
    );
    record(
      assertions,
      "distinct-session-instances",
      allocations[0].resourceName !== allocations[1].resourceName && allocations.every((a) => a.resourceUid),
    );
    await step("native readiness for both Sessions", () =>
      allComplete(
        allocations.map(async (allocation) => {
          const deadline = Date.now() + readyTimeout;
          for (;;) {
            const current = await api("GET", shared.accountSandboxRunnerPath(allocation.sandboxId));
            if (
              current.lifecycle === "ready" &&
              current.runnerReady &&
              current.runnerReadiness?.runnerVersion === cliVersion
            )
              return;
            if (Date.now() >= deadline) fail("Native Runner readiness timed out");
            await sleep(2_000);
          }
        }),
      ),
    );
    await step(`concurrent native ${values.mode} acceptance`, () =>
      allComplete(
        allocations.map(async (allocation) => {
          const accepted = await api("POST", shared.accountSandboxRunnerAcceptancePath(allocation.sandboxId), {
            mode: values.mode,
            ...(piInput ? { piConfig: piInput.config } : {}),
          });
          const safe = JSON.parse(redact(JSON.stringify(accepted)));
          allocation.acceptance = safe;
          record(
            assertions,
            `${allocation.sessionId}-owned-result`,
            safe.sandboxId === allocation.sandboxId && safe.environmentGeneration === allocation.generation,
          );
          record(
            assertions,
            `${allocation.sessionId}-acceptance`,
            safe.outcome === "passed" &&
              safe.report?.offline === "passed" &&
              (values.mode !== "real" || safe.report?.model === "passed"),
          );
        }),
      ),
    );
  } catch {
    summary.error = stopping.signal.aborted
      ? "Acceptance interrupted; cleanup required"
      : "Cloud acceptance failed; see bounded Server diagnostics and resource receipt";
  } finally {
    // Best-effort but fail-closed teardown: every allocation, config check, fixture cleanup and
    // the final receipt is attempted even when an earlier step throws. Failures stay visible as
    // failing assertions / `artifactError`, so a cleanup failure can never become a false pass.
    await finalizeRun({ api, allocations, shared, receipt, assertions, piInput, fixture, summary });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdout.write(`[cloud-runner] ${summary.outcome}; artifacts: ${artifactDirectory}\n`);
  }
  return summary.outcome === "passed" ? 0 : 1;
}

function note(assertions, name, ok, detail = "") {
  assertions.push({ name, ok: Boolean(ok), detail: String(detail ?? "") });
}

/** One allocation, at most three attempts; the outcome and evidence stay on the allocation. */
async function cleanupAllocation({ api, allocation, shared, receipt, sleepFn }) {
  allocation.cleanup = "unverified";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const current = await api("GET", shared.accountSandboxRunnerPath(allocation.sandboxId), undefined, true);
      Object.assign(allocation, {
        resourceName: current.currentResourceName,
        resourceUid: current.currentResourceUid,
        generation: current.environmentGeneration,
      });
      // The resource receipt is written before the stop attempt; a write failure is recorded on
      // the allocation but must not skip the stop.
      await Promise.resolve()
        .then(() => receipt())
        .catch(() => {
          allocation.receiptError = true;
        });
      const stopped = await api(
        "POST",
        shared.accountSandboxRunnerStopPath(allocation.sandboxId),
        {
          environmentGeneration: current.environmentGeneration,
        },
        true,
      );
      if (stopped.lifecycle !== "unallocated" || stopped.currentResourceName !== null)
        throw new Error("Cloud removal is uncertain");
      allocation.cleanup = "verified-removed";
      return;
    } catch (error) {
      allocation.cleanup = "unverified";
      allocation.cleanupError = error instanceof Error ? error.message : String(error);
      await sleepFn(2_000);
    }
  }
}

/**
 * Best-effort resource cleanup: every allocation is attempted, and each failure is recorded as a
 * failing assertion instead of aborting the loop. `sleepFn` is injectable so tests do not wait out
 * the retry backoff.
 */
export async function cleanupAllocations({ api, allocations, shared, receipt, assertions, sleepFn = sleep }) {
  if (!api) return;
  for (const allocation of allocations) {
    await cleanupAllocation({ api, allocation, shared, receipt, sleepFn });
    note(
      assertions,
      `${allocation.sessionId}-cloud-removed`,
      allocation.cleanup === "verified-removed",
      allocation.cleanupError ?? "",
    );
  }
}

/** Config verification and fixture teardown are exception-isolated so the receipt still runs. */
async function recordPiConfigVerification(assertions, piInput) {
  if (!piInput) return;
  let unchanged = false;
  let detail = "";
  try {
    unchanged = (await piInput.verifyUnchanged()) === true;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  note(assertions, "host-pi-config-unchanged", unchanged, detail);
}

async function recordFixtureCleanup(assertions, fixture) {
  if (!fixture) return;
  try {
    const failures = await fixture.cleanup();
    note(
      assertions,
      "fixture-cleanup",
      Array.isArray(failures) && failures.length === 0,
      Array.isArray(failures) ? failures.join("; ") : "",
    );
  } catch (error) {
    note(assertions, "fixture-cleanup", false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Runs every teardown step even when an earlier one fails and never throws. The summary stays
 * fail-closed through the recorded assertions (and `artifactError` when the receipt could not be
 * written); one failed step cannot skip the remaining allocations, fixture teardown, or receipt.
 */
export async function finalizeRun({
  api,
  allocations,
  shared,
  receipt,
  assertions,
  piInput,
  fixture,
  summary,
  sleepFn = sleep,
}) {
  await cleanupAllocations({ api, allocations, shared, receipt, assertions, sleepFn }).catch((error) => {
    note(assertions, "allocation-cleanup", false, error instanceof Error ? error.message : String(error));
  });
  await recordPiConfigVerification(assertions, piInput);
  await recordFixtureCleanup(assertions, fixture);
  summary.finishedAt = new Date().toISOString();
  summary.outcome = acceptanceOutcome(summary);
  try {
    await receipt();
  } catch {
    summary.artifactError = true;
    summary.outcome = "failed";
  }
  return summary;
}

function invalidInputs(values, accessToken) {
  const missing = REQUIRED_INPUTS.filter((key) => !values[key]);
  if (missing.length) return `Missing required inputs: ${missing.join(", ")}`;
  if (!/^gs:\/\/[a-z0-9][a-z0-9._-]+[a-z0-9]\/[A-Za-z0-9._/-]+$/.test(values.storageBase))
    return "--storage-base must be an owned gs://bucket/prefix";
  if (!accessToken) return "OPENTAG_E3_GCP_ACCESS_TOKEN is required (env only)";
  if (values.mode === "real" && (!values.piConfigDir || values.provider !== "deepseek"))
    return "Real mode requires --pi-config-dir and --provider deepseek";
  if (!/^[^\s]+@sha256:[0-9a-f]{64}$/.test(values.image)) return "--image must be digest-pinned";

  return undefined;
}

async function allComplete(promises) {
  const results = await Promise.allSettled(promises);
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Concurrent acceptance step failed after every in-flight operation settled");
}

function acceptanceOutcome(summary) {
  return !summary.error &&
    !summary.artifactError &&
    summary.assertions.length > 0 &&
    summary.assertions.every((e) => e.ok)
    ? "passed"
    : "failed";
}
