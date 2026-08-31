import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryRoot } from "./playwright.config.js";

const execFileAsync = promisify(execFile);
const composeFile = join(repositoryRoot, "docker-compose.yml");
const runtimeFile = join(repositoryRoot, "e2e/.runtime.json");
const authStateFile = join(repositoryRoot, "e2e/.auth/admin.json");

function connectionTarget(url: string): { dsn: string; password: string } {
  const target = new URL(url);
  const password = decodeURIComponent(target.password);
  target.password = "";
  return { dsn: target.href, password };
}

async function dropDatabase(adminDatabaseURL: string, databaseURL: string): Promise<void> {
  const databaseName = new URL(databaseURL).pathname.slice(1);
  if (!/^[a-z][a-z0-9_]{0,61}$/.test(databaseName) || !databaseName.includes("e2e")) return;
  const { dsn, password } = connectionTarget(adminDatabaseURL);
  await execFileAsync(
    "psql",
    [dsn, "-v", "ON_ERROR_STOP=1", "-Atc", `drop database if exists "${databaseName}" with (force)`],
    { env: { ...process.env, PGPASSWORD: password } },
  );
}

export default async function globalTeardown(): Promise<void> {
  let runtime: { adminDatabaseURL?: string; databaseURL?: string } | undefined;
  try {
    runtime = JSON.parse(await readFile(runtimeFile, "utf8")) as typeof runtime;
  } catch {
    // The stack launcher may have removed the runtime file during its own shutdown.
  }

  const adminDatabaseURL = runtime?.adminDatabaseURL ?? process.env.OPENTAG_E2E_ADMIN_DATABASE_URL;
  if (adminDatabaseURL && runtime?.databaseURL) {
    await dropDatabase(adminDatabaseURL, runtime.databaseURL).catch(() => undefined);
  }
  await rm(runtimeFile, { force: true }).catch(() => undefined);
  await rm(authStateFile, { force: true }).catch(() => undefined);
  await execFileAsync("docker", ["compose", "-f", composeFile, "down"], {
    cwd: repositoryRoot,
  }).catch(() => undefined);
}
