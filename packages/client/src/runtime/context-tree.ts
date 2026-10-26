import { type ChildProcess, spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  type AgentRuntimeProvider,
  type ContextTreeConnection,
  contextTreeIdentity,
  contextTreeSelector,
  normalizeContextTrees,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { collectDescendantPids, waitForProcessTreeGone } from "../runner/processes.js";
import { resolveAccountHome } from "../storage/context-tree-home.js";
import { ensurePrivateDirectory, writeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { CONTEXT_TREE_COMMAND_CLIENT_SOURCE, requestContextTreeCommand } from "./context-tree-commands.js";
import {
  type ContextTreeResult,
  type ContextTreeStatus,
  configureContextTrees,
  syncedTree,
} from "./context-tree-connections.js";

/** Context Tree commands are local and bounded; a hung CLI must not stall Session start. */
const CLI_TIMEOUT_MS = 20_000;
/** A GitHub target clones on first use, so its first connect is allowed to take longer. */
const CLI_NETWORK_TIMEOUT_MS = 120_000;
/** SIGTERM grace before SIGKILL; the owned tree is awaited either way. */
const CLI_KILL_GRACE_MS = 2_000;
const CLI_MAX_BUFFER = 1024 * 1024;
const SESSION_START_BUDGET_MS = 5_000;
const FAILURE_COOLDOWN_MS = 60_000;

export interface ContextTreePackage {
  root: string;
  cliPath: string;
  skillsPath: string;
}

export type { ContextTreeResult, ContextTreeStatus } from "./context-tree-connections.js";

export type ContextTreeExecFile = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string }>;

interface ContextTreeCliProcessError extends Error {
  readonly stdout: string;
  readonly killed: boolean;
  readonly signal?: string;
}

function cliProcessError(
  message: string,
  fields: { stdout: string; killed: boolean; signal?: string },
): ContextTreeCliProcessError {
  return Object.assign(new Error(message), fields);
}

function cliAbortError(message: string): ContextTreeCliProcessError {
  return cliProcessError(message, { killed: true, signal: "SIGTERM", stdout: "" });
}

function cliExitError(
  terminating: boolean,
  bufferExceeded: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
): ContextTreeCliProcessError | undefined {
  if (!terminating && !bufferExceeded && code === 0) return undefined;
  return cliProcessError(`Context Tree CLI exited with ${code ?? signal ?? "unknown"}`, {
    killed: terminating,
    stdout,
    ...(terminating ? { signal: "SIGTERM" } : signal ? { signal } : {}),
  });
}

function signalOwned(pid: number, signal: NodeJS.Signals, detached: boolean): void {
  try {
    if (detached) process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* the process is already gone */
    }
  }
}

/**
 * Stop the CLI and every descendant it owns. `git` children are detached into their own process
 * groups, so the CLI group alone is not the whole tree: enumerate descendants before signalling,
 * stop each group, escalate after a grace period, and resolve only once none remain.
 */
function createOwnedTreeStopper(child: ChildProcess, detached: boolean): () => Promise<void> {
  let stopped: Promise<void> | undefined;
  return () => {
    stopped ??= (async () => {
      const descendants = child.pid === undefined ? [] : await collectDescendantPids(child.pid);
      const pids = [child.pid, ...descendants].filter((pid): pid is number => typeof pid === "number");
      for (const pid of pids) signalOwned(pid, "SIGTERM", detached);
      try {
        await waitForProcessTreeGone(pids, { timeoutMs: CLI_KILL_GRACE_MS });
        return;
      } catch {
        /* escalate below */
      }
      for (const pid of pids) signalOwned(pid, "SIGKILL", detached);
      await waitForProcessTreeGone(pids, { timeoutMs: CLI_KILL_GRACE_MS }).catch(() => undefined);
    })();
    return stopped;
  };
}

/**
 * Production exec: one CLI child in its own process group. `execFile` signals only the direct
 * child, so a nested `git` would keep mutating the workspace after the caller stopped waiting.
 * A timeout or abort therefore stops the whole owned tree and the returned promise settles only
 * after those processes are gone.
 */
