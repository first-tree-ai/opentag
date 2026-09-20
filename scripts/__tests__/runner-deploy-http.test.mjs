import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  RUNNER_IMAGE_KEY,
  RUNNER_VERSION_KEY,
  readDeployConfig,
  runDeploy,
  runnerTargetHash,
} from "../runner/deploy.mjs";
import { formatReleaseRecord, parseReleaseRecord } from "../runner/release-record.mjs";

const REPO = "us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner";
const VERSION = "0.0.6-staging.30.1";
const OLD_VERSION = "0.0.6-staging.29.1";
const DIGEST = `sha256:${"1".repeat(64)}`;
const OLD_DIGEST = `sha256:${"0".repeat(64)}`;
const RELEASE_SHA = "a".repeat(40);
const SERVER_SHA = "c".repeat(40);
const PASSWORD = "fixture-password";
const TOKEN = "fixture-token";

const release = parseReleaseRecord(
  formatReleaseRecord({
    channel: "staging",
    version: VERSION,
    sourceSha: RELEASE_SHA,
    repository: REPO,
    digest: DIGEST,
  }),
);

function baseDefinition() {
  return {
    appName: "opentag-staging",
    deployedVersion: 7,
    versions: [{ version: 7, deployedImageName: `ghcr.io/first-tree-ai/opentag:${SERVER_SHA}` }],
    captainDefinitionRelativeFilePath: "./captain-definition",
    tags: ["staging"],
    instanceCount: 1,
    appPushWebhook: { repoInfo: { repo: "first-tree-ai/opentag", branch: "main", user: "deploy-bot" } },
    envVars: [
      { key: "OPENTAG_ENV", value: "staging" },
      { key: "OPENTAG_PUBLIC_URL", value: "ORIGIN" },
      { key: "OPENTAG_CLOUD_IDENTITIES_ENABLED", value: "true" },
      { key: "OPENTAG_CLOUD_RUNNER_ENABLED", value: "true" },
      { key: RUNNER_IMAGE_KEY, value: `${REPO}@${OLD_DIGEST}` },
      { key: RUNNER_VERSION_KEY, value: OLD_VERSION },
    ],
  };
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}

function envRunnerHash(definition) {
  const env = new Map(definition.envVars.map((entry) => [entry.key, entry.value]));
  return runnerTargetHash({ image: env.get(RUNNER_IMAGE_KEY), version: env.get(RUNNER_VERSION_KEY) });
}

function readRequestBody(request, onDone) {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => onDone(body));
}

function readyzResponse(fixture, response) {
  const { state, revision, adoptAfterPolls } = fixture;
  if (state.updateBodies.length > 0) state.readyPollsAfterUpdate += 1;
  const adopted = state.updateBodies.length > 0 && state.readyPollsAfterUpdate >= adoptAfterPolls;
  const definition = adopted ? state.definition : { ...state.definition, envVars: baseDefinition().envVars };
  response.writeHead(200, {
    "content-type": "application/json",
    "x-opentag-revision": revision,
    "x-opentag-runner-target": envRunnerHash(definition),
  });
  response.end(JSON.stringify({ status: "ready" }));
}

function loginResponse(state, request, response) {
  readRequestBody(request, (body) => {
    const password = JSON.parse(body || "{}").password;
    state.loginPasswords.push(password);
    if (password !== PASSWORD) {
      sendJson(response, 401, { status: 101, description: "invalid password" });
      return;
    }
    sendJson(response, 200, { status: 100, description: "ok", data: { token: TOKEN } });
  });
}

function apiResponse(state, request, response, pathname) {
  if (request.headers["x-captain-auth"] !== TOKEN) {
    sendJson(response, 401, { status: 101, description: "unauthenticated" });
    return;
  }
  if (pathname === "/api/v2/user/apps/appDefinitions" && request.method === "GET") {
    sendJson(response, 200, { status: 100, description: "ok", data: { appDefinitions: [state.definition] } });
    return;
  }
  if (pathname.startsWith("/api/v2/user/apps/appData/")) {
    sendJson(response, 200, { status: 100, description: "ok", data: { isAppBuilding: false } });
    return;
  }
  if (pathname === "/api/v2/user/apps/appDefinitions/update" && request.method === "POST") {
    readRequestBody(request, (body) => {
      const definition = JSON.parse(body || "{}");
      state.updateBodies.push(definition);
      state.definition = { ...state.definition, ...definition };
      sendJson(response, 200, { status: 100, description: "ok", data: {} });
    });
    return;
  }
  sendJson(response, 404, { status: 101, description: "not found" });
}

function routeFixtureRequest(fixture, request, response) {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/readyz") {
    readyzResponse(fixture, response);
    return;
  }
  fixture.state.apiRequests.push({ path: pathname, namespace: request.headers["x-namespace"] });
  if (request.headers["x-namespace"] !== "captain") {
    sendJson(response, 400, { status: 101, description: "namespace missing" });
    return;
  }
  if (pathname === "/api/v2/login") {
    loginResponse(fixture.state, request, response);
    return;
  }
  apiResponse(fixture.state, request, response, pathname);
}

