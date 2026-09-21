import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRunnerEnvironment,
  assertServerImage,
  caproverLogin,
  deployedImageOf,
  getAppDefinition,
  readEnvVars,
  snapshotAppDefinition,
} from "../runner/caprover.mjs";
import {
  parseDeployArgv,
  probeReady,
  RUNNER_IMAGE_KEY,
  RUNNER_VERSION_KEY,
  readDeployConfig,
  runDeploy,
  runnerTargetHash,
  waitForRunnerTarget,
} from "../runner/deploy.mjs";
import { formatReleaseRecord, parseReleaseRecord } from "../runner/release-record.mjs";

const HOST = "us-west1-docker.pkg.dev";
const REPO = `${HOST}/opentag-test/runners/opentag-runner`;
const VERSION = "0.0.6-staging.30.1";
const OLD_VERSION = "0.0.6-staging.29.1";
const DIGEST = `sha256:${"1".repeat(64)}`;
const OLD_DIGEST = `sha256:${"0".repeat(64)}`;
const RELEASE_SHA = "a".repeat(40);
const SERVER_SHA = "c".repeat(40);
const PASSWORD = "fixture-password";

const release = parseReleaseRecord(
  formatReleaseRecord({
    channel: "staging",
    version: VERSION,
    sourceSha: RELEASE_SHA,
    repository: REPO,
    digest: DIGEST,
  }),
);

function headerMap(entries, cookies = []) {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null, getSetCookie: () => cookies };
}

function envelope(data, cookies = []) {
  return { status: 200, headers: headerMap({}, cookies), json: async () => ({ status: 100, description: "", data }) };
}

function appDefinition(overrides = {}) {
  return {
    appName: "opentag-staging",
    deployedVersion: 7,
    versions: [{ version: 7, deployedImageName: `ghcr.io/first-tree-ai/opentag:${SERVER_SHA}` }],
    captainDefinitionRelativeFilePath: "./captain-definition",
    tags: ["staging"],
    instanceCount: 1,
    hasPersistentData: false,
    notExposeAsWebApp: false,
    forceSsl: true,
    websocketSupport: true,
    appPushWebhook: { repoInfo: { repo: "first-tree-ai/opentag", branch: "main", user: "deploy-bot" } },
    envVars: [
      { key: "OPENTAG_ENV", value: "staging" },
      { key: "OPENTAG_PUBLIC_URL", value: "https://dev.opentag.build" },
      { key: "OPENTAG_CLOUD_IDENTITIES_ENABLED", value: "true" },
      { key: RUNNER_IMAGE_KEY, value: `${REPO}@${OLD_DIGEST}` },
      { key: RUNNER_VERSION_KEY, value: OLD_VERSION },
      { key: "OPENTAG_DATABASE_URL", value: "postgres://db-internal:5432/opentag" },
    ],
    ...overrides,
  };
}

const CONFIG = {
  server: "https://captain.apps.example.com",
  app: "opentag-staging",
  passwordSecret: "projects/opentag-test/secrets/captain-password/versions/1",
  publicUrl: "https://dev.opentag.build",
};

function stateRunnerHash(definition) {
  const env = new Map(definition.envVars.map((entry) => [entry.key, entry.value]));
  return runnerTargetHash({ image: env.get(RUNNER_IMAGE_KEY), version: env.get(RUNNER_VERSION_KEY) });
}