export const runContextTreeProcess: ContextTreeExecFile = (file, args, options) =>
  new Promise<{ stdout: string }>((resolveRun, rejectRun) => {
    if (options.signal?.aborted) {
      rejectRun(cliAbortError("Context Tree CLI was aborted before it started"));
      return;
    }
    const detached = process.platform !== "win32";
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      detached,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: options.windowsHide,
    });
    let stdout = "";
    let bufferExceeded = false;
    let settled = false;
    let terminating = false;
    let cleanup: Promise<void> | undefined;
    const stopOwnedTree = createOwnedTreeStopper(child, detached);
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      cleanup = stopOwnedTree();
    };
    const timer = setTimeout(terminate, options.timeout);
    timer.unref?.();
    options.signal?.addEventListener("abort", terminate, { once: true });
    const finish = (error?: ContextTreeCliProcessError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", terminate);
      if (error) rejectRun(error);
      else resolveRun({ stdout });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!bufferExceeded && stdout.length > options.maxBuffer) {
        bufferExceeded = true;
        terminate();
      }
    });
    child.stderr?.resume();
    child.once("error", (error: Error) => {
      finish(
        cliProcessError(error.message, { killed: terminating, stdout, ...(terminating ? { signal: "SIGTERM" } : {}) }),
      );
    });
    child.once("close", (code, signal) => {
      const error = cliExitError(terminating, bufferExceeded, code, signal, stdout);
      const complete = () => finish(error);
      if (cleanup) void cleanup.then(complete, complete);
      else complete();
    });
  });

export function resolveContextTreePackage(from: string = import.meta.url): ContextTreePackage | undefined {
  try {
    const root = dirname(createRequire(from).resolve("@first-tree-ai/context-tree/package.json"));
    return { root, cliPath: join(root, "dist", "cli", "index.mjs"), skillsPath: join(root, "skills") };
  } catch {
    return undefined;
  }
}

class ContextTreeCliFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ContextTreeCliFailure";
  }
}

/**
 * The failure code in one CLI payload, or undefined when it reports success.
 *
 * Most commands use an `error.code` envelope, but `verify` reports an unusable tree as
 * `ok: false` with findings instead, so the flag has to be honoured on its own.
 */
export function contextTreeFailureCode(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return "CLI_FAILED";
  const record = payload as { error?: { code?: unknown }; ok?: unknown; findings?: readonly { code?: unknown }[] };
  if (typeof record.error?.code === "string") return record.error.code;
  if (record.ok !== false) return undefined;
  const finding = record.findings?.find((entry) => typeof entry.code === "string")?.code;
  return typeof finding === "string" ? finding : "INVALID_TREE";
}

/**
 * Why the Codex host install did not install, or undefined when it did.
 *
 * The CLI reports a missing host as a `skipped` entry with an explanatory reason rather than as a
 * failure, so the payload itself has to be inspected: claiming `ready` while the Agent has no
 * skills is the worst available outcome.
 */
export function codexInstallSkipReason(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return "CODEX_INSTALL_FAILED";
  const record = payload as {
    installed?: readonly { host?: unknown }[];
    skipped?: readonly { host?: unknown; reason?: unknown }[];
  };
  if ((record.installed ?? []).some((entry) => entry.host === "codex")) return undefined;
  const skipped = (record.skipped ?? []).find((entry) => entry.host === "codex");
  const reason = skipped?.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : "CODEX_NOT_INSTALLED";
}

/**
 * Run one Context Tree command and return its single JSON line.
 *
 * The CLI reports operational failures as JSON on stdout with exit code 1, and sometimes with
 * exit code 0, so the payload is authoritative and the exit code is not.
 */
