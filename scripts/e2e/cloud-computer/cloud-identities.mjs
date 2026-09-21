import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgentCases, runCloudComputerCases } from "./cloud-identities-cloud.mjs";
import {
  CLOUD_STORAGE_URI,
  E2_IDS,
  e1LocalSeedSql,
  gitState,
  loadShared,
  readCliVersion,
  resourceUniqueProbeSql,
  SUBSTITUTIONS,
} from "./cloud-identities-data.mjs";
import { createCloudIdentitiesFixture } from "./cloud-identities-fixture.mjs";
import { runCloudGuardCases, runLocalConnectCases } from "./cloud-identities-local.mjs";
import { cloudIdentityHeaders, record, requestJson } from "./cloud-identities-net.mjs";
import { runSandboxCases } from "./cloud-identities-sandbox.mjs";
import { createStepper } from "./common.mjs";

const HELP = `OpenTag E2 Cloud identities acceptance

Usage:
  node scripts/e2e/cloud-computer.mjs cloud-identities [--help]

Requirements:
  - Docker for a disposable postgres:17-alpine container (loopback only)
  - A built workspace (\`pnpm build\`) so Server and Shared dist entries exist
  - Node.js ^22.22.2 || ^24.15.0 || ^26.0.0

Not required: Pi credentials, model calls, GCP, Slack/Feishu network, daemon.

This command does not start agents or copy provider config.
`;

function cloudEnv(cliVersion, extra = {}) {
  return {
    OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
    OPENTAG_CLOUD_STORAGE_BASE: CLOUD_STORAGE_URI,
    OPENTAG_CLOUD_RUNNER_VERSION: cliVersion,
    // Valid inert coordinates: identity/setup reads must never allocate or contact GCP.
    OPENTAG_CLOUD_RUNNER_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
    OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-e2-fixture",
    OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
    OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-e2-fixture.iam.gserviceaccount.com",
    OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://runner-fixture.example.com",
    OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "fixture-network",
    OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "fixture-subnet",
    OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "fixture-runner",
    ...extra,
  };
}

async function currentMigrationHashes(repositoryRoot) {
  const folder = join(repositoryRoot, "packages/server/drizzle");
  const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
  return Promise.all(
    journal.entries.map(async (entry) =>
      createHash("sha256")
        .update(await readFile(join(folder, `${entry.tag}.sql`)))
        .digest("hex"),
    ),
  );
}

