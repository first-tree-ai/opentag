import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  type AgentRuntimeProvider,
  computeRuntimeSnapshotHashes,
  RUNTIME_CAPABILITY,
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
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { AdmissionController } from "./admission-controller.js";
import { AgentRuntimeAvailabilityTester } from "./agent-runtime-availability-tester.js";
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
import { ContextTreeManager } from "./context-tree.js";
import { ImCredentialEnvironmentManager } from "./im-credential-environment-manager.js";
import { ImResourceFetcher } from "./im-resource-fetcher.js";
import { MvpTurnReportRecovery } from "./mvp-turn-report-recovery.js";
import { resolveAccountHome } from "./provider-cli/account-layout.js";
import { ProviderCliManager } from "./provider-cli/manager.js";
import { ProviderCliReconciler } from "./provider-cli/reconciler.js";
import { ProviderCliTurnPlanManager } from "./provider-cli/turn-plan-manager.js";
import { resolveProviderCliTurnRunnerInvocation } from "./provider-cli/turn-runner.js";
import { ProviderCliValidationRunner } from "./provider-cli/validation-runner.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import {
  FileRuntimeDurabilityStore,
  RuntimeDurabilityMetrics,
  type RuntimeDurabilityStore,
} from "./runtime-durability.js";
import { ServerRuntimeDurabilityStore } from "./server-runtime-durability-store.js";
import { SessionBindingStore } from "./session-binding-store.js";
import { SessionCliProofManager } from "./session-cli-proof-manager.js";
import { SessionMessageInbox } from "./session-message-inbox.js";
import { SessionReconciler } from "./session-reconciler.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { TurnCustodyOwner } from "./turn-custody-owner.js";
import { TurnReportOwner } from "./turn-report-owner.js";

const DEFAULT_CAPABILITY_REFRESH_INTERVAL_MS = Math.floor(RUNTIME_CLIENT_CAPABILITY_TTL_MS / 2);
const DEFAULT_PROVIDER_PROBE_DEADLINE_MS = 10_000;

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

/**
 * Every local state whose interruption could lose or duplicate an accepted Turn, pending Turn
 * completion/report custody, or an accepted IM delivery — aggregated from the authoritative owners
 * (Session reconciler activity and recoveries, Turn custody, Turn runner, Turn reports, and the
 * Session message inbox) rather than from any heuristic. `total === 0` is the only upgrade gate.
 */
export interface ProtectedWorkSnapshot {
  /** Live per-Session Turn activity recorded by the Session reconciler. */
  sessionActivities: number;
  /** Unresolved Turns recovered from durable state that still owe a completion report. */
  pendingRecoveries: number;
  /** Accepted Turns still under local custody (not yet recorded as reported). */
  custodyTurns: number;
  /** Turns the runner is currently executing or reporting. */
  activeTurns: number;
  /** Turn Reports awaiting Server confirmation. */
  pendingReports: number;
  /** Accepted Session messages that have not reached a terminal state, including retry backoff. */
  queuedSessionMessages: number;
  /** Total protected items; zero means no protected work remains. */
  total: number;
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

interface SharedProviderRefreshContext {
  readonly connection: RuntimeConnection;
  readonly providers: AgentRuntimeProviderRegistry;
  readonly readinessSignal: AbortSignal;
  readonly providerProbeDeadlineMs: number;
  readonly sharedProviderRefreshes: Map<string, SharedProviderRefresh>;
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

function providerProbeDeadline(value: number | undefined): number {
  const deadline = value ?? DEFAULT_PROVIDER_PROBE_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline < 1) {
    throw new Error("Agent Runtime provider probe deadline must be a positive safe integer");
  }
  return deadline;
}

function startSharedProviderRefresh(context: SharedProviderRefreshContext, providerId: string): SharedProviderRefresh {
  const controller = new AbortController();
  let resolveOwner!: (available: boolean) => void;
  let rejectOwner!: (reason: unknown) => void;
  const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
    resolveOwner = resolvePromise;
    rejectOwner = rejectPromise;
  });
  const owner: SharedProviderRefresh = { controller, promise, settled: false, waiters: 0 };
  context.sharedProviderRefreshes.set(providerId, owner);
  const deadlineError = new Error(`Agent Runtime provider probe exceeded its deadline: ${providerId}`);
  const deadlineTimer = setTimeout(() => controller.abort(deadlineError), context.providerProbeDeadlineMs);
  deadlineTimer.unref();
  const operation = runSharedProviderRefresh(context, providerId, owner, deadlineError, deadlineTimer);
  void operation.then(resolveOwner, rejectOwner);
  void owner.promise.catch(() => undefined);
  return owner;
}