export async function runContextTreeCli(
  contextTreePackage: ContextTreePackage,
  args: readonly string[],
  options: {
    cwd?: string;
    network?: boolean;
    execFile?: ContextTreeExecFile;
    nodePath?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<{ payload: unknown; failureCode?: string }> {
  const managed = managedContextTreeCommand(args, options.env, options.signal);
  if (managed) return managed;
  const run = options.execFile ?? runContextTreeProcess;
  let stdout: string;
  try {
    ({ stdout } = await run(options.nodePath ?? process.execPath, [contextTreePackage.cliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      maxBuffer: CLI_MAX_BUFFER,
      timeout: options.network === true ? CLI_NETWORK_TIMEOUT_MS : CLI_TIMEOUT_MS,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env ? { env: options.env } : {}),
    }));
  } catch (error) {
    const failure = error as { stdout?: string; killed?: boolean; signal?: string };
    if (failure.killed === true || failure.signal === "SIGTERM") return { payload: undefined, failureCode: "TIMEOUT" };
    stdout = typeof failure.stdout === "string" ? failure.stdout : "";
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return { payload: undefined, failureCode: "CLI_FAILED" };
  }
  const failureCode = contextTreeFailureCode(payload);
  return failureCode === undefined ? { payload } : { payload, failureCode };
}

function managedContextTreeCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal,
): Promise<{ payload: unknown; failureCode?: string }> | undefined {
  if (
    !environment ||
    !(environment.OPENTAG_CONTEXT_TREE_SOCKET || environment.OPENTAG_CONTEXT_TREE_URL) ||
    !(args[0] === "sync" || args[0] === "write")
  )
    return undefined;
  return requestContextTreeCommand(
    { socketPath: environment.OPENTAG_CONTEXT_TREE_SOCKET, url: environment.OPENTAG_CONTEXT_TREE_URL },
    args,
    signal,
  ).then((result) => {
    const payload: unknown = JSON.parse(result.stdout || "{}");
    return { payload, ...(result.code !== 0 ? { failureCode: contextTreeFailureCode(payload) ?? "CLI_FAILED" } : {}) };
  });
}

export interface ContextTreeManagerOptions {
  home: string;
  environment?: NodeJS.ProcessEnv;
  logger?: ClientLogger;
  /** Omit to resolve the installed package; pass `null` for a manager that has none. */
  contextTreePackage?: ContextTreePackage | null;
  execFile?: ContextTreeExecFile;
  /**
   * Trusted credential mode. When true, Context Tree CLI children only run with an explicit
   * execution-local environment and never fall back to ambient host credentials.
   */
  managedCredentials?: boolean;
  platform?: NodeJS.Platform;
  /** Absolute path to the Node.js runtime the generated shim should exec. */
  nodePath?: string;
  /** Resolved Codex config home; skills install independently under account HOME's `.agents`. */
  codexHome?: string;
  sessionStartBudgetMs?: number;
  failureCooldownMs?: number;
}

/**
 * Owns each Agent's optional Context Tree wiring for Sessions.
 *
 * The repository comes from the Agent runtime snapshot; repository-owned configuration stays separate.
 *
 * Every operation here is optional memory, never a Session availability dependency: each failure
 * is reported through the managed prompt, and nothing in this class throws into Session start.
 */