async function runUpgradePhase({ repositoryRoot, artifactDirectory, cliVersion, assertions, step }) {
  const fixture = await step("upgrade E1 baseline database into current Server", async () =>
    createCloudIdentitiesFixture({
      repositoryRoot,
      artifactDirectory,
      upgradeFromE1: true,
      serverEnv: cloudEnv(cliVersion),
    }),
  );
  try {
    record(assertions, "e1-baseline-count", fixture.e1.count === 42, String(fixture.e1.count));
    const secret = `e1local${randomUUID().replaceAll("-", "")}`;
    await fixture.postgres.psql(e1LocalSeedSql({ accountId: fixture.accounts[0].id, secret }));
    const snapshotSql = `select jsonb_build_object(
      'computer', (select to_jsonb(c) - 'kind' from computers c where id='${E2_IDS.localComputer}'),
      'credential', (select to_jsonb(c) from computer_credentials c where id='${E2_IDS.localCredential}'),
      'agent', (select to_jsonb(a) from agents a where id='${E2_IDS.localAgent}'),
      'runtime', (select to_jsonb(r) - 'context_tree_repository' from agent_runtime_configs r where agent_id='${E2_IDS.localAgent}')
    )::text`;
    const beforeUpgrade = await fixture.postgres.psql(snapshotSql);
    await fixture.startServer();
    record(assertions, "e1-all-local-data-preserved", (await fixture.postgres.psql(snapshotSql)) === beforeUpgrade);
    const signed = await fixture.signIn(fixture.accounts[0].email);
    const listed = await signed.api.get("/api/v1/computers");
    record(
      assertions,
      "e1-local-api-query",
      listed.computers.some((entry) => entry.computerId === E2_IDS.localComputer && entry.kind === undefined),
    );
    const ledger = await fixture.readAppliedMigrations();
    const expectedHashes = await currentMigrationHashes(repositoryRoot);
    record(assertions, "e1-upgrade-count", ledger.count === expectedHashes.length, String(ledger.count));
    record(assertions, "e1-upgrade-source-hashes", JSON.stringify(ledger.hashes) === JSON.stringify(expectedHashes));
    record(
      assertions,
      "e1-context-tree-default",
      (await fixture.postgres.psql(
        `select context_tree_repository is null from agent_runtime_configs where agent_id='${E2_IDS.localAgent}'`,
      )) === "t",
    );
    record(
      assertions,
      "e1-hash-prefix",
      JSON.stringify(ledger.hashes.slice(0, 42)) === JSON.stringify(fixture.e1.hashes),
    );
    const kind = await fixture.postgres.psql(`select kind from computers where id='${E2_IDS.localComputer}'`);
    record(assertions, "e1-local-kind", kind === "local", kind);
    const cred = await fixture.postgres.psql(
      `select count(*)::int from computer_credentials where id='${E2_IDS.localCredential}'`,
    );
    record(assertions, "e1-local-credential", Number(cred) === 1, cred);
    const agent = await fixture.postgres.psql(`select runtime_provider from agents where id='${E2_IDS.localAgent}'`);
    record(assertions, "e1-local-agent", agent === "pi", agent);
    const config = await fixture.postgres.psql(
      `select count(*)::int from agent_runtime_configs where agent_id='${E2_IDS.localAgent}'`,
    );
    record(assertions, "e1-local-runtime-config", Number(config) === 1, config);
  } catch (error) {
    const failures = await fixture.cleanup();
    if (failures.length) {
      throw new Error(`${error.message}; upgrade cleanup failed: ${failures.join("; ")}`);
    }
    throw error;
  }
  const failures = await fixture.cleanup();
  if (failures.length) throw new Error(`upgrade cleanup failed: ${failures.join("; ")}`);
  return fixture.lastCleanup;
}

async function signBoth(fixture, assertions) {
  const first = await fixture.signIn(fixture.accounts[0].email);
  const second = await fixture.signIn(fixture.accounts[1].email);
  const meA = await first.api.get("/api/v1/me");
  const meB = await second.api.get("/api/v1/me");
  record(assertions, "signin-a-account", meA.user.id === fixture.accounts[0].id);
  record(
    assertions,
    "signin-a-cookie-csrf",
    Boolean(first.cookies.header()) && Boolean(first.cookies.get("opentag_csrf")),
  );
  record(assertions, "signin-b-account", meB.user.id === fixture.accounts[1].id);
  record(assertions, "signin-b-cookie", Boolean(second.cookies.header()));
  return { first, second };
}

async function runAuthGuards(fixture, shared, cookiesA, assertions) {
  const unauth = await requestJson({
    baseUrl: fixture.baseUrl,
    method: "PUT",
    path: shared.HTTP_PATHS.accountCloudComputer,
    body: {},
    headers: cloudIdentityHeaders(),
    csrf: false,
  });
  record(
    assertions,
    "unauthenticated-cloud-ensure",
    unauth.status === 401 && unauth.body?.error?.code === "AUTH_INVALID_TOKEN",
    unauth.status,
  );
  const before = await fixture.postgres.psql("select count(*)::int from computers where kind = 'cloud'");
  const noCsrf = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "PUT",
    path: shared.HTTP_PATHS.accountCloudComputer,
    body: {},
    headers: cloudIdentityHeaders(),
    csrf: false,
  });
  const after = await fixture.postgres.psql("select count(*)::int from computers where kind = 'cloud'");
  record(
    assertions,
    "csrf-free-cloud-ensure",
    noCsrf.status === 403 && noCsrf.body?.error?.code === "AUTH_INVALID_TOKEN" && before === after,
    `${noCsrf.status} ${before}->${after}`,
  );
}

