import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { AgentRuntimeProvider } from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { collectDescendantPids, waitForProcessTreeGone } from "../runner/processes.js";
import { resolveAccountHome } from "../storage/context-tree-home.js";
import { ensurePrivateDirectory, writeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

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

/**
 * Why a Session has no durable memory. `reason` is the Context Tree CLI's own error code where
 * there is one, so nothing is lost in translation, or one of OpenTag's own codes below.
 * `unconfigured` is a normal state, not a fault: nobody has run `context-tree connect` here yet.
 */
export type ContextTreeStatus =
  | { status: "ready"; treePath: string }
  | { status: "unconfigured" }
  | { status: "unavailable"; reason: string };

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
const defaultExecFile: ContextTreeExecFile = (file, args, options) =>
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
  const run = options.execFile ?? defaultExecFile;
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
 * The repository comes from the Agent runtime snapshot; local legacy configuration is ignored.
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
  readonly #ready = new Map<string, { target: string; status: ContextTreeStatus }>();
  readonly #cooldown = new Map<string, { target: string; status: ContextTreeStatus; until: number }>();
  readonly #inFlight = new Map<string, { target: string; promise: Promise<ContextTreeStatus> }>();
  readonly #observedTarget = new Map<string, string>();
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
    repository: string | null = null,
    environment?: Readonly<Record<string, string | undefined>>,
  ): Promise<ContextTreeStatus> {
    return this.#withinSessionStartBudget(this.#prepareAgent(cwd, provider, repository, environment));
  }

  async #prepareAgent(
    cwd: string,
    provider: AgentRuntimeProvider | undefined,
    repository: string | null,
    environment: Readonly<Record<string, string | undefined>> | undefined,
  ): Promise<ContextTreeStatus> {
    const shimReady = await this.#prepareShim();
    if (repository === null) {
      this.#observedTarget.delete(cwd);
      this.#ready.delete(cwd);
      this.#cooldown.delete(cwd);
      // Queue behind any preparation still completing after the session startup budget.
      return this.#serialize(async () => {
        if (!this.#package) return { status: "unconfigured" };
        try {
          await this.#run(["disconnect", "--project-path", cwd, "--json"], cwd, false);
        } catch {
          return { status: "unavailable", reason: "DISCONNECT_FAILED" };
        }
        return { status: "unconfigured" };
      });
    }
    const executableFailure = !this.#package ? "PACKAGE_MISSING" : shimReady ? undefined : "SHIM_UNAVAILABLE";
    const managedFailure = this.#managedFailure(repository, environment);
    // Cached preparation never substitutes for the current execution grant.
    if (managedFailure) return this.#unavailable(managedFailure, repository);

    const target = `${repository}:${provider ?? "codex"}`;
    if (this.#observedTarget.get(cwd) !== target) {
      this.#observedTarget.set(cwd, target);
      this.#ready.delete(cwd);
      this.#cooldown.delete(cwd);
    }
    const cached = this.#ready.get(cwd);
    if (cached?.target === target) return cached.status;
    const cooling = this.#cooldown.get(cwd);
    if (cooling?.target === target && cooling.until > Date.now()) return cooling.status;
    if (cooling) this.#cooldown.delete(cwd);
    return this.#joinPreparation(cwd, repository, target, executableFailure ?? managedFailure, provider, environment);
  }

  /**
   * Managed credential mode only runs the CLI with an explicit execution-local environment and
   * only for repositories in that execution's granted GitHub set. Legacy mode returns undefined
   * and keeps the existing ambient-credential behavior.
   */
  #managedFailure(
    repository: string | null,
    environment: Readonly<Record<string, string | undefined>> | undefined,
  ): string | undefined {
    if (!this.#managedCredentials || repository === null) return undefined;
    if (!environment) return "AUTHENTICATION_REQUIRED";
    return managedRepositoryAllowed(environment, repository) ? undefined : "GITHUB_PERMISSION";
  }

  async #ensureAgentOnce(
    cwd: string,
    repository: string,
    provider: AgentRuntimeProvider | undefined,
    environment: Readonly<Record<string, string | undefined>> | undefined,
  ): Promise<ContextTreeStatus> {
    if (!this.#package) return this.#unavailable("PACKAGE_MISSING", repository);
    if (provider === "pi") return this.#ensurePiAgent(cwd, repository, environment);

    try {
      // `connect` is idempotent for an identical connection and already returns the resolved
      // tree, so it is both the ensure operation and the source of the tree path.
      const connected = await this.#run(
        ["connect", repository, "--project-path", cwd, "--json"],
        cwd,
        true,
        environment,
      );
      const treePath = (connected as { tree?: { path?: unknown } }).tree?.path;
      if (typeof treePath !== "string" || treePath.length === 0) return this.#unavailable("CONNECT_FAILED", repository);
      // Claude Code loads skills from the workspace because OpenTag passes `--setting-sources
      // project`; Codex loads them from the account home's `.agents/skills` directory.
      await this.#run(["install", "--host", "claude", "--project", cwd], cwd, false, environment);
      const codexInstall = await this.#run(["install", "--host", "codex"], cwd, false, {
        ...this.#environment,
        HOME: resolveAccountHome(this.#environment),
        CODEX_HOME: this.#codexHome,
      });
      // A skipped Codex host is a diagnosable state, never a silent `ready`.
      const skipReason = codexInstallSkipReason(codexInstall);
      if (skipReason !== undefined) return this.#unavailable(skipReason, repository);
      this.#logger.info({ target: repository, treePath }, "Context Tree connected for an Agent workspace");
      return { status: "ready", treePath };
    } catch (error) {
      if (error instanceof ContextTreeCliFailure) return this.#unavailable(error.reason, repository);
      this.#logger.warn({ err: describe(error) }, "Context Tree preparation failed");
      return { status: "unavailable", reason: "CLI_FAILED" };
    }
  }

  /**
   * Pi receives the packaged skills through explicit `--skill` arguments in Client composition.
   * Connecting its workspace does not install or overwrite skills in the user's Pi home.
   */
  async #ensurePiAgent(
    cwd: string,
    repository: string,
    environment: Readonly<Record<string, string | undefined>> | undefined,
  ): Promise<ContextTreeStatus> {
    try {
      const connected = await this.#run(
        ["connect", repository, "--project-path", cwd, "--json"],
        cwd,
        true,
        environment,
      );
      const treePath = (connected as { tree?: { path?: unknown } }).tree?.path;
      if (typeof treePath !== "string" || treePath.length === 0) return this.#unavailable("CONNECT_FAILED", repository);
      this.#logger.info({ target: repository, treePath }, "Context Tree connected for a Pi Agent workspace");
      return { status: "ready", treePath };
    } catch (error) {
      if (error instanceof ContextTreeCliFailure) return this.#unavailable(error.reason, repository);
      this.#logger.warn({ err: describe(error) }, "Context Tree Pi preparation failed");
      return { status: "unavailable", reason: "CLI_FAILED" };
    }
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
      env: mergeContextTreeEnvironment(this.#environment, environment),
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
    await writeDurableFile(
      join(bin, "context-tree"),
      `#!/bin/sh\n# Generated by OpenTag; edits are overwritten.\nexec ${quote(this.#nodePath)} ${quote(this.#package.cliPath)} "$@"\n`,
      0o700,
    );
    return true;
  }

  #unavailable(reason: string, repository: string): ContextTreeStatus {
    this.#logger.warn({ reason, target: repository }, "Context Tree is unavailable for this Session");
    return { status: "unavailable", reason };
  }

  #joinPreparation(
    cwd: string,
    repository: string,
    target: string,
    preparationFailure: string | undefined,
    provider: AgentRuntimeProvider | undefined,
    environment: Readonly<Record<string, string | undefined>> | undefined,
  ): Promise<ContextTreeStatus> {
    const current = this.#inFlight.get(cwd);
    if (current?.target === target) return current.promise;
    // The CLI's connection store has no cross-process lock, so background work remains serialized
    // even though Session callers stop waiting after their short budget.
    const prepared = this.#serialize(async () =>
      preparationFailure
        ? this.#unavailable(preparationFailure, repository)
        : this.#ensureAgentOnce(cwd, repository, provider, environment),
    ).catch((error: unknown) => {
      this.#logger.error({ err: describe(error) }, "Context Tree preparation raised an unexpected failure");
      return { status: "unavailable", reason: "CLI_FAILED" } as const;
    });
    let terminal: Promise<ContextTreeStatus>;
    terminal = prepared
      .then(async (status) => {
        if (status.status === "ready" && this.#observedTarget.get(cwd) === target) {
          this.#ready.set(cwd, { target, status });
          this.#cooldown.delete(cwd);
        } else if (status.status === "unavailable" && this.#observedTarget.get(cwd) === target) {
          this.#cooldown.set(cwd, { target, status, until: Date.now() + this.#failureCooldownMs });
        }
        return status;
      })
      .then((status) => {
        if (this.#inFlight.get(cwd)?.promise === terminal) this.#inFlight.delete(cwd);
        return status;
      });
    this.#inFlight.set(cwd, { target, promise: terminal });
    return terminal;
  }

  async #withinSessionStartBudget(preparation: Promise<ContextTreeStatus>): Promise<ContextTreeStatus> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<ContextTreeStatus>((resolveBudget) => {
      timer = setTimeout(
        () => resolveBudget({ status: "unavailable", reason: "PREPARING" }),
        this.#sessionStartBudgetMs,
      );
      timer.unref();
    });
    const status = await Promise.race([preparation, budget]);
    if (timer) clearTimeout(timer);
    return status;
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialize(operation);
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

/**
 * True when the execution-local GitHub metadata grants this repository. Managed Context Tree
 * preparation must never reach a repository outside the current execution's granted set; this is
 * a consistency pre-check only, and the GitHub proxy still revalidates the exact target on every
 * request.
 */
export function managedRepositoryAllowed(
  environment: Readonly<Record<string, string | undefined>>,
  repository: string,
): boolean {
  const raw = environment.OPENTAG_GITHUB_REPOSITORIES;
  if (typeof raw !== "string" || raw.length === 0) return false;
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(entries)) return false;
  const wanted = repository.toLowerCase();
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const { fullName, role } = entry as { fullName?: unknown; role?: unknown };
    return role === "context_tree" && typeof fullName === "string" && fullName.toLowerCase() === wanted;
  });
}
