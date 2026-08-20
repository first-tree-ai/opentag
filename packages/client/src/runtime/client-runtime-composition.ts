import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  computeRuntimeSnapshotHashes,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  type RuntimeProviderReadinessObservation,
} from "@opentag/shared";
import type {
  AgentRuntimeFactory,
  AgentRuntimeProbeRequest,
  AgentRuntimeProbeResult,
  CreateAgentRuntimeRequest,
  ResumeAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import type { OpenTagApi } from "../api.js";
import type { AccessTokenProvider } from "../auth/token-provider.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import {
  CODEX_AGENT_RUNTIME_MANIFEST,
  CodexAgentRuntimeFactory,
  codexAgentRuntimeEnvironment,
} from "../providers/codex/agent-runtime.js";
import { codexRuntimePolicy, validateCodexRuntimePolicy } from "../providers/codex/runtime-policy.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import {
  type AgentRuntimeProviderRegistration,
  AgentRuntimeProviderRegistry,
} from "./agent-runtime-provider-registry.js";
import { AgentTurnRunner } from "./agent-turn-runner.js";
import { AgentWorkspaceManager } from "./agent-workspace.js";
import { ClientRuntime, type ClientRuntimeOptions } from "./client-runtime.js";
import { ImResourceFetcher } from "./im-resource-fetcher.js";
import { MvpTurnReportRecovery } from "./mvp-turn-report-recovery.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import { RuntimeToolHost } from "./runtime-tool-host.js";
import { SessionBindingStore } from "./session-binding-store.js";
import { SessionReconciler } from "./session-reconciler.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { TurnCustodyOwner } from "./turn-custody-owner.js";
import { TurnReportOwner } from "./turn-report-owner.js";

const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = Math.floor(RUNTIME_CLIENT_CAPABILITY_TTL_MS / 2);

export interface CreateClientRuntimeOptions {
  readonly api?: Pick<OpenTagApi, "openImResource">;
  readonly capabilityRefreshIntervalMs?: number;
  readonly clientVersion: string;
  readonly codexCommand?: string;
  readonly codexHome?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly factory?: AgentRuntimeFactory;
  readonly home: string;
  readonly logger?: ClientLogger;
  readonly signal?: AbortSignal;
  readonly tokenProvider?: Pick<AccessTokenProvider, "getAccessTokenLease">;
}

export class ComposedClientRuntime {
  readonly bindingStore: SessionBindingStore;
  readonly custody: TurnCustodyOwner;
  readonly messageToolAvailable: boolean;
  readonly reconciler: SessionReconciler;
  readonly reportOwner: TurnReportOwner;
  readonly runner: AgentTurnRunner;
  readonly runtimeManager: SessionRuntimeManager;
  readonly toolHost: RuntimeToolHost;
  readonly workspace: AgentWorkspaceManager;
  readonly #runtime: ClientRuntime;
  readonly #refreshCapability: () => Promise<void>;
  readonly #capabilityRefreshIntervalMs: number;
  readonly #capabilityAbort: AbortController;
  #capabilityTimer?: ReturnType<typeof setInterval>;
  #capabilityRefreshInFlight?: Promise<void>;
  #stopped = false;

  constructor(
    runtime: ClientRuntime,
    components: {
      bindingStore: SessionBindingStore;
      custody: TurnCustodyOwner;
      messageToolAvailable: boolean;
      reconciler: SessionReconciler;
      reportOwner: TurnReportOwner;
      runner: AgentTurnRunner;
      runtimeManager: SessionRuntimeManager;
      toolHost: RuntimeToolHost;
      workspace: AgentWorkspaceManager;
      refreshCapability: () => Promise<void>;
      capabilityRefreshIntervalMs: number;
      capabilityAbort: AbortController;
    },
  ) {
    this.#runtime = runtime;
    this.bindingStore = components.bindingStore;
    this.custody = components.custody;
    this.messageToolAvailable = components.messageToolAvailable;
    this.reconciler = components.reconciler;
    this.reportOwner = components.reportOwner;
    this.runner = components.runner;
    this.runtimeManager = components.runtimeManager;
    this.toolHost = components.toolHost;
    this.workspace = components.workspace;
    this.#refreshCapability = components.refreshCapability;
    this.#capabilityRefreshIntervalMs = components.capabilityRefreshIntervalMs;
    this.#capabilityAbort = components.capabilityAbort;
  }

