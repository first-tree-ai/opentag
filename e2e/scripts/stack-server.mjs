#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = join(repositoryRoot, "docker-compose.yml");
const port = Number(process.env.OPENTAG_E2E_PORT ?? 8123);
const baseURL = `http://127.0.0.1:${port}`;
const adminDatabaseURL =
  process.env.OPENTAG_E2E_ADMIN_DATABASE_URL ?? "postgresql://opentag:opentag@127.0.0.1:5432/postgres";
const databaseName = process.env.OPENTAG_E2E_DATABASE ?? "opentag_e2e";
const databaseURL = new URL(adminDatabaseURL);
databaseURL.pathname = `/${databaseName}`;
const devEmail = "e2e@opentag.local";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountComputerId = "44444444-4444-4444-8444-444444444444";
const installationId = "55555555-5555-4555-8555-555555555555";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const runtimeFile = join(repositoryRoot, "e2e", ".runtime.json");

if (!/^[a-z][a-z0-9_]{0,61}$/.test(databaseName) || !databaseName.includes("e2e")) {
  throw new Error(`OPENTAG_E2E_DATABASE must be a lowercase disposable e2e identifier, received ${databaseName}`);
}

function connectionTarget(url) {
  const target = new URL(String(url));
  const password = decodeURIComponent(target.password);
  target.password = "";
  return { dsn: target.href, password };
}

async function psql(url, sql) {
  const { dsn, password } = connectionTarget(url);
  const { stdout } = await execFileAsync("psql", [dsn, "-v", "ON_ERROR_STOP=1", "-Atc", sql], {
    env: { ...process.env, PGPASSWORD: password },
  });
  return stdout.trim();
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { cwd: repositoryRoot, ...options });
}

async function waitForDatabase() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await psql(adminDatabaseURL, "select 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function resetDatabase() {
  await psql(adminDatabaseURL, `drop database if exists "${databaseName}" with (force)`);
  await psql(adminDatabaseURL, `create database "${databaseName}"`);
}

async function bootstrapAndSeed() {
  const bootstrap = await run("node", [join(repositoryRoot, "packages/server/dist/admin/bootstrap-cli.mjs")], {
    env: {
      ...process.env,
      OPENTAG_DATABASE_URL: databaseURL.toString(),
      OPENTAG_BOOTSTRAP_EMAIL: devEmail,
      OPENTAG_BOOTSTRAP_DISPLAY_NAME: "OpenTag E2E Admin",
    },
  });
  const result = JSON.parse(bootstrap.stdout);
  const userId = result.userId;
  await psql(
    databaseURL,
    `insert into workspaces (id, name, display_name) values ('${workspaceId}', 'e2e-workspace', 'E2E Workspace');
     insert into workspace_admin_grants (workspace_id, user_id, granted_by_user_id)
       values ('${workspaceId}', '${userId}', '${userId}');
     insert into computers (id) values ('${installationId}');
     insert into account_computers (
       id, owner_account_id, current_installation_id, display_name, platform, arch, client_version
     ) values (
       '${accountComputerId}', '${userId}', '${installationId}', 'E2E Computer', 'linux', 'x86_64', 'e2e'
     );
     insert into workspace_computers (
       id, workspace_id, computer_id, display_name, platform, arch, client_version, enrolled_by_user_id
     ) values (
       '${accountComputerId}', '${workspaceId}', '${installationId}', 'E2E Computer', 'linux', 'x86_64', 'e2e', '${userId}'
     );`,
  );
  await mkdir(dirname(runtimeFile), { recursive: true });
  await writeFile(
    runtimeFile,
    JSON.stringify(
      {
        adminDatabaseURL,
        databaseURL: databaseURL.toString(),
        userId,
        workspaceId,
        accountComputerId,
        installationId,
        devEmail,
        baseURL,
      },
      null,
      2,
    ),
  );
}

async function main() {
  if (!existsSync(join(repositoryRoot, "packages/server/dist/index.mjs"))) {
    throw new Error("Built server is missing. Run pnpm build before pnpm test:e2e.");
  }
  if (!existsSync(join(repositoryRoot, "apps/web/dist/index.html"))) {
    throw new Error("Built Web app is missing. Run pnpm build before pnpm test:e2e.");
  }
  await run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres"]);
  await waitForDatabase();
  await resetDatabase();
  await bootstrapAndSeed();

  const server = spawn(process.execPath, [join(repositoryRoot, "packages/server/dist/index.mjs")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OPENTAG_DATABASE_URL: databaseURL.toString(),
      OPENTAG_AUTO_MIGRATE: "true",
      OPENTAG_ENV: "dev",
      OPENTAG_HOST: "127.0.0.1",
      OPENTAG_PORT: String(port),
      OPENTAG_PUBLIC_URL: baseURL,
      OPENTAG_JWT_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      OPENTAG_ENCRYPTION_KEY: encryptionKey,
      OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
      OPENTAG_DEV_AUTH_EMAIL: devEmail,
      OPENTAG_EMAIL_PASSWORD_AUTH_ENABLED: "true",
      OPENTAG_OTEL_ENDPOINT: "",
    },
    stdio: "inherit",
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    if (server.exitCode === null) {
      await new Promise((resolveExit) => {
        server.once("exit", resolveExit);
        server.kill(signal);
      });
    }
    await psql(adminDatabaseURL, `drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await rm(runtimeFile, { force: true }).catch(() => undefined);
    await run("docker", ["compose", "-f", composeFile, "down"], { stdio: "ignore" }).catch(() => undefined);
  };
  const handleSignal = async (signal) => {
    await stop(signal);
    process.exit(0);
  };
  process.once("SIGTERM", () => void handleSignal("SIGTERM"));
  process.once("SIGINT", () => void handleSignal("SIGINT"));
  server.once("exit", async (code) => {
    await stop("SIGTERM");
    process.exit(code ?? 1);
  });
}

await main();
