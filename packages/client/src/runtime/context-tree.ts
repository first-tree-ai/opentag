import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type ContextTreeConfig,
  ContextTreeConfigSchema,
  type ContextTreePreparation,
  ContextTreePreparationSchema,
  formatContextTreeTarget,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { ensurePrivateDirectory, readDurableJson, writeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

const execFileAsync = promisify(execFile);

/** Context Tree commands are local and bounded; a hung CLI must not stall Session start. */
const CLI_TIMEOUT_MS = 20_000;
/** A GitHub target clones on first use, so its first connect is allowed to take longer. */
const CLI_NETWORK_TIMEOUT_MS = 120_000;
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
  options: { cwd: string; timeout: number; maxBuffer: number; windowsHide: boolean; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

const defaultExecFile: ContextTreeExecFile = async (file, args, options) =>
  execFileAsync(file, [...args], { ...options, encoding: "utf8" });

export function resolveContextTreePackage(from: string = import.meta.url): ContextTreePackage | undefined {
  try {
    const root = dirname(createRequire(from).resolve("@first-tree-ai/context-tree/package.json"));
    return { root, cliPath: join(root, "dist", "cli", "index.mjs"), skillsPath: join(root, "skills") };
  } catch {
    return undefined;
  }
}

/** Read the last completed preparation without starting or waiting for Context Tree work. */
export function readContextTreePreparation(home: string): Promise<ContextTreePreparation | undefined> {
  return readDurableJson(resolveOpenTagHomeLayout(home).contextTreePreparationFile, ContextTreePreparationSchema.parse);
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

/** `connect` arguments for one target kind, mirroring the CLI's own argument shape. */
function connectArguments(target: ContextTreeConfig["target"], projectPath: string): readonly string[] {
  const project = ["--project-path", projectPath];
  if (target.kind === "managed") return ["connect", target.name, ...project];
  if (target.kind === "github") return ["connect", target.repository, ...project];
  return ["connect", "--tree-path", target.path, ...project];
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
  logger?: ClientLogger;
  /** Omit to resolve the installed package; pass `null` for a manager that has none. */
  contextTreePackage?: ContextTreePackage | null;
  execFile?: ContextTreeExecFile;
  platform?: NodeJS.Platform;
  /** Absolute path to the Node.js runtime the generated shim should exec. */
  nodePath?: string;
  /** Resolved home passed to Codex itself; host skill installation must use the same root. */
  codexHome?: string;
  sessionStartBudgetMs?: number;
  failureCooldownMs?: number;
}

/**
 * Owns the Computer's Context Tree wiring for Agent Sessions.
 *
 * OpenTag never creates a tree. A user names one once per Computer with
 * `opentag context-tree connect`; from then on every Agent workspace is connected to it
 * automatically, so all Agents on the Computer share one tree.
 *
 * Every operation here is optional memory, never a Session availability dependency: each failure
 * is reported through the managed prompt, and nothing in this class throws into Session start.
 */
export class ContextTreeManager {
  readonly #home: string;
  readonly #logger: ClientLogger;
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
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: ContextTreeManagerOptions) {
    this.#home = resolve(options.home);
    this.#logger = options.logger ?? createLogger("context-tree");
    this.#package =
      options.contextTreePackage === undefined
        ? resolveContextTreePackage()
        : (options.contextTreePackage ?? undefined);
    this.#execFile = options.execFile;
    this.#platform = options.platform ?? process.platform;
    this.#nodePath = options.nodePath ?? process.execPath;
    this.#codexHome = resolve(options.codexHome ?? join(homedir(), ".codex"));
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
  async ensureAgent(cwd: string): Promise<ContextTreeStatus> {
    // Read the configuration before consulting the cache. `opentag context-tree connect` only
    // writes the file, so a Computer configured after this daemon started must still activate,
    // and an entry recorded under another target must never be served for this one.
    const config = await this.readConfig();
    if (!config) return { status: "unconfigured" };
    const target = formatContextTreeTarget(config.target);
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
    return this.#withinSessionStartBudget(this.#joinPreparation(cwd, config, target));
  }

  async readConfig(): Promise<ContextTreeConfig | undefined> {
    try {
      return await readDurableJson(resolveOpenTagHomeLayout(this.#home).contextTreeConfigFile, (value) =>
        ContextTreeConfigSchema.parse(value),
      );
    } catch (error) {
      this.#logger.warn({ err: describe(error) }, "Context Tree configuration is unreadable");
      return undefined;
    }
  }

  async #ensureAgentOnce(cwd: string, config: ContextTreeConfig): Promise<ContextTreeStatus> {
    if (!this.#package) return this.#unavailable("PACKAGE_MISSING", config);
    const shim = await this.#writeShim().catch((error: unknown) => {
      this.#logger.warn({ err: describe(error) }, "Context Tree shim could not be created");
      return false;
    });
    if (!shim) return this.#unavailable("SHIM_UNAVAILABLE", config);

    try {
      // `connect` is idempotent for an identical connection and already returns the resolved
      // tree, so it is both the ensure operation and the source of the tree path.
      const connected = await this.#run(connectArguments(config.target, cwd), cwd, config.target.kind === "github");
      const treePath = (connected as { tree?: { path?: unknown } }).tree?.path;
      if (typeof treePath !== "string" || treePath.length === 0) return this.#unavailable("CONNECT_FAILED", config);
      // Claude Code loads skills from the workspace because OpenTag passes `--setting-sources
      // project`; Codex loads them from its own home, and only for a host that is present.
      await this.#run(["install", "--host", "claude", "--project", cwd], cwd, false);
      await this.#run(["install", "--host", "codex"], cwd, false, {
        ...process.env,
        HOME: dirname(this.#codexHome),
      });
      this.#logger.info(
        { target: formatContextTreeTarget(config.target), treePath },
        "Context Tree connected for an Agent workspace",
      );
      return { status: "ready", treePath };
    } catch (error) {
      if (error instanceof ContextTreeCliFailure) return this.#unavailable(error.reason, config);
      this.#logger.warn({ err: describe(error) }, "Context Tree preparation failed");
      return { status: "unavailable", reason: "CLI_FAILED" };
    }
  }

  /** OpenTag always invokes the packaged CLI directly, so a broken shim cannot redirect it. */
  async #run(args: readonly string[], cwd: string, network: boolean, env?: NodeJS.ProcessEnv): Promise<unknown> {
    if (!this.#package) throw new ContextTreeCliFailure("PACKAGE_MISSING");
    const { payload, failureCode } = await runContextTreeCli(this.#package, args, {
      cwd,
      network,
      nodePath: this.#nodePath,
      ...(env ? { env } : {}),
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

  #unavailable(reason: string, config: ContextTreeConfig): ContextTreeStatus {
    this.#logger.warn(
      { reason, target: formatContextTreeTarget(config.target) },
      "Context Tree is unavailable for this Session",
    );
    return { status: "unavailable", reason };
  }

  #joinPreparation(cwd: string, config: ContextTreeConfig, target: string): Promise<ContextTreeStatus> {
    const current = this.#inFlight.get(cwd);
    if (current?.target === target) return current.promise;
    // The CLI's connection store has no cross-process lock, so background work remains serialized
    // even though Session callers stop waiting after their short budget.
    const prepared = this.#serialize(() => this.#ensureAgentOnce(cwd, config)).catch((error: unknown) => {
      this.#logger.error({ err: describe(error) }, "Context Tree preparation raised an unexpected failure");
      return { status: "unavailable", reason: "CLI_FAILED" } as const;
    });
    let terminal: Promise<ContextTreeStatus>;
    terminal = prepared
      .then(async (status) => {
        await this.#recordPreparation(target, status);
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

  async #recordPreparation(target: string, status: ContextTreeStatus): Promise<void> {
    if (status.status === "unconfigured") return;
    const record: ContextTreePreparation = {
      schemaVersion: 1,
      target,
      status: status.status,
      ...(status.status === "unavailable" ? { reason: status.reason } : {}),
      at: new Date().toISOString(),
    };
    const file = resolveOpenTagHomeLayout(this.#home).contextTreePreparationFile;
    try {
      await ensurePrivateDirectory(this.#home, dirname(file));
      await writeDurableFile(file, `${JSON.stringify(ContextTreePreparationSchema.parse(record), undefined, 2)}\n`);
    } catch (error) {
      this.#logger.warn({ err: describe(error) }, "Context Tree preparation outcome could not be recorded");
    }
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