async function runSharedProviderRefresh(
  context: SharedProviderRefreshContext,
  providerId: string,
  owner: SharedProviderRefresh,
  deadlineError: Error,
  deadlineTimer: ReturnType<typeof setTimeout>,
): Promise<boolean> {
  let releaseReadiness: (() => void) | undefined;
  try {
    const provider = providerId as AgentRuntimeProvider;
    if (context.providers.isReady(providerId)) {
      releaseReadiness = context.connection.leaseProviderReadiness({ provider, status: "ready" });
    }
    if (!releaseReadiness) context.connection.setProviderReadiness({ provider, status: "checking" });
    const ownerSignal = AbortSignal.any([context.readinessSignal, owner.controller.signal]);
    let settled: { available: boolean } | { error: unknown };
    try {
      settled = { available: await context.providers.refresh(providerId, ownerSignal) };
    } catch (error) {
      settled = { error };
    }
    return resolveSharedProviderRefreshResult(context, providerId, owner, deadlineError, settled);
  } finally {
    owner.settled = true;
    clearTimeout(deadlineTimer);
    releaseReadiness?.();
    if (context.sharedProviderRefreshes.get(providerId) === owner) context.sharedProviderRefreshes.delete(providerId);
  }
}

function resolveSharedProviderRefreshResult(
  context: SharedProviderRefreshContext,
  providerId: string,
  owner: SharedProviderRefresh,
  deadlineError: Error,
  settled: { available: boolean } | { error: unknown },
): boolean {
  if (context.sharedProviderRefreshes.get(providerId) !== owner) {
    if ("error" in settled) throw settled.error;
    owner.controller.signal.throwIfAborted();
    return settled.available;
  }
  if ("error" in settled) {
    if (context.readinessSignal.aborted || owner.controller.signal.reason !== deadlineError) throw settled.error;
    const result: AgentRuntimeProbeResult = {
      ready: false,
      issues: [{ code: "temporarily_unavailable", message: "Provider readiness probe exceeded its deadline" }],
    };
    context.providers.invalidate(providerId, result);
    context.connection.setProviderReadiness(providerReadiness(providerId as AgentRuntimeProvider, false, result));
    return false;
  }
  context.connection.setProviderReadiness(
    providerReadiness(providerId as AgentRuntimeProvider, settled.available, context.providers.probeResult(providerId)),
  );
  return settled.available;
}

export interface CreateClientRuntimeOptions {
  readonly api?: Pick<OpenTagApi, "openImResource">;
  readonly serverDurability?: {
    readonly api: Pick<OpenTagApi, "listRuntimeDurableWork" | "writeRuntimeDurableWork">;
    readonly machineToken: string;
    readonly now?: () => number;
  };
  readonly capabilityRefreshIntervalMs?: number;
  readonly providerProbeDeadlineMs?: number;
  readonly clientVersion: string;
  readonly codexCommand?: string;
  readonly codexHome?: string;
  readonly claudeCodeCommand?: string;
  readonly claudeCodeHome?: string;
  readonly cliCommand?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly factory?: AgentRuntimeFactory;
  readonly factories?: readonly AgentRuntimeFactory[];
  readonly home: string;
  readonly logger?: ClientLogger;
  readonly signal?: AbortSignal;
  readonly machineToken?: string;
  readonly durabilityStore?: RuntimeDurabilityStore;
  readonly durabilityMetrics?: RuntimeDurabilityMetrics;
}

