#!/usr/bin/env node

/** Release-time image import. No Server connection, Session, bootstrap token or business work. */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertRunnerEnvironment, caproverLogin, getAppDefinition, readEnvVars } from "./caprover.mjs";
import { readCaproverPassword, readDeployConfig } from "./deploy.mjs";
import { readGcloudAccessToken, runLocalCommand } from "./gar.mjs";
import { parseReleaseRecord, readReleaseRecord } from "./release-record.mjs";

const OWNER_KEY = "opentag-prewarm-owner";
const PURPOSE_KEY = "opentag-purpose";
const PURPOSE = "runner-image-prewarm";
const sleepDefault = (ms) => new Promise((done) => setTimeout(done, ms));
const PROBE_CODE =
  "require('node:http').createServer((req,res)=>res.end('image-import-probe')).listen(8080,'0.0.0.0');setTimeout(()=>process.exit(0),120000)";

/** Read the actual environment, rather than maintaining separate CI project/region settings. */
export async function readPrewarmTarget({ release, config, runCommand = runLocalCommand, fetchImpl = fetch }) {
  const password = await readCaproverPassword({ secret: config.passwordSecret, runCommand });
  const token = await caproverLogin({ server: config.server, password, fetchImpl });
  const definition = await getAppDefinition({ server: config.server, token, appName: config.app, fetchImpl });
  const envVars = readEnvVars(definition);
  assertRunnerEnvironment({ envVars, channel: release.channel, publicUrl: config.publicUrl });
  const read = (suffix, pattern) => {
    const key = `OPENTAG_CLOUD_RUNNER_${suffix}`;
    const value = envVars.get(key);
    if (!pattern.test(value ?? "")) throw new Error(`${key} is missing or malformed`);
    return value;
  };
  return {
    project: read("PROJECT", /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    region: read("REGION", /^[a-z]+-[a-z]+[0-9]$/),
    serviceAccount: read(
      "SERVICE_ACCOUNT",
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/,
    ),
    network: read("VPC_NETWORK", /^[a-z][a-z0-9-]{0,62}$/),
    subnet: read("VPC_SUBNET", /^[a-z][a-z0-9-]{0,62}$/),
    executionTag: read("EXECUTION_TAG", /^[a-z][a-z0-9-]{0,62}$/),
  };
}

export function makePrewarmState({ release, target, owner = randomUUID().replaceAll("-", "") }) {
  const record = {
    schemaVersion: release.schemaVersion,
    channel: release.channel,
    version: release.version,
    sourceSha: release.sourceSha,
    image: release.image,
  };
  return { schemaVersion: 1, release: record, ...target, owner, instanceId: `ot-warm-${owner}` };
}

export function parsePrewarmState(value) {
  if (value?.schemaVersion !== 1 || !/^[0-9a-f]{32}$/.test(value.owner ?? "")) {
    throw new Error("invalid prewarm state identity");
  }
  if (value.instanceId !== `ot-warm-${value.owner}`) throw new Error("invalid prewarm instance name");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.project ?? "")) throw new Error("invalid prewarm project");
  if (!/^[a-z]+-[a-z]+[0-9]$/.test(value.region ?? "")) throw new Error("invalid prewarm region");
  parseReleaseRecord(value.release);
  return value;
}

/** Same regional v1 creation path supported by the runtime; v2 deletion supplies an etag fence. */
export function prewarmBody(state) {
  return {
    apiVersion: "run.googleapis.com/v1",
    kind: "Instance",
    metadata: {
      name: state.instanceId,
      labels: { [OWNER_KEY]: state.owner, [PURPOSE_KEY]: PURPOSE },
      annotations: {
        "run.googleapis.com/launch-stage": "BETA",
        "run.googleapis.com/ingress": "internal",
        "run.googleapis.com/default-url-disabled": "true",
        "run.googleapis.com/invoker-iam-disabled": "false",
        "run.googleapis.com/network-interfaces": JSON.stringify([
          { network: state.network, subnetwork: state.subnet, tags: [state.executionTag] },
        ]),
        "run.googleapis.com/vpc-access-egress": "all-traffic",
        "run.googleapis.com/cpu-throttling": "false",
      },
    },
    spec: {
      serviceAccountName: state.serviceAccount,
      restartPolicy: "Never",
      containers: [
        {
          image: state.release.image,
          command: ["/usr/local/bin/runner-entrypoint"],
          args: ["/usr/local/bin/node", "-e", PROBE_CODE],
          ports: [{ containerPort: 8080 }],
          resources: { limits: { cpu: "1", memory: "512Mi" } },
        },
      ],
    },
  };
}