/** Stateful fake CapRover + readyz router. `isBuilding` may be a per-read sequence (clamped at the last value). */
function caproverFake({
  definition = appDefinition(),
  isBuilding = false,
  appData,
  ready = "live",
  updateFailure,
  onUpdate,
  onRead,
} = {}) {
  const state = { definition: structuredClone(definition) };
  const calls = [];
  let reads = 0;
  let buildReads = 0;
  const buildState = () => {
    if (!Array.isArray(isBuilding)) return isBuilding;
    const value = isBuilding[Math.min(buildReads, isBuilding.length - 1)];
    buildReads += 1;
    return value;
  };
  const readyz = () => {
    const runnerHash = ready === "stale" ? "0".repeat(64) : stateRunnerHash(state.definition);
    return {
      status: ready === "down" ? 503 : 200,
      headers: headerMap({ "x-opentag-revision": SERVER_SHA, "x-opentag-runner-target": runnerHash }),
    };
  };
  const update = (requestOptions) => {
    if (updateFailure === "transport") throw new Error("socket hangup");
    if (updateFailure === "reject") return { status: 500, headers: headerMap({}), json: async () => ({}) };
    if (updateFailure === "silent-loss") return envelope({});
    const body = JSON.parse(requestOptions.body);
    onUpdate?.(body);
    state.definition = { ...state.definition, ...structuredClone(body) };
    return envelope({});
  };
  const definitions = () => {
    reads += 1;
    onRead?.(state.definition, reads);
    return envelope({ appDefinitions: [state.definition] });
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/readyz")) return readyz();
    if (url.endsWith("/api/v2/login")) return envelope({ token: "fixture-token" });
    if (url.includes("/api/v2/user/apps/appData/")) {
      return appData ? envelope(appData) : envelope({ isAppBuilding: buildState() });
    }
    if (url.endsWith("/api/v2/user/apps/appDefinitions/update")) return update(options);
    if (url.endsWith("/api/v2/user/apps/appDefinitions")) return definitions();
    throw new Error(`unexpected request ${url}`);
  };
  return { calls, fetchImpl, state, updates: () => calls.filter((call) => call.url.endsWith("/update")) };
}

function deployDeps(fake, overrides = {}) {
  return {
    mode: "check",
    release,
    serverRevision: SERVER_SHA,
    config: CONFIG,
    fetchImpl: fake.fetchImpl,
    runCommand: async (command, args) => {
      assert.equal(command, "gcloud");
      assert.deepEqual(args.slice(0, 3), ["secrets", "versions", "access"]);
      return { status: 0, stdout: `${PASSWORD}\n`, stderr: "" };
    },
    sleep: async () => {},
    ...overrides,
  };
}

test("readDeployConfig requires HTTPS origins and validates secret and app names", () => {
  const env = {
    CAPROVER_SERVER: "https://captain.apps.example.com",
    CAPROVER_APP: "opentag-staging",
    CAPROVER_PASSWORD_SECRET: "projects/opentag-test/secrets/captain-password/versions/latest",
    OPENTAG_PUBLIC_URL: "https://dev.opentag.build",
  };
  assert.deepEqual(readDeployConfig(env), {
    server: "https://captain.apps.example.com",
    app: "opentag-staging",
    passwordSecret: "projects/opentag-test/secrets/captain-password/versions/latest",
    publicUrl: "https://dev.opentag.build",
  });
  assert.throws(() => readDeployConfig({ ...env, CAPROVER_SERVER: "http://captain.apps.example.com" }), /HTTPS/);
  assert.throws(
    () => readDeployConfig({ ...env, CAPROVER_SERVER: `http://user:${PASSWORD}@captain.example.com` }),
    (error) => /HTTPS/.test(error.message) && !error.message.includes(PASSWORD),
  );
  assert.throws(() => readDeployConfig({ ...env, CAPROVER_SERVER: "https://captain.example.com/path" }), /bare origin/);
  assert.throws(() => readDeployConfig({ ...env, OPENTAG_PUBLIC_URL: "https://user:pw@example.com" }), /bare origin/);
  assert.throws(() => readDeployConfig({ ...env, CAPROVER_PASSWORD_SECRET: "captain-password" }), /projects\//);
  assert.throws(() => readDeployConfig({ ...env, CAPROVER_APP: "Bad App" }), /app name/);
  assert.throws(() => readDeployConfig({ ...env, CAPROVER_APP: "" }), /CAPROVER_APP must be configured/);
});

test("readDeployConfig only accepts plain HTTP for an explicitly injected loopback seam", () => {
  const env = {
    CAPROVER_SERVER: "http://127.0.0.1:3000",
    CAPROVER_APP: "opentag-staging",
    CAPROVER_PASSWORD_SECRET: "projects/p-12345/secrets/s/versions/1",
    OPENTAG_PUBLIC_URL: "http://127.0.0.1:3000",
  };
  assert.throws(() => readDeployConfig(env), /HTTPS/);
  const config = readDeployConfig(env, { allowLoopbackHttp: true });
  assert.equal(config.server, "http://127.0.0.1:3000");
  assert.throws(
    () => readDeployConfig({ ...env, CAPROVER_SERVER: "http://169.254.169.254" }, { allowLoopbackHttp: true }),
    /HTTPS/,
  );
});

test("caproverLogin posts the password with the captain namespace and reads the API auth token", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return envelope({ token: "tok-123" });
  };
  const token = await caproverLogin({ server: "https://captain.example.com", password: PASSWORD, fetchImpl });
  assert.equal(token, "tok-123");
  assert.equal(seen[0].options.headers["x-namespace"], "captain");
  assert.deepEqual(JSON.parse(seen[0].options.body), { password: PASSWORD });
});

