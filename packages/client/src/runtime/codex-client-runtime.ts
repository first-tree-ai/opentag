import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  computeRuntimeSnapshotHashes,
  type InputRejectReason,
  OPENTAG_MESSAGE_TOOLS,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
} from "@opentag/shared";
import type { OpenTagApi } from "../api.js";
import type { AccessTokenProvider } from "../auth/token-provider.js";
import {
  CODEX_V0_APP_SERVER_ARGS,
  CodexAdapter,
  CodexLocalPolicy,
  codexDynamicToolSpecs,
  codexProviderEnvironment,
} from "../providers/codex/adapter.js";
import { CodexAppServerProcess } from "../providers/codex/app-server-wire.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import { AgentWorkspaceManager } from "./agent-workspace.js";
import { ClientRuntime } from "./client-runtime.js";
import { CodexTurnRunner } from "./codex-turn-runner.js";
import { ImResourceFetcher } from "./im-resource-fetcher.js";
import { MvpTurnReportRecovery } from "./mvp-turn-report-recovery.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import { RuntimeToolHost } from "./runtime-tool-host.js";
import { SessionBindingStore } from "./session-binding-store.js";
import { SessionReconciler } from "./session-reconciler.js";
import { TurnCustodyOwner } from "./turn-custody-owner.js";
import { TurnReportOwner } from "./turn-report-owner.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = Math.floor(RUNTIME_CLIENT_CAPABILITY_TTL_MS / 2);

export interface CreateCodexClientRuntimeOptions {
  adapter?: CodexAdapter;
  clientVersion: string;
  codexCommand?: string;
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
  home: string;
  log?: (message: string) => void;
  probe?: (command: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  capabilityRefreshIntervalMs?: number;
  api?: Pick<OpenTagApi, "openImResource">;
  tokenProvider?: Pick<AccessTokenProvider, "getAccessTokenLease">;
}

export class CodexClientRuntime {
  readonly bindingStore: SessionBindingStore;
  readonly custody: TurnCustodyOwner;
  readonly reconciler: SessionReconciler;
  readonly reportOwner: TurnReportOwner;
  readonly runner: CodexTurnRunner;
  readonly workspace: AgentWorkspaceManager;
  readonly toolHost: RuntimeToolHost;
  readonly messageToolAvailable: boolean;
  readonly #runtime: ClientRuntime;
  readonly #refreshCapability: () => Promise<void>;
  readonly #capabilityRefreshIntervalMs: number;
  #capabilityTimer?: ReturnType<typeof setInterval>;
  #capabilityRefreshInFlight = false;

  constructor(
    runtime: ClientRuntime,
    components: {
      bindingStore: SessionBindingStore;
      custody: TurnCustodyOwner;
      reconciler: SessionReconciler;
      reportOwner: TurnReportOwner;
      runner: CodexTurnRunner;
      workspace: AgentWorkspaceManager;
      toolHost: RuntimeToolHost;
      messageToolAvailable: boolean;
      refreshCapability: () => Promise<void>;
      capabilityRefreshIntervalMs: number;
    },
  ) {
    this.#runtime = runtime;
    this.bindingStore = components.bindingStore;
    this.custody = components.custody;
    this.reconciler = components.reconciler;
    this.reportOwner = components.reportOwner;
    this.runner = components.runner;
    this.workspace = components.workspace;
    this.toolHost = components.toolHost;
    this.messageToolAvailable = components.messageToolAvailable;
    this.#refreshCapability = components.refreshCapability;
    this.#capabilityRefreshIntervalMs = components.capabilityRefreshIntervalMs;
  }

  async run(): Promise<void> {
    this.#startCapabilityMonitor();
    try {
      await this.#runtime.run();
    } finally {
      this.#stopCapabilityMonitor();
      this.runner.stop();
      await this.runner.settled();
      this.reportOwner.stop();
      this.toolHost.close();
    }
  }

  stop(): void {
    this.#stopCapabilityMonitor();
    this.runner.stop();
    this.toolHost.close();
    this.#runtime.stop();
  }

  #startCapabilityMonitor(): void {
    if (this.#capabilityTimer) return;
    this.#capabilityTimer = setInterval(() => {
      if (this.#capabilityRefreshInFlight) return;
      this.#capabilityRefreshInFlight = true;
      void this.#refreshCapability().finally(() => {
        this.#capabilityRefreshInFlight = false;
      });
    }, this.#capabilityRefreshIntervalMs);
    this.#capabilityTimer.unref();
  }

  #stopCapabilityMonitor(): void {
    if (!this.#capabilityTimer) return;
    clearInterval(this.#capabilityTimer);
    this.#capabilityTimer = undefined;
  }
}