function urls(state) {
  const name = `projects/${state.project}/locations/${state.region}/instances/${state.instanceId}`;
  const collection = `https://${state.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${state.project}/instances`;
  return {
    name,
    collection,
    instance: `${collection}/${state.instanceId}`,
    v2: `https://run.googleapis.com/v2/${name}`,
  };
}

/** Do not include API bodies, tokens, or process stderr in errors or reports. */
async function request({ url, method = "GET", body, accessToken, fetchImpl, timeoutMs = 30_000 }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch {
    throw new Error(`Cloud Run ${method} transport failure`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloud Run ${method} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`Cloud Run ${method} returned invalid JSON`);
  }
}

function assertOwned(instance, state, v2 = false) {
  const labels = v2 ? instance.labels : instance.metadata?.labels;
  const containers = v2 ? instance.containers : instance.spec?.containers;
  const account = v2 ? instance.serviceAccount : instance.spec?.serviceAccountName;
  const expected = prewarmBody(state).spec.containers[0];
  if (
    labels?.[OWNER_KEY] !== state.owner ||
    labels?.[PURPOSE_KEY] !== PURPOSE ||
    containers?.length !== 1 ||
    containers[0].image !== state.release.image ||
    !isDeepStrictEqual(containers[0].command, expected.command) ||
    !isDeepStrictEqual(containers[0].args, expected.args) ||
    (containers[0].env?.length ?? 0) !== 0 ||
    account !== state.serviceAccount
  )
    throw new Error(`prewarm ownership mismatch; refusing to use or delete ${urls(state).name}`);
}

/** Delete only the owned probe, with the current etag. Wait for definitive absence. */
export async function cleanupPrewarm({
  state,
  accessToken,
  fetchImpl = fetch,
  sleep = sleepDefault,
  now = Date.now,
  deadlineMs = 120_000,
}) {
  parsePrewarmState(state);
  const url = urls(state).v2;
  const deadline = now() + deadlineMs;
  const call = (options = {}) =>
    request({ url, accessToken, fetchImpl, timeoutMs: Math.min(30_000, Math.max(1, deadline - now())), ...options });
  const current = await call();
  if (!current) return { deleted: true, alreadyGone: true };
  assertOwned(current, state, true);
  if (!current.uid || !current.etag) throw new Error("prewarm cleanup requires UID and etag");
  if (state.uid && current.uid !== state.uid) throw new Error("prewarm cleanup UID changed; refusing deletion");
  if (!current.deleteTime) await call({ url: `${url}?etag=${encodeURIComponent(current.etag)}`, method: "DELETE" });
  while (now() < deadline) {
    const after = await call();
    if (!after) return { deleted: true, uid: current.uid };
    assertOwned(after, state, true);
    if (after.uid !== current.uid) throw new Error("prewarm cleanup UID changed; refusing further deletion");
    await sleep(Math.min(2_000, Math.max(0, deadline - now())));
  }
  throw new Error(`prewarm deletion did not complete: ${urls(state).name}`);
}

async function rememberIdentity(view, state, onIdentity) {
  assertOwned(view, state);
  if (!view.metadata.uid) throw new Error("prewarm observation has no UID");
  if (state.uid && state.uid !== view.metadata.uid) throw new Error("prewarm observation UID changed");
  if (!state.uid) {
    state.uid = view.metadata.uid;
    await onIdentity(state);
  }
}

