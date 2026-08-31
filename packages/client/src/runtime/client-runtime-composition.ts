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
  RUNTIME_CAPABILITY,
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
  codexBindingRequiresHostedToolReplacement,
} from "../providers/codex/agent-runtime.js";
import { codexRuntimePolicy, validateCodexRuntimePolicy } from "../providers/codex/runtime-policy.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import { AdmissionController } from "./admission-controller.js";
import {
  AgentRuntimeExecutableDiscoveryError,
  AgentRuntimeExecutableNotFoundError,
  canAdvanceRuntimeCandidate,
  iterateAgentRuntimeExecutables,
  type ResolveAgentRuntimeExecutableOptions,
  type ResolvedAgentRuntimeExecutable,
} from "./agent-runtime-installation.js";
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
import { SessionCliProofManager } from "./session-cli-proof-manager.js";
import { SessionMessageInbox } from "./session-message-inbox.js";
import { SessionReconciler } from "./session-reconciler.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { TurnCustodyOwner } from "./turn-custody-owner.js";
import { TurnReportOwner } from "./turn-report-owner.js";

const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = Math.floor(RUNTIME_CLIENT_CAPABILITY_TTL_MS / 2);
const DEFAULT_PROVIDER_PROBE_DEADLINE_MS = 10_000;
const execFileAsync = promisify(execFile);

interface SharedProviderRefresh {
  readonly controller: AbortController;
  readonly promise: Promise<boolean>;
  settled: boolean;
  waiters: number;
}

export interface LoginShellDiscovery {
  readonly options: ResolveAgentRuntimeExecutableOptions;
  enable(): void;
}

export function createLoginShellDiscovery(): LoginShellDiscovery {
  let enabled = false;
  function includeLoginShell(): boolean {
    return enabled;
  }
  return {
    options: { includeLoginShell },
    enable() {
      enabled = true;
    },
  };
}