/**
 * A real loopback CapRover + Server fixture. The readyz runner-target header only flips after
 * `adoptAfterPolls` probes following the update, so the bounded wait must actually poll the proof
 * header instead of trusting control-plane acceptance.
 */
async function startFixture({ adoptAfterPolls = 1, revision = SERVER_SHA } = {}) {
  const state = {
    definition: baseDefinition(),
    updateBodies: [],
    apiRequests: [],
    readyPollsAfterUpdate: 0,
    loginPasswords: [],
  };
  const fixture = { state, revision, adoptAfterPolls };
  const server = createServer((request, response) => routeFixtureRequest(fixture, request, response));
  await new Promise((settle) => server.listen(0, "127.0.0.1", settle));
  const origin = `http://127.0.0.1:${server.address().port}`;
  state.definition.envVars = state.definition.envVars.map((entry) =>
    entry.key === "OPENTAG_PUBLIC_URL" ? { key: entry.key, value: origin } : entry,
  );
  return { origin, server, state };
}

function fixtureConfig(origin) {
  return readDeployConfig(
    {
      CAPROVER_SERVER: origin,
      CAPROVER_APP: "opentag-staging",
      CAPROVER_PASSWORD_SECRET: "projects/opentag-test/secrets/captain-password/versions/1",
      OPENTAG_PUBLIC_URL: origin,
    },
    { allowLoopbackHttp: true },
  );
}

const passwordCommand = async (command, args) => {
  assert.equal(command, "gcloud");
  assert.equal(args[2], "access");
  return { status: 0, stdout: `${PASSWORD}\n`, stderr: "" };
};

test("apply over real HTTP waits for the readyz runner-target proof, not control-plane acceptance", async () => {
  const fixture = await startFixture({ adoptAfterPolls: 3 });
  try {
    const summary = await runDeploy({
      mode: "apply",
      release,
      serverRevision: SERVER_SHA,
      config: fixtureConfig(fixture.origin),
      runCommand: passwordCommand,
      sleep: async () => {},
      deadlineMs: 60_000,
      intervalMs: 1,
    });
    assert.equal(summary.active, true);
    assert.equal(summary.updated, true);
    assert.equal(fixture.state.updateBodies.length, 1);
    assert.equal(
      fixture.state.readyPollsAfterUpdate,
      3,
      "the wait polled until the responding Server proved the target",
    );

    const env = new Map(fixture.state.definition.envVars.map((entry) => [entry.key, entry.value]));
    assert.equal(env.get(RUNNER_IMAGE_KEY), `${REPO}@${DIGEST}`);
    assert.equal(env.get(RUNNER_VERSION_KEY), VERSION);
    assert.deepEqual(fixture.state.definition.appPushWebhook, baseDefinition().appPushWebhook);
    assert.deepEqual(fixture.state.loginPasswords, [PASSWORD], "the password only ever went to the login endpoint");
    assert.ok(fixture.state.apiRequests.every((request) => request.namespace === "captain"));
  } finally {
    fixture.server.close();
  }
});

test("check over real HTTP stays read-only and rejects a wrong Server revision before any mutation", async () => {
  const fixture = await startFixture();
  try {
    const summary = await runDeploy({
      mode: "check",
      release,
      serverRevision: SERVER_SHA,
      config: fixtureConfig(fixture.origin),
      runCommand: passwordCommand,
    });
    assert.equal(summary.alreadyAtTarget, false);
    assert.equal(fixture.state.updateBodies.length, 0);

    await assert.rejects(
      runDeploy({
        mode: "apply",
        release,
        serverRevision: "d".repeat(40),
        config: fixtureConfig(fixture.origin),
        runCommand: passwordCommand,
        sleep: async () => {},
      }),
      /deployed image|readyz gate/,
    );
    assert.equal(fixture.state.updateBodies.length, 0, "a wrong revision must reject before the mutation");
  } finally {
    fixture.server.close();
  }
});

test("a bad password fails the login without leaking it, and no update is attempted", async () => {
  const fixture = await startFixture();
  try {
    await assert.rejects(
      runDeploy({
        mode: "apply",
        release,
        serverRevision: SERVER_SHA,
        config: fixtureConfig(fixture.origin),
        runCommand: async () => ({ status: 0, stdout: "wrong-password\n", stderr: "" }),
      }),
      (error) => {
        assert.match(error.message, /HTTP status 401/);
        assert.ok(!error.message.includes("wrong-password"), "the password never appears in the error");
        return true;
      },
    );
    assert.equal(fixture.state.updateBodies.length, 0);
  } finally {
    fixture.server.close();
  }
});