async function runFlagOffCases(ctx) {
  const { fixture, shared, cookiesA, assertions } = ctx;
  const availability = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.HTTP_PATHS.accountCloudComputer,
  });
  record(
    assertions,
    "overall-off-overrides-model-on",
    availability.ok &&
      availability.body.enabled === false &&
      availability.body.available === false &&
      availability.body.reason === "disabled",
    availability.status,
  );
  const ensure = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "PUT",
    path: shared.HTTP_PATHS.accountCloudComputer,
    body: {},
    headers: cloudIdentityHeaders(),
  });
  record(assertions, "flag-off-cloud-ensure", ensure.status === 404, ensure.status);
  const agent = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: {
      name: "e2-flag-off",
      displayName: "flag off",
      runtimeProvider: "pi",
      computerId: ctx.cloudA.computerId,
      creationIntentId: randomUUID(),
    },
  });
  record(assertions, "flag-off-known-cloud-agent", agent.status === 404, agent.status);
  const replay = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountAgents,
    body: {
      name: ctx.agentA.name,
      displayName: ctx.agentA.displayName,
      runtimeProvider: "pi",
      computerId: ctx.cloudA.computerId,
      creationIntentId: ctx.intentId,
    },
  });
  record(assertions, "flag-off-cloud-creation-intent-replay", replay.status === 404, replay.status);
  const sandbox = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountSandboxes,
    body: {
      imBindingId: ctx.bindingA.bindingId,
      channelId: "C0E2FLAG",
      conversationKind: "channel",
      kind: "channel",
    },
    headers: cloudIdentityHeaders(),
  });
  record(assertions, "flag-off-sandbox-ensure", sandbox.status === 404, sandbox.status);
  const read = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "GET",
    path: shared.accountSandboxPath(ctx.sandboxA.sandboxId),
    headers: cloudIdentityHeaders(),
  });
  record(assertions, "flag-off-existing-read", read.ok && read.body.sandboxId === ctx.sandboxA.sandboxId);
  const localIssue = await requestJson({
    baseUrl: fixture.baseUrl,
    cookies: cookiesA,
    method: "POST",
    path: shared.HTTP_PATHS.accountComputerConnectCodes,
    body: { mode: "create" },
  });
  record(assertions, "flag-off-local-paths", localIssue.ok, localIssue.status);
}

export async function runCloudIdentities({ repositoryRoot, args = [] }) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  return executeCloudIdentities(repositoryRoot);
}