test("caproverLogin fails without a usable token and never echoes the password", async () => {
  await assert.rejects(
    caproverLogin({ server: "https://captain.example.com", password: PASSWORD, fetchImpl: async () => envelope({}) }),
    (error) => {
      assert.match(error.message, /auth token/);
      assert.ok(!error.message.includes(PASSWORD));
      return true;
    },
  );
  const fromBody = await caproverLogin({
    server: "https://captain.example.com",
    password: PASSWORD,
    fetchImpl: async () => envelope({ token: "body-token" }),
  });
  assert.equal(fromBody, "body-token", "the API returns data.token");
  await assert.rejects(
    caproverLogin({
      server: "https://captain.example.com",
      password: PASSWORD,
      fetchImpl: async () => ({
        status: 401,
        headers: headerMap({}),
        json: async () => ({ status: 401, description: "bad" }),
      }),
    }),
    /HTTP status 401/,
  );
});

test("getAppDefinition selects exactly the named app", async () => {
  const definitions = [appDefinition(), appDefinition({ appName: "other-app" })];
  const fetchImpl = async () => envelope({ appDefinitions: definitions });
  const found = await getAppDefinition({
    server: "https://c.example.com",
    token: "t",
    appName: "other-app",
    fetchImpl,
  });
  assert.equal(found.appName, "other-app");
  await assert.rejects(
    getAppDefinition({ server: "https://c.example.com", token: "t", appName: "missing", fetchImpl }),
    /was not found/,
  );
  const ambiguous = async () => envelope({ appDefinitions: [appDefinition(), appDefinition()] });
  await assert.rejects(
    getAppDefinition({ server: "https://c.example.com", token: "t", appName: "opentag-staging", fetchImpl: ambiguous }),
    /matched 2 definitions/,
  );
});

test("readEnvVars rejects duplicate keys and snapshotAppDefinition excludes read-only metadata", () => {
  const duplicate = appDefinition({
    envVars: [
      { key: "A", value: "1" },
      { key: "A", value: "2" },
    ],
  });
  assert.throws(() => readEnvVars(duplicate), /duplicate env key: A/);
  assert.deepEqual(readEnvVars({}).size, 0);
  const unknown = appDefinition({ internalRuntimeState: { pid: 1 } });
  assert.ok(!("internalRuntimeState" in snapshotAppDefinition(unknown)));
  const snapshot = snapshotAppDefinition(appDefinition());
  assert.equal(snapshot.appPushWebhook.repoInfo.user, "deploy-bot");
  assert.ok(!("internalRuntimeState" in snapshot));
});

test("environment and server-image guards reject the wrong target", () => {
  const env = readEnvVars(appDefinition());
  assertRunnerEnvironment({ envVars: env, channel: "staging", publicUrl: "https://dev.opentag.build" });
  assert.throws(
    () => assertRunnerEnvironment({ envVars: env, channel: "prod", publicUrl: "https://dev.opentag.build" }),
    /OPENTAG_ENV/,
  );
  assert.throws(
    () => assertRunnerEnvironment({ envVars: env, channel: "staging", publicUrl: "https://app.opentag.build" }),
    /OPENTAG_PUBLIC_URL/,
  );
  const disabled = readEnvVars(
    appDefinition({
      envVars: appDefinition().envVars.map((entry) =>
        entry.key === "OPENTAG_CLOUD_IDENTITIES_ENABLED" ? { key: entry.key, value: "false" } : entry,
      ),
    }),
  );
  assert.throws(
    () => assertRunnerEnvironment({ envVars: disabled, channel: "staging", publicUrl: "https://dev.opentag.build" }),
    /CLOUD_IDENTITIES_ENABLED/,
  );

  assertServerImage({ deployedImageName: `ghcr.io/first-tree-ai/opentag:${SERVER_SHA}`, serverRevision: SERVER_SHA });
  assertServerImage({
    deployedImageName: `ghcr.io/first-tree-ai/opentag:${SERVER_SHA}@${DIGEST}`,
    serverRevision: SERVER_SHA,
  });
  assert.throws(
    () =>
      assertServerImage({
        deployedImageName: `ghcr.io/first-tree-ai/opentag:${RELEASE_SHA}`,
        serverRevision: SERVER_SHA,
      }),
    /expected/,
  );
  assert.throws(
    () =>
      assertServerImage({
        deployedImageName: `ghcr.io/first-tree-ai/opentag:${SERVER_SHA}@garbage`,
        serverRevision: SERVER_SHA,
      }),
    /digest suffix/,
  );
  assert.throws(() => assertServerImage({ deployedImageName: undefined, serverRevision: SERVER_SHA }), /expected/);
});

