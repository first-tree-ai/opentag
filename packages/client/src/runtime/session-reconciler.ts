import {
  computeReconcilePayloadHash,
  computeRuntimeSnapshotHashes,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type InputRejectReason,
  type RuntimeSnapshotHashes,
  type SessionReconcileRequest,
  SessionReconcileRequestSchema,
  type SessionReconcileResult,
} from "@opentag/shared";

export type SessionActivityPhase = "running" | "reporting";

export interface SessionTurnIdentity {
  deliveryId: string;
  turnId: string;
}

export interface SessionActivity extends SessionTurnIdentity {
  phase: SessionActivityPhase;
}

export interface RuntimePreparation {
  prepareAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void>;
  verifyAgent?(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void>;
  prepareSession(
    request: SessionReconcileRequest,
    hashes: RuntimeSnapshotHashes,
  ): Promise<{ unresolvedTurn?: SessionTurnIdentity } | undefined>;
  stopSession(sessionId: string, placementGeneration: number): Promise<void>;
}

export interface RuntimeLocalPolicy {
  validate(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined;
}

export interface SessionReconcilerOptions {
  computerId: string;
  localPolicy?: RuntimeLocalPolicy;
  maxRememberedRequests?: number;
  preparation?: RuntimePreparation;
}

export interface AgentRuntimeState extends RuntimeSnapshotHashes {
  agentId: string;
  provider: string;
  revisionId: string;
  revisionSequence: number;
  workspaceId: string;
}

export interface SessionRuntimeState extends RuntimeSnapshotHashes {
  agentId: string;
  placementGeneration: number;
  provider: string;
  revisionId: string;
  revisionSequence: number;
  sessionId: string;
  status: "ready" | "stopped";
  workspaceId: string;
}

interface RememberedReconcile {
  payloadHash: string;
  result: Promise<SessionReconcileResult>;
}

const noopPreparation: RuntimePreparation = {
  prepareAgent: async () => undefined,
  prepareSession: async () => undefined,
  stopSession: async () => undefined,
};

export class SessionReconciler {
  readonly #computerId: string;
  readonly #preparation: RuntimePreparation;
  readonly #localPolicy?: RuntimeLocalPolicy;
  readonly #maxRememberedRequests: number;
  readonly #agents = new Map<string, AgentRuntimeState>();
  readonly #sessions = new Map<string, SessionRuntimeState>();
  readonly #activities = new Map<string, SessionActivity>();
  readonly #recoveries = new Map<string, SessionTurnIdentity>();
  readonly #requests = new Map<string, RememberedReconcile>();
  readonly #agentTails = new Map<string, Promise<void>>();

