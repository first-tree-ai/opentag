import {
  computeReconcilePayloadHash,
  computeRuntimeSnapshotHashes,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type InputRejectReason,
  type RuntimeSnapshotHashes,
  type SessionMessageDeliveryRequestV3,
  type SessionReconcileRequest,
  SessionReconcileRequestSchema,
  type SessionReconcileResult,
} from "@opentag/shared";
import { SessionBindingConflictError } from "./session-binding-store.js";

const BINDING_CONFLICT_REASONS: Record<SessionBindingConflictError["code"], string> = {
  conflict: "session_binding_conflict",
  recovery_required: "unresolved_turn",
  stale: "stale_configuration",
};

const RESUME_KEEPS_RETRY = new Set<SessionReconcileResult["status"]>(["running", "recovery_required"]);

export type SessionActivityPhase = "running" | "reporting";

export interface SessionTurnIdentity {
  deliveryId: string;
  turnId: string;
}

export interface SessionActivity extends SessionTurnIdentity {
  phase: SessionActivityPhase;
}

/** Authoritative protected-work snapshot: live Turn activity and unresolved recovered Turns. */
export interface SessionProtectedWorkSnapshot {
  activities: Array<SessionActivity & { sessionId: string }>;
  recoveries: Array<SessionTurnIdentity & { sessionId: string }>;
}