export class ContextTreeManager {
  readonly #home: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #logger: ClientLogger;
  readonly #managedCredentials: boolean;
  readonly #package: ContextTreePackage | undefined;
  readonly #execFile: ContextTreeExecFile | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #nodePath: string;
  readonly #codexHome: string;
  readonly #sessionStartBudgetMs: number;
  readonly #failureCooldownMs: number;
  readonly #cache = new Map<
    string,
    { target: string; results: Map<string, { result: ContextTreeResult; retryAt: number }> }
  >();
  readonly #inFlight = new Map<
    string,
    { target: string; results: ContextTreeResult[]; promise: Promise<ContextTreeStatus> }
  >();
  readonly #observedTarget = new Map<string, string>();
  readonly #skillsInstalled = new Set<string>();
  #shimPreparation: Promise<boolean> | undefined;
  #shimRetryAt = 0;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: ContextTreeManagerOptions) {
    this.#home = resolve(options.home);
    this.#environment = { ...(options.environment ?? process.env) };
    this.#logger = options.logger ?? createLogger("context-tree");
    this.#managedCredentials = options.managedCredentials === true;
    this.#package =
      options.contextTreePackage === undefined
        ? resolveContextTreePackage()
        : (options.contextTreePackage ?? undefined);
    this.#execFile = options.execFile;
    this.#platform = options.platform ?? process.platform;
    this.#nodePath = options.nodePath ?? process.execPath;
    this.#codexHome = resolve(options.codexHome ?? join(resolveAccountHome(this.#environment), ".codex"));
    this.#sessionStartBudgetMs = options.sessionStartBudgetMs ?? SESSION_START_BUDGET_MS;
    this.#failureCooldownMs = options.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
  }

  /** Directory to prepend to a Session PATH so the packaged skills can invoke `context-tree`. */
  binDirectory(): string {
    return resolveOpenTagHomeLayout(this.#home).contextTreeBin;
  }

  /** Explicit packaged assets for providers that disable automatic workspace skill discovery. */
  async skillPaths(): Promise<string[]> {
    if (!this.#package) return [];
    const root = this.#package.skillsPath;
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
    } catch (error) {
      this.#logger.warn(
        { code: "context_tree_skills_unavailable", reason: String(error) },
        "Context Tree skills are unavailable",
      );
      return [];
    }
  }

  /**
   * Resolve Context Tree for one Agent workspace, connecting it on first use.
   *
   * `cwd` must come from `AgentWorkspaceManager.cwd(agentId)`, which refuses to return a path
   * until the workspace layout state is schema-v3 `complete`. That ordering is what keeps the
   * connection from writing into a workspace still mid-migration.
   */
  async ensureAgent(
    cwd: string,
    provider?: AgentRuntimeProvider,
    connections: readonly ContextTreeConnection[] = [],
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<ContextTreeStatus> {
    const ordered = normalizeContextTrees(connections);
    const target = JSON.stringify([
      provider ?? "codex",
      ordered,
      this.#managedCredentials ? hasManagedGitHubTransport(environment ?? {}) : null,
    ]);
    if (this.#observedTarget.get(cwd) !== target) {
      this.#observedTarget.set(cwd, target);
      this.#cache.delete(cwd);
    }
    // Execution handles rotate independently of the cached read snapshot. Only in-flight work
    // is tied to the exact handle; every caller still needs an authorized managed transport.
    const executionTarget = JSON.stringify([
      target,
      this.#managedCredentials
        ? [
            environment?.OPENTAG_EXECUTION_ID,
            environment?.OPENTAG_CONTEXT_TREE_SOCKET,
            environment?.OPENTAG_CONTEXT_TREE_URL,
            environment?.GH_TOKEN,
          ]
        : null,
    ]);
    let active = this.#inFlight.get(cwd);
    if (active?.target !== executionTarget) {
      const results = this.#initialResults(cwd, connections, environment);
      const promise = this.#serialize(() =>
        this.#prepareSafely(cwd, provider, connections, target, results, environment),
      );
      active = { target: executionTarget, results, promise };
      this.#inFlight.set(cwd, active);
      void promise.finally(() => {
        if (this.#inFlight.get(cwd)?.promise === promise) this.#inFlight.delete(cwd);
      });
    }
    let timer: NodeJS.Timeout | undefined;
    const pending = active;
    const budget = new Promise<ContextTreeStatus>((resolveBudget) => {
      timer = setTimeout(
        () =>
          resolveBudget(
            connections.length
              ? { status: "configured", connections: [...pending.results] }
              : { status: "unavailable", reason: "PREPARING" },
          ),
        this.#sessionStartBudgetMs,
      );
      timer.unref();
    });
    try {
      return await Promise.race([active.promise, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #initialResults(
    cwd: string,
    connections: readonly ContextTreeConnection[],
    environment?: Readonly<Record<string, string | undefined>>,
  ): ContextTreeResult[] {
    const cache = this.#cache.get(cwd);
    return connections.map((connection) => {
      const denied = this.#managedFailure(environment);
      if (denied) return { ...connection, status: "unavailable", reason: denied };
      const cached = cache?.results.get(contextTreeIdentity(connection));
      if (cached?.result.status === "ready") return cached.result;
      if (cached && cached.retryAt > Date.now()) return cached.result;
      return { ...connection, status: "unavailable", reason: "PREPARING" };
    });
  }

  async #prepareSafely(
    cwd: string,
    provider: AgentRuntimeProvider | undefined,
    connections: readonly ContextTreeConnection[],
    target: string,
    results: ContextTreeResult[],
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<ContextTreeStatus> {
    try {
      return await this.#prepareConnections(cwd, provider, connections, target, results, environment);
    } catch (error) {
      const reason = error instanceof ContextTreeCliFailure ? error.reason : "CLI_FAILED";
      connections.forEach((connection, index) => {
        if (results[index]?.status !== "ready") results[index] = { ...connection, status: "unavailable", reason };
      });
      return connections.length
        ? { status: "configured", connections: [...results] }
        : { status: "unavailable", reason };
    }
  }

  async #prepareConnections(
    cwd: string,
    provider: AgentRuntimeProvider | undefined,
    connections: readonly ContextTreeConnection[],
    target: string,
    results: ContextTreeResult[],
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<ContextTreeStatus> {
    const failAll = (reason: string): ContextTreeStatus => {
      connections.forEach((entry, index) => {
        results[index] = { ...entry, status: "unavailable", reason };
      });
      return connections.length
        ? { status: "configured", connections: [...results] }
        : { status: "unavailable", reason };
    };
    const permitted = this.#managedFailure(environment) ? [] : connections;
    await configureContextTrees(cwd, permitted);
    if (!this.#package) return connections.length ? failAll("PACKAGE_MISSING") : { status: "unconfigured" };
    const shimReady = await this.#prepareShim();
    if (!connections.length) return { status: "unconfigured" };
    if (!shimReady) return failAll("SHIM_UNAVAILABLE");
    const installFailure = await this.#installSkills(cwd, provider, environment);
    if (installFailure) return failAll(installFailure);
    return this.#connectAll(cwd, connections, target, results, environment);
  }

  async #installSkills(
    cwd: string,
    provider: AgentRuntimeProvider | undefined,
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<string | undefined> {
    if (provider === "pi" || this.#skillsInstalled.has(cwd)) return undefined;
    await this.#run(["skills", "install", "--host", "claude", "--project", cwd], cwd, false, environment);
    const installed = await this.#run(["skills", "install", "--host", "codex"], cwd, false, {
      ...this.#environment,
      HOME: resolveAccountHome(this.#environment),
      CODEX_HOME: this.#codexHome,
    });
    const failure = codexInstallSkipReason(installed);
    if (!failure) this.#skillsInstalled.add(cwd);
    return failure;
  }

  async #connectAll(
    cwd: string,
    connections: readonly ContextTreeConnection[],
    target: string,
    results: ContextTreeResult[],
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<ContextTreeStatus> {
    let cache = this.#cache.get(cwd);
    if (cache?.target !== target) {
      cache = { target, results: new Map() };
      if (this.#observedTarget.get(cwd) === target) this.#cache.set(cwd, cache);
    }
    for (const [index, connection] of connections.entries()) {
      const denied = this.#managedFailure(environment);
      if (denied) {
        results[index] = { ...connection, status: "unavailable", reason: denied };
        cache.results.delete(contextTreeIdentity(connection));
        continue;
      }
      const cached = cache.results.get(contextTreeIdentity(connection));
      if (cached && (cached.result.status === "ready" || cached.retryAt > Date.now())) {
        results[index] = cached.result;
        continue;
      }
      const result = await this.#connect(cwd, connection, environment);
      results[index] = result;
      cache.results.set(contextTreeIdentity(connection), { result, retryAt: Date.now() + this.#failureCooldownMs });
    }
    return { status: "configured", connections: [...results] };
  }

  #managedFailure(environment: Readonly<Record<string, string | undefined>> | undefined): string | undefined {
    if (!this.#managedCredentials) return undefined;
    if (!environment) return "AUTHENTICATION_REQUIRED";
    return hasManagedGitHubTransport(environment) ? undefined : "GITHUB_PERMISSION";
  }

  async #connect(
    cwd: string,
    connection: ContextTreeConnection,
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<ContextTreeResult> {
    const projectPath = join(await realpath(cwd), ".opentag", "context-tree", "project");
    const args = ["sync", "--tree", contextTreeSelector(connection), "--project-path", projectPath];
    const run = (offline: boolean) =>
      runContextTreeCli(this.#package as ContextTreePackage, [...args, ...(offline ? ["--offline"] : [])], {
        cwd,
        network: !offline,
        nodePath: this.#nodePath,
        env: {
          ...mergeContextTreeEnvironment(this.#environment, environment),
          HOME: resolveAccountHome(this.#environment),
        },
        ...(this.#execFile ? { execFile: this.#execFile } : {}),
      });
    const refreshed = await run(false);
    const entry = syncedTree(refreshed.payload, connection);
    if (entry?.ok && entry.connection.projectRoot === projectPath)
      return {
        ...connection,
        status: "ready",
        treePath: entry.treeRoot,
        projectPath,
        branch: connection.ref,
        sha: entry.repository?.sha,
      };
    const reason = entry && !entry.ok ? entry.error.code : (refreshed.failureCode ?? "SYNC_FAILED");
    if (!["DIRTY_TREE", "INVALID_TREE"].includes(reason)) {
      const cached = syncedTree((await run(true)).payload, connection);
      if (cached?.ok && cached.connection.projectRoot === projectPath)
        return { ...connection, status: "stale", treePath: cached.treeRoot, projectPath, reason };
    }
    return { ...connection, status: "unavailable", reason };
  }

  /** OpenTag always invokes the packaged CLI directly, so a broken shim cannot redirect it. */
  async #run(
    args: readonly string[],
    cwd: string,
    network: boolean,
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<unknown> {
    if (!this.#package) throw new ContextTreeCliFailure("PACKAGE_MISSING");
    if (this.#managedCredentials && network && !environment) throw new ContextTreeCliFailure("AUTHENTICATION_REQUIRED");
    const { payload, failureCode } = await runContextTreeCli(this.#package, args, {
      cwd,
      network,
      nodePath: this.#nodePath,
      env: {
        ...mergeContextTreeEnvironment(this.#environment, environment),
        HOME: resolveAccountHome(this.#environment),
      },
      ...(this.#execFile ? { execFile: this.#execFile } : {}),
    });
    if (failureCode !== undefined) throw new ContextTreeCliFailure(failureCode);
    return payload;
  }

  /**
   * Write the `context-tree` shim the packaged skills invoke by name.
   *
   * The shim pins the same Node.js runtime OpenTag uses, so a Session cannot resolve a different
   * one from the user's shell configuration.
   */
  #prepareShim(): Promise<boolean> {
    if (this.#shimPreparation && Date.now() < this.#shimRetryAt) return this.#shimPreparation;
    if (this.#shimPreparation && this.#shimRetryAt === 0) return this.#shimPreparation;
    this.#shimRetryAt = 0;
    this.#shimPreparation = this.#writeShim()
      .catch((error: unknown) => {
        this.#logger.warn({ err: describe(error) }, "Context Tree shim could not be created");
        return false;
      })
      .then((success) => {
        if (!success) this.#shimRetryAt = Date.now() + this.#failureCooldownMs;
        return success;
      });
    return this.#shimPreparation;
  }

  async #writeShim(): Promise<boolean> {
    if (!this.#package) return false;
    if (this.#platform === "win32") {
      // Windows Provider lifecycle, path, and lock coverage is a separate prerequisite.
      this.#logger.warn({ platform: this.#platform }, "Context Tree shim is not supported on this platform");
      return false;
    }
    const bin = resolveOpenTagHomeLayout(this.#home).contextTreeBin;
    await ensurePrivateDirectory(this.#home, bin);
    const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
    await writeDurableFile(join(bin, "context-tree-client.mjs"), CONTEXT_TREE_COMMAND_CLIENT_SOURCE, 0o600);
    await writeDurableFile(
      join(bin, "context-tree"),
      `#!/bin/sh\n# Generated by OpenTag; edits are overwritten.\nexport HOME=${quote(resolveAccountHome(this.#environment))}\nexec ${quote(this.#nodePath)} ${quote(join(bin, "context-tree-client.mjs"))} ${quote(this.#package.cliPath)} "$@"\n`,
      0o700,
    );
    return true;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation, operation);
    this.#pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Never log tree contents, credentials, or full command output. */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Merge an execution-local environment over the base environment. `undefined` override entries
 * unset the inherited variable, so a managed CLI child never inherits ambient credentials.
 */
export function mergeContextTreeEnvironment(
  base: NodeJS.ProcessEnv,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  if (!overrides) return merged;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Managed transports need execution-local routing, never an Agent repository allowlist. */
export function hasManagedGitHubTransport(environment: Readonly<Record<string, string | undefined>>): boolean {
  return (
    Boolean(environment.OPENTAG_CONTEXT_TREE_SOCKET || environment.OPENTAG_CONTEXT_TREE_URL) ||
    (typeof environment.GH_TOKEN === "string" &&
      environment.GH_TOKEN.length > 0 &&
      typeof environment.OPENTAG_PROVIDER_PROXY_URL === "string" &&
      environment.OPENTAG_PROVIDER_PROXY_URL.length > 0)
  );
}
