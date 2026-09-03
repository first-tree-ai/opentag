import { delimiter } from "node:path";
import type {
  EffectiveRuntimeSnapshot,
  InputRejectReason,
  RuntimeSnapshotHashes,
  SessionReconcileRequest,
} from "@opentag/shared";
import type { AgentRuntime, AgentRuntimeEventSink } from "../agent-runtime/types.js";
import { createLogger } from "../observability/logger.js";
import type { AgentRuntimeProviderRegistry } from "./agent-runtime-provider-registry.js";
import type { AgentWorkspaceManager } from "./agent-workspace.js";
import type { ContextTreeManager, ContextTreeStatus } from "./context-tree.js";
import { renderManagedSystemPrompt } from "./managed-instructions.js";
import type { LocalSessionBinding, SessionBindingStore, SessionPreparationResult } from "./session-binding-store.js";
import type { SessionCliProofManager } from "./session-cli-proof-manager.js";
import type { RuntimeLocalPolicy, RuntimePreparation } from "./session-reconciler.js";

const logger = createLogger("runtime-session-manager");

interface ManagedSessionRuntime {
  readonly agentId: string;
  readonly cwd: string;
  readonly effectiveSnapshotHash: string;
  readonly providerId: string;
  readonly snapshot: EffectiveRuntimeSnapshot;
  readonly sessionKind: "visible" | "internal";
  readonly creatorSessionId?: string;
  proofId?: string;
  proofPath?: string;
  readonly placementGeneration: number;
  binding: LocalSessionBinding;
  eventSink?: AgentRuntimeEventSink;
  runtime?: AgentRuntime;
  start?: Promise<AgentRuntime>;
}

export class ClientRuntimeProviderStartError extends Error {
  constructor(
    readonly providerId: string,
    options?: ErrorOptions,
  ) {
    const detail = options?.cause instanceof Error ? `: ${options.cause.message}` : "";
    super(`Agent Runtime provider failed to start (${providerId})${detail}`, options);
    this.name = "ClientRuntimeProviderStartError";
  }
}

export interface SessionRuntimeManagerOptions {
  readonly bindingStore: SessionBindingStore;
  readonly cliCommand?: string;
  readonly cleanupProviderEnvironment?: (sessionId: string) => Promise<void>;
  readonly contextTree?: Pick<ContextTreeManager, "ensureAgent">;
  readonly ensureProviderReady: (providerId: string, signal?: AbortSignal) => Promise<void>;
  readonly providers: AgentRuntimeProviderRegistry;
  readonly home?: string;
  readonly providerEnvironmentPath: (sessionId: string) => string;
  readonly proofManager?: Pick<SessionCliProofManager, "cleanup" | "materialize">;
  /**
   * Optional. Visible Sessions may receive the currently active Slack config leaf as one extra
   * writable root. Internal Sessions and Feishu must return undefined. Leave unset when unused.
   */
  readonly slackConfigWritableRoot?: (sessionId: string) => string | undefined;
  /** Absolute Session launch-bin directory prepended to the Agent Runtime PATH. Visible only. */
  readonly providerCliLaunchPath?: (sessionId: string) => string | undefined;
  /** Inherited PATH after the launch bin. Tests may override; production uses process.env.PATH. */
  readonly inheritedPath?: string;
  readonly workspace: AgentWorkspaceManager;
}

