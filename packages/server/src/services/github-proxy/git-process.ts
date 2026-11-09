import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { getCurrentPerformanceLogger } from "../../observability/performance-logger.js";
import { GitPublicationError } from "./git-packets.js";

export interface GitProcessOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  input?: AsyncIterable<Uint8Array>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

const SAFE_GIT_SUBCOMMANDS = new Set([
  "add",
  "cat-file",
  "checkout",
  "clone",
  "commit",
  "commit-tree",
  "config",
  "fetch",
  "init",
  "ls-remote",
  "mktree",
  "push",
  "rev-parse",
  "sparse-checkout",
  "status",
  "unpack-objects",
  "version",
]);

function resolveSubprocessOperation(binary: string, args: string[]): string {
  if (binary !== "git" && !binary.endsWith("/git")) {
    return "subprocess.exec";
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "-c" || arg === "-C") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return SAFE_GIT_SUBCOMMANDS.has(arg) ? `subprocess.git.${arg}` : "subprocess.git.exec";
  }
  return "subprocess.git.exec";
}

/** No shell, inherited Git configuration, credential-bearing argv, or unbounded diagnostic output. */
export async function runTrustedProcess(
  binary: string,
  args: string[],
  options: GitProcessOptions,
): Promise<{ code: number; stdout: Buffer }> {
  options.signal.throwIfAborted();
  const perfHandle = getCurrentPerformanceLogger()?.startOperation({
    module: "git-subprocess",
    category: "service",
    operation: resolveSubprocessOperation(binary, args),
  });
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    perfHandle?.fail(error, { errorCode: "unavailable" }, "unavailable");
    throw error;
  }
  const output: Buffer[] = [];
  const max = options.maxOutputBytes ?? 1024 * 1024;
  let bytes = 0;
  let errorBytes = 0;
  let failure: Error | undefined;
  const kill = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const fail = (error: Error) => {
    failure ??= error;
    kill();
  };
  const aborted = () => fail(new GitPublicationError("unavailable"));
  options.signal.addEventListener("abort", aborted, { once: true });
  const timer = setTimeout(() => fail(new GitPublicationError("resource_limit")), options.timeoutMs ?? 120_000);
  timer.unref();
  child.on("error", () => fail(new GitPublicationError("unavailable")));
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > max) fail(new GitPublicationError("resource_limit"));
    else output.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > max) fail(new GitPublicationError("resource_limit"));
  });
  let exited = false;
  void (async () => {
    try {
      for await (const chunk of options.input ?? []) {
        if (exited) break;
        if (!child.stdin.write(chunk)) await once(child.stdin, "drain");
      }
      child.stdin.end();
    } catch {
      if (child.exitCode === null) fail(new GitPublicationError("invalid_request"));
    }
  })();
  child.stdin.on("error", () => {
    /* The exit status handles a receiver that rejects before consuming the pack. */
  });
  try {
    const [code] = (await once(child, "close").catch((err) => {
      const pubErr = new GitPublicationError("unavailable");
      perfHandle?.fail(pubErr, { errorCode: "unavailable" });
      throw err instanceof GitPublicationError ? err : pubErr;
    })) as [number | null];
    exited = true;
    if (failure) {
      perfHandle?.fail(failure, {
        ...(failure instanceof GitPublicationError ? { errorCode: failure.code } : {}),
      });
      throw failure;
    }
    const resolvedCode = code ?? 1;
    const stdoutBuffer = Buffer.concat(output);
    perfHandle?.complete({
      statusCode: resolvedCode,
    });
    return { code: resolvedCode, stdout: stdoutBuffer };
  } finally {
    exited = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", aborted);
  }
}

export async function runTrustedGit(args: string[], options: GitProcessOptions): Promise<Buffer> {
  const result = await runTrustedProcess(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args],
    options,
  );
  if (result.code !== 0) throw new GitPublicationError("invalid_objects");
  return result.stdout;
}