export class ComposedClientRuntime {
  readonly #admission: AdmissionController;
  readonly bindingStore: SessionBindingStore;
  readonly custody: TurnCustodyOwner;
  readonly credentialEnvironment: ImCredentialEnvironmentManager;
  readonly reconciler: SessionReconciler;
  readonly sessionMessageInbox: SessionMessageInbox;
  readonly reportOwner: TurnReportOwner;
  readonly durabilityMetrics: RuntimeDurabilityMetrics;
  readonly runner: AgentTurnRunner;
  readonly runtimeManager: SessionRuntimeManager;
  readonly workspace: AgentWorkspaceManager;
  readonly #providerCliReconciler?: { close(): Promise<void>; refreshPublishedImCliReadiness(): Promise<void> };
  readonly #providerCliTurnPlans?: { recover(): Promise<void> };
  readonly #runtime: ClientRuntime;
  readonly #refreshCapability: () => Promise<void>;
  readonly #capabilityRefreshIntervalMs: number;
  readonly #capabilityAbort: AbortController;
  #capabilityTimer?: ReturnType<typeof setInterval>;
  #capabilityRefreshInFlight?: Promise<void>;
  #shutdownPromise?: Promise<void>;
  #stopped = false;

  constructor(
    runtime: ClientRuntime,
    components: {
      admission: AdmissionController;
      bindingStore: SessionBindingStore;
      custody: TurnCustodyOwner;
      credentialEnvironment: ImCredentialEnvironmentManager;
      reconciler: SessionReconciler;
      sessionMessageInbox: SessionMessageInbox;
      reportOwner: TurnReportOwner;
      durabilityMetrics: RuntimeDurabilityMetrics;
      runner: AgentTurnRunner;
      runtimeManager: SessionRuntimeManager;
      workspace: AgentWorkspaceManager;
      refreshCapability: () => Promise<void>;
      capabilityRefreshIntervalMs: number;
      capabilityAbort: AbortController;
      providerCliReconciler?: { close(): Promise<void>; refreshPublishedImCliReadiness(): Promise<void> };
      providerCliTurnPlans?: { recover(): Promise<void> };
    },
  ) {
    this.#runtime = runtime;
    this.#admission = components.admission;
    this.#providerCliReconciler = components.providerCliReconciler;
    this.#providerCliTurnPlans = components.providerCliTurnPlans;
    this.bindingStore = components.bindingStore;
    this.custody = components.custody;
    this.credentialEnvironment = components.credentialEnvironment;
    this.reconciler = components.reconciler;
    this.sessionMessageInbox = components.sessionMessageInbox;
    this.reportOwner = components.reportOwner;
    this.durabilityMetrics = components.durabilityMetrics;
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
      await this.#shutdown();
    }
  }

  /**
   * Authoritative protected-work snapshot for the automatic-upgrade gate. The Session module owns
   * the bounded lifetime of every counted unit (Turn budgets, delivery deadlines, report retries
   * with terminal outcomes), so a caller may wait on `total === 0` indefinitely without adding a
   * force timeout of its own.
   */
  protectedWork(): ProtectedWorkSnapshot {
    const reconcilerWork = this.reconciler.protectedWorkSnapshot();
    const snapshot = {
      sessionActivities: reconcilerWork.activities.length,
      pendingRecoveries: reconcilerWork.recoveries.length,
      custodyTurns: this.custody.liveTurnCount,
      activeTurns: this.runner.activeCount,
      pendingReports: this.reportOwner.pendingCount,
      queuedSessionMessages: this.sessionMessageInbox.pendingCount,
      total: 0,
    };
    snapshot.total =
      snapshot.sessionActivities +
      snapshot.pendingRecoveries +
      snapshot.custodyTurns +
      snapshot.activeTurns +
      snapshot.pendingReports +
      snapshot.queuedSessionMessages;
    return snapshot;
  }

  /**
   * Close admission before the updater reads its zero-work snapshot. Already accepted Session
   * messages may still reserve capacity and drain; every new direct or Session delivery receives a
   * retryable `client_busy` result. The returned release function is used only when the attempt is
   * abandoned or fails — a successful install stays quiesced until supervisor handoff.
   */
  quiesceForUpdate(): () => void {
    this.#admission.pause();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#admission.resume();
    };
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const shutdown = this.#shutdown();
    this.#runtime.stop();
    /* v8 ignore next -- shutdown failures surface through runtime state, not this detached promise. */
    void shutdown.catch(() => undefined);
  }

  #shutdown(): Promise<void> {
    this.#stopped = true;
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    this.#stopCapabilityMonitor();
    this.#capabilityAbort.abort(new Error("Client Runtime stopped"));
    this.sessionMessageInbox.stop();
    this.runner.stop();
    await Promise.all([
      this.#capabilityRefreshInFlight?.catch(() => undefined),
      this.runner.settled(),
      this.sessionMessageInbox.settled(),
    ]);
    try {
      await this.runtimeManager.close();
    } finally {
      this.reportOwner.stop();
      await this.reportOwner.settled();
      await this.credentialEnvironment.close();
      // Recovery may remove PATH sentinels, so it must run only after all Runs
      // and Agent Runtime processes have stopped using their launch bin.
      await this.#providerCliTurnPlans?.recover();
      await this.#providerCliReconciler?.close();
    }
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
          void this.#providerCliReconciler?.refreshPublishedImCliReadiness().catch(() => undefined);
          /* v8 ignore else -- only the newest refresh clears the in-flight slot. */
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
  // The packaged Context Tree skills invoke `context-tree` by name, so the shim directory has to
  // win the PATH lookup. This belongs to composition rather than the per-Session workspace
  // environment: a Session-level PATH would replace the value the factory composes, including the
  // discovered executable directory that lets `codex` and `claude` resolve at all.
  const contextTreeBin = resolveOpenTagHomeLayout(options.home).contextTreeBin;
  const withContextTreeOnPath = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    prependPath(environment, contextTreeBin);
  const codexEnvironment = withContextTreeOnPath(
    codexAgentRuntimeEnvironment({ ...sourceEnvironment, CODEX_HOME: codexHome }),
  );
  const canonicalDefaultClaudeCodeHome = await realpath(defaultClaudeCodeHome).catch(() => defaultClaudeCodeHome);
  const claudeCodeEnvironment = withContextTreeOnPath(
    claudeCodeProcessEnvironment(sourceEnvironment, claudeCodeHome, canonicalDefaultClaudeCodeHome),
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
  const providerProbeDeadlineMs = providerProbeDeadline(options.providerProbeDeadlineMs);
  const sharedProviderRefreshes = new Map<string, SharedProviderRefresh>();
  const liveSharedProviderRefresh = (providerId: string): SharedProviderRefresh | undefined => {
    const owner = sharedProviderRefreshes.get(providerId);
    if (!owner || owner.settled || owner.controller.signal.aborted) return undefined;
    return owner;
  };
  const refreshProviderReadiness = async (providerId: string, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    readinessSignal.throwIfAborted();
    const owner =
      liveSharedProviderRefresh(providerId) ??
      startSharedProviderRefresh(
        { connection, providers, readinessSignal, providerProbeDeadlineMs, sharedProviderRefreshes },
        providerId,
      );
    owner.waiters += 1;
    try {
      return await waitForSharedRefresh(owner.promise, signal);
    } finally {
      owner.waiters -= 1;
      if (owner.waiters === 0 && !owner.settled) {
        /* v8 ignore else -- the shared map still holds this owner while its last waiter unwinds. */
        if (sharedProviderRefreshes.get(providerId) === owner) sharedProviderRefreshes.delete(providerId);
        owner.controller.abort(new Error(`Agent Runtime provider probe has no waiters: ${providerId}`));
      }
    }
  };
  const refreshCapability = async (): Promise<void> => {
    const results = await Promise.allSettled([
      ...providers.providerIds().map((providerId) => refreshProviderReadiness(providerId)),
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
  const contextTree = new ContextTreeManager({
    codexHome,
    home: options.home,
    logger: moduleLogger("context-tree"),
  });
  const durabilityStore =
    options.durabilityStore ??
    (options.serverDurability
      ? new ServerRuntimeDurabilityStore(options.serverDurability)
      : new FileRuntimeDurabilityStore(options.home));
  const durabilityMetrics = options.durabilityMetrics ?? new RuntimeDurabilityMetrics();
  const reportOwner = new TurnReportOwner({
    connection,
    metrics: durabilityMetrics,
    persistence: durabilityStore,
  });
  const credentialEnvironment = new ImCredentialEnvironmentManager({
    connection,
    home: options.home,
    logger: moduleLogger("im-credential-environment"),
  });
  const providerCliReconciler = new ProviderCliReconciler({
    connection,
    manager: new ProviderCliManager({ accountHome: resolveAccountHome() }),
    signal: readinessSignal,
    validation: new ProviderCliValidationRunner({ home: options.home }),
  });
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const providerCliTurnPlans = new ProviderCliTurnPlanManager({
    accountHome: resolveAccountHome(),
    openTagHome: options.home,
    readySelection: providerCliReconciler.readySelectionForRun.bind(providerCliReconciler),
    runnerInvocation: resolveProviderCliTurnRunnerInvocation(),
  });
  await providerCliTurnPlans.recover();
  const proofManager = new SessionCliProofManager(options.home);
  const runtimeManager = new SessionRuntimeManager({
    bindingStore,
    cliCommand: options.cliCommand ?? "opentag",
    cleanupProviderEnvironment: (sessionId) => credentialEnvironment.cleanup(sessionId),
    contextTree,
    ensureProviderReady,
    home: options.home,
    providers,
    providerEnvironmentPath: (sessionId) => credentialEnvironment.pathForSession(sessionId),
    providerCliLaunchPath: (sessionId) => providerCliTurnPlans.sessionDir(sessionId),
    inheritedPath: sourceEnvironment.PATH,
    slackConfigWritableRoot: (sessionId) => credentialEnvironment.activeSlackConfigDirForSession(sessionId),
    proofManager,
    workspace,
  });
  const reconciler = new SessionReconciler({
    installationId: connection.installationId,
    preparation: runtimeManager,
    localPolicy: runtimeManager,
  });
  const admission = new AdmissionController();
  const sessionMessageInbox = new SessionMessageInbox({
    admission,
    cliCommand: options.cliCommand ?? "opentag",
    credentialEnvironment,
    imCredentialGrantVersion: connection.capabilityVersion.bind(connection, RUNTIME_CAPABILITY.imCredentialGrant),
    metrics: durabilityMetrics,
    persistence: durabilityStore,
    reconciler,
    runtimeManager,
    turnPlan: providerCliTurnPlans,
  });
  await Promise.all([reportOwner.ready(), sessionMessageInbox.ready()]);
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
    turnPlan: providerCliTurnPlans,
  });
  const availabilityTester = new AgentRuntimeAvailabilityTester({
    factories: new Map(factories.map((factory) => [factory.manifest.providerId, factory])),
  });
  const runtime = new ClientRuntime(connection, {
    logger: moduleLogger("client-runtime"),
    reconciler,
    handleSessionMessageDelivery: sessionMessageInbox.accept.bind(sessionMessageInbox),
    availabilityTester,
    ...createClientRuntimeHandlers(custody, reportOwner, mvpReportRecovery),
  });
  return new ComposedClientRuntime(runtime, {
    admission,
    bindingStore,
    custody,
    credentialEnvironment,
    sessionMessageInbox,
    reconciler,
    reportOwner,
    durabilityMetrics,
    runner,
    runtimeManager,
    workspace,
    refreshCapability,
    providerCliReconciler,
    providerCliTurnPlans,
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

export interface ResolvedCodexFactoryOptions {
  readonly clientVersion: string;
  readonly codexHome: string;
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly discovery?: ResolveAgentRuntimeExecutableOptions;
  readonly createCandidateFactory?: (command: string, environment: NodeJS.ProcessEnv) => CodexAgentRuntimeFactory;
}

/**
 * Claude Code treats a set CLAUDE_CONFIG_DIR as a distinct credential record, even when the
 * value equals its own default. Omit the variable only when the resolved home is that default.
 * Exported so the CLI probes the same environment the daemon runs in.
 */
export function claudeCodeProcessEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  claudeCodeHome: string,
  defaultClaudeCodeHome: string,
): NodeJS.ProcessEnv {
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

function prependPath(
  environment: NodeJS.ProcessEnv,
  directory: string,
  pathDelimiter: string = delimiter,
): NodeJS.ProcessEnv {
  const current = environment.PATH;
  if (!current) return { ...environment, PATH: directory };
  if (current === directory || current.startsWith(`${directory}${pathDelimiter}`)) return environment;
  return { ...environment, PATH: `${directory}${pathDelimiter}${current}` };
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

interface ResolvedFactoryProbeOptions<TFactory extends AgentRuntimeFactory> {
  readonly provider: AgentRuntimeProvider;
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly discovery?: ResolveAgentRuntimeExecutableOptions;
  readonly createCandidate: (command: string, environment: NodeJS.ProcessEnv) => TFactory;
  readonly artifactMessage: string;
  readonly onReady: (factory: TFactory) => void;
}

async function probeResolvedFactory<TFactory extends AgentRuntimeFactory>(
  request: AgentRuntimeProbeRequest,
  options: ResolvedFactoryProbeOptions<TFactory>,
): Promise<AgentRuntimeProbeResult> {
  request.signal?.throwIfAborted();
  let lastBinaryResult: AgentRuntimeProbeResult | undefined;
  const candidates = iterateAgentRuntimeExecutables(
    options.provider,
    options.command,
    options.sourceEnvironment,
    options.discovery,
  );
  while (true) {
    const candidateStep = await nextExecutableCandidate(candidates, request.signal, options.artifactMessage);
    if ("result" in candidateStep) return candidateStep.result;
    if (candidateStep.step.done) break;
    request.signal?.throwIfAborted();
    const environment = withSearchBinOnPath(
      options.environment,
      candidateStep.step.value,
      options.discovery?.pathDelimiter ?? delimiter,
    );
    const candidate = options.createCandidate(candidateStep.step.value.path, environment);
    const result = await candidate.probe(request);
    if (result.ready) {
      options.onReady(candidate);
      return result;
    }
    if (!canAdvanceRuntimeCandidate(result)) return result;
    lastBinaryResult = result;
  }
  return lastBinaryResult ?? { ready: false, issues: [{ code: "artifact_missing", message: options.artifactMessage }] };
}

async function nextExecutableCandidate(
  candidates: AsyncGenerator<ResolvedAgentRuntimeExecutable>,
  signal: AbortSignal | undefined,
  artifactMessage: string,
): Promise<
  { readonly step: IteratorResult<ResolvedAgentRuntimeExecutable> } | { readonly result: AgentRuntimeProbeResult }
> {
  try {
    return { step: await candidates.next() };
  } catch (error) {
    return { result: translateExecutableDiscoveryError(error, signal, artifactMessage) };
  }
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
    probe: (request) =>
      probeResolvedFactory(request, {
        provider: "codex",
        command: options.command,
        environment: options.environment,
        sourceEnvironment: options.sourceEnvironment,
        discovery: options.discovery,
        createCandidate,
        artifactMessage: "Codex CLI could not be executed",
        onReady: (factory) => {
          readyFactory = factory;
        },
      }),
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
    probe: (request) =>
      probeResolvedFactory(request, {
        provider: "claude-code",
        command: options.command,
        environment: options.environment,
        sourceEnvironment: options.sourceEnvironment,
        discovery: options.discovery,
        createCandidate,
        artifactMessage: "Claude Code CLI could not be executed",
        onReady: (factory) => {
          readyFactory = factory;
        },
      }),
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