export async function createCodexClientRuntime(
  connection: RuntimeConnection,
  options: CreateCodexClientRuntimeOptions,
): Promise<CodexClientRuntime> {
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
    probe: options.probe ?? probeCodexRuntime,
    signal: options.signal,
    sourceEnvironment,
  });
  const refreshCapability = async (): Promise<void> => {
    const available = await ensureProviderReady()
      .then(() => true)
      .catch(() => false);
    connection.setVerifiedCapabilities({ imMessageTool: available ? 1 : 0 });
  };
  const messageToolAvailable = await ensureProviderReady()
    .then(() => true)
    .catch(() => false);
  connection.setVerifiedCapabilities({ imMessageTool: messageToolAvailable ? 1 : 0 });

  const bindingStore = new SessionBindingStore({ home: options.home, providerHomeIdentity });
  const workspace = new AgentWorkspaceManager({ home: options.home, bindingStore });
  const localPolicy = new CodexLocalPolicy();
  const reconciler = new SessionReconciler({
    computerId: connection.computerId,
    preparation: workspace,
    localPolicy,
  });
  const reportOwner = new TurnReportOwner({ connection });
  const toolHost = new RuntimeToolHost(connection);
  const resourceFetcher = new ImResourceFetcher({
    computerId: connection.computerId,
    instanceId: connection.instanceId,
    api: options.api,
    tokenProvider: options.tokenProvider,
  });
  const mvpReportRecovery = new MvpTurnReportRecovery({
    bindingStore,
    log: options.log,
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
    log: options.log,
    reportOwner,
    toolHost,
    resourceFetcher,
    workspace,
  });
  const runtime = new ClientRuntime(connection, {
    reconciler,
    handleDelivery: (request) => custody.accept(request),
    handleTurnReportResult: async (result) => {
      await reportOwner.handleResult(result);
    },
    prepareReconcileResult: (request, result) => mvpReportRecovery.prepare(request, result),
    onReconcileResultSendFailed: (request, result) => mvpReportRecovery.cancel(request, result),
    onReconciled: (request, result) => mvpReportRecovery.afterReconciled(request, result),
  });
  return new CodexClientRuntime(runtime, {
    bindingStore,
    custody,
    reconciler,
    reportOwner,
    runner,
    toolHost,
    messageToolAvailable,
    refreshCapability,
    capabilityRefreshIntervalMs: Math.max(
      10,
      options.capabilityRefreshIntervalMs ?? DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS,
    ),
    workspace,
  });
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
  let pending: Promise<string> | undefined;
  return async () => {
    if (!pending) {
      pending = (async () => {
        options.signal?.throwIfAborted();
        const command = await resolveExecutable(options.configuredCommand, options.sourceEnvironment);
        options.signal?.throwIfAborted();
        await options.probe(command, options.environment, options.signal);
        options.signal?.throwIfAborted();
        options.process.command = command;
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

export async function probeCodexRuntime(
  command: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const common = { env: environment, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, signal };
  const version = await execFileAsync(command, ["--version"], common);
  assertCompatibleCodexVersion(version.stdout);
  await execFileAsync(command, ["login", "status"], common);
  const cwd = environment.CODEX_HOME ?? process.cwd();
  const appServer = new CodexAppServerProcess({
    command,
    args: [...CODEX_V0_APP_SERVER_ARGS],
    cwd,
    env: environment,
    expectedCodexHome: environment.CODEX_HOME,
    requestTimeoutMs: 5_000,
  });
  try {
    appServer.setDynamicToolHandler(async () => ({ success: false, text: "Readiness probe only." }));
    await appServer.initialize("opentag-readiness", signal);
    const response = await appServer.request(
      "thread/start",
      {
        approvalPolicy: "never",
        cwd,
        sandbox: "workspace-write",
        ephemeral: true,
        serviceName: "OpenTag readiness",
        dynamicTools: codexDynamicToolSpecs(OPENTAG_MESSAGE_TOOLS),
      },
      signal,
    );
    if (
      typeof response !== "object" ||
      response === null ||
      !("thread" in response) ||
      typeof response.thread !== "object" ||
      response.thread === null ||
      !("id" in response.thread) ||
      typeof response.thread.id !== "string"
    ) {
      throw new Error("Codex App Server did not accept the hosted dynamic tool contract");
    }
  } finally {
    await appServer.close();
  }
}

function assertCompatibleCodexVersion(output: string): void {
  const match = /(?:codex-cli|codex)\s+(\d+)\.(\d+)\.(\d+)/i.exec(output);
  if (!match) throw new Error("Codex returned an unsupported version string");
  const version = match.slice(1).map(Number);
  const minimum = [0, 147, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = version[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (actual > required) return;
    if (actual < required) throw new Error("Codex 0.147.0 or newer is required");
  }
}

function preflightReason(error: unknown): InputRejectReason {
  if (error instanceof RuntimeStorageError) return "session_binding_conflict";
  return "provider_unavailable";
}