async function executeCloudIdentities(repositoryRoot) {
  const startedAt = Date.now();
  const artifactDirectory = resolve(
    process.env.OPENTAG_E2_ARTIFACTS ?? join(tmpdir(), `opentag-e2-identities-${process.pid}`),
  );
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const assertions = [];
  const { step, steps } = createStepper();
  let fixture;
  let exitCode = 1;
  const summary = {
    command: "cloud-identities",
    status: "failed",
    phase: "startup",
    substitutions: SUBSTITUTIONS,
    assertions,
    steps,
    artifactDirectory,
  };
  const writeSummary = (extra = {}) =>
    writeFile(
      join(artifactDirectory, "summary.json"),
      `${JSON.stringify({ ...summary, ...extra, assertions, steps }, null, 2)}\n`,
    );
  try {
    const [git, shared, cliVersion] = await Promise.all([
      gitState(repositoryRoot),
      loadShared(repositoryRoot),
      readCliVersion(repositoryRoot),
    ]);
    Object.assign(summary, git, { clientVersion: cliVersion });
    await writeSummary({ phase: "prerequisites" });
    summary.upgradeCleanup = await runUpgradePhase({ repositoryRoot, artifactDirectory, cliVersion, assertions, step });
    fixture = await step("start clean disposable Postgres and production Server", async () =>
      createCloudIdentitiesFixture({
        repositoryRoot,
        artifactDirectory,
        port: process.env.OPENTAG_E2_PORT ? Number(process.env.OPENTAG_E2_PORT) : undefined,
        serverEnv: cloudEnv(cliVersion),
      }),
    );
    await fixture.startServer();
    const clean = await fixture.readAppliedMigrations();
    const expectedHashes = await currentMigrationHashes(repositoryRoot);
    record(assertions, "clean-migration-count", clean.count === expectedHashes.length, String(clean.count));
    record(
      assertions,
      "clean-migration-source-hashes",
      JSON.stringify(clean.hashes) === JSON.stringify(expectedHashes),
    );
    const { first, second } = await step("two real dev sign-ins across Server restart", () =>
      signBoth(fixture, assertions),
    );
    await runAuthGuards(fixture, shared, first.cookies, assertions);
    const ctx = {
      fixture,
      shared,
      cookiesA: first.cookies,
      cookiesB: second.cookies,
      assertions,
      cliVersion,
      accountA: fixture.accounts[0],
      accountB: fixture.accounts[1],
      intentId: randomUUID(),
    };
    await step("Cloud Computer ensure, metadata, and lists", () => runCloudComputerCases(ctx));
    await step("Cloud Pi Agent create and rebind guards", () => runAgentCases(ctx));
    await step("Sandbox ensure, distinct identity, and foreign refusal", () => runSandboxCases(ctx));
    await step("Local connect/repair/register without daemon", () => runLocalConnectCases(ctx));
    await step("Cloud Local repair/register negative fixtures", () => runCloudGuardCases(ctx));
    const beforeRestart = {
      cloudId: ctx.cloudA.computerId,
      agentId: ctx.agentA.id,
      sessionId: ctx.sandboxA.sessionId,
      sandboxId: ctx.sandboxA.sandboxId,
      storageUri: ctx.sandboxA.storageUri,
    };
    const restarted = await fixture.restartServer(
      cloudEnv(cliVersion, {
        OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-e2-fixture/other",
        OPENTAG_CLOUD_RUNNER_VERSION: "9.9.9",
      }),
    );
    record(assertions, "restart-new-pid", Boolean(restarted.pid) && restarted.pid !== restarted.previousPid);
    record(assertions, "restart-old-exit", restarted.previousExitCode !== null || Boolean(restarted.previousSignal));
    summary.restart = restarted;
    const me = await first.api.get("/api/v1/me");
    record(assertions, "cookie-survives-restart", me.user.id === fixture.accounts[0].id);
    const sandbox = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: first.cookies,
      method: "GET",
      path: shared.accountSandboxPath(beforeRestart.sandboxId),
      headers: cloudIdentityHeaders(),
    });
    record(assertions, "restart-same-sandbox", sandbox.body?.sandboxId === beforeRestart.sandboxId);
    record(assertions, "restart-same-storage-uri", sandbox.body?.storageUri === beforeRestart.storageUri);
    record(assertions, "restart-same-session", sandbox.body?.sessionId === beforeRestart.sessionId);
    record(assertions, "storage-prefix-not-overwritten", sandbox.body?.storageUri.startsWith(CLOUD_STORAGE_URI));
    const cloud = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: first.cookies,
      method: "PUT",
      path: shared.HTTP_PATHS.accountCloudComputer,
      body: {},
      headers: cloudIdentityHeaders(),
    });
    record(assertions, "restart-same-cloud", cloud.body?.computerId === beforeRestart.cloudId);
    record(
      assertions,
      "restart-cloud-all-metadata-stable",
      (await fixture.postgres.psql(`select to_jsonb(c)::text from computers c where id='${beforeRestart.cloudId}'`)) ===
        ctx.cloudSnapshot,
    );
    const agentAfterRestart = await first.api.get(shared.agentConfigPath(beforeRestart.agentId));
    record(
      assertions,
      "restart-agent-binding-stable",
      agentAfterRestart.id === beforeRestart.agentId &&
        agentAfterRestart.computerId === beforeRestart.cloudId &&
        agentAfterRestart.runtimeProvider === "pi",
    );
    const reensured = await requestJson({
      baseUrl: fixture.baseUrl,
      cookies: first.cookies,
      method: "POST",
      path: shared.HTTP_PATHS.accountSandboxes,
      body: {
        imBindingId: ctx.bindingA.bindingId,
        channelId: "C0E2CHANNEL",
        conversationKind: "channel",
        kind: "channel",
      },
    });
    record(
      assertions,
      "restart-sandbox-reensure-stable",
      reensured.ok && JSON.stringify(reensured.body) === JSON.stringify(ctx.sandboxA),
    );
    await runResourceConstraints(ctx);
    await fixture.restartServer(
      cloudEnv(cliVersion, {
        OPENTAG_CLOUD_IDENTITIES_ENABLED: "false",
        OPENTAG_CLOUD_MODEL_ENABLED: "true",
        OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "https://models-fixture.example.com/v1",
        OPENTAG_CLOUD_MODEL_MASTER_KEY: "fixture-model-key-not-a-secret",
        OPENTAG_CLOUD_MODEL_ALLOWED_MODELS: "fixture-model",
      }),
    );
    await runFlagOffCases(ctx);
    if (assertions.some((entry) => !entry.ok)) throw new Error("Acceptance contains a failed assertion");
    summary.status = "passed";
    summary.phase = "complete";
    exitCode = 0;
  } catch (error) {
    const detail = fixture ? fixture.redact(error.message) : String(error?.message ?? error);
    summary.error = detail;
    summary.phase = steps.filter((entry) => !entry.ok).at(-1)?.label ?? summary.phase;
    process.stderr.write(`${detail}\n`);
  } finally {
    if (await finishFixture(fixture, summary)) exitCode = 1;
    summary.elapsedMs = Date.now() - startedAt;
    await writeSummary();
    process.stdout.write(`${assertions.filter((entry) => entry.ok).length}/${assertions.length} assertions passed\n`);
    process.stdout.write(`Artifacts: ${artifactDirectory}\n`);
  }
  return exitCode;
}

