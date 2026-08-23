import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type AgentRuntimeProvider,
  computeRuntimeSnapshotHashes,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  type RuntimeImCliReadinessObservation,
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
  CLAUDE_CODE_AGENT_RUNTIME_MANIFEST,
  ClaudeCodeAgentRuntimeFactory,
  claudeCodeAgentRuntimeEnvironment,
} from "../providers/claude-code/agent-runtime.js";
import { claudeCodeRuntimePolicy, validateClaudeCodeRuntimePolicy } from "../providers/claude-code/runtime-policy.js";
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
  AgentRuntimeProviderUnavailableError,
} from "./agent-runtime-provider-registry.js";
import { AgentTurnRunner } from "./agent-turn-runner.js";
import { AgentWorkspaceManager } from "./agent-workspace.js";
import { ClientRuntime, type ClientRuntimeOptions } from "./client-runtime.js";
import { ImCredentialEnvironmentManager } from "./im-credential-environment-manager.js";
import { ImResourceFetcher } from "./im-resource-fetcher.js";
import { MvpTurnReportRecovery } from "./mvp-turn-report-recovery.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import { SessionBindingStore } from "./session-binding-store.js";
import { SessionReconciler } from "./session-reconciler.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { TurnCustodyOwner } from "./turn-custody-owner.js";
import { TurnReportOwner } from "./turn-report-owner.js";

const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = Math.floor(RUNTIME_CLIENT_CAPABILITY_TTL_MS / 2);
const execFileAsync = promisify(execFile);

export interface CreateClientRuntimeOptions {
  readonly api?: Pick<OpenTagApi, "openImResource">;
  readonly capabilityRefreshIntervalMs?: number;
  readonly clientVersion: string;
  readonly codexCommand?: string;
  readonly codexHome?: string;
  readonly claudeCodeCommand?: string;
  readonly claudeCodeHome?: string;
  readonly larkCliCommand?: string;
  readonly slackCliCommand?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly factory?: AgentRuntimeFactory;
  readonly factories?: readonly AgentRuntimeFactory[];
  readonly home: string;
  readonly logger?: ClientLogger;
  readonly signal?: AbortSignal;
  readonly tokenProvider?: Pick<AccessTokenProvider, "getAccessTokenLease">;
}

