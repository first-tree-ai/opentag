import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Native Cloud Run sandbox orchestration. The sandbox supervisor binary lives at a fixed
 * Cloud Run-provided path; every invocation is an exact argv array (no shell, no interpolation),
 * built only from Server-controlled configuration — never from workspace content.
 *
 * Isolation contract:
 * - The sandbox root filesystem is the clean, immutable image-built `/opt/sandbox-root` copy.
 *   The default (no --rootfs) sandbox exposes the host instance root read-only, which would
 *   expose parent runtime files; that default is never used.
 * - Only the workspace and read-only platform DNS configuration are mounted; parent HOME is never exposed.
 * - The parent bootstrap token lives in the parent process env only and is never placed in the
 *   sandbox env, argv, or mounts.
 */

export const SANDBOX_BINARY = "/usr/local/gcp/bin/sandbox";
export const SANDBOX_ROOTFS = "/opt/sandbox-root";
export const SANDBOX_WORKSPACE_DESTINATION = "/workspace";
export const SANDBOX_WORKER_ENTRY = "/opt/opentag/client/dist/runner/bin.mjs";
export const SANDBOX_NODE = "/usr/local/bin/node";
/** Explicit PATH inside the sandbox; matches the image layout and nothing else. */
export const SANDBOX_PATH = "/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin";
export const SANDBOX_PI = "/opt/opentag/tools/bin/pi";

const CAPTURE_LIMIT_BYTES = 256 * 1024;

export class NativeSandboxError extends Error {
  readonly code: "unavailable" | "requires_root" | "launch_failed" | "exec_failed" | "delete_failed" | "probe_failed";

