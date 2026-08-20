import type {
  EffectiveRuntimeSnapshot,
  InputRejectReason,
  RuntimeSnapshotHashes,
  SessionReconcileRequest,
} from "@opentag/shared";
import type { AgentRuntime, AgentRuntimeEventSink } from "../agent-runtime/types.js";
import type { AgentRuntimeProviderRegistry } from "./agent-runtime-provider-registry.js";
import type { AgentWorkspaceManager } from "./agent-workspace.js";
import type { RuntimeToolHost } from "./runtime-tool-host.js";
import type { LocalSessionBinding, SessionBindingStore, SessionPreparationResult } from "./session-binding-store.js";
import type { RuntimeLocalPolicy, RuntimePreparation } from "./session-reconciler.js";

interface ManagedSessionRuntime {
  readonly agentId: string;
  readonly cwd: string;
  readonly effectiveSnapshotHash: string;
  readonly providerId: string;
  readonly snapshot: EffectiveRuntimeSnapshot;
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
  readonly providers: AgentRuntimeProviderRegistry;
  readonly readinessSignal?: AbortSignal;
  readonly toolHost: RuntimeToolHost;
  readonly workspace: AgentWorkspaceManager;
}

export class SessionRuntimeManager implements RuntimePreparation, RuntimeLocalPolicy {
  readonly #bindingStore: SessionBindingStore;
  readonly #providers: AgentRuntimeProviderRegistry;
  readonly #readinessSignal?: AbortSignal;
  readonly #toolHost: RuntimeToolHost;
  readonly #workspace: AgentWorkspaceManager;
  readonly #sessions = new Map<string, ManagedSessionRuntime>();
  readonly #prepares = new Set<Promise<SessionPreparationResult>>();
  readonly #starts = new Set<Promise<AgentRuntime>>();
  readonly #closeFailures: unknown[] = [];
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(options: SessionRuntimeManagerOptions) {
    this.#bindingStore = options.bindingStore;
    this.#providers = options.providers;
    this.#readinessSignal = options.readinessSignal;
    this.#toolHost = options.toolHost;
    this.#workspace = options.workspace;
  }

  validate(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
    return this.#providers.validateConfiguration(snapshot);
  }

  prepareAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void> {
    return this.#workspace.prepareAgent(snapshot, hashes);
  }

  verifyAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void> {
    return this.#workspace.verifyAgent(snapshot, hashes);
  }

  prepareSession(request: SessionReconcileRequest, hashes: RuntimeSnapshotHashes): Promise<SessionPreparationResult> {
    this.#assertOpen();
    const operation = this.#prepareSession(request, hashes);
    this.#prepares.add(operation);
    void operation.finally(() => this.#prepares.delete(operation)).catch(() => undefined);
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

    const current = this.#sessions.get(request.sessionId);
    if (
      current &&
      current.effectiveSnapshotHash === hashes.effectiveSnapshotHash &&
      current.providerId === snapshot.provider
    ) {
      current.binding = prepared.binding;
      if (current.runtime?.state.phase === "closed") current.runtime = undefined;
      return prepared;
    }
    if (current) {
      this.#sessions.delete(request.sessionId);
      try {
        await this.#closeManaged(current);
      } catch (error) {
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
      providerId: snapshot.provider,
      snapshot,
    });
    return prepared;
  }

  async ensureRuntime(sessionId: string, signal?: AbortSignal): Promise<AgentRuntime> {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed) throw new Error("The Session Agent Runtime has not been prepared");
    await this.#providers.ensureReady(managed.providerId, combineSignals(this.#readinessSignal, signal));
    this.#assertOpen();
    if (managed.runtime && managed.runtime.state.phase !== "closed") return managed.runtime;
    if (managed.start) return waitForStart(managed.start, signal);

    const start = this.#startRuntime(managed).finally(() => {
      if (managed.start === start) managed.start = undefined;
      this.#starts.delete(start);
    });
    managed.start = start;
    this.#starts.add(start);
    void start.catch(() => undefined);
    return waitForStart(start, signal);
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
    const common = {
      eventSink,
      hostedTools: this.#toolHost.hostedTools(managed.snapshot.allowedTools),
      workspace: { cwd: managed.cwd, writableRoots: [managed.cwd] },
      policy: provider.policy(managed.snapshot),
      configuration: {
        ...(managed.snapshot.model ? { model: managed.snapshot.model } : {}),
        ...(managed.snapshot.reasoningEffort ? { reasoningEffort: managed.snapshot.reasoningEffort } : {}),
      },
    } as const;
    let runtime: AgentRuntime | undefined;
    try {
      try {
        runtime = managed.binding.runtimeBinding
          ? await provider.factory.resume({ ...common, binding: managed.binding.runtimeBinding })
          : await provider.factory.create(common);
      } catch (error) {
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
          if (this.#closing) this.#closeFailures.push(closeError);
          else throw new AggregateError([error, closeError], "Agent Runtime creation and cleanup both failed");
        }
      }
      throw error;
    }
  }

  async stopSession(sessionId: string, placementGeneration: number): Promise<void> {
    const current = this.#sessions.get(sessionId);
    if (current) {
      this.#sessions.delete(sessionId);
      await this.#closeManaged(current);
    }
    await this.#workspace.stopSession(sessionId, placementGeneration);
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
      const results = await Promise.allSettled(sessions.map((session) => this.#closeManaged(session)));
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
    if (start) await start.catch(() => undefined);
    if (!managed.runtime || managed.runtime.state.phase === "closed") return;
    await managed.runtime.close();
    managed.runtime = undefined;
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error("The Session Runtime manager is closing");
  }
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal | undefined): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  return AbortSignal.any([first, second]);
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
