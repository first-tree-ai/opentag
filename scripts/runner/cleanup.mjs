import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const cleanups = [];
const emergencyHooks = [];
let installed = false;

function runCleanup(entry, errors) {
  try {
    entry();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (errors) errors.push(message);
    else process.stderr.write(`[runner-cleanup] ${message}\n`);
  }
}

function flush(errors) {
  while (cleanups.length > 0) {
    const entry = cleanups.pop();
    if (entry) runCleanup(entry, errors);
  }
}

function onSignal(exitCode) {
  // Signal path: kill owned children first, then best-effort cleanup with visible errors.
  for (const hook of emergencyHooks.splice(0)) {
    try {
      hook();
    } catch (error) {
      process.stderr.write(
        `[runner-cleanup] emergency hook failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  flush();
  process.exit(exitCode);
}

function install() {
  if (installed) return;
  installed = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => onSignal(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1)));
  }
  process.on("exit", flush);
}

/** Emergency hooks run before cleanup on signals (e.g. killing owned child processes). */
export function registerEmergencyHook(fn) {
  install();
  emergencyHooks.push(fn);
  return () => {
    const index = emergencyHooks.lastIndexOf(fn);
    if (index >= 0) emergencyHooks.splice(index, 1);
  };
}

export function registerCleanup(fn) {
  install();
  cleanups.push(fn);
  return () => {
    const index = cleanups.lastIndexOf(fn);
    if (index >= 0) cleanups.splice(index, 1);
  };
}

export function registerTempDir(path) {
  return registerCleanup(() => rmSync(path, { recursive: true, force: true }));
}

export function registerContainer(name, docker = "docker") {
  return registerCleanup(() => {
    spawnSync(docker, ["rm", "-f", name], { stdio: "ignore" });
  });
}

export function registerImage(tag, docker = "docker") {
  return registerCleanup(() => {
    spawnSync(docker, ["rmi", "-f", tag], { stdio: "ignore" });
  });
}

/**
 * Runs fn and always flushes registered cleanups afterwards. Cleanup failures on this normal
 * path fail the run — they are never swallowed; the signal path still exits with its own code.
 */
export async function runWithCleanup(fn) {
  install();
  const errors = [];
  let result;
  let failure;
  let failed = false;
  try {
    result = await fn();
  } catch (error) {
    failed = true;
    failure = error;
  }
  flush(errors);
  if (errors.length > 0) {
    const primary = failed ? `; primary error: ${failure instanceof Error ? failure.message : String(failure)}` : "";
    throw new Error(`cleanup failed: ${errors.join("; ")}${primary}`);
  }
  if (failed) throw failure;
  return result;
}

export function cleanupNow() {
  const errors = [];
  flush(errors);
  if (errors.length > 0) throw new Error(`cleanup failed: ${errors.join("; ")}`);
}