async function waitForSharedRefresh(refresh: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return refresh;
  signal.throwIfAborted();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const available = await Promise.race([refresh, aborted]);
    signal.throwIfAborted();
    return available;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface CreateClientRuntimeOptions {
  readonly api?: Pick<OpenTagApi, "openImResource">;
  readonly capabilityRefreshIntervalMs?: number;
  readonly providerProbeDeadlineMs?: number;
  readonly clientVersion: string;
  readonly codexCommand?: string;
  readonly codexHome?: string;
  readonly claudeCodeCommand?: string;
  readonly claudeCodeHome?: string;
  readonly larkCliCommand?: string;
  readonly slackCliCommand?: string;
  readonly cliCommand?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly factory?: AgentRuntimeFactory;
  readonly factories?: readonly AgentRuntimeFactory[];
  readonly home: string;
  readonly logger?: ClientLogger;
  readonly signal?: AbortSignal;
  readonly machineToken?: string;
}

export class ComposedClientRuntime {
  readonly bindingStore: SessionBindingStore;
  readonly custody: TurnCustodyOwner;
  readonly credentialEnvironment: ImCredentialEnvironmentManager;
  readonly reconciler: SessionReconciler;
  readonly sessionMessageInbox: SessionMessageInbox;
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
      sessionMessageInbox: SessionMessageInbox;
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
    this.sessionMessageInbox = components.sessionMessageInbox;
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
      this.sessionMessageInbox.stop();
      this.runner.stop();
      await this.runner.settled();
      await this.sessionMessageInbox.settled();
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
    this.sessionMessageInbox.stop();
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
  const defaultClaudeCodeHome = resolve(join(defaultHome, ".claude"));
  const configuredClaudeCodeHome = resolve(
    options.claudeCodeHome ?? sourceEnvironment.CLAUDE_CONFIG_DIR ?? defaultClaudeCodeHome,
  );
  await mkdir(configuredCodexHome, { recursive: true, mode: 0o700 });
  await mkdir(configuredClaudeCodeHome, { recursive: true, mode: 0o700 });
  const codexHome = await realpath(configuredCodexHome);
  const claudeCodeHome = await realpath(configuredClaudeCodeHome);
  const codexCommand = options.codexCommand ?? "codex";
  const claudeCodeCommand = options.claudeCodeCommand ?? "claude";
  options.signal?.throwIfAborted();
  const codexEnvironment = codexAgentRuntimeEnvironment({ ...sourceEnvironment, CODEX_HOME: codexHome });
  const canonicalDefaultClaudeCodeHome = await realpath(defaultClaudeCodeHome).catch(() => defaultClaudeCodeHome);
  const claudeCodeEnvironment = claudeCodeProcessEnvironment(
    sourceEnvironment,
    claudeCodeHome,
    canonicalDefaultClaudeCodeHome,
  );
  const providerHomes: Readonly<Record<"codex" | "claude-code", string>> = {
    codex: codexHome,
    "claude-code": claudeCodeHome,
  };
  const providerArtifactIdentities: Readonly<Record<"codex" | "claude-code", string>> = {
    codex: createHash("sha256").update(codexHome, "utf8").digest("hex"),
    "claude-code": createHash("sha256").update(claudeCodeHome, "utf8").digest("hex"),
  };
  const loginShellDiscovery = createLoginShellDiscovery();
  const discovery = loginShellDiscovery.options;
  const factories =
    options.factories ??
    (options.factory
      ? [options.factory]
      : [
          resolvedCodexFactory({
            clientVersion: options.clientVersion,
            command: codexCommand,
            codexHome,
            discovery,
            environment: codexEnvironment,
            sourceEnvironment,
          }),
          resolvedClaudeCodeFactory({
            claudeCodeHome,
            command: claudeCodeCommand,
            discovery,
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
  const providerProbeDeadlineMs = options.providerProbeDeadlineMs ?? DEFAULT_PROVIDER_PROBE_DEADLINE_MS;
  if (!Number.isSafeInteger(providerProbeDeadlineMs) || providerProbeDeadlineMs < 1) {
    throw new Error("Agent Runtime provider probe deadline must be a positive safe integer");
  }
  const sharedProviderRefreshes = new Map<string, SharedProviderRefresh>();
  const startSharedProviderRefresh = (providerId: string): SharedProviderRefresh => {
    const controller = new AbortController();
    let resolveOwner!: (available: boolean) => void;
    let rejectOwner!: (reason: unknown) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolveOwner = resolvePromise;
      rejectOwner = rejectPromise;
    });
    const owner: SharedProviderRefresh = {
      controller,
      promise,
      settled: false,
      waiters: 0,
    };
    sharedProviderRefreshes.set(providerId, owner);
    const deadlineError = new Error(`Agent Runtime provider probe exceeded its deadline: ${providerId}`);
    const deadlineTimer = setTimeout(() => {
      controller.abort(deadlineError);
    }, providerProbeDeadlineMs);
    deadlineTimer.unref();
    const provider = providerId as AgentRuntimeProvider;
    const operation = (async () => {
      let releaseReadiness: (() => void) | undefined;
      try {
        releaseReadiness = providers.isReady(providerId)
          ? connection.leaseProviderReadiness({ provider, status: "ready" })
          : undefined;
        if (!releaseReadiness) connection.setProviderReadiness({ provider, status: "checking" });
        const ownerSignal = AbortSignal.any([readinessSignal, controller.signal]);
        let settled: { available: boolean } | { error: unknown };
        try {
          settled = { available: await providers.refresh(providerId, ownerSignal) };
        } catch (error) {
          settled = { error };
        }
        const isCurrentOwner = sharedProviderRefreshes.get(providerId) === owner;
        if (!isCurrentOwner) {
          if ("error" in settled) throw settled.error;
          controller.signal.throwIfAborted();
          return settled.available;
        }
        if ("error" in settled) {
          if (readinessSignal.aborted || controller.signal.reason !== deadlineError) {
            throw settled.error;
          }
          const result: AgentRuntimeProbeResult = {
            ready: false,
            issues: [{ code: "temporarily_unavailable", message: "Provider readiness probe exceeded its deadline" }],
          };
          providers.invalidate(providerId, result);
          connection.setProviderReadiness(providerReadiness(provider, false, result));
          return false;
        }
        connection.setProviderReadiness(
          providerReadiness(provider, settled.available, providers.probeResult(providerId)),
        );
        return settled.available;
      } finally {
        owner.settled = true;
        clearTimeout(deadlineTimer);
        releaseReadiness?.();
        if (sharedProviderRefreshes.get(providerId) === owner) sharedProviderRefreshes.delete(providerId);
      }
    })();
    void operation.then(resolveOwner, rejectOwner);
    void owner.promise.catch(() => undefined);
    return owner;
  };
  const liveSharedProviderRefresh = (providerId: string): SharedProviderRefresh | undefined => {
    const owner = sharedProviderRefreshes.get(providerId);
    if (!owner || owner.settled || owner.controller.signal.aborted) return undefined;
    return owner;
  };
  const refreshProviderReadiness = async (providerId: string, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    readinessSignal.throwIfAborted();
    const owner = liveSharedProviderRefresh(providerId) ?? startSharedProviderRefresh(providerId);
    owner.waiters += 1;
    try {
      return await waitForSharedRefresh(owner.promise, signal);
    } finally {
      owner.waiters -= 1;
      if (owner.waiters === 0 && !owner.settled) {
        if (sharedProviderRefreshes.get(providerId) === owner) sharedProviderRefreshes.delete(providerId);
        owner.controller.abort(new Error(`Agent Runtime provider probe has no waiters: ${providerId}`));
      }
    }
  };
  const refreshCapability = async (): Promise<void> => {
    const results = await Promise.allSettled([
      ...providers.providerIds().map((providerId) => refreshProviderReadiness(providerId)),
      refreshImCliReadiness(
        connection,
        "feishu",
        options.larkCliCommand ?? "lark-cli",
        sourceEnvironment,
        readinessSignal,
      ),
      refreshImCliReadiness(
        connection,
        "slack",
        options.slackCliCommand ?? "slack",
        sourceEnvironment,
        readinessSignal,
      ),
    ]);
    readinessSignal.throwIfAborted();
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length > 0) throw new AggregateError(failures, "Client capability refresh failed");
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
  loginShellDiscovery.enable();

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
  const proofManager = new SessionCliProofManager(options.home);
  const runtimeManager = new SessionRuntimeManager({
    bindingStore,
    cliCommand: options.cliCommand ?? "opentag",
    cleanupProviderEnvironment: (sessionId) => credentialEnvironment.cleanup(sessionId),
    ensureProviderReady,
    home: options.home,
    providers,
    providerEnvironmentPath: (sessionId) => credentialEnvironment.pathForSession(sessionId),
    proofManager,
    workspace,
  });
  const reconciler = new SessionReconciler({
    computerId: connection.computerId,
    preparation: runtimeManager,
    localPolicy: runtimeManager,
  });
  const admission = new AdmissionController();
  const sessionMessageInbox = new SessionMessageInbox({
    admission,
    cliCommand: options.cliCommand ?? "opentag",
    credentialEnvironment,
    imCredentialGrantVersion: connection.capabilityVersion.bind(connection, RUNTIME_CAPABILITY.imCredentialGrant),
    reconciler,
    runtimeManager,
  });
  const resourceFetcher = new ImResourceFetcher({
    instanceId: connection.instanceId,
    api: options.api,
    machineToken: options.machineToken,
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
    admission,
    bindingStore,
    imDeliveryVersion: connection.capabilityVersion.bind(connection, RUNTIME_CAPABILITY.imDelivery),
    imSteerVersion: connection.capabilityVersion.bind(connection, RUNTIME_CAPABILITY.imSteer),
    reconciler,
    preflight,
    /* v8 ignore next -- late binding is required because custody and runner own each other. */
    start: (owner) => runner.start(owner),
    /* v8 ignore next -- late binding is required because custody and runner own each other. */
    steer: (request) => runner.steer(request),
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
    handleSessionMessageDelivery: sessionMessageInbox.accept.bind(sessionMessageInbox),
    ...createClientRuntimeHandlers(custody, reportOwner, mvpReportRecovery),
  });
  return new ComposedClientRuntime(runtime, {
    bindingStore,
    custody,
    credentialEnvironment,
    sessionMessageInbox,
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

export async function refreshImCliReadiness(
  connection: Pick<RuntimeConnection, "setImCliReadiness">,
  provider: RuntimeImCliReadinessObservation["provider"],
  configuredCommand: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  connection.setImCliReadiness({ provider, status: "checking" });
  const probe = (async () => {
    let command: string;
    try {
      command = await resolveExecutable(configuredCommand, environment);
    } catch {
      return "install" as const;
    }
    const execution = { env: environment, signal, timeout: 10_000, windowsHide: true } as const;
    try {
      if (provider === "feishu") {
        await execFileAsync(command, ["--version"], execution);
        await execFileAsync(command, ["im", "--help"], execution);
      } else {
        await execFileAsync(command, ["version"], execution);
        await execFileAsync(command, ["api", "--help"], execution);
      }
      return "ready" as const;
    } catch {
      return "unavailable" as const;
    }
  })();
  let onAbort: (() => void) | undefined;
  const status = await (signal
    ? Promise.race([
        probe,
        new Promise<"aborted">((resolve) => {
          if (signal.aborted) {
            resolve("aborted");
            return;
          }
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      })
    : probe);
  if (status === "aborted" || signal?.aborted) return;
  connection.setImCliReadiness({ provider, status });
}

export interface ResolvedCodexFactoryOptions {
  readonly clientVersion: string;
  readonly codexHome: string;
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly discovery?: ResolveAgentRuntimeExecutableOptions;
  readonly createCandidateFactory?: (command: string, environment: NodeJS.ProcessEnv) => CodexAgentRuntimeFactory;
}

function claudeCodeProcessEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  claudeCodeHome: string,
  defaultClaudeCodeHome: string,
): NodeJS.ProcessEnv {
  // Claude Code treats a set CLAUDE_CONFIG_DIR as a distinct credential record, even when the
  // value equals its own default. Omit the variable only when the resolved home is that default.
  if (claudeCodeHome === defaultClaudeCodeHome) {
    const environment = { ...sourceEnvironment };
    delete environment.CLAUDE_CONFIG_DIR;
    return claudeCodeAgentRuntimeEnvironment(environment);
  }
  return claudeCodeAgentRuntimeEnvironment({
    ...sourceEnvironment,
    CLAUDE_CONFIG_DIR: claudeCodeHome,
  });
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
    ? {
        ...common,
        policy: codexRuntimePolicy,
        requiresBindingReplacement: codexBindingRequiresHostedToolReplacement,
        validate: validateCodexRuntimePolicy,
      }
    : { ...common, policy: claudeCodeRuntimePolicy, validate: validateClaudeCodeRuntimePolicy };
}

function withSearchBinOnPath(
  environment: NodeJS.ProcessEnv,
  resolved: ResolvedAgentRuntimeExecutable,
  pathDelimiter: string = delimiter,
): NodeJS.ProcessEnv {
  if (resolved.source === "explicit" || !resolved.searchDir) return environment;
  const current = environment.PATH;
  if (!current) return { ...environment, PATH: resolved.searchDir };
  if (current === resolved.searchDir || current.startsWith(`${resolved.searchDir}${pathDelimiter}`)) {
    return environment;
  }
  return { ...environment, PATH: `${resolved.searchDir}${pathDelimiter}${current}` };
}

function translateExecutableDiscoveryError(
  error: unknown,
  signal: AbortSignal | undefined,
  artifactMessage: string,
): AgentRuntimeProbeResult {
  if (signal?.aborted) throw error;
  if (error instanceof AgentRuntimeExecutableNotFoundError) {
    return {
      ready: false,
      issues: [{ code: "artifact_missing", message: artifactMessage }],
    };
  }
  if (error instanceof AgentRuntimeExecutableDiscoveryError) {
    return {
      ready: false,
      issues: [{ code: "temporarily_unavailable", message: artifactMessage }],
    };
  }
  throw error;
}

export function resolvedCodexFactory(options: ResolvedCodexFactoryOptions): AgentRuntimeFactory {
  let readyFactory: CodexAgentRuntimeFactory | undefined;
  const createCandidate =
    options.createCandidateFactory ??
    ((command: string, environment: NodeJS.ProcessEnv) =>
      new CodexAgentRuntimeFactory({
        clientVersion: options.clientVersion,
        process: { command, env: environment, expectedCodexHome: options.codexHome },
      }));
  return {
    manifest: CODEX_AGENT_RUNTIME_MANIFEST,
    async probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
      request.signal?.throwIfAborted();
      let lastBinaryResult: AgentRuntimeProbeResult | undefined;
      const candidates = iterateAgentRuntimeExecutables(
        "codex",
        options.command,
        options.sourceEnvironment,
        options.discovery,
      );
      while (true) {
        let step: IteratorResult<ResolvedAgentRuntimeExecutable>;
        try {
          step = await candidates.next();
        } catch (error) {
          return translateExecutableDiscoveryError(error, request.signal, "Codex CLI could not be executed");
        }
        if (step.done) break;
        request.signal?.throwIfAborted();
        const environment = withSearchBinOnPath(
          options.environment,
          step.value,
          options.discovery?.pathDelimiter ?? delimiter,
        );
        const candidate = createCandidate(step.value.path, environment);
        const result = await candidate.probe(request);
        if (result.ready) {
          readyFactory = candidate;
          return result;
        }
        if (!canAdvanceRuntimeCandidate(result)) return result;
        lastBinaryResult = result;
      }
      return (
        lastBinaryResult ?? {
          ready: false,
          issues: [{ code: "artifact_missing", message: "Codex CLI could not be executed" }],
        }
      );
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
  readonly discovery?: ResolveAgentRuntimeExecutableOptions;
  readonly createCandidateFactory?: (command: string, environment: NodeJS.ProcessEnv) => ClaudeCodeAgentRuntimeFactory;
}

export function resolvedClaudeCodeFactory(options: ResolvedClaudeCodeFactoryOptions): AgentRuntimeFactory {
  let readyFactory: ClaudeCodeAgentRuntimeFactory | undefined;
  const createCandidate =
    options.createCandidateFactory ??
    ((command: string, environment: NodeJS.ProcessEnv) =>
      new ClaudeCodeAgentRuntimeFactory({
        process: { command, env: environment },
      }));
  return {
    manifest: CLAUDE_CODE_AGENT_RUNTIME_MANIFEST,
    async probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
      request.signal?.throwIfAborted();
      let lastBinaryResult: AgentRuntimeProbeResult | undefined;
      const candidates = iterateAgentRuntimeExecutables(
        "claude-code",
        options.command,
        options.sourceEnvironment,
        options.discovery,
      );
      while (true) {
        let step: IteratorResult<ResolvedAgentRuntimeExecutable>;
        try {
          step = await candidates.next();
        } catch (error) {
          return translateExecutableDiscoveryError(error, request.signal, "Claude Code CLI could not be executed");
        }
        if (step.done) break;
        request.signal?.throwIfAborted();
        const environment = withSearchBinOnPath(
          options.environment,
          step.value,
          options.discovery?.pathDelimiter ?? delimiter,
        );
        const candidate = createCandidate(step.value.path, environment);
        const result = await candidate.probe(request);
        if (result.ready) {
          readyFactory = candidate;
          return result;
        }
        if (!canAdvanceRuntimeCandidate(result)) return result;
        lastBinaryResult = result;
      }
      return (
        lastBinaryResult ?? {
          ready: false,
          issues: [{ code: "artifact_missing", message: "Claude Code CLI could not be executed" }],
        }
      );
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
    | "handleSteer"
    | "handleTurnReportResult"
    | "onReconcileResultSendFailed"
    | "onReconciled"
    | "prepareReconcileResult"
  >
>;

export function createClientRuntimeHandlers(
  custody: Pick<TurnCustodyOwner, "accept" | "acceptSteer">,
  reportOwner: Pick<TurnReportOwner, "handleResult">,
  recovery: Pick<MvpTurnReportRecovery, "afterReconciled" | "cancel" | "prepare">,
): ComposedClientRuntimeHandlers {
  return {
    handleDelivery: (request) => custody.accept(request),
    handleSteer: (request) => custody.acceptSteer(request),
    handleTurnReportResult: (result) => reportOwner.handleResult(result).then(() => undefined),
    prepareReconcileResult: (request, result) => recovery.prepare(request, result),
    onReconcileResultSendFailed: (request, result) => recovery.cancel(request, result),
    onReconciled: (request, result) => recovery.afterReconciled(request, result),
  };
}