test("check is strictly read-only and reports the current and target Runner", async () => {
  const fake = caproverFake();
  const summary = await runDeploy(deployDeps(fake));
  assert.equal(summary.mode, "check");
  assert.deepEqual(summary.currentRunner, { image: `${REPO}@${OLD_DIGEST}`, version: OLD_VERSION });
  assert.deepEqual(summary.targetRunner, { image: `${REPO}@${DIGEST}`, version: VERSION });
  assert.equal(summary.alreadyAtTarget, false);
  assert.equal(fake.updates().length, 0, "check must never mutate");
  assert.ok(!JSON.stringify(summary).includes("postgres"), "no unrelated env values in the output");
});

test("check rejects the wrong environment, revision, build state, and unproven readyz", async () => {
  const wrongChannel = caproverFake({
    definition: appDefinition({
      envVars: appDefinition().envVars.map((entry) =>
        entry.key === "OPENTAG_ENV" ? { key: entry.key, value: "prod" } : entry,
      ),
    }),
  });
  await assert.rejects(runDeploy(deployDeps(wrongChannel)), /OPENTAG_ENV/);
  assert.equal(wrongChannel.updates().length, 0);

  const wrongRevision = caproverFake({
    definition: appDefinition({
      versions: [{ version: 7, deployedImageName: `ghcr.io/first-tree-ai/opentag:${RELEASE_SHA}` }],
    }),
  });
  await assert.rejects(runDeploy(deployDeps(wrongRevision)), /deployed image/);

  await assert.rejects(runDeploy(deployDeps(caproverFake({ isBuilding: true }))), /ongoing app build/);
  await assert.rejects(runDeploy(deployDeps(caproverFake({ appData: {} }))), /build state/);
  await assert.rejects(runDeploy(deployDeps(caproverFake({ ready: "down" }))), /readyz gate failed/);

  const staleRevision = caproverFake();
  await assert.rejects(runDeploy(deployDeps(staleRevision, { serverRevision: RELEASE_SHA })), /deployed image/);
});

test("apply changes only the two Runner env keys and preserves everything else", async () => {
  let updateBody;
  const fake = caproverFake({ onUpdate: (body) => (updateBody = body) });
  const summary = await runDeploy(deployDeps(fake, { mode: "apply" }));
  assert.equal(summary.updated, true);
  assert.equal(summary.active, true);
  assert.deepEqual(summary.previousRunner, { image: `${REPO}@${OLD_DIGEST}`, version: OLD_VERSION });

  const env = new Map(updateBody.envVars.map((entry) => [entry.key, entry.value]));
  assert.equal(env.get(RUNNER_IMAGE_KEY), `${REPO}@${DIGEST}`);
  assert.equal(env.get(RUNNER_VERSION_KEY), VERSION);
  assert.equal(env.get("OPENTAG_DATABASE_URL"), "postgres://db-internal:5432/opentag");
  assert.equal(env.size, appDefinition().envVars.length, "no env key added or dropped");
  assert.deepEqual(updateBody.appPushWebhook, appDefinition().appPushWebhook, "repoInfo mapping is preserved");
  for (const key of ["deployedImageName", "deployedVersion", "versions", "hasPersistentData"]) {
    assert.ok(!(key in updateBody), `${key} is response-only metadata`);
  }
  assert.deepEqual(updateBody.tags, ["staging"]);
  assert.equal(updateBody.captainDefinitionRelativeFilePath, "./captain-definition");
  assert.equal(fake.state.definition.deployedVersion, 7);
  assert.equal(fake.updates().length, 1);
});

test("apply is a verified no-op when the target is already active", async () => {
  const atTarget = appDefinition({
    envVars: appDefinition().envVars.map((entry) => {
      if (entry.key === RUNNER_IMAGE_KEY) return { key: entry.key, value: `${REPO}@${DIGEST}` };
      if (entry.key === RUNNER_VERSION_KEY) return { key: entry.key, value: VERSION };
      return entry;
    }),
  });
  const fake = caproverFake({ definition: atTarget });
  const summary = await runDeploy(deployDeps(fake, { mode: "apply" }));
  assert.equal(summary.updated, false);
  assert.equal(summary.active, true);
  assert.equal(fake.updates().length, 0);
});

