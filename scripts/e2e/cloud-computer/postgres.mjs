import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { execFileAsync, redactSecrets, waitFor } from "./common.mjs";

const POSTGRES_USER = "opentag";
const POSTGRES_DB = "opentag_e1";

export async function startDisposablePostgres() {
  const password = randomBytes(18).toString("base64url");
  const name = `opentag-e1-pg-${process.pid}-${randomBytes(3).toString("hex")}`;
  let created = false;
  const stop = () => execFileAsync("docker", ["rm", "-f", name], { timeout: 30_000 });
  try {
    await execFileAsync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        name,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        `POSTGRES_USER=${POSTGRES_USER}`,
        "--env",
        "POSTGRES_PASSWORD",
        "--env",
        `POSTGRES_DB=${POSTGRES_DB}`,
        "postgres:17-alpine",
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 120_000 },
    );
    created = true;
    const { stdout: published } = await execFileAsync(
      "docker",
      ["inspect", "--format", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name],
      { timeout: 10_000 },
    );
    const port = Number(published.trim());
    if (!Number.isInteger(port) || port < 1) throw new Error("Disposable Postgres did not publish a port");
    await waitFor(
      "disposable Postgres to accept connections",
      async () => {
        try {
          await execFileAsync("docker", ["exec", name, "pg_isready", "-U", POSTGRES_USER, "-d", POSTGRES_DB], {
            timeout: 5_000,
          });
          return true;
        } catch {
          return false;
        }
      },
      { timeoutMs: 90_000, intervalMs: 500 },
    );
    return {
      name,
      port,
      password,
      databaseUrl: `postgresql://${POSTGRES_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${POSTGRES_DB}`,
      async psql(sql) {
        try {
          return await runPsql(name, sql);
        } catch (error) {
          throw new Error(redactSecrets(error.message, password));
        }
      },
      stop,
    };
  } catch (error) {
    if (created) {
      try {
        await stop();
      } catch (cleanupError) {
        throw new Error(
          redactSecrets(
            `Postgres startup failed: ${error.message}; container ${name} cleanup failed: ${cleanupError.message}`,
            password,
          ),
        );
      }
    }
    throw new Error(redactSecrets(`Failed to start disposable Postgres: ${error.message}`, password));
  }
}

function runPsql(container, sql) {
  return new Promise((settle, fail) => {
    const child = spawn(
      "docker",
      ["exec", "-i", container, "psql", "-U", POSTGRES_USER, "-d", POSTGRES_DB, "-v", "ON_ERROR_STOP=1", "-At"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (code === 0) {
        settle(stdout.trim());
        return;
      }
      fail(new Error(stderr.trim() || stdout.trim() || `psql exited ${code}`));
    });
    child.stdin.end(sql);
  });
}
