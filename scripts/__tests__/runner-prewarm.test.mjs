import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  cleanupPrewarm,
  makePrewarmState,
  parsePrewarmState,
  prewarmBody,
  readPrewarmTarget,
  runPrewarm,
} from "../runner/prewarm.mjs";

const release = {
  schemaVersion: 1,
  channel: "staging",
  version: "0.1.1-staging.33.1",
  sourceSha: "a".repeat(40),
  image: `us-west1-docker.pkg.dev/opentag-test/runners/runner@sha256:${"b".repeat(64)}`,
};
const target = {
  project: "opentag-test",
  region: "us-west1",
  serviceAccount: "runner@opentag-test.iam.gserviceaccount.com",
  network: "test-net",
  subnet: "test-subnet",
  executionTag: "runner-egress",
};
const state = makePrewarmState({ release, target, owner: "c".repeat(32) });
const reply = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => structuredClone(body),
});

function cloud({ polls = 1, createFailure = false, foreign = false, deleteFailure = false, deletedPolls = 0 } = {}) {
  const calls = [];
  let exists = false;
  let poll = 0;
  let deleted = false;
  let remainingDeleted = deletedPolls;
  const body = prewarmBody(state);
  const readInstance = (url) => {
    if (!exists || (deleted && remainingDeleted-- <= 0)) return reply(null, 404);
    const labels = { ...body.metadata.labels };
    if (foreign) labels["opentag-prewarm-owner"] = "d".repeat(32);
    if (url.includes("/v2/")) {
      return reply({
        uid: "uid-1",
        etag: "etag-1",
        labels,
        serviceAccount: target.serviceAccount,
        containers: body.spec.containers,
        ...(deleted ? { deleteTime: "2026-10-09T00:00:01Z" } : {}),
      });
    }
    poll += 1;
    return reply({
      metadata: { ...body.metadata, labels, uid: "uid-1", creationTimestamp: "2026-10-09T00:00:00Z" },
      spec: body.spec,
      status: {
        conditions: [
          { type: "ContainerReady", status: "True", lastTransitionTime: "2026-10-09T00:01:00Z" },
          { type: "Running", status: poll >= polls ? "True" : "Unknown", lastTransitionTime: "2026-10-09T00:01:10Z" },
        ],
      },
    });
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body), body);
      exists = true;
      if (createFailure) throw new Error("fixture-token and private server error");
      return reply({ metadata: { name: state.instanceId } });
    }
    if (options.method === "DELETE") {
      assert.match(url, /\?etag=etag-1$/);
      if (deleteFailure) return reply({ error: "private error" }, 403);
      deleted = true;
      return reply({ name: "operation-delete" });
    }
    return readInstance(url);
  };
  let time = 0;
  return {
    calls,
    fetchImpl,
    sleep: async (ms) => {
      time += ms;
    },
    now: () => time,
  };
}

test("image import probe has the exact digest and network but no business bootstrap or Server connection", () => {
  const body = prewarmBody(state);
  assert.equal(body.spec.containers[0].image, release.image);
  assert.equal(body.spec.serviceAccountName, target.serviceAccount);
  assert.equal(body.spec.restartPolicy, "Never");
  assert.equal(body.metadata.annotations["run.googleapis.com/ingress"], "internal");
  assert.match(body.spec.containers[0].args[2], /process.exit\(0\),120000/);
  assert.doesNotMatch(JSON.stringify(body), /bootstrap|BACKEND_ORIGIN|Session|opentag-runner|API_KEY/i);
  assert.deepEqual(parsePrewarmState(state), state);
  assert.throws(() => parsePrewarmState({ ...state, instanceId: "business-runner" }), /name/);
  assert.throws(() => parsePrewarmState({ ...state, release: { ...release, image: "image:latest" } }), /digest/);
});

