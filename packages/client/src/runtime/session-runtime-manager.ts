import {
  type EffectiveRuntimeSnapshot,
  type InputRejectReason,
  OPENTAG_MESSAGE_TOOLS,
  type RuntimeSnapshotHashes,
  type SessionReconcileRequest,
} from "@opentag/shared";
import type {
  AgentRuntime,
  AgentRuntimeEventSink,
  AgentRuntimeFactory,
  AgentRuntimePolicy,
} from "../agent-runtime/types.js";
import type { AgentWorkspaceManager } from "./agent-workspace.js";
import type { RuntimeToolHost } from "./runtime-tool-host.js";
import type { SessionBindingStore, SessionPreparationResult } from "./session-binding-store.js";
import type { RuntimeLocalPolicy, RuntimePreparation } from "./session-reconciler.js";

const OPENTAG_TOOL_SET: ReadonlySet<string> = new Set(OPENTAG_MESSAGE_TOOLS);

interface ManagedSessionRuntime {
  readonly agentId: string;
  readonly cwd: string;
  readonly effectiveSnapshotHash: string;
  readonly providerId: string;
  readonly runtime: AgentRuntime;
  eventSink?: AgentRuntimeEventSink;
}

export interface SessionRuntimeManagerOptions {
  readonly bindingStore: SessionBindingStore;
  readonly factories: ReadonlyMap<string, AgentRuntimeFactory>;
  readonly providerAvailable?: () => boolean;
  readonly toolHost: RuntimeToolHost;
  readonly workspace: AgentWorkspaceManager;
}

export class SessionRuntimeManager implements RuntimePreparation, RuntimeLocalPolicy {
  readonly #bindingStore: SessionBindingStore;
  readonly #factories: ReadonlyMap<string, AgentRuntimeFactory>;
  readonly #providerAvailable: () => boolean;
  readonly #toolHost: RuntimeToolHost;
  readonly #workspace: AgentWorkspaceManager;
  readonly #sessions = new Map<string, ManagedSessionRuntime>();
  readonly #prepares = new Set<Promise<SessionPreparationResult>>();
  readonly #closeFailures: unknown[] = [];
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(options: SessionRuntimeManagerOptions) {
    this.#bindingStore = options.bindingStore;
    this.#factories = options.factories;
    this.#providerAvailable = options.providerAvailable ?? (() => true);
    this.#toolHost = options.toolHost;
    this.#workspace = options.workspace;
  }

  validate(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
    if (!this.#factories.has(snapshot.provider)) return "configuration_unsupported";
    if (!this.#providerAvailable()) return "provider_unavailable";
    if (snapshot.execution.approvalPolicy !== "never" || snapshot.execution.networkAccess) {
      return "configuration_unsupported";
    }
    if (snapshot.allowedTools.some((tool) => !OPENTAG_TOOL_SET.has(tool))) return "configuration_unsupported";
    return undefined;
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

    const current = this.#sessions.get(request.sessionId);
    if (
      current &&
      current.effectiveSnapshotHash === hashes.effectiveSnapshotHash &&
      current.providerId === snapshot.provider &&
      current.runtime.state.phase !== "closed"
    ) {
      return prepared;
    }
    if (current) {
      this.#sessions.delete(request.sessionId);
      try {
        await current.runtime.close();
      } catch (error) {
        if (this.#closing) this.#closeFailures.push(error);
        throw error;
      }
      this.#assertOpen();
    }

    const factory = this.#factories.get(snapshot.provider);
    if (!factory) throw new Error(`Agent Runtime provider is unavailable: ${snapshot.provider}`);
    const cwd = await this.#workspace.cwd(request.agentId);
    this.#assertOpen();
    let ready: ManagedSessionRuntime | undefined;
    const eventSink: AgentRuntimeEventSink = async (event) => {
      if (event.type === "binding_changed") {
        this.#assertOpen();
        await this.#bindingStore.saveRuntimeBinding(
          request.agentId,
          request.sessionId,
          hashes.effectiveSnapshotHash,
          event.binding,
        );
        this.#assertOpen();
      }
      await ready?.eventSink?.(event);
    };
    const common = {
      eventSink,
      hostedTools: this.#toolHost.hostedTools(snapshot.allowedTools),
      workspace: { cwd, writableRoots: [cwd] },
      policy: runtimePolicy(snapshot),
      configuration: {
        ...(snapshot.model ? { model: snapshot.model } : {}),
        ...(snapshot.reasoningEffort ? { reasoningEffort: snapshot.reasoningEffort } : {}),
      },
    } as const;
    let runtime: AgentRuntime | undefined;
    try {
      runtime = prepared.binding.runtimeBinding
        ? await factory.resume({ ...common, binding: prepared.binding.runtimeBinding })
        : await factory.create(common);
      this.#assertOpen();
      if (!runtime.binding) throw new Error("Agent Runtime did not produce a durable binding");
      const binding = await this.#bindingStore.saveRuntimeBinding(
        request.agentId,
        request.sessionId,
        hashes.effectiveSnapshotHash,
        runtime.binding,
      );
      this.#assertOpen();
      if (!binding) throw new Error("The durable Session binding disappeared");
      ready = {
        agentId: request.agentId,
        cwd,
        effectiveSnapshotHash: hashes.effectiveSnapshotHash,
        providerId: snapshot.provider,
        runtime,
      };
      this.#sessions.set(request.sessionId, ready);
      return { binding };
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
      await current.runtime.close();
      this.#sessions.delete(sessionId);
    }
    await this.#workspace.stopSession(sessionId, placementGeneration);
  }

  runtime(sessionId: string): AgentRuntime {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed || managed.runtime.state.phase === "closed") {
      throw new Error("The Session Agent Runtime is not ready");
    }
    return managed.runtime;
  }

  cwd(sessionId: string): string {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed) throw new Error("The Session Agent Runtime is not ready");
    return managed.cwd;
  }

  observe(sessionId: string, sink: AgentRuntimeEventSink): () => void {
    this.#assertOpen();
    const managed = this.#sessions.get(sessionId);
    if (!managed) throw new Error("The Session Agent Runtime is not ready");
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
      await Promise.allSettled([...this.#prepares]);
      const sessions = [...this.#sessions.values()];
      this.#sessions.clear();
      const results = await Promise.allSettled(sessions.map((session) => session.runtime.close()));
      for (const result of results) {
        if (result.status === "rejected") this.#closeFailures.push(result.reason);
      }
      if (this.#closeFailures.length > 0) {
        throw new AggregateError(this.#closeFailures, "One or more Agent Runtimes failed to close");
      }
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error("The Session Runtime manager is closing");
  }
}

function runtimePolicy(snapshot: EffectiveRuntimeSnapshot): AgentRuntimePolicy {
  return {
    fileSystem: "workspace-write",
    network: snapshot.execution.networkAccess ? "enabled" : "disabled",
    approvals: "never",
    tools: { mode: "allow-list", names: snapshot.allowedTools },
  };
}