  constructor(code: NativeSandboxError["code"], message: string) {
    super(message);
    this.name = "NativeSandboxError";
    this.code = code;
  }
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface NativeSandboxOptions {
  readonly name: string;
  readonly workspace: string;
  readonly spawnProcess?: SpawnProcess;
  readonly sandboxBinary?: string;
  readonly rootfs?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SandboxProbeResult {
  readonly nodeVersion: string;
  readonly piVersion: string;
  readonly runnerVersion: string;
}

export interface SandboxExecResult {
  readonly code: number;
  readonly stdout: string;
  /** Bounded; diagnostics only, never credential-bearing (worker prints no secrets). */
  readonly stderr: string;
}

function classifySpawnError(error: unknown): NativeSandboxError {
  const errno = error as NodeJS.ErrnoException;
  if (errno?.code === "ENOENT") {
    return new NativeSandboxError(
      "unavailable",
      "The native Cloud Run sandbox binary is absent; this is not a native Cloud Run Instance",
    );
  }
  if (errno?.code === "EACCES" || errno?.code === "EPERM") {
    return new NativeSandboxError(
      "requires_root",
      "The native sandbox binary exists but cannot be executed by this user; the gcp sandbox may require root",
    );
  }
  return new NativeSandboxError("launch_failed", "Native sandbox process could not start");
}

/** The exact PoC argv: run NAME --detach --write --allow-egress --rootfs ROOT --mount … --env PATH=… -- sleep infinity */
export function buildSandboxRunArgv(input: {
  name: string;
  workspace: string;
  rootfs?: string;
  sandboxBinary?: string;
}): readonly string[] {
  return [
    input.sandboxBinary ?? SANDBOX_BINARY,
    "run",
    input.name,
    "--detach",
    "--write",
    "--allow-egress",
    "--rootfs",
    input.rootfs ?? SANDBOX_ROOTFS,
    "--mount",
    `type=bind,source=${input.workspace},destination=${SANDBOX_WORKSPACE_DESTINATION}`,
    "--mount",
    "type=bind,source=/etc/resolv.conf,destination=/etc/resolv.conf,readonly",
    "--env",
    `PATH=${SANDBOX_PATH}`,
    "--",
    "/usr/local/bin/opentag-init",
    "/bin/sleep",
    "infinity",
  ];
}

export function buildSandboxExecArgv(input: {
  name: string;
  command: string;
  args?: readonly string[];
  sandboxBinary?: string;
}): readonly string[] {
  return [input.sandboxBinary ?? SANDBOX_BINARY, "exec", input.name, "--", input.command, ...(input.args ?? [])];
}

export function buildSandboxDeleteArgv(input: { name: string; sandboxBinary?: string }): readonly string[] {
  return [input.sandboxBinary ?? SANDBOX_BINARY, "delete", "--force", input.name];
}

/** Assert that a value can never smuggle option/argv structure into the sandbox CLI. */
function assertSafeOperand(value: string, what: string): void {
  if (value.length === 0 || value.length > 512 || /[\0\n\r]/.test(value)) {
    throw new NativeSandboxError("launch_failed", `Unsafe ${what} for the native sandbox`);
  }
}

export class NativeSandbox {
  readonly #name: string;
  readonly #workspace: string;
  readonly #rootfs: string;
  readonly #binary: string;
  readonly #spawn: SpawnProcess;
  readonly #sleep: (ms: number) => Promise<void>;
  // Retained across delete/relaunch, so readiness also proves the previous writable layer vanished.
  readonly #rootfsCanary = `/tmp/opentag-rootfs-${randomUUID()}`;

  constructor(options: NativeSandboxOptions) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.name))
      throw new NativeSandboxError("launch_failed", "Invalid sandbox name");
    assertSafeOperand(options.workspace, "workspace path");
    if (
      !options.workspace.startsWith("/") ||
      options.workspace.includes(",") ||
      options.workspace.split("/").includes("..")
    )
      throw new NativeSandboxError("launch_failed", "Unsafe workspace mount");
    this.#name = options.name;
    this.#workspace = options.workspace;
    this.#rootfs = options.rootfs ?? SANDBOX_ROOTFS;
    this.#binary = options.sandboxBinary ?? SANDBOX_BINARY;
    this.#spawn =
      options.spawnProcess ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], { ...spawnOptions, stdio: "pipe" }) as ChildProcessWithoutNullStreams);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get name(): string {
    return this.#name;
  }

  /** run --detach; resolves once the CLI accepted the launch, then verifies the sandbox answers exec. */
  async launch(): Promise<void> {
    const argv = buildSandboxRunArgv({
      name: this.#name,
      workspace: this.#workspace,
      rootfs: this.#rootfs,
      sandboxBinary: this.#binary,
    });
    const [command, ...args] = argv as [string, ...string[]];
    const result = await this.#runToExit(command, args, { timeoutMs: 30_000 });
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      if (/permission denied|operation not permitted|must be run as root|requires root/i.test(stderr)) {
        throw new NativeSandboxError("requires_root", "Native sandbox launch requires platform privileges");
      }
      throw new NativeSandboxError("launch_failed", `Sandbox launch failed (exit ${result.code})`);
    }
  }

  /** Native sandbox/tool readiness inside the sandbox: exact versions from the immutable rootfs. */
  async probe(): Promise<SandboxProbeResult> {
    const node = await this.exec(SANDBOX_NODE, ["--version"], { timeoutMs: 30_000 });
    if (node.code !== 0 || !/^v\d+\.\d+\.\d+$/.test(node.stdout.trim())) {
      throw new NativeSandboxError("probe_failed", "The sandbox rootfs does not provide a working node runtime");
    }
    const pi = await this.exec(SANDBOX_PI, ["--version"], { timeoutMs: 60_000 });
    if (pi.code !== 0 || pi.stdout.trim().length === 0) {
      throw new NativeSandboxError("probe_failed", "The sandbox rootfs does not provide a working Pi toolchain");
    }
    const identity = await this.exec(
      SANDBOX_NODE,
      [
        "-e",
        "process.stdout.write(JSON.parse(require('node:fs').readFileSync('/opt/opentag/identity.json','utf8')).version)",
      ],
      { timeoutMs: 30_000 },
    );
    if (identity.code !== 0 || !/^[0-9A-Za-z.+-]{1,64}$/.test(identity.stdout.trim())) {
      throw new NativeSandboxError("probe_failed", "The sandbox provides no valid Runner version");
    }
    const canaryRoot = await mkdtemp(join(tmpdir(), "opentag-parent-canary-"));
    const canary = join(canaryRoot, "parent-only");
    try {
      await writeFile(canary, "parent", { mode: 0o600 });
      const code = `const fs=require('node:fs'); const p=${JSON.stringify(canary)};
        const rootfsCanary=${JSON.stringify(this.#rootfsCanary)};
        if(fs.existsSync(rootfsCanary))process.exit(12);
        fs.writeFileSync(rootfsCanary,'sandbox-layer');
        if(fs.existsSync(p)||fs.existsSync('/opt/sandbox-root'))process.exit(10);
        for(const file of ['/proc/self/environ','/proc/1/environ']) {
          const value=fs.readFileSync(file,'utf8');
          if(value.includes('OPENTAG_RUNNER_BOOTSTRAP_TOKEN')||value.includes('OPENTAG_RUNNER_BACKEND_URL'))process.exit(11);
        }
        fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,'sandbox');
        process.stdout.write('isolated');`;
      const isolation = await this.exec(SANDBOX_NODE, ["-e", code], { timeoutMs: 30_000 });
      if (isolation.code !== 0 || isolation.stdout !== "isolated" || (await readFile(canary, "utf8")) !== "parent") {
        throw new NativeSandboxError("probe_failed", "Native sandbox failed filesystem or credential isolation checks");
      }
      const lowerLayerCanary = await lstat(join(this.#rootfs, this.#rootfsCanary)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (lowerLayerCanary) {
        throw new NativeSandboxError("probe_failed", "Native sandbox modified the immutable root filesystem");
      }
    } finally {
      await rm(canaryRoot, { recursive: true, force: true });
    }
    return {
      nodeVersion: node.stdout.trim(),
      piVersion: pi.stdout.trim().split("\n", 1)[0] ?? "",
      runnerVersion: identity.stdout.trim(),
    };
  }

  /** Exec a command inside the sandbox with bounded capture and optional stdin payload. */
  async exec(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; stdin?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult> {
    assertSafeOperand(command, "exec command");
    const argv = buildSandboxExecArgv({ name: this.#name, command, args, sandboxBinary: this.#binary });
    const [binary, ...rest] = argv as [string, ...string[]];
    return this.#runToExit(binary, rest, options);
  }

  /**
   * Teardown/cancellation path: `delete --force`, and deletion must succeed — a failure is an
   * error, never a swallowed warning, because an alive sandbox is an alive untrusted workload.
   */
  async destroy(options: { attempts?: number } = {}): Promise<void> {
    const attempts = options.attempts ?? 3;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const argv = buildSandboxDeleteArgv({ name: this.#name, sandboxBinary: this.#binary });
      const [command, ...args] = argv as [string, ...string[]];
      const result = await this.#runToExit(command, args, { timeoutMs: 30_000 });
      if (result.code === 0) return;

      if (attempt < attempts) await this.#sleep(1_000 * attempt);
    }
    throw new NativeSandboxError("delete_failed", `Sandbox deletion failed after ${attempts} attempts`);
  }

  #runToExit(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; stdin?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult> {
    if (options.signal?.aborted)
      return Promise.reject(new NativeSandboxError("exec_failed", "Sandbox execution cancelled before spawn"));
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.#spawn(command, args, { env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
      } catch (error) {
        reject(classifySpawnError(error));
        return;
      }
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let stdoutBytes = 0,
        stderrBytes = 0;
      let failure: NativeSandboxError | undefined;
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalation);
        options.signal?.removeEventListener("abort", onAbort);
        if (failure) reject(failure);
        else
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
      };
      const cancel = (message: string) => {
        if (settled || failure) return;
        failure = new NativeSandboxError("exec_failed", message);
        child.kill("SIGTERM");
        escalation = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 2_000);
      };
      const onAbort = () => cancel("Sandbox execution cancelled");
      const timer = setTimeout(() => cancel("Sandbox execution deadline exceeded"), options.timeoutMs);
      child.once("error", (error) => {
        failure = classifySpawnError(error);
        finish(-1);
      });
      child.once("close", (code) => finish(code ?? -1));
      child.stdout.on("data", (chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, CAPTURE_LIMIT_BYTES - stdoutBytes));
        if (kept.length > 0) stdout.push(Buffer.from(kept));
        stdoutBytes += kept.length;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, CAPTURE_LIMIT_BYTES - stderrBytes));
        if (kept.length > 0) stderr.push(Buffer.from(kept));
        stderrBytes += kept.length;
      });
      child.stdin.on("error", () => cancel("Sandbox worker stdin failed"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      if (options.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }
}
