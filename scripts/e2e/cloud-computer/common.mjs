import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** execFile has no `input` option; write bounded fixture SQL through stdin. */
export function execFileAsync(command, args, options = {}) {
  const { input, ...execution } = options;
  if (input === undefined) return executeFile(command, args, execution);
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(command, args, execution, (error, stdout, stderr) => {
      if (error) rejectRun(error);
      else resolveRun({ stdout, stderr });
    });
    child.stdin.once("error", (error) => {
      child.kill("SIGTERM");
      rejectRun(error);
    });
    child.stdin.end(input);
  });
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function withTimeout(promise, timeoutMs, message) {
  let timer;
  const expiry = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export async function waitFor(description, predicate, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

export function redactSecrets(message, ...secrets) {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[redacted]"), String(message));
}

export function createStepper(redact = String) {
  const steps = [];
  let stepIndex = 0;
  async function step(name, run) {
    stepIndex += 1;
    const label = `${String(stepIndex).padStart(2, "0")} ${name}`;
    const startedAt = Date.now();
    try {
      const value = await run();
      const detail = typeof value === "string" ? value : typeof value?.detail === "string" ? value.detail : "";
      steps.push({ label, ok: true, detail, ms: Date.now() - startedAt });
      process.stdout.write(`PASS ${label}${detail ? ` — ${detail}` : ""}\n`);
      return value;
    } catch (error) {
      const detail = redact(error?.message ?? error);
      steps.push({ label, ok: false, detail, ms: Date.now() - startedAt });
      process.stdout.write(`FAIL ${label} — ${detail}\n`);
      throw error;
    }
  }
  return { step, steps };
}

export async function assertPortAvailable(port) {
  await new Promise((settle, fail) => {
    const probe = createServer();
    probe.once("error", (error) =>
      fail(
        error.code === "EADDRINUSE"
          ? new Error(`127.0.0.1:${port} is already in use; stop it or set OPENTAG_E1_PORT`)
          : error,
      ),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(() => settle(undefined)));
  });
}

export function spawnLogged(command, args, { cwd, env, logPath, secrets = [] }) {
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let openStreams = 2;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) log.write(`${redactSecrets(line, ...secrets)}\n`);
    });
    stream.on("end", () => {
      if (pending) log.write(redactSecrets(pending, ...secrets));
      openStreams -= 1;
      if (openStreams === 0) log.end();
    });
  }
  child.logFinished = new Promise((resolveLog, rejectLog) => {
    log.once("finish", resolveLog);
    log.once("error", rejectLog);
  });
  child.logFinished.catch(() => undefined);
  child.once("error", (error) => log.write(`${redactSecrets(error.message, ...secrets)}\n`));
  return child;
}

export async function stopChild(child, { name = "process", graceMs = 2_000 } = {}) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode) {
    await child.logFinished;
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((settle) => child.once("exit", () => settle(true))),
    sleep(graceMs).then(() => false),
  ]);
  if (!exited && child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((settle) => child.once("exit", () => settle(undefined))), sleep(2_000)]);
  }
  if (child.exitCode === null && !child.signalCode) {
    throw new Error(`${name} pid ${child.pid} did not exit after SIGKILL`);
  }
  await child.logFinished;
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

export function childStillRunning(child) {
  return Boolean(child && child.exitCode === null && !child.signalCode);
}

export async function collectDescendantPids(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 8 * 1024 * 1024 });
    const rows = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
      });
    const children = new Map();
    for (const row of rows) {
      const list = children.get(row.ppid) ?? [];
      list.push(row);
      children.set(row.ppid, list);
    }
    const found = [];
    const stack = [rootPid];
    const seen = new Set();
    while (stack.length > 0) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const child of children.get(pid) ?? []) {
        found.push(child);
        stack.push(child.pid);
      }
    }
    return found;
  } catch {
    return [];
  }
}

export function isPiCommand(command) {
  return (
    /\bpi\b/.test(command) &&
    (command.includes("--mode") || command.includes("rpc") || command.includes("--session-id"))
  );
}

export async function listPiProcesses(rootPid) {
  const descendants = await collectDescendantPids(rootPid);
  return descendants.filter((row) => isPiCommand(row.command)).map((row) => ({ pid: row.pid, ppid: row.ppid }));
}

export async function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { dirname };
