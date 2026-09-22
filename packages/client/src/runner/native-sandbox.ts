import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

/**
 * Native Cloud Run sandbox orchestration. The sandbox supervisor binary lives at a fixed
 * Cloud Run-provided path; every invocation is an exact argv array (no shell, no interpolation),
 * built only from Server-controlled configuration — never from workspace content.
 *
 * Isolation contract:
 * - The sandbox root filesystem is the clean, immutable image-built `/opt/sandbox-root` copy.
 *   The default (no --rootfs) sandbox exposes the host instance root read-only, which would
 *   expose parent runtime files; that default is never used.
 * - Only the per-Session workspace and a read-only private copy of the platform resolver are
 *   mounted; the sensitive platform path is never a mount source and parent HOME is never exposed.
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
/**
 * Directory the in-Sandbox web bridge may use for its fresh per-execution listener. The bridge
 * creates and removes its own short socket inside the Sandbox namespace; the parent never mounts
 * a socket or listener into the Sandbox, so the path is a nonsecret descriptor only.
 */
export const SANDBOX_WEB_BRIDGE_DIRECTORY = "/tmp";
/** Platform resolver source; its bytes are snapshotted so this sensitive path is never mounted. */
export const SANDBOX_RESOLVER_SOURCE = "/etc/resolv.conf";
/** Upper bound on the copied resolver; the source is validated before any private file is written. */
export const MAX_RESOLVER_BYTES = 64 * 1024;
const RESOLVER_DESTINATION = "/etc/resolv.conf";

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
  /** Platform resolver file to snapshot; production uses `/etc/resolv.conf`. */
  readonly resolverSource?: string;
  readonly spawnProcess?: SpawnProcess;
  readonly sandboxBinary?: string;
  readonly rootfs?: string;
  /**
   * E4: additional read-only bind mounts (e.g. the trusted per-turn credential bridge root).
   * Each source must be an absolute, comma-free path outside the workspace; destinations are
   * fixed absolute paths. The Session workspace contract is unchanged.
   */
  readonly extraMounts?: readonly { source: string; destination: string }[];
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

/**
 * Minimal duplex surface over one `sandbox exec` process. Framing and limits stay with the
 * trusted parent caller; this type deliberately exposes no raw process or environment access.
 */
export interface SandboxExecDuplex {
  asStream(): Duplex;
  write(chunk: Uint8Array): void;
  end(): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (chunk: Buffer) => void): () => void;
  onStderr(listener: (chunk: Buffer) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
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
  /** Explicit private copy; the sensitive platform resolver is never a default mount source. */
  resolverCopy: string;
  rootfs?: string;
  sandboxBinary?: string;
  /** E4: additional read-only bind mounts (validated absolute paths). */
  extraMounts?: readonly { source: string; destination: string }[];
}): readonly string[] {
  assertSafeOperand(input.resolverCopy, "resolver copy path");
  if (
    !input.resolverCopy.startsWith("/") ||
    input.resolverCopy.includes(",") ||
    input.resolverCopy.split("/").includes("..")
  ) {
    throw new NativeSandboxError("launch_failed", "Unsafe resolver copy mount");
  }
  for (const mount of input.extraMounts ?? []) {
    assertSafeOperand(mount.source, "extra mount source");
    assertSafeOperand(mount.destination, "extra mount destination");
    if (
      !mount.source.startsWith("/") ||
      mount.source.includes(",") ||
      mount.source.split("/").includes("..") ||
      !mount.destination.startsWith("/") ||
      mount.destination.includes(",") ||
      mount.destination.split("/").includes("..")
    ) {
      throw new NativeSandboxError("launch_failed", "Unsafe extra mount");
    }
  }
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
    `type=bind,source=${input.resolverCopy},destination=${RESOLVER_DESTINATION},readonly`,
    ...(input.extraMounts ?? []).flatMap((mount) => [
      "--mount",
      `type=bind,source=${mount.source},destination=${mount.destination},readonly`,
    ]),
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
function assertSafeOperand(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\0\n\r]/.test(value)) {
    throw new NativeSandboxError("launch_failed", `Unsafe ${what} for the native sandbox`);
  }
}