export class SessionRuntimeManager implements RuntimePreparation, RuntimeLocalPolicy {
  readonly #bindingStore: SessionBindingStore;
  readonly #cliCommand: string;
  readonly #cleanupProviderEnvironment?: SessionRuntimeManagerOptions["cleanupProviderEnvironment"];
  readonly #contextTree?: SessionRuntimeManagerOptions["contextTree"];
  readonly #ensureProviderReady: SessionRuntimeManagerOptions["ensureProviderReady"];
  readonly #providers: AgentRuntimeProviderRegistry;
  readonly #home: string;
  readonly #providerEnvironmentPath: SessionRuntimeManagerOptions["providerEnvironmentPath"];
  readonly #proofManager: Pick<SessionCliProofManager, "cleanup" | "materialize">;
  readonly #slackConfigWritableRoot?: SessionRuntimeManagerOptions["slackConfigWritableRoot"];
  readonly #providerCliLaunchPath?: SessionRuntimeManagerOptions["providerCliLaunchPath"];
  readonly #inheritedPath: string | undefined;
  readonly #workspace: AgentWorkspaceManager;
  readonly #sessions = new Map<string, ManagedSessionRuntime>();
  readonly #prepares = new Set<Promise<SessionPreparationResult>>();
  readonly #starts = new Set<Promise<AgentRuntime>>();
  readonly #closeFailures: unknown[] = [];
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(options: SessionRuntimeManagerOptions) {
    this.#bindingStore = options.bindingStore;
    this.#cliCommand = options.cliCommand ?? "opentag";
    this.#cleanupProviderEnvironment = options.cleanupProviderEnvironment;
    if (options.contextTree) this.#contextTree = options.contextTree;
    this.#ensureProviderReady = options.ensureProviderReady;
    this.#providers = options.providers;
    this.#home = options.home ?? "";
    this.#providerEnvironmentPath = options.providerEnvironmentPath;
    this.#slackConfigWritableRoot = options.slackConfigWritableRoot;
    this.#providerCliLaunchPath = options.providerCliLaunchPath;
    this.#inheritedPath = options.inheritedPath ?? process.env.PATH;
    this.#proofManager =
      options.proofManager ??
      ({
        cleanup: async () => undefined,
        materialize: async () => {
          throw new Error("Session CLI proof manager is unavailable");
        },
      } satisfies Pick<SessionCliProofManager, "cleanup" | "materialize">);
    this.#workspace = options.workspace;
  }

  validate(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
    return this.#providers.validateConfiguration(snapshot);
  }

  validateDelivery(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
    return this.#providers.validateConfiguration(snapshot);
  }

  prepareAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void> {
    return this.#workspace.prepareAgent(snapshot, hashes);
  }

  verifyAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void> {
    return this.#workspace.verifyAgent(snapshot, hashes);
  }

  requiresSessionPreparation(request: SessionReconcileRequest): boolean {
    const current = this.#sessions.get(request.sessionId);
    if (!current) return false;
    return current.proofId !== request.sessionCliProof?.proofId;
  }