async function waitForPrewarm({
  state,
  accessToken,
  fetchImpl,
  sleep,
  now,
  deadline,
  started,
  deadlineMs,
  onIdentity,
}) {
  const { name, instance } = urls(state);
  while (now() < deadline) {
    const view = await request({
      url: instance,
      accessToken,
      fetchImpl,
      timeoutMs: Math.min(30_000, Math.max(1, deadline - now())),
    });
    if (view) {
      await rememberIdentity(view, state, onIdentity);
      const conditions = view.status?.conditions ?? [];
      const imported = conditions.find((entry) => entry.type === "ContainerReady" && entry.status === "True");
      const running = conditions.find((entry) => entry.type === "Running" && entry.status === "True");
      if (imported && running && now() < deadline) {
        return {
          image: state.release.image,
          channel: state.release.channel,
          version: state.release.version,
          project: state.project,
          region: state.region,
          resourceName: name,
          uid: view.metadata.uid,
          createdAt: view.metadata.creationTimestamp,
          importedAt: imported.lastTransitionTime,
          runningAt: running.lastTransitionTime,
          preparationMs: now() - started,
          imported: true,
          cacheRetentionGuaranteed: false,
        };
      }
    }
    await sleep(Math.min(2_000, Math.max(0, deadline - now())));
  }
  throw new Error(`prewarm did not become ContainerReady and Running within ${deadlineMs / 1000}s: ${name}`);
}

/** One create attempt; an uncertain outcome is observed and cleaned, never recreated. */
export async function runPrewarm({
  state,
  accessToken,
  fetchImpl = fetch,
  sleep = sleepDefault,
  now = Date.now,
  deadlineMs = 300_000,
  onIdentity = async () => {},
}) {
  parsePrewarmState(state);
  const { name, collection, instance } = urls(state);
  const started = now();
  const deadline = started + deadlineMs;
  let failure;
  let result;
  let createAttempted = false;
  try {
    const existing = await request({ url: instance, accessToken, fetchImpl });
    if (existing) throw new Error(`prewarm instance already exists: ${name}`);
    createAttempted = true;
    const created = await request({
      url: collection,
      method: "POST",
      body: prewarmBody(state),
      accessToken,
      fetchImpl,
    });
    if (!created) throw new Error("Cloud Run create endpoint returned HTTP 404");
    result = await waitForPrewarm({
      state,
      accessToken,
      fetchImpl,
      sleep,
      now,
      deadline,
      started,
      deadlineMs,
      onIdentity,
    });
  } catch (error) {
    failure = error;
  }
  try {
    const cleanup = createAttempted
      ? await cleanupPrewarm({ state, accessToken, fetchImpl, sleep, now })
      : { deleted: false, createAttempted: false };
    if (result) result.cleanup = cleanup;
  } catch (error) {
    throw new Error(
      `prewarm cleanup failed: ${error.message}${failure ? `; preparation failed: ${failure.message}` : ""}`,
    );
  }
  if (failure) throw failure;
  return result;
}

async function main(argv) {
  const [mode, ...args] = argv;
  if (!["run", "cleanup"].includes(mode))
    throw new Error("usage: prewarm.mjs <run|cleanup> --state <JSON> [--release <verified JSON> --output <JSON>]");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !["--state", "--release", "--output"].includes(key) ||
      options[key] ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    ) {
      throw new Error("invalid prewarm arguments");
    }
    options[key] = args[i + 1];
  }
  if (!options["--state"]) throw new Error("--state is required");
  if (mode === "cleanup") {
    let state;
    try {
      state = parsePrewarmState(JSON.parse(await readFile(options["--state"], "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const accessToken = await readGcloudAccessToken({ runCommand: runLocalCommand });
    console.log(JSON.stringify(await cleanupPrewarm({ state, accessToken })));
    return;
  }
  if (!options["--release"] || !options["--output"]) throw new Error("--release and --output are required for run");
  const release = await readReleaseRecord(options["--release"]);
  const config = readDeployConfig(process.env);
  const target = await readPrewarmTarget({ release, config });
  const accessToken = await readGcloudAccessToken({ runCommand: runLocalCommand });
  const state = makePrewarmState({ release, target });
  // Save ownership BEFORE sending the create, so workflow cancellation/uncertain responses can be cleaned.
  await writeFile(options["--state"], `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const result = await runPrewarm({
    state,
    accessToken,
    onIdentity: (observed) => writeFile(options["--state"], `${JSON.stringify(observed, null, 2)}\n`, { mode: 0o600 }),
  });
  await writeFile(options["--output"], `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[runner-prewarm] ${error.message}`);
    process.exitCode = 1;
  });
}