  async run(): Promise<void> {
    this.#startCapabilityMonitor();
    try {
      await this.#runtime.run();
    } finally {
      this.#stopCapabilityMonitor();
      this.#capabilityAbort.abort(new Error("Client Runtime stopped"));
      await this.#capabilityRefreshInFlight?.catch(() => undefined);
      this.runner.stop();
      await this.runner.settled();
      await this.runtimeManager.close();
      this.reportOwner.stop();
      this.toolHost.close();
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopCapabilityMonitor();
    this.#capabilityAbort.abort(new Error("Client Runtime stopped"));
    this.runner.stop();
    void this.runtimeManager.close();
    this.toolHost.close();
    this.#runtime.stop();
  }

  #startCapabilityMonitor(): void {
    if (this.#capabilityTimer || this.#stopped) return;
    this.#capabilityTimer = setInterval(() => {
      if (this.#capabilityRefreshInFlight || this.#stopped) return;
      const refresh = this.#refreshCapability();
      this.#capabilityRefreshInFlight = refresh;
      void refresh
        .catch(() => undefined)
        .finally(() => {
          if (this.#capabilityRefreshInFlight === refresh) this.#capabilityRefreshInFlight = undefined;
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

export async function createClientRuntime(
  connection: RuntimeConnection,
  options: CreateClientRuntimeOptions,
): Promise<ComposedClientRuntime> {
  const moduleLogger = (module: string) => options.logger?.child({ module }) ?? createLogger(module);
  const sourceEnvironment = options.environment ?? process.env;
  options.signal?.throwIfAborted();
  const defaultHome = sourceEnvironment.HOME ?? homedir();
  const configuredCodexHome = resolve(options.codexHome ?? sourceEnvironment.CODEX_HOME ?? join(defaultHome, ".codex"));
  await mkdir(configuredCodexHome, { recursive: true, mode: 0o700 });
  const codexHome = await realpath(configuredCodexHome);
  const command = options.codexCommand ?? "codex";
  options.signal?.throwIfAborted();
  const environment = codexAgentRuntimeEnvironment({ ...sourceEnvironment, CODEX_HOME: codexHome });
  const providerArtifactIdentity = createHash("sha256").update(codexHome, "utf8").digest("hex");
  const factory =
    options.factory ??
    resolvedCodexFactory({
      clientVersion: options.clientVersion,
      command,
      codexHome,
      environment,
      sourceEnvironment,
    });
  const providers = new AgentRuntimeProviderRegistry([
    codexProviderRegistration(factory, providerArtifactIdentity, codexHome),
  ]);
  const capabilityAbort = new AbortController();
  const readinessSignal = options.signal
    ? AbortSignal.any([options.signal, capabilityAbort.signal])
    : capabilityAbort.signal;
  const refreshCapability = async (): Promise<void> => {
    connection.setProviderReadiness({
      provider: "codex",
      status: providers.isReady(CODEX_AGENT_RUNTIME_MANIFEST.providerId) ? "ready" : "checking",
    });
    const available = await providers.refresh(CODEX_AGENT_RUNTIME_MANIFEST.providerId, readinessSignal);
    readinessSignal.throwIfAborted();
    connection.setVerifiedCapabilities({ imMessageTool: available ? 1 : 0 });
    connection.setProviderReadiness(codexProviderReadiness(available, providers.probeResult("codex")));
  };
  try {
    await refreshCapability();
  } catch (error) {
    capabilityAbort.abort(error);
    throw error;
  }

  const bindingStore = new SessionBindingStore({
    home: options.home,
    providerArtifactIdentity: (providerId) => providers.artifactIdentity(providerId),
  });
  const workspace = new AgentWorkspaceManager({ home: options.home, bindingStore });
  const reportOwner = new TurnReportOwner({ connection });
  const toolHost = new RuntimeToolHost(connection);
  const runtimeManager = new SessionRuntimeManager({
    bindingStore,
    providers,
    toolHost,
    workspace,
  });
  const reconciler = new SessionReconciler({
    computerId: connection.computerId,
    preparation: runtimeManager,
    localPolicy: runtimeManager,
  });
  const resourceFetcher = new ImResourceFetcher({
    computerId: connection.computerId,
    instanceId: connection.instanceId,
    api: options.api,
    tokenProvider: options.tokenProvider,
  });
  const mvpReportRecovery = new MvpTurnReportRecovery({
    bindingStore,
    logger: moduleLogger("report-recovery"),
    reconciler,
    reportOwner,
  });
  let runner: AgentTurnRunner;
  const preflight = createClientRuntimePreflight({
    providers,
    readinessSignal,
    runtimeManager,
    workspace,
  });
  const custody = new TurnCustodyOwner({
    bindingStore,
    reconciler,
    preflight,
    /* v8 ignore next -- late binding is required because custody and runner own each other. */
    start: (owner) => runner.start(owner),
  });
  runner = new AgentTurnRunner({
    bindingStore,
    connection,
    custody,
    logger: moduleLogger("turn"),
    reportOwner,
    resourceFetcher,
    runtimeManager,
    toolHost,
  });
  const runtime = new ClientRuntime(connection, {
    logger: moduleLogger("client-runtime"),
    reconciler,
    ...createClientRuntimeHandlers(custody, reportOwner, mvpReportRecovery),
  });
  return new ComposedClientRuntime(runtime, {
    bindingStore,
    custody,
    messageToolAvailable: providers.isReady(CODEX_AGENT_RUNTIME_MANIFEST.providerId),
    reconciler,
    reportOwner,
    runner,
    runtimeManager,
    toolHost,
    workspace,
    refreshCapability,
    capabilityAbort,
    capabilityRefreshIntervalMs: Math.max(
      10,
      options.capabilityRefreshIntervalMs ?? DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS,
    ),
  });
}

export function codexProviderReadiness(
  available: boolean,
  result: AgentRuntimeProbeResult | undefined,
): RuntimeProviderReadinessObservation {
  if (available) return { provider: "codex", status: "ready" };
  if (result?.issues.some((issue) => issue.code === "artifact_missing")) {
    return { provider: "codex", status: "install" };
  }
  if (result?.issues.some((issue) => issue.code === "credential_missing")) {
    return { provider: "codex", status: "sign-in" };
  }
  return { provider: "codex", status: "unavailable" };
}

export interface ResolvedCodexFactoryOptions {
  readonly clientVersion: string;
  readonly codexHome: string;
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
}

function codexProviderRegistration(
  factory: AgentRuntimeFactory,
  artifactIdentity: string,
  codexHome: string,
): AgentRuntimeProviderRegistration {
  if (factory.manifest.providerId !== CODEX_AGENT_RUNTIME_MANIFEST.providerId) {
    throw new Error("Production Client Runtime only registers the reviewed Codex provider");
  }
  return {
    artifactIdentity,
    factory,
    policy: codexRuntimePolicy,
    validate: validateCodexRuntimePolicy,
    verifyArtifact: async (signal) => {
      signal?.throwIfAborted();
      if ((await realpath(codexHome)) !== codexHome) throw new Error("Codex Home identity changed");
    },
  };
}

export function resolvedCodexFactory(options: ResolvedCodexFactoryOptions): AgentRuntimeFactory {
  let readyFactory: CodexAgentRuntimeFactory | undefined;
  return {
    manifest: CODEX_AGENT_RUNTIME_MANIFEST,
    async probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
      let command: string;
      try {
        request.signal?.throwIfAborted();
        command = await resolveExecutable(options.command, options.sourceEnvironment);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        return { ready: false, issues: [{ code: "artifact_missing", message: "Codex CLI could not be executed" }] };
      }
      const candidate = new CodexAgentRuntimeFactory({
        clientVersion: options.clientVersion,
        process: { command, env: options.environment, expectedCodexHome: options.codexHome },
      });
      const result = await candidate.probe(request);
      if (result.ready) readyFactory = candidate;
      return result;
    },
    create(request: CreateAgentRuntimeRequest) {
      return requireReadyCodexFactory(readyFactory).create(request);
    },
    resume(request: ResumeAgentRuntimeRequest) {
      return requireReadyCodexFactory(readyFactory).resume(request);
    },
  };
}

function requireReadyCodexFactory(factory: CodexAgentRuntimeFactory | undefined): CodexAgentRuntimeFactory {
  if (!factory) throw new Error("Codex provider readiness has not been established");
  return factory;
}

export function resolveCodexHome(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), ".codex"));
}

export async function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
  if (isAbsolute(command)) {
    await access(command, constants.X_OK);
    return realpath(command);
  }
  const path = environment.PATH;
  if (!path) throw new Error("PATH is unavailable while locating Codex");
  /* v8 ignore next -- executable suffix probing is a Windows-only branch. */
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

interface ClientRuntimePreflightDependencies {
  readonly providers: Pick<AgentRuntimeProviderRegistry, "ensureReady" | "validateConfiguration">;
  readonly readinessSignal?: AbortSignal;
  readonly runtimeManager: Pick<SessionRuntimeManager, "runtime">;
  readonly workspace: Pick<AgentWorkspaceManager, "verifyAgent">;
}

export function createClientRuntimePreflight(
  dependencies: ClientRuntimePreflightDependencies,
): NonNullable<ConstructorParameters<typeof TurnCustodyOwner>[0]["preflight"]> {
  return async (request) => {
    const policyReason = dependencies.providers.validateConfiguration(request.runtime);
    if (policyReason) return policyReason;
    try {
      await dependencies.providers.ensureReady(request.runtime.provider, dependencies.readinessSignal);
      await dependencies.workspace.verifyAgent(request.runtime, computeRuntimeSnapshotHashes(request.runtime));
      dependencies.runtimeManager.runtime(request.sessionId);
      return undefined;
    } catch (error) {
      return error instanceof RuntimeStorageError ? "session_binding_conflict" : "provider_unavailable";
    }
  };
}

type ComposedClientRuntimeHandlers = Required<
  Pick<
    ClientRuntimeOptions,
    | "handleDelivery"
    | "handleTurnReportResult"
    | "onReconcileResultSendFailed"
    | "onReconciled"
    | "prepareReconcileResult"
  >
>;

export function createClientRuntimeHandlers(
  custody: Pick<TurnCustodyOwner, "accept">,
  reportOwner: Pick<TurnReportOwner, "handleResult">,
  recovery: Pick<MvpTurnReportRecovery, "afterReconciled" | "cancel" | "prepare">,
): ComposedClientRuntimeHandlers {
  return {
    handleDelivery: (request) => custody.accept(request),
    handleTurnReportResult: (result) => reportOwner.handleResult(result).then(() => undefined),
    prepareReconcileResult: (request, result) => recovery.prepare(request, result),
    onReconcileResultSendFailed: (request, result) => recovery.cancel(request, result),
    onReconciled: (request, result) => recovery.afterReconciled(request, result),
  };
}