  prepareSession(request: SessionReconcileRequest, hashes: RuntimeSnapshotHashes): Promise<SessionPreparationResult> {
    this.#assertOpen();
    const operation = this.#prepareSession(request, hashes);
    this.#prepares.add(operation);
    void operation
      .finally(() => this.#prepares.delete(operation))
      .catch((error: unknown) => {
        logger.debug({ code: "session_prepare_failed", error: String(error) }, "Session preparation failed");
      });
    return operation;
  }

  async #prepareSession(
    request: SessionReconcileRequest,
    hashes: RuntimeSnapshotHashes,
  ): Promise<SessionPreparationResult> {
    const prepared = await this.#workspace.prepareSession(request, hashes);
    this.#assertOpen();
    if (prepared.unresolvedTurn) return prepared;
    const snapshot = request.runtime;
    if (!snapshot) throw new Error("A ready Session requires a runtime snapshot");
    if (!this.#providers.registration(snapshot.provider)) {
      throw new Error(`Agent Runtime provider is not registered: ${snapshot.provider}`);
    }
    const proofPath = request.sessionCliProof
      ? await this.#proofManager.materialize(request.sessionId, request.sessionCliProof)
      : undefined;

    const current = this.#sessions.get(request.sessionId);
    if (
      current &&
      current.effectiveSnapshotHash === hashes.effectiveSnapshotHash &&
      current.providerId === snapshot.provider &&
      current.placementGeneration === request.placementGeneration &&
      current.sessionKind === (request.sessionKind ?? "visible")
    ) {
      current.binding = prepared.binding;
      current.proofId = request.sessionCliProof?.proofId;
      current.proofPath = proofPath;
      if (current.runtime?.state.phase === "closed") current.runtime = undefined;
      return prepared;
    }
    if (current) {
      this.#sessions.delete(request.sessionId);
      try {
        await this.#closeManaged(current);
      } catch (error) {
        logger.debug(
          { code: "managed_runtime_close_failed", error: String(error) },
          "Managed Session Runtime close failed",
        );
        /* v8 ignore else -- close failures outside shutdown propagate without being collected. */
        if (this.#closing) this.#closeFailures.push(error);
        throw error;
      }
      this.#assertOpen();
    }

    const cwd = await this.#workspace.cwd(request.agentId);
    this.#assertOpen();
    this.#sessions.set(request.sessionId, {
      agentId: request.agentId,
      binding: prepared.binding,
      cwd,
      effectiveSnapshotHash: hashes.effectiveSnapshotHash,
      ...(request.creatorSessionId ? { creatorSessionId: request.creatorSessionId } : {}),
      ...(request.sessionCliProof ? { proofId: request.sessionCliProof.proofId } : {}),
      ...(proofPath ? { proofPath } : {}),
      providerId: snapshot.provider,
      sessionKind: request.sessionKind ?? "visible",
      placementGeneration: request.placementGeneration,
      snapshot,
    });
    return prepared;
  }

  async ensureRuntime(sessionId: string, signal?: AbortSignal): Promise<AgentRuntime> {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed) throw new Error("The Session Agent Runtime has not been prepared");
    await this.#ensureProviderReady(managed.providerId, signal);
    this.#assertOpen();
    if (managed.runtime && managed.runtime.state.phase !== "closed") return managed.runtime;
    if (managed.start) return waitForStart(managed.start, signal);

    const start = this.#startRuntime(managed).finally(() => {
      /* v8 ignore else -- only the owning start clears its own slot. */
      if (managed.start === start) managed.start = undefined;
      this.#starts.delete(start);
    });
    managed.start = start;
    this.#starts.add(start);
    void start.catch((error: unknown) => {
      logger.debug({ code: "runtime_start_failed", error: String(error) }, "Session Runtime start failed");
    });
    return waitForStart(start, signal);
  }

  sessionKind(sessionId: string): "visible" | "internal" {
    const managed = this.#sessions.get(sessionId);
    if (!managed) throw new Error("The Session Agent Runtime has not been prepared");
    return managed.sessionKind;
  }

  async #startRuntime(managed: ManagedSessionRuntime): Promise<AgentRuntime> {
    const provider = this.#providers.registration(managed.providerId);
    /* v8 ignore next -- registrations are immutable for the lifetime of a managed Session. */
    if (!provider) throw new Error(`Agent Runtime provider is not registered: ${managed.providerId}`);
    let bindingPersisted = false;
    const eventSink: AgentRuntimeEventSink = async (event) => {
      if (event.type === "binding_changed") {
        this.#assertOpen();
        const binding = await this.#bindingStore.saveRuntimeBinding(
          managed.agentId,
          managed.binding.sessionId,
          managed.effectiveSnapshotHash,
          event.binding,
        );
        if (!binding) throw new Error("The durable Session binding disappeared");
        managed.binding = binding;
        bindingPersisted = true;
        this.#assertOpen();
      }
      await managed.eventSink?.(event);
    };
    // Context Tree is prepared here rather than in workspace preparation because `verifyAgent`
    // runs on every Turn admission, and this runs once per Provider Runtime start. The manager
    // caches per workspace, revalidates that entry against the Computer's recorded target, and
    // never throws, so a failure only changes what the prompt reports.
    const contextTree = await prepareContextTree(this.#contextTree, managed.cwd);
    const common = {
      eventSink,
      systemPrompt: renderManagedSystemPrompt(managed.snapshot, {
        sessionId: managed.binding.sessionId,
        sessionKind: managed.sessionKind,
        ...(managed.creatorSessionId ? { creatorSessionId: managed.creatorSessionId } : {}),
        cliCommand: this.#cliCommand,
        sessionCliAvailable: Boolean(managed.proofPath),
        ...contextTree.promptContext,
      }),
      workspace: {
        cwd: managed.cwd,
        environment: {
          ...(this.#home ? { OPENTAG_HOME: this.#home } : {}),
          ...(managed.proofPath ? { OPENTAG_SESSION_PROOF_FILE: managed.proofPath } : {}),
          ...(managed.sessionKind === "visible"
            ? {
                OPENTAG_PROVIDER_ENV_FILE: this.#providerEnvironmentPath(managed.binding.sessionId),
                ...visibleProviderCliPath(managed.binding.sessionId, this.#providerCliLaunchPath, this.#inheritedPath),
              }
            : {}),
        },
        writableRoots: [
          ...visibleSlackWritableRoots(
            managed.sessionKind,
            managed.cwd,
            managed.binding.sessionId,
            this.#slackConfigWritableRoot,
          ),
          ...contextTree.writableRoots,
        ],
      },
      policy: provider.policy(managed.snapshot),
      configuration: {
        ...(managed.snapshot.model ? { model: managed.snapshot.model } : {}),
        ...(managed.snapshot.reasoningEffort ? { reasoningEffort: managed.snapshot.reasoningEffort } : {}),
      },
    } as const;
    let runtime: AgentRuntime | undefined;
    try {
      try {
        const runtimeBinding = managed.binding.runtimeBinding;
        const replaceBinding =
          runtimeBinding && provider.requiresBindingReplacement?.(runtimeBinding, undefined) === true;
        runtime =
          runtimeBinding && !replaceBinding
            ? await provider.factory.resume({ ...common, binding: runtimeBinding })
            : await provider.factory.create(common);
      } catch (error) {
        logger.debug(
          {
            code: "provider_start_failed",
            providerId: managed.providerId,
            error: String(error),
          },
          "Session provider Runtime start failed",
        );
        throw new ClientRuntimeProviderStartError(managed.providerId, { cause: error });
      }
      this.#assertOpen();
      if (!runtime.binding) {
        throw new ClientRuntimeProviderStartError(managed.providerId, {
          cause: new Error("Agent Runtime did not produce a durable binding"),
        });
      }
      if (!bindingPersisted) {
        const binding = await this.#bindingStore.saveRuntimeBinding(
          managed.agentId,
          managed.binding.sessionId,
          managed.effectiveSnapshotHash,
          runtime.binding,
        );
        if (!binding) throw new Error("The durable Session binding disappeared");
        managed.binding = binding;
      }
      this.#assertOpen();
      managed.runtime = runtime;
      return runtime;
    } catch (error) {
      if (runtime) {
        try {
          await runtime.close();
        } catch (closeError) {
          logger.debug(
            { code: "runtime_cleanup_failed", error: String(closeError) },
            "Session Runtime cleanup after start failure failed",
          );
          if (this.#closing) this.#closeFailures.push(closeError);
          else throw new AggregateError([error, closeError], "Agent Runtime creation and cleanup both failed");
        }
      }
      throw error;
    }
  }

  async stopSession(sessionId: string, placementGeneration: number): Promise<void> {
    const sessionKind = this.#sessions.get(sessionId)?.sessionKind;
    try {
      const current = this.#sessions.get(sessionId);
      if (current) {
        this.#sessions.delete(sessionId);
        await this.#closeManaged(current);
      }
      await this.#workspace.stopSession(sessionId, placementGeneration);
    } finally {
      await this.#proofManager.cleanup(sessionId);
      /* v8 ignore else -- internal sessions have no provider environment to clean up. */
      if (sessionKind !== "internal") {
        await this.#cleanupProviderEnvironment?.(sessionId);
      }
    }
  }

  runtime(sessionId: string): AgentRuntime {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed?.runtime || managed.runtime.state.phase === "closed") {
      throw new Error("The Session Agent Runtime is not ready");
    }
    return managed.runtime;
  }

  cwd(sessionId: string): string {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed) throw new Error("The Session Agent Runtime has not been prepared");
    return managed.cwd;
  }

  observe(sessionId: string, sink: AgentRuntimeEventSink): () => void {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed?.runtime || managed.runtime.state.phase === "closed") {
      throw new Error("The Session Agent Runtime is not ready");
    }
    if (managed.eventSink) throw new Error("The Session Agent Runtime already has an active observer");
    managed.eventSink = sink;
    return () => {
      if (managed.eventSink === sink) managed.eventSink = undefined;
    };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#prepares, ...this.#starts]);
      const sessions = [...this.#sessions.values()];
      this.#sessions.clear();
      const results = await Promise.allSettled(
        sessions.map(async (session) => {
          try {
            await this.#closeManaged(session);
          } finally {
            await this.#proofManager.cleanup(session.binding.sessionId);
          }
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") this.#closeFailures.push(result.reason);
      }
      if (this.#closeFailures.length > 0) {
        throw new AggregateError(this.#closeFailures, "One or more Agent Runtimes failed to close");
      }
    })();
    return this.#closePromise;
  }

  async #closeManaged(managed: ManagedSessionRuntime): Promise<void> {
    const start = managed.start;
    if (start)
      await start.catch((error: unknown) => {
        logger.debug(
          { code: "pending_runtime_start_failed", error: String(error) },
          "Pending Session Runtime start failed",
        );
      });
    if (!managed.runtime || managed.runtime.state.phase === "closed") return;
    await managed.runtime.close();
    managed.runtime = undefined;
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error("The Session Runtime manager is closing");
  }
}