test("apply aborts when the configuration changes between validation and update", async () => {
  const onRead = (definition, reads) => {
    if (reads === 2) definition.envVars.push({ key: "OPENTAG_LOG_LEVEL", value: "debug" });
  };
  const fake = caproverFake({ onRead });
  await assert.rejects(runDeploy(deployDeps(fake, { mode: "apply" })), /changed between validation and update/);
  assert.equal(fake.updates().length, 0, "a concurrent change must stop before the mutation");
});

test("apply waits out an in-progress build, then updates exactly once", async () => {
  const fake = caproverFake({ isBuilding: [true, true, false] });
  const summary = await runDeploy(deployDeps(fake, { mode: "apply" }));
  assert.equal(summary.updated, true);
  assert.equal(summary.active, true);
  assert.equal(fake.updates().length, 1, "one update after the build finished");
});

test("apply re-gates on the fresh post-build snapshot, not the pre-build state", async () => {
  const onRead = (definition, reads) => {
    if (reads === 2) {
      definition.versions = [{ version: 7, deployedImageName: `ghcr.io/first-tree-ai/opentag:${RELEASE_SHA}` }];
    }
  };
  const fake = caproverFake({ isBuilding: [true, false], onRead });
  await assert.rejects(runDeploy(deployDeps(fake, { mode: "apply" })), /deployed image/);
  assert.equal(fake.updates().length, 0, "a Server change during the build must stop before the mutation");
});

test("apply fails closed with zero updates when the build never finishes", async () => {
  const fake = caproverFake({ isBuilding: true });
  await assert.rejects(
    runDeploy(
      deployDeps(fake, {
        mode: "apply",
        deadlineMs: 30,
        intervalMs: 10,
        sleep: (ms) => new Promise((settle) => setTimeout(settle, ms)),
      }),
    ),
    /ongoing app build/,
  );
  assert.equal(fake.updates().length, 0);
});

test("apply never waits through a build that starts at the pre-update check", async () => {
  const fake = caproverFake({ isBuilding: [false, true] });
  await assert.rejects(runDeploy(deployDeps(fake, { mode: "apply" })), /ongoing app build/);
  assert.equal(fake.updates().length, 0, "the fresh pre-update check stays fail-fast");
});

test("a failed update is never blindly retried and reports the observed state", async () => {
  const transport = caproverFake({ updateFailure: "transport" });
  await assert.rejects(runDeploy(deployDeps(transport, { mode: "apply" })), (error) => {
    assert.match(error.message, /not retried/);
    assert.match(
      error.message,
      new RegExp(`observed Runner after failure: image=${REPO}@${OLD_DIGEST.replaceAll(".", "\\.")}`),
    );
    return true;
  });
  assert.equal(transport.updates().length, 1);
  const rejected = caproverFake({ updateFailure: "reject" });
  await assert.rejects(runDeploy(deployDeps(rejected, { mode: "apply" })), /HTTP status 500/);
  assert.equal(rejected.updates().length, 1);
});

test("a silently lost update fails the post-update verification", async () => {
  const fake = caproverFake({ updateFailure: "silent-loss" });
  await assert.rejects(runDeploy(deployDeps(fake, { mode: "apply" })), /did not land exactly/);
  assert.equal(fake.updates().length, 1);
});

test("the readyz wait is bounded and requires the exact runner target hash", async () => {
  const fake = caproverFake({ ready: "stale" });
  const sleeps = [];
  await assert.rejects(
    runDeploy(
      deployDeps(fake, { mode: "apply", deadlineMs: 30, intervalMs: 10, sleep: async (ms) => sleeps.push(ms) }),
    ),
    /did not prove the new Runner target/,
  );
  assert.equal(sleeps.length, 2, "30ms at 10ms intervals is exactly three probes and two sleeps");
});