export interface RuntimePreparation {
  validateSession?(request: SessionReconcileRequest, hashes: RuntimeSnapshotHashes): Promise<void>;
  prepareAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void>;
  verifyAgent?(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void>;
  requiresSessionPreparation?(request: SessionReconcileRequest, hashes: RuntimeSnapshotHashes): boolean;
  prepareSession(
    request: SessionReconcileRequest,
    hashes: RuntimeSnapshotHashes,
    options?: { resumeTurnId?: string },
  ): Promise<{ unresolvedTurn?: SessionTurnIdentity } | undefined>;
  stopSession(sessionId: string, placementGeneration: number): Promise<void>;
}

export interface RuntimeLocalPolicy {
  validate(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined;
  validateDelivery?(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined;
}

/**
 * The owner of automatic retries of Turns that a daemon restart interrupted. A ready reconcile of
 * such a Session prepares it around its unresolved Turn and hands the Turn back for the retry.
 */
export interface InterruptedTurnResumer {
  /** True when this unresolved Turn waits for its automatic retry. */
  pending(sessionId: string, turn: SessionTurnIdentity): boolean;
  /**
   * Called under the Agent lock once the Session is prepared. Starts the retry and returns true,
   * or returns false so the Turn falls back to an ordinary recovery report.
   */
  resume(sessionId: string, turn: SessionTurnIdentity): Promise<boolean>;
  /** The retry cannot run (preparation failed or was refused): fall back to recovery reporting. */
  abandon(sessionId: string, turn: SessionTurnIdentity, reason: string): void;
}

export interface SessionReconcilerOptions {
  installationId: string;
  resumer?: InterruptedTurnResumer;
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
  /** The Agent configuration this Session prepared on, which a newer one doesn't replace until it prepares again. */
  agentRevisionId: string;
  agentRevisionSequence: number;
  placementGeneration: number;
  provider: string;
  revisionId: string;
  revisionSequence: number;
  sessionId: string;
  sessionKind: "visible" | "internal";
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

/** Ends an internal Session's accepted work: its running Run, retries and queued messages. */
export interface InternalSessionWorkStopper {
  stopSessionWork(sessionId: string, placementGeneration: number): Promise<void>;
}

export class SessionReconciler {
  readonly #installationId: string;
  readonly #preparation: RuntimePreparation;
  readonly #localPolicy?: RuntimeLocalPolicy;
  #resumer?: InterruptedTurnResumer;
  readonly #maxRememberedRequests: number;
  readonly #agents = new Map<string, AgentRuntimeState>();
  #internalWorkStopper: InternalSessionWorkStopper | undefined;
  readonly #sessions = new Map<string, SessionRuntimeState>();
  readonly #activities = new Map<string, SessionActivity>();
  readonly #recoveries = new Map<string, SessionTurnIdentity>();
  readonly #requests = new Map<string, RememberedReconcile>();
  readonly #agentTails = new Map<string, Promise<void>>();

  constructor(options: SessionReconcilerOptions) {
    this.#installationId = options.installationId;
    this.#preparation = options.preparation ?? noopPreparation;
    this.#localPolicy = options.localPolicy;
    this.#resumer = options.resumer;
    this.#maxRememberedRequests = options.maxRememberedRequests ?? 256;
    if (!Number.isSafeInteger(this.#maxRememberedRequests) || this.#maxRememberedRequests < 1) {
      throw new Error("maxRememberedRequests must be a positive safe integer");
    }
  }

  /** Late binding: the resumer and the reconciler depend on each other. */
  setResumer(resumer: InterruptedTurnResumer): void {
    this.#resumer = resumer;
  }

  /** Late binding: the inbox needs the reconciler before the reconciler can reach the inbox. */
  setInternalWorkStopper(stopper: InternalSessionWorkStopper): void {
    this.#internalWorkStopper = stopper;
  }

  getAgent(agentId: string): AgentRuntimeState | undefined {
    return this.#agents.get(agentId);
  }

  /**
   * The authoritative local record of work whose interruption could lose or duplicate an accepted
   * Turn: live per-Session Turn activity plus unresolved Turns recovered from durable state that
   * still owe the Server a completion report. Accepted-but-undrained Session messages are owned by
   * the Session message inbox, which registers its drains here as activity.
   */
  protectedWorkSnapshot(): SessionProtectedWorkSnapshot {
    return {
      activities: [...this.#activities.entries()].map(([sessionId, activity]) => ({ sessionId, ...activity })),
      recoveries: [...this.#recoveries.entries()].map(([sessionId, turn]) => ({ sessionId, ...turn })),
    };
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

  claimRecovery(sessionId: string, turn: SessionTurnIdentity, options: { reportReady?: boolean } = {}): boolean {
    const activity = this.#activities.get(sessionId);
    if (activity) {
      return (
        options.reportReady === true &&
        activity.phase === "reporting" &&
        activity.turnId === turn.turnId &&
        activity.deliveryId === turn.deliveryId
      );
    }
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

    const result = this.#stopsInternalWork(request)
      ? this.#stopInternalSession(request)
      : this.withAgentLock(request.agentId, () => this.#reconcileLocked(request));
    this.#requests.set(request.requestId, { payloadHash, result });
    this.#trimRequests();
    return result;
  }

  checkDelivery(input: DirectImMessageDeliveryRequest): InputRejectReason | undefined {
    if (input.agentId !== input.runtime.agentId) return "target_mismatch";
    if (this.#sessions.get(input.sessionId)?.sessionKind === "internal") return "target_mismatch";
    return this.#checkRuntimeTarget(input.sessionId, input.agentId, input.placementGeneration, input.runtime);
  }

  checkSessionMessageDelivery(input: SessionMessageDeliveryRequestV3): InputRejectReason | undefined {
    if (input.agentId !== input.runtime.agentId) return "target_mismatch";
    return this.#checkRuntimeTarget(input.targetSessionId, input.agentId, input.placementGeneration, input.runtime);
  }

  #checkRuntimeTarget(
    sessionId: string,
    agentId: string,
    placementGeneration: number,
    runtime: EffectiveRuntimeSnapshot,
  ): InputRejectReason | undefined {
    const session = this.#sessions.get(sessionId);
    if (session?.status !== "ready") return "session_not_ready";
    if (session.agentId !== agentId) return "target_mismatch";
    if (placementGeneration < session.placementGeneration) return "stale_generation";
    if (placementGeneration > session.placementGeneration) return "session_not_ready";
    if (this.#recoveries.has(sessionId)) return "session_recovery_required";

    const agent = this.#agents.get(agentId);
    if (!agent) return "session_not_ready";
    const hashes = computeRuntimeSnapshotHashes(runtime);
    if (
      agent.provider !== runtime.provider ||
      agent.workspaceId !== runtime.workspace.workspaceId ||
      session.provider !== runtime.provider ||
      session.workspaceId !== runtime.workspace.workspaceId
    ) {
      return "session_binding_conflict";
    }
    // Against what this Session prepared: other Sessions may already run a newer Agent configuration.
    if (
      runtime.revision.agent.sequence < session.agentRevisionSequence ||
      runtime.revision.session.sequence < session.revisionSequence
    ) {
      return "stale_configuration";
    }
    if (
      runtime.revision.agent.sequence > session.agentRevisionSequence ||
      runtime.revision.session.sequence > session.revisionSequence
    ) {
      return "session_not_ready";
    }
    if (
      runtime.revision.agent.id !== session.agentRevisionId ||
      runtime.revision.session.id !== session.revisionId ||
      hashes.agentConfigHash !== session.agentConfigHash ||
      hashes.sessionConfigHash !== session.sessionConfigHash ||
      hashes.effectiveSnapshotHash !== session.effectiveSnapshotHash
    ) {
      return "session_binding_conflict";
    }
    return this.#localPolicy?.validateDelivery
      ? this.#localPolicy.validateDelivery(runtime)
      : this.#localPolicy?.validate(runtime);
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

  /**
   * The answer for a Session with an unresolved recovered Turn: `recovery_required`, unless this
   * ready reconcile prepares the Session for that Turn's automatic retry. Undefined otherwise.
   */
  async #recoveryResult(
    request: SessionReconcileRequest,
    resumeTurn: SessionTurnIdentity | undefined,
  ): Promise<SessionReconcileResult | undefined> {
    const recovery = this.#recoveries.get(request.sessionId);
    if (!recovery || resumeTurn) return undefined;
    const pending = this.#resumer?.pending(request.sessionId, recovery) === true;
    // A Turn waiting for its automatic retry is live work, not a Turn that needs recovery reporting.
    if (pending && request.desired !== "ready") return this.#result(request, "busy", "active_turn");
    if (!pending) return { ...this.#result(request, "recovery_required", "unresolved_turn"), turn: recovery };
    const result = await this.#reconcileLocked(request, recovery).catch((error: unknown) => {
      this.#resumer?.abandon(request.sessionId, recovery, "preparation_failed");
      throw error;
    });
    // `recovery_required` after preparation means the resumer could not start the Turn yet: it keeps
    // the pending retry and asks for another reconcile. Anything else ends the retry.
    if (!RESUME_KEEPS_RETRY.has(result.status)) {
      this.#resumer?.abandon(request.sessionId, recovery, result.reason ?? result.status);
    }
    return result;
  }

  /** Under the Agent lock: hand a prepared interrupted Turn to the resumer for its automatic retry. */
  async #resumed(
    sessionId: string,
    unresolved: SessionTurnIdentity,
    resumeTurn: SessionTurnIdentity | undefined,
  ): Promise<boolean> {
    if (!resumeTurn || unresolved.turnId !== resumeTurn.turnId || unresolved.deliveryId !== resumeTurn.deliveryId) {
      return false;
    }
    return (await this.#resumer?.resume(sessionId, unresolved)) === true;
  }

  /**
   * A stop may interrupt an internal Session's work only when the frame could also win the reconcile:
   * a frame for another installation, Agent or an older placement is refused below without side effects.
   * The frame names the kind itself because a restarted daemon has not prepared the Session yet.
   */
  #stopsInternalWork(request: SessionReconcileRequest): boolean {
    if (request.desired !== "stopped" || !this.#internalWorkStopper) return false;
    if (request.installationId !== this.#installationId) return false;
    const existing = this.#sessions.get(request.sessionId);
    if (
      existing &&
      (request.placementGeneration < existing.placementGeneration || existing.agentId !== request.agentId)
    ) {
      return false;
    }
    return request.sessionKind === "internal" || existing?.sessionKind === "internal";
  }

  /**
   * The Run's own cleanup clears its activity under the Agent lock, so the work stops before the lock is
   * taken; the normal stop then finds the Session idle. A message authorized before the Server ended the
   * Session can still arrive in between, so the work is withdrawn again once the stop has been decided.
   */
  async #stopInternalSession(request: SessionReconcileRequest): Promise<SessionReconcileResult> {
    await this.#internalWorkStopper?.stopSessionWork(request.sessionId, request.placementGeneration);
    const result = await this.withAgentLock(request.agentId, () => this.#reconcileLocked(request));
    if (result.status === "stopped") {
      await this.#internalWorkStopper?.stopSessionWork(request.sessionId, request.placementGeneration);
    }
    return result;
  }

  async #reconcileLocked(
    request: SessionReconcileRequest,
    resumeTurn?: SessionTurnIdentity,
  ): Promise<SessionReconcileResult> {
    if (request.installationId !== this.#installationId) return this.#result(request, "rejected", "target_mismatch");

    const existingSession = this.#sessions.get(request.sessionId);
    if (existingSession && request.placementGeneration < existingSession.placementGeneration) {
      return this.#result(request, "rejected", "stale_generation");
    }
    if (existingSession && existingSession.agentId !== request.agentId) {
      return this.#result(request, "rejected", "session_binding_conflict");
    }
    if (
      request.desired === "ready" &&
      existingSession &&
      existingSession.sessionKind !== (request.sessionKind ?? "visible")
    ) {
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
      if (!snapshot) return this.#result(request, "busy", "active_turn");
      const hashes = computeRuntimeSnapshotHashes(snapshot);
      // A running Session finishes on the Agent configuration it started with.
      const agentComparison = compareRevision(
        snapshot.revision.agent.sequence,
        snapshot.revision.agent.id,
        hashes.agentConfigHash,
        existingSession.agentRevisionSequence,
        existingSession.agentRevisionId,
        existingSession.agentConfigHash,
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
    const recovered = await this.#recoveryResult(request, resumeTurn);
    if (recovered) return recovered;

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
      // Other running Sessions don't hold back a newer configuration: they keep what they started with.
      // A resumed Turn does the same, so its pinned configuration may be older than the Agent's latest.
      if (comparison === "stale" && !resumeTurn) return this.#result(request, "rejected", "stale_configuration");
      if (comparison === "conflict") return this.#result(request, "rejected", "configuration_conflict");
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
    // A resumed Turn always follows a restart, so its Session has no prepared entry yet.
    const shouldPrepareSession =
      !existingSession ||
      request.placementGeneration > existingSession.placementGeneration ||
      hashes.effectiveSnapshotHash !== existingSession.effectiveSnapshotHash ||
      existingSession.status === "stopped" ||
      this.#preparation.requiresSessionPreparation?.(request, hashes) === true;
    const prepared = await this.#prepareOrReject(
      request,
      snapshot,
      hashes,
      shouldPrepareAgent,
      shouldPrepareSession,
      resumeTurn,
    );
    if ("rejected" in prepared) return prepared.rejected;
    const preparedSession = prepared.value;

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
      agentRevisionId: snapshot.revision.agent.id,
      agentRevisionSequence: snapshot.revision.agent.sequence,
      provider: snapshot.provider,
      revisionId: snapshot.revision.session.id,
      revisionSequence: snapshot.revision.session.sequence,
      sessionId: request.sessionId,
      sessionKind: existingSession?.sessionKind ?? request.sessionKind ?? "visible",
      status: "ready",
      workspaceId: snapshot.workspace.workspaceId,
    });
    if (preparedSession?.unresolvedTurn) {
      const recovery = {
        deliveryId: preparedSession.unresolvedTurn.deliveryId,
        turnId: preparedSession.unresolvedTurn.turnId,
      };
      if (await this.#resumed(request.sessionId, recovery, resumeTurn)) {
        return { ...this.#result(request, "running"), turn: recovery };
      }
      this.setRecovery(request.sessionId, recovery);
      return {
        ...this.#result(request, "recovery_required", "unresolved_turn"),
        turn: recovery,
      };
    }
    return this.#result(request, "ready");
  }

  async #prepareOrReject(
    request: SessionReconcileRequest,
    snapshot: EffectiveRuntimeSnapshot,
    hashes: RuntimeSnapshotHashes,
    shouldPrepareAgent: boolean,
    shouldPrepareSession: boolean,
    resumeTurn?: SessionTurnIdentity,
  ): Promise<
    { value: Awaited<ReturnType<RuntimePreparation["prepareSession"]>> } | { rejected: SessionReconcileResult }
  > {
    // Validate the durable binding before Agent preparation so a conflict has no side effects.
    const validated = await this.#rejectBindingConflict(request, async () => {
      await this.#preparation.validateSession?.(request, hashes);
    });
    if ("rejected" in validated) return validated;
    if (shouldPrepareAgent) await this.#preparation.prepareAgent(snapshot, hashes);
    else await this.#preparation.verifyAgent?.(snapshot, hashes);
    if (!shouldPrepareSession) return { value: undefined };
    return this.#rejectBindingConflict(request, () =>
      this.#preparation.prepareSession(request, hashes, resumeTurn ? { resumeTurnId: resumeTurn.turnId } : undefined),
    );
  }

  async #rejectBindingConflict<T>(
    request: SessionReconcileRequest,
    operation: () => Promise<T>,
  ): Promise<{ value: T } | { rejected: SessionReconcileResult }> {
    try {
      return { value: await operation() };
    } catch (error) {
      // The durable binding outlives this in-memory state, so after a restart it is the first
      // place a same-sequence conflict is seen. Answer the Server instead of dropping the frame.
      if (!(error instanceof SessionBindingConflictError)) throw error;
      return { rejected: this.#result(request, "rejected", BINDING_CONFLICT_REASONS[error.code]) };
    }
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
