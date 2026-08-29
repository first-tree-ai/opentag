#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const suffix = `${process.pid}-${randomBytes(3).toString("hex")}`;
const prefix = `opentag-doctor-e2e-${suffix}`;
const network = `${prefix}-network`;
const systemdImage = `${prefix}-systemd`;
const minimalImage = `${prefix}-minimal`;
const serverImage = `${prefix}-server`;
const runner = `${prefix}-runner`;
const containers = [];
const keep = process.argv.includes("--keep");

function run(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== (options.expectedStatus ?? 0)) {
    throw new Error(
      `docker ${arguments_.join(" ")} exited with ${result.status}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function start(name, arguments_) {
  run(["run", "--detach", "--name", name, ...arguments_]);
  containers.push(name);
}

function waitForContainerHealth(name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = run([
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      name,
    ]).stdout.trim();
    if (state === "healthy" || state === "running") return;
    if (state === "unhealthy" || state === "exited" || state === "dead") {
      throw new Error(`${name} entered ${state}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`timed out waiting for ${name}`);
}

function waitForUserManager(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = run(
      [
        "exec",
        "--user",
        "node",
        "--env",
        "XDG_RUNTIME_DIR=/run/user/1000",
        "--env",
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
        runner,
        "/usr/bin/systemctl",
        "--user",
        "show-environment",
      ],
      { allowFailure: true },
    );
    if (last.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`systemd user manager did not become ready: ${last?.stderr ?? "no result"}`);
}

function waitForSystemManager(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = run(["exec", runner, "/usr/bin/systemctl", "is-system-running"], { allowFailure: true });
    if (["running", "degraded"].includes(last.stdout.trim())) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(
    `systemd system manager did not become ready: ${last?.stdout.trim() || last?.stderr.trim() || "no result"}`,
  );
}

function dumpLogs() {
  for (const name of containers) {
    const result = run(["logs", "--tail", "200", name], { allowFailure: true });
    process.stderr.write(`\n--- ${name} logs ---\n${result.stdout}${result.stderr}`);
  }
}

function cleanup() {
  if (keep) {
    process.stdout.write(`Preserved Docker resources with prefix ${prefix}\n`);
    return;
  }
  for (const name of [...containers].reverse()) run(["rm", "--force", name], { allowFailure: true });
  run(["network", "rm", network], { allowFailure: true });
  for (const image of [systemdImage, minimalImage, serverImage]) {
    run(["image", "rm", "--force", image], { allowFailure: true });
  }
}

async function main() {
  run(["version"]);
  process.stdout.write("Building Docker doctor QA images...\n");
  run(
    [
      "build",
      "--target",
      "systemd-runner",
      "--tag",
      systemdImage,
      "--file",
      "scripts/e2e/doctor-docker/Dockerfile",
      ".",
    ],
    { inherit: true },
  );
  run([
    "build",
    "--target",
    "minimal-runner",
    "--tag",
    minimalImage,
    "--file",
    "scripts/e2e/doctor-docker/Dockerfile",
    ".",
  ]);
  run(["build", "--tag", serverImage, "."]);
  run(["network", "create", network]);

  const postgres = `${prefix}-postgres`;
  start(postgres, [
    "--network",
    network,
    "--network-alias",
    "postgres",
    "--env",
    "POSTGRES_DB=opentag",
    "--env",
    "POSTGRES_USER=opentag",
    "--env",
    "POSTGRES_PASSWORD=opentag",
    "--health-cmd",
    "pg_isready -U opentag -d opentag",
    "--health-interval",
    "1s",
    "--health-timeout",
    "5s",
    "--health-retries",
    "30",
    "postgres:17",
  ]);
  waitForContainerHealth(postgres);

  start(runner, [
    "--privileged",
    "--cgroupns=host",
    "--volume",
    "/sys/fs/cgroup:/sys/fs/cgroup:rw",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--network",
    network,
    systemdImage,
  ]);
  waitForContainerHealth(runner);
  waitForSystemManager();
  run(["exec", runner, "/usr/bin/mkdir", "-p", "/var/lib/systemd/linger"]);
  run(["exec", runner, "/usr/bin/touch", "/var/lib/systemd/linger/node"]);
  run(["exec", runner, "/usr/bin/systemctl", "start", "user@1000.service"]);
  waitForUserManager();

  const realServer = `${prefix}-real-server`;
  start(realServer, [
    "--network",
    `container:${runner}`,
    "--env",
    "OPENTAG_HOST=0.0.0.0",
    "--env",
    "OPENTAG_PORT=8000",
    "--env",
    "OPENTAG_SERVER_URL=http://127.0.0.1:8000",
    "--env",
    "OPENTAG_PUBLIC_URL=http://127.0.0.1:8000",
    "--env",
    "OPENTAG_ENV=dev",
    "--env",
    "OPENTAG_DATABASE_URL=postgresql://opentag:opentag@postgres:5432/opentag",
    "--env",
    "OPENTAG_JWT_SECRET=doctor-e2e-jwt-secret-with-32-characters",
    "--env",
    "BETTER_AUTH_SECRET=doctor-e2e-auth-secret-that-is-different",
    "--env",
    "OPENTAG_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "--env",
    "OPENTAG_AUTO_MIGRATE=true",
    serverImage,
  ]);

  for (const [label, mode, port] of [
    ["health-ok", "healthy", "18080"],
    ["sentinel-a", "healthy", "18081"],
    ["sentinel-b", "healthy", "18082"],
    ["http-503", "http-503", "18083"],
    ["invalid-schema", "invalid-schema", "18084"],
    ["health-hang", "hang", "18085"],
    ["baseline", "baseline", "18086"],
  ]) {
    const name = `${prefix}-doctor-${label}`;
    start(name, [
      "--network",
      `container:${runner}`,
      systemdImage,
      "node",
      "/opt/doctor-e2e/fault-server.mjs",
      mode,
      port,
    ]);
  }

  process.stdout.write("Running Docker doctor fault scenarios...\n");
  run(["run", "--rm", "--network", `container:${runner}`, minimalImage, "minimal"], { inherit: true });
  run(
    [
      "exec",
      "--user",
      "node",
      "--env",
      "HOME=/home/node",
      "--env",
      "XDG_RUNTIME_DIR=/run/user/1000",
      "--env",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      runner,
      nodePath(),
      "/opt/doctor-e2e/scenario-runner.mjs",
      "core",
    ],
    { inherit: true },
  );
}

function nodePath() {
  return "/usr/local/bin/node";
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  try {
    dumpLogs();
  } catch (logError) {
    process.stderr.write(`Could not collect Docker logs: ${logError}\n`);
  }
} finally {
  try {
    cleanup();
  } catch (cleanupError) {
    failed = true;
    process.stderr.write(`Docker cleanup failed: ${cleanupError}\n`);
  }
}

if (failed) process.exitCode = 1;