test("probeReady requires status, revision, and runner hash together", async () => {
  const respond = (status, headers) => async () => ({ status, headers: headerMap(headers) });
  const base = { publicUrl: "https://dev.opentag.build", serverRevision: SERVER_SHA, runnerHash: "f".repeat(64) };
  const ok = await probeReady({
    ...base,
    requireRunner: true,
    fetchImpl: respond(200, { "x-opentag-revision": SERVER_SHA, "x-opentag-runner-target": "f".repeat(64) }),
  });
  assert.equal(ok.ok, true);
  const wrongRunner = await probeReady({
    ...base,
    requireRunner: true,
    fetchImpl: respond(200, { "x-opentag-revision": SERVER_SHA, "x-opentag-runner-target": "0".repeat(64) }),
  });
  assert.equal(wrongRunner.ok, false);
  const wrongRevision = await probeReady({ ...base, fetchImpl: respond(200, { "x-opentag-revision": RELEASE_SHA }) });
  assert.equal(wrongRevision.ok, false);
  const down = await probeReady({ ...base, fetchImpl: async () => ({ status: 503, headers: headerMap({}) }) });
  assert.equal(down.ok, false);
  const unreachable = await probeReady({
    ...base,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(unreachable, { ok: false, status: 0, revision: null, runner: null });
});

test("parseDeployArgv rejects unknown, duplicate, and missing arguments", () => {
  assert.deepEqual(parseDeployArgv(["check", "--release", "r.json", "--server-revision", SERVER_SHA]), {
    mode: "check",
    options: { release: "r.json", "server-revision": SERVER_SHA },
  });
  assert.throws(() => parseDeployArgv(["deploy"]), /usage/);
  assert.throws(
    () => parseDeployArgv(["check", "--release", "r.json"]),
    /--release and --server-revision are required/,
  );
  assert.throws(
    () => parseDeployArgv(["check", "--release", "a", "--release", "b", "--server-revision", SERVER_SHA]),
    /duplicate/,
  );
  assert.throws(
    () => parseDeployArgv(["check", "--release", "a", "--server-revision", SERVER_SHA, "--force", "yes"]),
    /unknown argument/,
  );
});

test("runnerTargetHash matches the Server readyz proof formula", () => {
  assert.equal(runnerTargetHash({ image: "i", version: "v" }), runnerTargetHash({ image: "i", version: "v" }));
  assert.notEqual(runnerTargetHash({ image: "i", version: "v" }), runnerTargetHash({ image: "i", version: "w" }));
  assert.match(runnerTargetHash({ image: "i", version: "v" }), /^[0-9a-f]{64}$/);
});

test("deployed image lookup rejects missing and ambiguous deployment metadata", () => {
  assert.equal(deployedImageOf(appDefinition()), `ghcr.io/first-tree-ai/opentag:${SERVER_SHA}`);
  assert.throws(() => deployedImageOf({ deployedImageName: "legacy" }), /deployed app version/);
  assert.throws(() => deployedImageOf(appDefinition({ versions: [] })), /deployed app version/);
  assert.throws(
    () => deployedImageOf(appDefinition({ versions: [{ version: 7 }, { version: 7 }] })),
    /deployed app version/,
  );
});

test("CapRover error bodies cannot echo credentials into logs", async () => {
  await assert.rejects(
    caproverLogin({
      server: CONFIG.server,
      password: PASSWORD,
      fetchImpl: async () => ({ status: 200, json: async () => ({ status: 1100, description: PASSWORD }) }),
    }),
    (error) => error.message.includes("1100") && !error.message.includes(PASSWORD),
  );
});

test("apply waits for the Server rollout before changing Runner configuration", async () => {
  const fake = caproverFake();
  let probes = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/readyz") && ++probes < 3) {
      assert.equal(fake.updates().length, 0);
      return { status: 200, headers: headerMap({ "x-opentag-revision": RELEASE_SHA }) };
    }
    return fake.fetchImpl(url, options);
  };
  const result = await runDeploy(deployDeps(fake, { mode: "apply", fetchImpl }));
  assert.equal(result.updated, true);
  assert.ok(probes >= 4);
});

test("readyz deadline counts request time as well as sleep time", async () => {
  let time = 0;
  let probes = 0;
  await assert.rejects(
    waitForRunnerTarget({
      publicUrl: CONFIG.publicUrl,
      serverRevision: SERVER_SHA,
      runnerHash: "unused",
      deadlineMs: 30,
      intervalMs: 10,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      fetchImpl: async () => {
        probes += 1;
        time += 25;
        return { status: 503, headers: headerMap({}) };
      },
    }),
    /did not prove/,
  );
  assert.equal(probes, 1);
  assert.equal(time, 30);
});