function visibleProviderCliPath(
  sessionId: string,
  resolveLaunchPath: ((sessionId: string) => string | undefined) | undefined,
  inheritedPath: string | undefined,
  pathDelimiter = delimiter,
): { PATH: string } | Record<string, never> {
  const launchPath = resolveLaunchPath?.(sessionId);
  if (!launchPath) return {};
  if (!inheritedPath) return { PATH: launchPath };
  if (inheritedPath === launchPath || inheritedPath.startsWith(`${launchPath}${pathDelimiter}`)) {
    return { PATH: inheritedPath };
  }
  return { PATH: `${launchPath}${pathDelimiter}${inheritedPath}` };
}

/**
 * Resolve Context Tree for one Agent Workspace into the two things a Provider Runtime needs.
 *
 * The shared tree lives outside the Workspace, so a workspace-write Provider such as Codex cannot
 * write to it unless it is named as a writable root. Optional memory: an absent or unavailable
 * tree yields no roots and only changes what the prompt reports.
 */
async function prepareContextTree(
  manager: Pick<ContextTreeManager, "ensureAgent"> | undefined,
  cwd: string,
): Promise<{ promptContext: { contextTree?: ContextTreeStatus }; writableRoots: readonly string[] }> {
  const status = await manager?.ensureAgent(cwd);
  if (!status) return { promptContext: {}, writableRoots: [] };
  return {
    promptContext: { contextTree: status },
    writableRoots: status.status === "ready" ? [status.treePath] : [],
  };
}

function visibleSlackWritableRoots(
  sessionKind: "visible" | "internal",
  cwd: string,
  sessionId: string,
  resolveSlackConfig?: (sessionId: string) => string | undefined,
): readonly string[] {
  if (sessionKind !== "visible" || !resolveSlackConfig) return [cwd];
  const configDir = resolveSlackConfig(sessionId);
  if (!configDir) return [cwd];
  return [cwd, configDir];
}

async function waitForStart(start: Promise<AgentRuntime>, signal?: AbortSignal): Promise<AgentRuntime> {
  if (!signal) return start;
  signal.throwIfAborted();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const runtime = await Promise.race([start, aborted]);
    signal.throwIfAborted();
    return runtime;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