/** Read the platform resolver with a hard byte bound before anything is written to the private copy. */
async function readBoundedResolver(source: string): Promise<Buffer> {
  let sourceStats: Awaited<ReturnType<typeof stat>>;
  try {
    sourceStats = await stat(source);
  } catch {
    throw new NativeSandboxError("launch_failed", "Platform resolver source cannot be read for the native sandbox");
  }
  if (!sourceStats.isFile()) {
    throw new NativeSandboxError("launch_failed", "Platform resolver source is not a regular file");
  }
  const handle = await open(source, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new NativeSandboxError("launch_failed", "Platform resolver source is not a regular file");
    }
    const buffer = Buffer.alloc(MAX_RESOLVER_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total === 0) {
      throw new NativeSandboxError("launch_failed", "Platform resolver source is empty");
    }
    if (total > MAX_RESOLVER_BYTES) {
      throw new NativeSandboxError("launch_failed", "Platform resolver source exceeds the snapshot bound");
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export class NativeSandbox {
  readonly #name: string;
  readonly #workspace: string;
  readonly #rootfs: string;
  readonly #binary: string;
  readonly #spawn: SpawnProcess;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #resolverSource: string;
  readonly #extraMounts: readonly { source: string; destination: string }[];
  // Retained across delete/relaunch, so readiness also proves the previous writable layer vanished.
  readonly #rootfsCanary = `/tmp/opentag-rootfs-${randomUUID()}`;
  #resolverSnapshot?: { readonly directory: string; readonly copy: string };
  #sandboxAlive = false;

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
    this.#resolverSource = options.resolverSource ?? SANDBOX_RESOLVER_SOURCE;
    this.#extraMounts = options.extraMounts ?? [];
    assertSafeOperand(this.#resolverSource, "resolver source path");
    if (!this.#resolverSource.startsWith("/"))
      throw new NativeSandboxError("launch_failed", "Unsafe resolver source path");
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
    const resolver = await this.#ensureResolverSnapshot();
    const argv = buildSandboxRunArgv({
      name: this.#name,
      workspace: this.#workspace,
      resolverCopy: resolver.copy,
      rootfs: this.#rootfs,
      sandboxBinary: this.#binary,
      extraMounts: this.#extraMounts,
    });
    const [command, ...args] = argv as [string, ...string[]];
    try {
      const result = await this.#runToExit(command, args, { timeoutMs: 30_000 });
      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        if (/permission denied|operation not permitted|must be run as root|requires root/i.test(stderr)) {
          throw new NativeSandboxError("requires_root", "Native sandbox launch requires platform privileges");
        }
        throw new NativeSandboxError("launch_failed", `Sandbox launch failed (exit ${result.code})`);
      }
      this.#sandboxAlive = true;
    } catch (error) {
      // A launch that never produced a live sandbox must not leave its resolver copy behind. After
      // a failed delete the previous sandbox still owns the mount, so keep that snapshot instead.
      if (!this.#sandboxAlive) await this.#removeResolverSnapshot().catch(() => undefined);
      throw error;
    }
  }

  /**
   * The platform resolver lives on a sensitive parent path the native CLI refuses to mount.
   * Snapshot its bounded bytes into a fresh 0700 directory outside the workspace and rootfs, and
   * mount only that copy read-only. The copy exists until the native sandbox is deleted.
   */
  async #ensureResolverSnapshot(): Promise<{ readonly directory: string; readonly copy: string }> {
    if (this.#resolverSnapshot) return this.#resolverSnapshot;
    let bytes: Buffer;
    try {
      bytes = await readBoundedResolver(this.#resolverSource);
    } catch (error) {
      if (error instanceof NativeSandboxError) throw error;
      throw new NativeSandboxError("launch_failed", "Could not read the platform resolver for the native sandbox");
    }
    const directory = await mkdtemp(join(tmpdir(), "opentag-resolver-"));
    const copy = join(directory, "resolv.conf");
    try {
      await writeFile(copy, bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error instanceof NativeSandboxError
        ? error
        : new NativeSandboxError("launch_failed", "Could not write the private resolver copy for the native sandbox");
    }
    this.#resolverSnapshot = { directory, copy };
    return this.#resolverSnapshot;
  }

  async #removeResolverSnapshot(): Promise<void> {
    const snapshot = this.#resolverSnapshot;
    if (!snapshot) return;
    await rm(snapshot.directory, { recursive: true, force: true });
    this.#resolverSnapshot = undefined;
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
          if(value.includes('OPENTAG_RUNNER_BOOTSTRAP_TOKEN')||value.includes('OPENTAG_RUNNER_CONTROL_TOKEN')||value.includes('OPENTAG_RUNNER_BACKEND_URL'))process.exit(11);
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
   * Long-lived duplex `sandbox exec` channel: stdin/stdout, no shell, no interpolation. This is
   * the verified native transport for the in-Sandbox web bridge — the parent process is the only
   * peer, so no network listener or credential ever enters the Sandbox. Callers own framing and
   * must close the handle on revocation.
   */
  openDuplex(command: string, args: readonly string[]): SandboxExecDuplex {
    assertSafeOperand(command, "exec command");
    const argv = buildSandboxExecArgv({ name: this.#name, command, args, sandboxBinary: this.#binary });
    const [binary, ...rest] = argv as [string, ...string[]];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawn(binary, rest, { env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
    } catch (error) {
      throw classifySpawnError(error);
    }
    /*
     * Eager single-delivery error pipeline. Streams (notably stdin EPIPE when the child closes
     * fd0, and stdout/stderr after teardown) must have a listener attached from the moment the
     * process exists, or Node raises an unhandled 'error' and can crash the trusted Runner. The
     * first classified error is stored and delivered exactly once to every current and future
     * onError listener; later stream errors are absorbed.
     */
    let firstError: NativeSandboxError | undefined;
    const errorListeners = new Set<(error: NativeSandboxError) => void>();
    const classifyPipeError = (error: unknown): NativeSandboxError => {
      if (error instanceof NativeSandboxError) return error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPIPE") {
        return new NativeSandboxError("exec_failed", "The sandbox duplex peer closed its input pipe");
      }
      return new NativeSandboxError("exec_failed", "The sandbox duplex pipe failed");
    };
    const deliverError = (error: unknown) => {
      if (firstError) return;
      firstError = classifyPipeError(error);
      for (const listener of [...errorListeners]) {
        try {
          listener(firstError);
        } catch {
          // A subscriber failure must not break the remaining error delivery.
        }
      }
    };
    child.on("error", deliverError);
    child.stdin.on("error", deliverError);
    child.stdout.on("error", deliverError);
    child.stderr.on("error", deliverError);
    let pipe: Duplex | undefined;
    return {
      asStream() {
        // Node supports a pair of Node streams; @types/node currently declares only the Web pair.
        const fromStreams = Duplex.from as unknown as (pair: {
          readable: ChildProcessWithoutNullStreams["stdout"];
          writable: ChildProcessWithoutNullStreams["stdin"];
        }) => Duplex;
        pipe ??= fromStreams({ readable: child.stdout, writable: child.stdin });
        return pipe;
      },
      write(chunk) {
        if (child.stdin.destroyed) return;
        try {
          child.stdin.write(Buffer.from(chunk));
        } catch (error) {
          deliverError(error);
        }
      },
      end() {
        if (child.stdin.destroyed) return;
        try {
          child.stdin.end();
        } catch (error) {
          deliverError(error);
        }
      },
      kill(signal = "SIGTERM") {
        try {
          child.kill(signal);
        } catch {
          // The process already exited; exit listeners own the outcome.
        }
      },
      onData(listener) {
        child.stdout.on("data", listener);
        return () => child.stdout.off("data", listener);
      },
      onStderr(listener) {
        child.stderr.on("data", listener);
        return () => child.stderr.off("data", listener);
      },
      onError(listener) {
        errorListeners.add(listener);
        if (firstError) listener(firstError);
        return () => errorListeners.delete(listener);
      },
      onExit(listener) {
        child.once("close", listener);
        return () => child.off("close", listener);
      },
    };
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
      if (result.code === 0) {
        this.#sandboxAlive = false;
        try {
          await this.#removeResolverSnapshot();
        } catch {
          throw new NativeSandboxError(
            "delete_failed",
            "Native sandbox was deleted but its private resolver copy could not be removed",
          );
        }
        return;
      }

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
