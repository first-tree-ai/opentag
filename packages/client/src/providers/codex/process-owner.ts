import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface WatchedProcessOptions {
  cwd: string;
  detached: boolean;
  env: NodeJS.ProcessEnv;
}

// The wrapper owns the provider process group. If the daemon disappears, its stdin
// closes and the wrapper terminates the whole group instead of orphaning Codex.
const WATCHDOG_SOURCE = `
const { spawn, spawnSync } = require("node:child_process");
const command = process.argv[1];
const args = process.argv.slice(2);
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
let stopping = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  if (process.platform === "win32") {
    if (child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-process.pid, signal); } catch { child.kill(signal); }
  }
  const timer = setTimeout(() => {
    if (process.platform !== "win32") {
      try { process.kill(-process.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    process.exit(1);
  }, 500);
  timer.unref();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.stdin.pipe(child.stdin);
process.stdin.once("end", () => stop());
process.stdin.once("error", () => stop());
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", () => stop());
child.once("exit", () => stop());
`;

export function spawnWatchedProcess(
  command: string,
  args: readonly string[],
  options: WatchedProcessOptions,
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", WATCHDOG_SOURCE, command, ...args], {
    cwd: options.cwd,
    detached: options.detached,
    env: options.env,
    stdio: "pipe",
  });
}

export function signalWatchedProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