export class ComposedClientRuntime {
  readonly bindingStore: SessionBindingStore;
  readonly custody: TurnCustodyOwner;
  readonly credentialEnvironment: ImCredentialEnvironmentManager;
  readonly reconciler: SessionReconciler;
  readonly reportOwner: TurnReportOwner;
  readonly runner: AgentTurnRunner;
  readonly runtimeManager: SessionRuntimeManager;
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
      credentialEnvironment: ImCredentialEnvironmentManager;
      reconciler: SessionReconciler;
      reportOwner: TurnReportOwner;
      runner: AgentTurnRunner;
      runtimeManager: SessionRuntimeManager;
      workspace: AgentWorkspaceManager;
      refreshCapability: () => Promise<void>;
      capabilityRefreshIntervalMs: number;
      capabilityAbort: AbortController;
    },
  ) {
    this.#runtime = runtime;
    this.bindingStore = components.bindingStore;
    this.custody = components.custody;
    this.credentialEnvironment = components.credentialEnvironment;
    this.reconciler = components.reconciler;
    this.reportOwner = components.reportOwner;
    this.runner = components.runner;
    this.runtimeManager = components.runtimeManager;
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
      try {
        await this.runtimeManager.close();
      } finally {
        this.reportOwner.stop();
        await this.credentialEnvironment.close();
      }
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopCapabilityMonitor();
    this.#capabilityAbort.abort(new Error("Client Runtime stopped"));
    this.runner.stop();
    void Promise.allSettled([this.runtimeManager.close(), this.credentialEnvironment.close()]);
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
  const configuredClaudeCodeHome = resolve(
    options.claudeCodeHome ?? sourceEnvironment.CLAUDE_CONFIG_DIR ?? join(defaultHome, ".claude"),
  );
  await mkdir(configuredCodexHome, { recursive: true, mode: 0o700 });
  await mkdir(configuredClaudeCodeHome, { recursive: true, mode: 0o700 });
  const codexHome = await realpath(configuredCodexHome);
  const claudeCodeHome = await realpath(configuredClaudeCodeHome);
  const codexCommand = options.codexCommand ?? "codex";
  const claudeCodeCommand = options.claudeCodeCommand ?? "claude";
  options.signal?.throwIfAborted();
  const codexEnvironment = codexAgentRuntimeEnvironment({ ...sourceEnvironment, CODEX_HOME: codexHome });
  const claudeCodeEnvironment = claudeCodeAgentRuntimeEnvironment({
    ...sourceEnvironment,
    CLAUDE_CONFIG_DIR: claudeCodeHome,
  });
  const providerHomes: Readonly<Record<"codex" | "claude-code", string>> = {
    codex: codexHome,
    "claude-code": claudeCodeHome,
  };
  const providerArtifactIdentities: Readonly<Record<"codex" | "claude-code", string>> = {
    codex: createHash("sha256").update(codexHome, "utf8").digest("hex"),
    "claude-code": createHash("sha256").update(claudeCodeHome, "utf8").digest("hex"),
  };
  const factories =
    options.factories ??
    (options.factory
      ? [options.factory]
      : [
          resolvedCodexFactory({
            clientVersion: options.clientVersion,
            command: codexCommand,
            codexHome,
            environment: codexEnvironment,
            sourceEnvironment,
          }),
          resolvedClaudeCodeFactory({
            claudeCodeHome,
            command: claudeCodeCommand,
            environment: claudeCodeEnvironment,
            sourceEnvironment,
          }),
        ]);
  const providers = new AgentRuntimeProviderRegistry(
    factories.map((factory) => productionProviderRegistration(factory, providerArtifactIdentities, providerHomes)),
  );
  const capabilityAbort = new AbortController();
  const readinessSignal = options.signal
    ? AbortSignal.any([options.signal, capabilityAbort.signal])
    : capabilityAbort.signal;
  const refreshProviderReadiness = async (providerId: string, signal?: AbortSignal): Promise<boolean> => {
    const refreshSignal = signal ? AbortSignal.any([readinessSignal, signal]) : readinessSignal;
    const provider = providerId as AgentRuntimeProvider;
    const releaseReadiness = providers.isReady(providerId)
      ? connection.leaseProviderReadiness({ provider, status: "ready" })
      : undefined;
    if (!releaseReadiness) connection.setProviderReadiness({ provider, status: "checking" });
    try {
      const available = await providers.refresh(providerId, refreshSignal);
      refreshSignal.throwIfAborted();
      connection.setProviderReadiness(providerReadiness(provider, available, providers.probeResult(providerId)));
      return available;
    } finally {
      releaseReadiness?.();
    }
  };
  const refreshCapability = async (): Promise<void> => {
    await Promise.all([
      ...providers.providerIds().map((providerId) => refreshProviderReadiness(providerId)),
      refreshImCliReadiness(connection, "feishu", options.larkCliCommand ?? "lark-cli", sourceEnvironment),
      refreshImCliReadiness(connection, "slack", options.slackCliCommand ?? "slack", sourceEnvironment),
    ]);
    connection.setVerifiedCapabilities({ imCredentialGrant: 1 });
  };
  const ensureProviderReady = async (providerId: string, signal?: AbortSignal): Promise<void> => {
    if (providers.isReady(providerId)) return;
    if (!(await refreshProviderReadiness(providerId, signal))) {
      throw new AgentRuntimeProviderUnavailableError(
        providerId,
        providers.probeResult(providerId) ?? {
          ready: false,
          issues: [{ code: "temporarily_unavailable", message: "Provider readiness could not be established" }],
        },
      );
    }
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
  const credentialEnvironment = new ImCredentialEnvironmentManager({
    connection,
    home: options.home,
    logger: moduleLogger("im-credential-environment"),
  });
  const runtimeManager = new SessionRuntimeManager({
    bindingStore,
    cleanupProviderEnvironment: (sessionId) => credentialEnvironment.cleanup(sessionId),
    ensureProviderReady,
    providers,
    providerEnvironmentPath: (sessionId) => credentialEnvironment.pathForSession(sessionId),
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
    credentialEnvironment,
  });
  const runtime = new ClientRuntime(connection, {
    logger: moduleLogger("client-runtime"),
    reconciler,
    ...createClientRuntimeHandlers(custody, reportOwner, mvpReportRecovery),
  });
  return new ComposedClientRuntime(runtime, {
    bindingStore,
    custody,
    credentialEnvironment,
    reconciler,
    reportOwner,
    runner,
    runtimeManager,
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
  return providerReadiness("codex", available, result);
}

export function providerReadiness(
  provider: AgentRuntimeProvider,
  available: boolean,
  result: AgentRuntimeProbeResult | undefined,
): RuntimeProviderReadinessObservation {
  if (available) return { provider, status: "ready" };
  if (result?.issues.some((issue) => issue.code === "artifact_missing")) {
    return { provider, status: "install" };
  }
  if (result?.issues.some((issue) => issue.code === "credential_missing")) {
    return { provider, status: "sign-in" };
  }
  return { provider, status: "unavailable" };
}

/**
 * `slack api <method>` exists since Slack CLI v4.1.0; v4.2.0 removed the background update check that
 * otherwise interferes with non-interactive `slack api` invocations, so 4.2.0 is the supported floor.
 */
export const SLACK_CLI_MINIMUM_VERSION = "4.2.0";
/** `slack version --skip-update` prints a leading blank line followed by `Using slack v4.6.0`, not bare semver. */
const SLACK_CLI_VERSION_OUTPUT = /^\s*Using slack v(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?\s*$/;

export function parseSlackCliVersion(output: string): string | undefined {
  return SLACK_CLI_VERSION_OUTPUT.exec(output)?.[1];
}

export function satisfiesMinimumVersion(detected: string, minimum: string): boolean {
  const left = detected.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export async function refreshImCliReadiness(
  connection: Pick<RuntimeConnection, "setImCliReadiness">,
  provider: RuntimeImCliReadinessObservation["provider"],
  configuredCommand: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  connection.setImCliReadiness({ provider, status: "checking" });
  let command: string;
  try {
    command = await resolveExecutable(configuredCommand, environment);
  } catch {
    connection.setImCliReadiness({ provider, status: "install" });
    return;
  }
  const execution = { env: environment, timeout: 10_000, windowsHide: true } as const;
  try {
    if (provider === "feishu") {
      await execFileAsync(command, ["--version"], execution);
      await execFileAsync(command, ["im", "--help"], execution);
    } else {
      const { stdout } = await execFileAsync(command, ["version", "--skip-update"], execution);
      const detectedVersion = parseSlackCliVersion(stdout);
      if (!detectedVersion) {
        connection.setImCliReadiness({ provider, status: "unavailable" });
        return;
      }
      if (!satisfiesMinimumVersion(detectedVersion, SLACK_CLI_MINIMUM_VERSION)) {
        connection.setImCliReadiness({
          provider,
          status: "unavailable",
          reason: "version_incompatible",
          detectedVersion,
        });
        return;
      }
      await execFileAsync(command, ["api", "--help", "--skip-update"], execution);
    }
    connection.setImCliReadiness({ provider, status: "ready" });
  } catch {
    connection.setImCliReadiness({ provider, status: "unavailable" });
  }
}

export interface ResolvedCodexFactoryOptions {
  readonly clientVersion: string;
  readonly codexHome: string;
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
}

function productionProviderRegistration(
  factory: AgentRuntimeFactory,
  artifactIdentities: Readonly<Record<"codex" | "claude-code", string>>,
  providerHomes: Readonly<Record<"codex" | "claude-code", string>>,
): AgentRuntimeProviderRegistration {
  const providerId = factory.manifest.providerId;
  if (providerId !== "codex" && providerId !== "claude-code") {
    throw new Error(`Production Client Runtime does not register the unreviewed provider: ${providerId}`);
  }
  const providerHome = providerHomes[providerId];
  const common = {
    artifactIdentity: artifactIdentities[providerId],
    factory,
    verifyArtifact: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if ((await realpath(providerHome)) !== providerHome) {
        throw new Error(`${factory.manifest.displayName} Home identity changed`);
      }
    },
  };
  return providerId === "codex"
    ? { ...common, policy: codexRuntimePolicy, validate: validateCodexRuntimePolicy }
    : { ...common, policy: claudeCodeRuntimePolicy, validate: validateClaudeCodeRuntimePolicy };
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

export interface ResolvedClaudeCodeFactoryOptions {
  readonly claudeCodeHome: string;
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
}

export function resolvedClaudeCodeFactory(options: ResolvedClaudeCodeFactoryOptions): AgentRuntimeFactory {
  let readyFactory: ClaudeCodeAgentRuntimeFactory | undefined;
  return {
    manifest: CLAUDE_CODE_AGENT_RUNTIME_MANIFEST,
    async probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
      let command: string;
      try {
        request.signal?.throwIfAborted();
        command = await resolveExecutable(options.command, options.sourceEnvironment);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        return {
          ready: false,
          issues: [{ code: "artifact_missing", message: "Claude Code CLI could not be executed" }],
        };
      }
      const candidate = new ClaudeCodeAgentRuntimeFactory({
        process: { command, env: options.environment },
      });
      const result = await candidate.probe(request);
      if (result.ready) readyFactory = candidate;
      return result;
    },
    create(request: CreateAgentRuntimeRequest) {
      return requireReadyClaudeCodeFactory(readyFactory).create(request);
    },
    resume(request: ResumeAgentRuntimeRequest) {
      return requireReadyClaudeCodeFactory(readyFactory).resume(request);
    },
  };
}

function requireReadyClaudeCodeFactory(
  factory: ClaudeCodeAgentRuntimeFactory | undefined,
): ClaudeCodeAgentRuntimeFactory {
  if (!factory) throw new Error("Claude Code provider readiness has not been established");
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
  if (!path) throw new Error("PATH is unavailable while locating an Agent Runtime provider");
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
  throw new Error("A compatible Agent Runtime provider executable is unavailable");
}

interface ClientRuntimePreflightDependencies {
  readonly providers: Pick<AgentRuntimeProviderRegistry, "validateConfiguration">;
  readonly workspace: Pick<AgentWorkspaceManager, "verifyAgent">;
}

export function createClientRuntimePreflight(
  dependencies: ClientRuntimePreflightDependencies,
): NonNullable<ConstructorParameters<typeof TurnCustodyOwner>[0]["preflight"]> {
  return async (request) => {
    const policyReason = dependencies.providers.validateConfiguration(request.runtime);
    if (policyReason) return policyReason;
    try {
      await dependencies.workspace.verifyAgent(request.runtime, computeRuntimeSnapshotHashes(request.runtime));
      return undefined;
    } catch (error) {
      return error instanceof RuntimeStorageError ? "session_binding_conflict" : "configuration_unsupported";
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