  constructor(options: SessionReconcilerOptions) {
    this.#computerId = options.computerId;
    this.#preparation = options.preparation ?? noopPreparation;
    this.#localPolicy = options.localPolicy;
    this.#maxRememberedRequests = options.maxRememberedRequests ?? 256;
    if (!Number.isSafeInteger(this.#maxRememberedRequests) || this.#maxRememberedRequests < 1) {
      throw new Error("maxRememberedRequests must be a positive safe integer");
    }
  }

  getAgent(agentId: string): AgentRuntimeState | undefined {
    return this.#agents.get(agentId);
  }

  getSession(sessionId: string): SessionRuntimeState | undefined {
    return this.#sessions.get(sessionId);
  }

  setActivity(sessionId: string, activity: SessionActivity): void {
    this.#activities.set(sessionId, activity);
    this.#recoveries.delete(sessionId);
  }

  clearActivity(sessionId: string, turnId: string): boolean {
    const current = this.#activities.get(sessionId);
    if (!current || current.turnId !== turnId) return false;
    return this.#activities.delete(sessionId);
  }

  setRecovery(sessionId: string, turn: SessionTurnIdentity): void {
    if (!this.#activities.has(sessionId)) this.#recoveries.set(sessionId, turn);
  }

  clearRecovery(sessionId: string, turnId: string): boolean {
    const current = this.#recoveries.get(sessionId);
    if (!current || current.turnId !== turnId) return false;
    return this.#recoveries.delete(sessionId);
  }

  claimRecovery(sessionId: string, turn: SessionTurnIdentity): boolean {
    if (this.#activities.has(sessionId)) return false;
    const current = this.#recoveries.get(sessionId);
    if (current) return current.turnId === turn.turnId && current.deliveryId === turn.deliveryId;
    this.#recoveries.set(sessionId, turn);
    return true;
  }

  reconcile(input: SessionReconcileRequest): Promise<SessionReconcileResult> {
    const request = SessionReconcileRequestSchema.parse(input);
    const payloadHash = computeReconcilePayloadHash(request);
    const remembered = this.#requests.get(request.requestId);
    if (remembered) {
      if (remembered.payloadHash === payloadHash) return remembered.result;
      return Promise.resolve(this.#result(request, "rejected", "request_conflict"));
    }

    const result = this.withAgentLock(request.agentId, () => this.#reconcileLocked(request));
    this.#requests.set(request.requestId, { payloadHash, result });
    this.#trimRequests();
    return result;
  }

  checkDelivery(input: DirectImMessageDeliveryRequest): InputRejectReason | undefined {
    if (input.agentId !== input.runtime.agentId) return "target_mismatch";
    const session = this.#sessions.get(input.sessionId);
    if (session?.status !== "ready") return "session_not_ready";
    if (session.agentId !== input.agentId) return "target_mismatch";
    if (input.placementGeneration < session.placementGeneration) return "stale_generation";
    if (input.placementGeneration > session.placementGeneration) return "session_not_ready";
    if (this.#recoveries.has(input.sessionId)) return "session_recovery_required";

    const agent = this.#agents.get(input.agentId);
    if (!agent) return "session_not_ready";
    const hashes = computeRuntimeSnapshotHashes(input.runtime);
    if (
      agent.provider !== input.runtime.provider ||
      agent.workspaceId !== input.runtime.workspace.workspaceId ||
      session.provider !== input.runtime.provider ||
      session.workspaceId !== input.runtime.workspace.workspaceId
    ) {
      return "session_binding_conflict";
    }
    if (
      input.runtime.revision.agent.sequence < agent.revisionSequence ||
      input.runtime.revision.session.sequence < session.revisionSequence
    ) {
      return "stale_configuration";
    }
    if (
      input.runtime.revision.agent.sequence > agent.revisionSequence ||
      input.runtime.revision.session.sequence > session.revisionSequence
    ) {
      return "session_not_ready";
    }
    if (
      input.runtime.revision.agent.id !== agent.revisionId ||
      input.runtime.revision.session.id !== session.revisionId ||
      hashes.agentConfigHash !== agent.agentConfigHash ||
      hashes.sessionConfigHash !== session.sessionConfigHash ||
      hashes.effectiveSnapshotHash !== session.effectiveSnapshotHash
    ) {
      return "session_binding_conflict";
    }
    return this.#localPolicy?.validate(input.runtime);
  }

  async withAgentLock<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#agentTails.get(agentId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#agentTails.set(agentId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release?.();
      if (this.#agentTails.get(agentId) === tail) this.#agentTails.delete(agentId);
    }
  }

  async #reconcileLocked(request: SessionReconcileRequest): Promise<SessionReconcileResult> {
    if (request.computerId !== this.#computerId) return this.#result(request, "rejected", "target_mismatch");

    const existingSession = this.#sessions.get(request.sessionId);
    if (existingSession && request.placementGeneration < existingSession.placementGeneration) {
      return this.#result(request, "rejected", "stale_generation");
    }
    if (existingSession && existingSession.agentId !== request.agentId) {
      return this.#result(request, "rejected", "session_binding_conflict");
    }
    const activity = this.#activities.get(request.sessionId);
    if (activity) {
      if (
        request.desired === "stopped" ||
        !existingSession ||
        request.placementGeneration !== existingSession.placementGeneration
      ) {
        return this.#result(request, "busy", "active_turn");
      }
      const snapshot = request.runtime;
      const existingAgent = this.#agents.get(request.agentId);
      if (!snapshot || !existingAgent) return this.#result(request, "busy", "active_turn");
      const hashes = computeRuntimeSnapshotHashes(snapshot);
      const agentComparison = compareRevision(
        snapshot.revision.agent.sequence,
        snapshot.revision.agent.id,
        hashes.agentConfigHash,
        existingAgent.revisionSequence,
        existingAgent.revisionId,
        existingAgent.agentConfigHash,
      );
      if (agentComparison === "stale") return this.#result(request, "rejected", "stale_configuration");
      if (agentComparison === "conflict") return this.#result(request, "rejected", "configuration_conflict");
      if (agentComparison === "newer") return this.#result(request, "busy", "agent_configuration_busy");
      const sessionComparison = compareRevision(
        snapshot.revision.session.sequence,
        snapshot.revision.session.id,
        hashes.sessionConfigHash,
        existingSession.revisionSequence,
        existingSession.revisionId,
        existingSession.sessionConfigHash,
      );
      if (sessionComparison === "stale") return this.#result(request, "rejected", "stale_configuration");
      if (sessionComparison === "conflict") return this.#result(request, "rejected", "configuration_conflict");
      if (sessionComparison === "newer") return this.#result(request, "busy", "active_turn");
      const status = activity.phase === "running" ? "running" : "reporting";
      return { ...this.#result(request, status), turn: { turnId: activity.turnId, deliveryId: activity.deliveryId } };
    }
    const recovery = this.#recoveries.get(request.sessionId);
    if (recovery) {
      return { ...this.#result(request, "recovery_required", "unresolved_turn"), turn: recovery };
    }

    if (request.desired === "stopped") {
      await this.#preparation.stopSession(request.sessionId, request.placementGeneration);
      if (existingSession) {
        this.#sessions.set(request.sessionId, {
          ...existingSession,
          placementGeneration: request.placementGeneration,
          status: "stopped",
        });
      }
      return this.#result(request, "stopped");
    }

    const snapshot = request.runtime;
    if (!snapshot) return this.#result(request, "rejected", "runtime_missing");
    const policyReason = this.#localPolicy?.validate(snapshot);
    if (policyReason) return this.#result(request, "rejected", policyReason);
    const hashes = computeRuntimeSnapshotHashes(snapshot);
    const existingAgent = this.#agents.get(request.agentId);

    const agentConflict =
      existingAgent &&
      (existingAgent.provider !== snapshot.provider || existingAgent.workspaceId !== snapshot.workspace.workspaceId);
    if (agentConflict) return this.#result(request, "rejected", "session_binding_conflict");

    if (existingAgent) {
      const comparison = compareRevision(
        snapshot.revision.agent.sequence,
        snapshot.revision.agent.id,
        hashes.agentConfigHash,
        existingAgent.revisionSequence,
        existingAgent.revisionId,
        existingAgent.agentConfigHash,
      );
      if (comparison === "stale") return this.#result(request, "rejected", "stale_configuration");
      if (comparison === "conflict") return this.#result(request, "rejected", "configuration_conflict");
      if (comparison === "newer" && this.#agentIsActive(request.agentId)) {
        return this.#result(request, "busy", "agent_configuration_busy");
      }
    }

    if (existingSession && request.placementGeneration === existingSession.placementGeneration) {
      const comparison = compareRevision(
        snapshot.revision.session.sequence,
        snapshot.revision.session.id,
        hashes.sessionConfigHash,
        existingSession.revisionSequence,
        existingSession.revisionId,
        existingSession.sessionConfigHash,
      );
      if (comparison === "stale") return this.#result(request, "rejected", "stale_configuration");
      if (comparison === "conflict") return this.#result(request, "rejected", "configuration_conflict");
    }

    const shouldPrepareAgent = !existingAgent || snapshot.revision.agent.sequence > existingAgent.revisionSequence;
    const shouldPrepareSession =
      !existingSession ||
      request.placementGeneration > existingSession.placementGeneration ||
      snapshot.revision.session.sequence > existingSession.revisionSequence ||
      existingSession.status === "stopped";
    if (shouldPrepareAgent) await this.#preparation.prepareAgent(snapshot, hashes);
    else await this.#preparation.verifyAgent?.(snapshot, hashes);
    const preparedSession = shouldPrepareSession ? await this.#preparation.prepareSession(request, hashes) : undefined;

    if (shouldPrepareAgent) {
      this.#agents.set(request.agentId, {
        ...hashes,
        agentId: request.agentId,
        provider: snapshot.provider,
        revisionId: snapshot.revision.agent.id,
        revisionSequence: snapshot.revision.agent.sequence,
        workspaceId: snapshot.workspace.workspaceId,
      });
    }
    this.#sessions.set(request.sessionId, {
      ...hashes,
      agentId: request.agentId,
      placementGeneration: request.placementGeneration,
      provider: snapshot.provider,
      revisionId: snapshot.revision.session.id,
      revisionSequence: snapshot.revision.session.sequence,
      sessionId: request.sessionId,
      status: "ready",
      workspaceId: snapshot.workspace.workspaceId,
    });
    if (preparedSession?.unresolvedTurn) {
      const recovery = {
        deliveryId: preparedSession.unresolvedTurn.deliveryId,
        turnId: preparedSession.unresolvedTurn.turnId,
      };
      this.setRecovery(request.sessionId, recovery);
      return {
        ...this.#result(request, "recovery_required", "unresolved_turn"),
        turn: recovery,
      };
    }
    return this.#result(request, "ready");
  }

  #result(
    request: SessionReconcileRequest,
    status: SessionReconcileResult["status"],
    reason?: string,
  ): SessionReconcileResult {
    return {
      type: "session:reconcile:result",
      requestId: request.requestId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      status,
      ...(reason ? { reason } : {}),
    };
  }

  #agentIsActive(agentId: string): boolean {
    for (const sessionId of this.#activities.keys()) {
      if (this.#sessions.get(sessionId)?.agentId === agentId) return true;
    }
    return false;
  }

  #trimRequests(): void {
    while (this.#requests.size > this.#maxRememberedRequests) {
      const oldest = this.#requests.keys().next().value;
      if (oldest === undefined) break;
      this.#requests.delete(oldest);
    }
  }
}

type RevisionComparison = "same" | "newer" | "stale" | "conflict";

function compareRevision(
  incomingSequence: number,
  incomingId: string,
  incomingHash: string,
  currentSequence: number,
  currentId: string,
  currentHash: string,
): RevisionComparison {
  if (incomingSequence < currentSequence) return "stale";
  if (incomingSequence > currentSequence) return "newer";
  return incomingId === currentId && incomingHash === currentHash ? "same" : "conflict";
}