async function finishFixture(fixture, summary) {
  if (!fixture) return false;
  const cleanupFailures = await fixture.cleanup();
  summary.cleanup = fixture.lastCleanup ?? { failures: cleanupFailures };
  summary.cleanupFailures = cleanupFailures;
  if (!cleanupFailures.length) return false;
  summary.status = "failed";
  summary.phase = "cleanup";
  return true;
}

async function runResourceConstraints({ fixture, assertions, sandboxA, sandboxOtherChannel }) {
  for (const field of ["name", "uid"]) {
    let conflict;
    try {
      await fixture.postgres.psql(
        resourceUniqueProbeSql({
          idA: sandboxA.sandboxId,
          idB: sandboxOtherChannel.sandboxId,
          name: "projects/opentag-e2-fixture/locations/us-west1/instances/fixture-e2-1",
          uid: randomUUID(),
          field,
        }),
      );
    } catch (error) {
      conflict = error;
    }
    record(
      assertions,
      `db-only-resource-${field}-unique`,
      Boolean(conflict?.message.includes(`sandboxes_current_resource_${field}_unique`)),
      "DB-only resource ownership test; not GCP allocation",
    );
  }
  const leftover = await fixture.postgres.psql(
    `select count(*) from sandboxes where current_resource_name is not null or current_resource_uid is not null`,
  );
  record(assertions, "db-only-resource-fields-restored", Number(leftover) === 0, leftover);
}