test("preparation waits for Running as well as ContainerReady and only succeeds after cleanup", async () => {
  const fake = cloud({ polls: 3, deletedPolls: 2 });
  const result = await runPrewarm({ state: structuredClone(state), accessToken: "fixture-token", ...fake });
  assert.equal(result.imported, true);
  assert.equal(result.preparationMs, 4000);
  assert.equal(result.uid, "uid-1");
  assert.equal(result.cacheRetentionGuaranteed, false);
  assert.equal(result.cleanup.deleted, true);
  assert.equal(fake.calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(fake.calls.filter((call) => call.options.method === "DELETE").length, 1);
  // A deletion timestamp alone is not completion: two reads observe soft deletion before absence.
  assert.equal(fake.calls.filter((call) => call.url.includes("/v2/") && call.options.method === "GET").length, 4);
});

test("lost create response is not retried and the owned instance is still removed", async () => {
  const fake = cloud({ createFailure: true });
  await assert.rejects(
    runPrewarm({ state: structuredClone(state), accessToken: "fixture-token", ...fake }),
    /POST transport failure/,
  );
  assert.equal(fake.calls.filter((call) => call.options.method === "POST").length, 1);
  assert.equal(fake.calls.filter((call) => call.options.method === "DELETE").length, 1);
});

test("import deadline failure still cleans the owned probe", async () => {
  const fake = cloud({ polls: 1000 });
  await assert.rejects(
    runPrewarm({ state: structuredClone(state), accessToken: "fixture-token", deadlineMs: 3000, ...fake }),
    /within 3s/,
  );
  assert.equal(fake.calls.filter((call) => call.options.method === "DELETE").length, 1);
});

test("cleanup failure prevents successful preparation and does not leak response bodies", async () => {
  const fake = cloud({ deleteFailure: true });
  await assert.rejects(
    runPrewarm({ state: structuredClone(state), accessToken: "fixture-token", ...fake }),
    (error) => {
      assert.match(error.message, /cleanup failed.*HTTP 403/);
      assert.doesNotMatch(error.message, /private error|fixture-token/);
      return true;
    },
  );
});

test("ownership mismatch never deletes a foreign instance", async () => {
  const fake = cloud({ foreign: true });
  await assert.rejects(
    runPrewarm({ state: structuredClone(state), accessToken: "fixture-token", ...fake }),
    /ownership mismatch/,
  );
  assert.equal(fake.calls.filter((call) => call.options.method === "DELETE").length, 0);
});

test("a probe name already present is never used or deleted", async () => {
  const fake = cloud();
  const fetchImpl = async (url, options = {}) =>
    options.method !== "GET" ? fake.fetchImpl(url, options) : reply(prewarmBody(state));
  await assert.rejects(
    runPrewarm({ state: structuredClone(state), accessToken: "fixture-token", ...fake, fetchImpl }),
    /already exists/,
  );
  assert.equal(fake.calls.length, 0);
});

test("cleanup is idempotent when the probe is definitively absent", async () => {
  const fake = cloud();
  assert.deepEqual(await cleanupPrewarm({ state, accessToken: "fixture-token", ...fake }), {
    deleted: true,
    alreadyGone: true,
  });
  assert.equal(fake.calls.length, 1);
});

test("cleanup fences a replaced UID even when labels and image were copied", async () => {
  const fake = cloud();
  await fake.fetchImpl("create", { method: "POST", body: JSON.stringify(prewarmBody(state)) });
  await assert.rejects(
    cleanupPrewarm({ state: { ...state, uid: "previous-uid" }, accessToken: "fixture-token", ...fake }),
    /UID changed/,
  );
  assert.equal(fake.calls.filter((call) => call.options.method === "DELETE").length, 0);
});

test("prewarm derives runtime placement from CapRover and rejects the wrong environment before creating anything", async () => {
  const config = {
    server: "https://captain.example.com",
    app: "opentag",
    passwordSecret: "fixture",
    publicUrl: "https://dev.opentag.build",
  };
  const definition = {
    appName: config.app,
    envVars: Object.entries({
      OPENTAG_ENV: "staging",
      OPENTAG_PUBLIC_URL: config.publicUrl,
      OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
      ...Object.fromEntries(
        Object.entries({
          PROJECT: target.project,
          REGION: target.region,
          SERVICE_ACCOUNT: target.serviceAccount,
          VPC_NETWORK: target.network,
          VPC_SUBNET: target.subnet,
          EXECUTION_TAG: target.executionTag,
        }).map(([key, value]) => [`OPENTAG_CLOUD_RUNNER_${key}`, value]),
      ),
      OPENTAG_DATABASE_URL: "secret database URL",
    }).map(([key, value]) => ({ key, value })),
  };
  const fetchImpl = async (url) =>
    reply({ status: 100, data: url.endsWith("/login") ? { token: "secret" } : { appDefinitions: [definition] } });
  const runCommand = async () => ({ status: 0, stdout: "secret-password\n" });
  assert.deepEqual(await readPrewarmTarget({ release, config, fetchImpl, runCommand }), target);
  definition.envVars.find((entry) => entry.key === "OPENTAG_ENV").value = "prod";
  await assert.rejects(readPrewarmTarget({ release, config, fetchImpl, runCommand }), /expected.*staging/);
});

test("all activation paths prepare first; staging rechecks main and prod preparation retains its approval", async () => {
  const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const staging = await read(".github/workflows/deploy-staging.yml");
  const manual = await read(".github/workflows/deploy-runner.yml");
  const production = await read(".github/workflows/prewarm-runner.yml");
  const action = await read(".github/actions/prewarm-runner/action.yml");
  assert.ok(staging.indexOf("Prewarm the verified") < staging.indexOf("Recheck the revision"));
  assert.ok(staging.indexOf("Recheck the revision") < staging.indexOf("Deploy the commit image"));
  assert.match(staging, /Deploy the commit image to CapRover\n\s+if: steps\.prepared\.outputs\.deploy == 'true'/);
  assert.match(manual, /Prewarm the verified Runner image\n\s+if: inputs\.mode == 'apply'/);
  assert.ok(manual.indexOf("Prewarm the verified") < manual.indexOf("Check or activate"));
  assert.match(production, /environment:.*'production'/);
  assert.match(production, /github\.ref == 'refs\/heads\/main'/);
  assert.match(production, /runner-release-prod/);
  assert.doesNotMatch(production, /deploy\.mjs|caprover\/deploy|service_account:/);
  assert.match(action, /if: always\(\)[\s\S]+prewarm\.mjs cleanup/);
});
