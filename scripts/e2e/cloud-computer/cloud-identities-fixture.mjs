/**
 * E2 identities fixture: disposable Postgres + production Server. No Pi config,
 * daemon, process secrets, or Slack/Feishu/model APIs. Parent SQL-seeds Local
 * Computer after E1 migrate and before startServer(). extraEnv allowlist is EXTRA_ENV_KEYS.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertPortAvailable,
  childStillRunning,
  ensureDir,
  execFileAsync,
  processExists,
  redactSecrets,
  spawnLogged,
  stopChild,
  waitFor,
  withTimeout,
} from "./common.mjs";
import { createBrowserApi, createCookieJar, signInDev } from "./http.mjs";
import { startDisposablePostgres } from "./postgres.mjs";

const E1_BASELINE_COMMIT = "440dfed53c3bb22a8527cd731f82e9b9006bd9b5";
const E1_THROUGH_IDX = 41;
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_HELPER = join(HERE, "cloud-identities-migrations.ts");
const EXTRA_ENV_KEYS = new Set([
  "OPENTAG_DEV_AUTH_EMAIL",
  "OPENTAG_DEV_AUTH_BYPASS_ENABLED",
  "OPENTAG_PORTABLE_DOWNLOAD_BASE_URL",
  "OPENTAG_EMAIL_PASSWORD_AUTH_ENABLED",
  "OPENTAG_DEV_INTERNAL_TOOLS_ENABLED",
  "OPENTAG_LOG_LEVEL",
  "OPENTAG_CLOUD_IDENTITIES_ENABLED",
  "OPENTAG_CLOUD_STORAGE_BASE",
  "OPENTAG_CLOUD_RUNNER_VERSION",
  "OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT",
  "OPENTAG_CLOUD_RUNNER_MAX_INSTANCES",
  "OPENTAG_CLOUD_RUNNER_IMAGE",
  "OPENTAG_CLOUD_RUNNER_PROJECT",
  "OPENTAG_CLOUD_RUNNER_REGION",
  "OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT",
  "OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN",
  "OPENTAG_CLOUD_RUNNER_VPC_NETWORK",
  "OPENTAG_CLOUD_RUNNER_VPC_SUBNET",
  "OPENTAG_CLOUD_RUNNER_EXECUTION_TAG",
  "OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN",
  "OPENTAG_PUBLIC_URL",
  "OPENTAG_CLOUD_MODEL_ENABLED",
  "OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL",
  "OPENTAG_CLOUD_MODEL_MASTER_KEY",
  "OPENTAG_CLOUD_MODEL_ALLOWED_MODELS",
]);
const BASIC_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
  "SHELL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];
const DEFAULT_ACCOUNTS = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", email: "e2-identities-a@opentag.local", displayName: "A" },
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", email: "e2-identities-b@opentag.local", displayName: "B" },
];

function copyEnvWithoutSecrets(source) {
  return Object.fromEntries(BASIC_ENV_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function pickAllowedEnv(extraEnv = {}) {
  const unknown = Object.keys(extraEnv).filter((key) => !EXTRA_ENV_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Refused extra env keys ${unknown.join(", ")}; use the explicit acceptance allowlist`);
  }
  return Object.fromEntries(Object.entries(extraEnv).filter(([, value]) => value !== undefined && value !== ""));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rememberSecret(secrets, value) {
  if (value && !secrets.includes(value)) secrets.push(value);
}

function seedAccountsSql(accounts) {
  const values = accounts
    .map((account) => `(${sqlString(account.id)}, ${sqlString(account.email)}, ${sqlString(account.displayName)})`)
    .join(", ");
  return `insert into users (id, email, display_name) values ${values} on conflict (id) do nothing;`;
}

async function allocateListenPort() {
  return new Promise((settle, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) fail(error);
        else if (!Number.isInteger(port) || port < 1) fail(new Error("Could not allocate a loopback port"));
        else settle(port);
      });
    });
  });
}

async function resolvePort(port) {
  if (port === undefined) return allocateListenPort();
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`Invalid port: ${port}`);
  await assertPortAvailable(value);
  return value;
}

function resolveAccounts(emails) {
  if (emails === undefined) return DEFAULT_ACCOUNTS.map((account) => ({ ...account }));
  if (!Array.isArray(emails) || emails.length !== 2 || emails.some((email) => !email)) {
    throw new Error("emails must be exactly two test account addresses");
  }
  return DEFAULT_ACCOUNTS.map((account, index) => ({ ...account, email: String(emails[index]).trim().toLowerCase() }));
}

async function readCurrentMigrationTags(repositoryRoot) {
  const journalPath = join(repositoryRoot, "packages/server/drizzle/meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  return journal.entries.map((entry) => entry.tag);
}

async function readAppliedMigrations(postgres) {
  const raw = await postgres.psql("select hash from drizzle.__drizzle_migrations order by created_at asc");
  const hashes = raw.split("\n").filter(Boolean);
  return { count: hashes.length, hashes };
}

function verifyE1Prefix({ tags, hashes, currentTags }) {
  if (tags.length !== hashes.length) {
    throw new Error(
      `E1 migrate applied ${hashes.length} hashes, expected ${tags.length} files through idx ${E1_THROUGH_IDX}`,
    );
  }
  const prefix = currentTags.slice(0, tags.length);
  const mismatch = tags.findIndex((tag, index) => prefix[index] !== tag);
  if (mismatch >= 0) {
    throw new Error(
      `E1 migration tag prefix mismatch at idx ${mismatch}: baseline ${tags[mismatch]}, current ${
        prefix[mismatch] ?? "(missing)"
      }`,
    );
  }
}

async function applyE1Migrations({ repositoryRoot, postgres, output, secrets }) {
  const tsxLoader = join(repositoryRoot, "node_modules", "tsx", "dist", "loader.mjs");
  if (!existsSync(tsxLoader) || !existsSync(MIGRATIONS_HELPER)) {
    throw new Error("E1 upgrade requires tsx and cloud-identities-migrations.ts");
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        pathToFileURL(tsxLoader).href,
        MIGRATIONS_HELPER,
        "--repository-root",
        repositoryRoot,
        "--output",
        output,
        "--commit",
        E1_BASELINE_COMMIT,
        "--through-idx",
        String(E1_THROUGH_IDX),
      ],
      {
        cwd: repositoryRoot,
        env: { ...copyEnvWithoutSecrets(process.env), OPENTAG_DATABASE_URL: postgres.databaseUrl },
        maxBuffer: 2 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    if (!Number.isInteger(parsed.count) || !Array.isArray(parsed.tags)) {
      throw new Error("E1 migrate helper did not report count and tags");
    }
    return parsed;
  } catch (error) {
    throw new Error(redactSecrets(error.message, ...secrets));
  }
}

function buildServerEnv(o) {
  return {
    ...copyEnvWithoutSecrets(process.env),
    HOME: o.home,
    // The Server resolves runtimeControlDirectory to '.opentag-control' under its cwd
    // (repositoryRoot here), which would leak durable control state past fixture cleanup.
    // Pin it inside the fixture-owned temporary HOME so workspace cleanup removes it.
    OPENTAG_RUNTIME_CONTROL_DIRECTORY: join(o.home, "runtime-control"),
    OPENTAG_DATABASE_URL: o.postgres.databaseUrl,
    OPENTAG_AUTO_MIGRATE: "true",
    OPENTAG_ENV: "dev",
    OPENTAG_HOST: "127.0.0.1",
    OPENTAG_PORT: String(o.port),
    OPENTAG_PUBLIC_URL: o.baseUrl,
    OPENTAG_JWT_SECRET: o.jwtSecret,
    BETTER_AUTH_SECRET: o.betterAuthSecret,
    OPENTAG_ENCRYPTION_KEY: o.encryptionKey.toString("base64"),
    OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
    OPENTAG_LOG_LEVEL: "info",
    OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: o.downloadBaseUrl,
    OPENTAG_OTEL_ENDPOINT: "",
    ...o.extraEnv,
    OPENTAG_DEV_AUTH_EMAIL:
      o.extraEnv.OPENTAG_DEV_AUTH_BYPASS_ENABLED === "false"
        ? undefined
        : (o.extraEnv.OPENTAG_DEV_AUTH_EMAIL ?? o.email),
  };
}

function spawnServer({ repositoryRoot, serverEntry, logPath, env, secrets, baseUrl }) {
  // Keep the cleanup API alive when Ctrl-C reaches the harness foreground process group.
  // The fixture retains the child handle and stops it only after Cloud resources are removed.
  const child = spawnLogged(process.execPath, [serverEntry], {
    cwd: repositoryRoot,
    logPath,
    secrets,
    env,
    detached: true,
  });
  const listening = new Promise((settle) => {
    let announced = "";
    child.stdout.on("data", (chunk) => {
      if (announced.length > 8_192) announced = announced.slice(-1_024);
      announced += String(chunk);
      if (announced.includes(`Server listening at ${baseUrl}`)) settle(undefined);
    });
  });
  const exited = new Promise((_, fail) => {
    child.once("exit", (code, signal) => fail(new Error(`Server exited with ${code ?? signal}; see ${logPath}`)));
  });
  exited.catch(() => undefined);
  return { child, listening, exited };
}

async function waitUntilReady({ listening, exited, baseUrl, logPath }) {
  await withTimeout(
    Promise.race([listening, exited]),
    60_000,
    `Server did not bind ${baseUrl} within 60s; see ${logPath}`,
  );
  await waitFor("the Server health endpoint", async () => (await fetch(`${baseUrl}/healthz`)).ok);
}

function redactOwned(resources, error) {
  return redactSecrets(error?.message ?? error, ...(resources.secrets ?? []));
}

async function stopOwned(resources) {
  const result = {
    failures: [...(resources.cleanupFailures ?? [])],
    server: { pid: resources.server?.pid, stopped: !resources.server, exitCode: null, signal: null },
    postgres: { name: resources.postgres?.name, removed: !resources.postgres },
    workspace: { path: resources.workspace, removed: false },
  };
  if (resources.server) {
    try {
      const pid = resources.server.pid;
      await stopChild(resources.server, { name: "server", graceMs: 10_000 });
      result.server = {
        pid,
        stopped: true,
        exitCode: resources.server.exitCode ?? null,
        signal: resources.server.signalCode ?? null,
      };
      resources.server = undefined;
    } catch (error) {
      result.failures.push(redactOwned(resources, error));
    }
  }
  if (resources.postgres) {
    try {
      await resources.postgres.stop();
      result.postgres.removed = true;
      resources.postgres = undefined;
    } catch (error) {
      result.failures.push(redactOwned(resources, error));
    }
  }
  if (resources.workspace) {
    try {
      await rm(resources.workspace, { recursive: true, force: true });
      result.workspace.removed = true;
    } catch (error) {
      result.failures.push(redactOwned(resources, error));
    }
  }
  resources.lastCleanup = result;
  return result;
}

async function failedStartup(resources, error) {
  const { failures } = await stopOwned(resources);
  const detail = redactOwned(resources, error);
  if (!failures.length) return new Error(`Fixture startup failed: ${detail}`, { cause: error });
  return new AggregateError(
    [error, ...failures.map((message) => new Error(message))],
    `Fixture startup failed: ${detail}; cleanup failed: ${failures.join("; ")}`,
  );
}

function requireServerEntry(repositoryRoot) {
  const serverEntry = join(repositoryRoot, "packages", "server", "dist", "index.mjs");
  if (!existsSync(serverEntry)) throw new Error("Run pnpm build before this check (packages/server/dist is required)");
  return serverEntry;
}

function createProcessController(ctx) {
  const currentEmail = () => ctx.extraEnv.OPENTAG_DEV_AUTH_EMAIL ?? ctx.accounts[0].email;

  async function startServer(nextEnv = {}) {
    if (childStillRunning(ctx.server)) throw new Error("Server is already running");
    ctx.extraEnv = { ...ctx.extraEnv, ...pickAllowedEnv(nextEnv) };
    const serverEntry = requireServerEntry(ctx.repositoryRoot);
    await assertPortAvailable(ctx.port);
    const spawned = spawnServer({
      repositoryRoot: ctx.repositoryRoot,
      serverEntry,
      logPath: ctx.serverLogPath,
      secrets: ctx.secrets,
      baseUrl: ctx.baseUrl,
      env: buildServerEnv({
        home: ctx.home,
        postgres: ctx.postgres,
        port: ctx.port,
        baseUrl: ctx.baseUrl,
        jwtSecret: ctx.jwtSecret,
        betterAuthSecret: ctx.betterAuthSecret,
        encryptionKey: ctx.encryptionKey,
        extraEnv: ctx.extraEnv,
        downloadBaseUrl: ctx.extraEnv.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL ?? ctx.downloadBaseUrl,
        email: currentEmail(),
      }),
    });
    ctx.server = spawned.child;
    ctx.resources.server = spawned.child;
    try {
      await waitUntilReady({ ...spawned, baseUrl: ctx.baseUrl, logPath: ctx.serverLogPath });
      await ctx.postgres.psql(seedAccountsSql(ctx.accounts));
    } catch (error) {
      try {
        await stopChild(ctx.server, { name: "server", graceMs: 10_000 });
        ctx.resources.server = undefined;
        ctx.server = undefined;
      } catch (stopError) {
        if (!ctx.resources.cleanupFailures) ctx.resources.cleanupFailures = [];
        ctx.resources.cleanupFailures.push(redactSecrets(stopError.message, ...ctx.secrets));
      }
      throw new Error(redactSecrets(error.message, ...ctx.secrets));
    }
    return { pid: ctx.server.pid };
  }

  async function stopServer() {
    const pid = ctx.server?.pid;
    const running = childStillRunning(ctx.server);
    try {
      await stopChild(ctx.server, { name: "server", graceMs: 10_000 });
    } catch (error) {
      if (running && pid && (await processExists(pid))) throw error;
    }
    const exitCode = ctx.server?.exitCode ?? null;
    const signal = ctx.server?.signalCode ?? null;
    if (running && pid && (await processExists(pid))) {
      throw new Error(`Server pid ${pid} still running after stop (exitCode=${exitCode})`);
    }
    ctx.resources.server = undefined;
    ctx.server = undefined;
    return { pid, exitCode, signal };
  }

  async function restartServer(nextEnv = {}) {
    const stopped = await stopServer();
    const started = await startServer(nextEnv);
    if (!started.pid || !(await processExists(started.pid))) {
      throw new Error("Server restart did not leave a running process");
    }
    return {
      previousPid: stopped.pid,
      previousExitCode: stopped.exitCode,
      previousSignal: stopped.signal,
      pid: started.pid,
    };
  }

  async function signIn(email) {
    if (!email) throw new Error("signIn requires an account email");
    if (!childStillRunning(ctx.server) || currentEmail() !== email) {
      const env = { OPENTAG_DEV_AUTH_EMAIL: email };
      await (childStillRunning(ctx.server) ? restartServer(env) : startServer(env));
    }
    const cookies = createCookieJar();
    await signInDev({ baseUrl: ctx.baseUrl, cookies });
    rememberSecret(ctx.secrets, cookies.header());
    rememberSecret(ctx.secrets, cookies.get("opentag_csrf"));
    return { cookies, api: createBrowserApi({ baseUrl: ctx.baseUrl, cookies }) };
  }

  return { startServer, stopServer, restartServer, signIn };
}

export async function createCloudIdentitiesFixture(options = {}) {
  const { repositoryRoot, artifactDirectory } = options;
  if (!repositoryRoot || !artifactDirectory) {
    throw new Error("createCloudIdentitiesFixture requires repositoryRoot and artifactDirectory");
  }
  // Canonicalize the platform temporary directory before mkdtemp: on macOS tmpdir() is
  // /var/folders/... with /var a symlink to /private/var, and the Server session-control
  // store rejects symlink ancestors. Workspace, home, runtime-control, and cleanup must
  // all use the physical path.
  const temporaryRoot = await realpath(tmpdir());
  const workspace = await mkdtemp(join(temporaryRoot, "opentag-e2-identities-"));
  const resources = { workspace, secrets: [], cleanupFailures: [] };
  try {
    return await assembleFixture({ ...options, resources });
  } catch (error) {
    throw await failedStartup(resources, error);
  }
}

async function assembleFixture(input) {
  const { repositoryRoot, artifactDirectory, upgradeFromE1, serverEnv, emails, resources } = input;
  const home = await ensureDir(join(resources.workspace, "home"));
  await ensureDir(artifactDirectory);
  const accounts = resolveAccounts(emails);
  const extraEnvState = pickAllowedEnv(serverEnv);
  const port = await resolvePort(input.port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const downloadBaseUrl = extraEnvState.OPENTAG_PORTABLE_DOWNLOAD_BASE_URL ?? `${baseUrl}/e2-channel-target`;
  const encryptionKey = randomBytes(32);
  const jwtSecret = randomBytes(32).toString("hex");
  const betterAuthSecret = randomBytes(32).toString("hex");
  const serverLogPath = join(artifactDirectory, "server.log");
  const secrets = resources.secrets;
  const postgres = await startDisposablePostgres();
  resources.postgres = postgres;
  rememberSecret(secrets, postgres.password);
  rememberSecret(secrets, postgres.databaseUrl);
  rememberSecret(secrets, jwtSecret);
  rememberSecret(secrets, betterAuthSecret);
  rememberSecret(secrets, encryptionKey.toString("base64"));
  rememberSecret(secrets, extraEnvState.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN);
  rememberSecret(secrets, extraEnvState.OPENTAG_CLOUD_MODEL_MASTER_KEY);

  let e1;
  if (upgradeFromE1) {
    const output = await ensureDir(join(resources.workspace, "e1-migrations"));
    const applied = await applyE1Migrations({ repositoryRoot, postgres, output, secrets });
    const hashes = await readAppliedMigrations(postgres);
    const currentTags = await readCurrentMigrationTags(repositoryRoot);
    verifyE1Prefix({ tags: applied.tags, hashes: hashes.hashes, currentTags });
    await postgres.psql(seedAccountsSql(accounts));
    e1 = {
      baselineCommit: E1_BASELINE_COMMIT,
      throughIdx: E1_THROUGH_IDX,
      count: hashes.count,
      hashes: hashes.hashes,
      tags: applied.tags,
    };
  }

  const cleanupFailures = [];
  const ctx = {
    accounts,
    betterAuthSecret,
    downloadBaseUrl,
    encryptionKey,
    extraEnv: extraEnvState,
    home,
    jwtSecret,
    port,
    postgres,
    repositoryRoot,
    resources,
    secrets,
    server: undefined,
    serverLogPath,
    baseUrl,
  };
  const control = createProcessController(ctx);

  async function cleanup() {
    const result = await stopOwned(resources);
    cleanupFailures.splice(0, cleanupFailures.length, ...result.failures);
    return result.failures;
  }

  return {
    postgres,
    baseUrl,
    port,
    encryptionKey,
    secrets,
    accounts,
    e1,
    artifactDirectory,
    serverLogPath,
    workspace: resources.workspace,
    ...control,
    readAppliedMigrations: () => readAppliedMigrations(postgres),
    cleanup,
    get lastCleanup() {
      return resources.lastCleanup;
    },
    get pids() {
      return { server: childStillRunning(ctx.server) ? ctx.server.pid : undefined };
    },
    get cleanupFailures() {
      return [...cleanupFailures, ...(resources.cleanupFailures ?? [])];
    },
    redact: (text) => redactSecrets(text, ...secrets),
  };
}

export { DEFAULT_ACCOUNTS, E1_BASELINE_COMMIT, E1_THROUGH_IDX };
