import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { computeRuntimeSnapshotHashes, type InputRejectReason } from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { CodexAdapter, CodexLocalPolicy, codexProviderEnvironment } from "../providers/codex/adapter.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import { AgentWorkspaceManager } from "./agent-workspace.js";
import { ClientRuntime } from "./client-runtime.js";
import { CodexTurnRunner } from "./codex-turn-runner.js";
import { MvpTurnReportRecovery } from "./mvp-turn-report-recovery.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import { SessionBindingStore } from "./session-binding-store.js";
import { SessionReconciler } from "./session-reconciler.js";
import { TurnCustodyOwner } from "./turn-custody-owner.js";
import { TurnReportOwner } from "./turn-report-owner.js";

const execFileAsync = promisify(execFile);

export interface CreateCodexClientRuntimeOptions {
  adapter?: CodexAdapter;
  clientVersion: string;
  codexCommand?: string;
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
  home: string;
  logger?: ClientLogger;
  probe?: (command: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export class CodexClientRuntime {
  readonly bindingStore: SessionBindingStore;
  readonly custody: TurnCustodyOwner;
  readonly reconciler: SessionReconciler;
  readonly reportOwner: TurnReportOwner;
  readonly runner: CodexTurnRunner;
  readonly workspace: AgentWorkspaceManager;
  readonly #runtime: ClientRuntime;

  constructor(
    runtime: ClientRuntime,
    components: {
      bindingStore: SessionBindingStore;
      custody: TurnCustodyOwner;
      reconciler: SessionReconciler;
      reportOwner: TurnReportOwner;
      runner: CodexTurnRunner;
      workspace: AgentWorkspaceManager;
    },
  ) {
    this.#runtime = runtime;
    this.bindingStore = components.bindingStore;
    this.custody = components.custody;
    this.reconciler = components.reconciler;
    this.reportOwner = components.reportOwner;
    this.runner = components.runner;
    this.workspace = components.workspace;
  }

  async run(): Promise<void> {
    try {
      await this.#runtime.run();
    } finally {
      this.runner.stop();
      await this.runner.settled();
      this.reportOwner.stop();
    }
  }

  stop(): void {
    this.runner.stop();
    this.#runtime.stop();
  }
}

export async function createCodexClientRuntime(
  connection: RuntimeConnection,
  options: CreateCodexClientRuntimeOptions,
): Promise<CodexClientRuntime> {
  const moduleLogger = (module: string) => options.logger?.child({ module }) ?? createLogger(module);
  const sourceEnvironment = options.environment ?? process.env;
  options.signal?.throwIfAborted();
  const defaultHome = sourceEnvironment.HOME ?? homedir();
  const configuredCodexHome = resolve(options.codexHome ?? sourceEnvironment.CODEX_HOME ?? join(defaultHome, ".codex"));
  await mkdir(configuredCodexHome, { recursive: true, mode: 0o700 });
  const codexHome = await realpath(configuredCodexHome);
  options.signal?.throwIfAborted();
  const environment = codexProviderEnvironment({ ...sourceEnvironment, CODEX_HOME: codexHome });
  const providerHomeIdentity = createHash("sha256").update(codexHome, "utf8").digest("hex");
  const processOptions = {
    command: options.codexCommand ?? "codex",
    env: environment,
    expectedCodexHome: codexHome,
  };
  const ensureProviderReady = providerReadiness({
    configuredCommand: processOptions.command,
    environment,
    process: processOptions,
    probe: options.probe ?? probeCodex,
    signal: options.signal,
    sourceEnvironment,
  });

  const bindingStore = new SessionBindingStore({ home: options.home, providerHomeIdentity });
  const workspace = new AgentWorkspaceManager({ home: options.home, bindingStore });
  const localPolicy = new CodexLocalPolicy();
  const reconciler = new SessionReconciler({
    computerId: connection.computerId,
    preparation: workspace,
    localPolicy,
  });
  const reportOwner = new TurnReportOwner({ connection });
  const mvpReportRecovery = new MvpTurnReportRecovery({
    bindingStore,
    logger: moduleLogger("report-recovery"),
    reconciler,
    reportOwner,
  });
  const adapter =
    options.adapter ??
    new CodexAdapter({
      clientVersion: options.clientVersion,
      process: processOptions,
    });

  let runner: CodexTurnRunner;
  const custody = new TurnCustodyOwner({
    bindingStore,
    reconciler,
    preflight: async (request) => {
      const policyReason = localPolicy.validate(request.runtime);
      if (policyReason) return policyReason;
      try {
        const command = await ensureProviderReady();
        if ((await realpath(codexHome)) !== codexHome) return "provider_unavailable";
        await access(command, constants.X_OK);
        await workspace.verifyAgent?.(request.runtime, computeRuntimeSnapshotHashes(request.runtime));
        return undefined;
      } catch (error) {
        return preflightReason(error);
      }
    },
    start: (owner) => runner.start(owner),
  });
  runner = new CodexTurnRunner({
    adapter,
    bindingStore,
    connection,
    custody,
    logger: moduleLogger("turn"),
    reportOwner,
    workspace,
  });
  const runtime = new ClientRuntime(connection, {
    logger: moduleLogger("client-runtime"),
    reconciler,
    handleDelivery: (request) => custody.accept(request),
    handleTurnReportResult: async (result) => {
      await reportOwner.handleResult(result);
    },
    prepareReconcileResult: (request, result) => mvpReportRecovery.prepare(request, result),
    onReconcileResultSendFailed: (request, result) => mvpReportRecovery.cancel(request, result),
    onReconciled: (request, result) => mvpReportRecovery.afterReconciled(request, result),
  });
  return new CodexClientRuntime(runtime, { bindingStore, custody, reconciler, reportOwner, runner, workspace });
}

interface ProviderReadinessOptions {
  configuredCommand: string;
  environment: NodeJS.ProcessEnv;
  process: { command: string };
  probe: NonNullable<CreateCodexClientRuntimeOptions["probe"]>;
  signal?: AbortSignal;
  sourceEnvironment: NodeJS.ProcessEnv;
}

function providerReadiness(options: ProviderReadinessOptions): () => Promise<string> {
  let readyCommand: string | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (readyCommand) return readyCommand;
    if (!pending) {
      pending = (async () => {
        options.signal?.throwIfAborted();
        const command = await resolveExecutable(options.configuredCommand, options.sourceEnvironment);
        options.signal?.throwIfAborted();
        await options.probe(command, options.environment, options.signal);
        options.signal?.throwIfAborted();
        options.process.command = command;
        readyCommand = command;
        return command;
      })().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

export function resolveCodexHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), ".codex"));
}

async function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return realpath(command);
  }
  const path = environment.PATH;
  if (!path) throw new Error("PATH is unavailable while locating Codex");
  const extensions = process.platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {
        // Continue through the explicit PATH allowlist.
      }
    }
  }
  throw new Error("A compatible Codex executable is unavailable");
}

async function probeCodex(command: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const common = { env: environment, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, signal };
  await execFileAsync(command, ["--version"], common);
  await execFileAsync(command, ["login", "status"], common);
}

function preflightReason(error: unknown): InputRejectReason {
  if (error instanceof RuntimeStorageError) return "session_binding_conflict";
  return "provider_unavailable";
}
