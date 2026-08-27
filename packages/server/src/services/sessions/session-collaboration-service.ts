import { randomUUID } from "node:crypto";
import {
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  type SessionCliCommandResponse,
  type SessionCliCreateRequest,
  type SessionCliSendRequest,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
  type SessionReconcileResult,
} from "@opentag/shared";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { type RuntimeDomainOwner, RuntimeDomainRequestError } from "../../runtime/runtime-domain-owner.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../runtime-config/index.js";
import type { SessionCliSourceContext } from "./session-cli-proof-service.js";
import type { SessionMessageAttempt, SessionMessageOutcome, SessionService } from "./session-service.js";

export interface SessionCollaborationServiceOptions {
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  domain: Pick<RuntimeDomainOwner, "requestReconcile" | "requestSessionMessageDelivery">;
  registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability">;
  sessions: Pick<
    SessionService,
    | "authorizeAndRecordMessage"
    | "createInternalSessionWithMessage"
    | "recordMessageOutcome"
    | "withCollaborationDispatchAdmission"
  >;
  onDiagnostic?: (code: string) => void;
}

export class SessionCollaborationService {
  readonly #assembler: SessionCollaborationServiceOptions["assembler"];
  readonly #domain: SessionCollaborationServiceOptions["domain"];
  readonly #registry: SessionCollaborationServiceOptions["registry"];
  readonly #sessions: SessionCollaborationServiceOptions["sessions"];
  readonly #onDiagnostic: SessionCollaborationServiceOptions["onDiagnostic"];

  constructor(options: SessionCollaborationServiceOptions) {
    this.#assembler = options.assembler;
    this.#domain = options.domain;
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#onDiagnostic = options.onDiagnostic;
  }

  async create(input: SessionCliCreateRequest, source: SessionCliSourceContext): Promise<SessionCliCommandResponse> {
    try {
      const attempt = await this.#sessions.createInternalSessionWithMessage({
        creatorSessionId: source.sessionId,
        creatorComputerId: source.computerId,
        creatorWorkspaceComputerId: source.workspaceComputerId,
        creatorPlacementGeneration: source.placementGeneration,
        messageId: input.messageId,
        initialMessage: input.message,
        overrides: {
          ...(input.model ? { model: input.model } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(input.maxDurationMs ? { maxDurationMs: input.maxDurationMs } : {}),
        },
      });
      return await this.#deliver(attempt, attempt.session.id);
    } catch (error) {
      return this.#failure(input.messageId, error);
    }
  }

  async send(input: SessionCliSendRequest, source: SessionCliSourceContext): Promise<SessionCliCommandResponse> {
    try {
      const attempt = await this.#sessions.authorizeAndRecordMessage({
        messageId: input.messageId,
        sourceSessionId: source.sessionId,
        sourceComputerId: source.computerId,
        sourceWorkspaceComputerId: source.workspaceComputerId,
        sourcePlacementGeneration: source.placementGeneration,
        targetSessionId: input.targetSessionId,
        content: input.message,
      });
      return await this.#deliver(attempt, input.targetSessionId);
    } catch (error) {
      return this.#failure(input.messageId, error);
    }
  }

  async #deliver(attempt: SessionMessageAttempt, sessionId: string): Promise<SessionCliCommandResponse> {
    if (attempt.attemptCount === null) {
      return response(
        attempt.message.id,
        attempt.message.lastOutcome,
        sessionId,
        attempt.message.lastErrorCode ?? undefined,
      );
    }
    let runtime: EffectiveRuntimeSnapshot;
    try {
      runtime = await this.#assembler.assembleForSession(attempt.route.targetSessionId);
    } catch {
      return this.#record(
        response(attempt.message.id, "unreachable", sessionId, "runtime_not_ready"),
        attempt.attemptCount,
      );
    }
    const targetInstanceId = this.#registry.currentInstanceId(attempt.route.targetWorkspaceComputerId);
    if (
      !targetInstanceId ||
      !this.#registry.supportsCapability(
        attempt.route.targetWorkspaceComputerId,
        targetInstanceId,
        RUNTIME_CAPABILITY.sessionCollaboration,
      )
    ) {
      return this.#record(
        response(attempt.message.id, "unreachable", sessionId, "runtime_unavailable"),
        attempt.attemptCount,
      );
    }
    let reconciled: SessionReconcileResult;
    try {
      reconciled = await this.#domain.requestReconcile(
        attempt.route.targetWorkspaceComputerId,
        targetInstanceId,
        {
          type: "session:reconcile",
          requestId: randomUUID(),
          computerId: attempt.route.targetComputerId,
          sessionId: attempt.route.targetSessionId,
          agentId: attempt.route.agentId,
          placementGeneration: attempt.route.targetPlacementGeneration,
          ...(attempt.route.targetSessionKind === "internal"
            ? {
                sessionKind: "internal" as const,
                creatorSessionId: attempt.route.targetCreatorSessionId ?? attempt.route.sourceSessionId,
              }
            : {}),
          desired: "ready",
          runtime,
        },
        undefined,
        (operation) => this.#sessions.withCollaborationDispatchAdmission(attempt.route, operation),
      );
    } catch {
      return this.#record(
        response(attempt.message.id, "unreachable", sessionId, "runtime_not_ready"),
        attempt.attemptCount,
      );
    }
    if (!new Set(["ready", "running", "reporting"]).has(reconciled.status)) {
      return this.#record(
        response(attempt.message.id, "unreachable", sessionId, "runtime_not_ready"),
        attempt.attemptCount,
      );
    }
    const delivery: SessionMessageDeliveryRequest = {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: attempt.message.id,
      sourceSessionId: attempt.route.sourceSessionId,
      targetSessionId: attempt.route.targetSessionId,
      agentId: attempt.route.agentId,
      placementGeneration: attempt.route.targetPlacementGeneration,
      content: { kind: "text", text: attempt.message.content },
      runtime,
    };
    try {
      const delivered = await this.#domain.requestSessionMessageDelivery(
        attempt.route.targetWorkspaceComputerId,
        targetInstanceId,
        delivery,
        undefined,
        (operation) => this.#sessions.withCollaborationDispatchAdmission(attempt.route, operation),
      );
      return this.#record(mapDelivery(delivered, sessionId), attempt.attemptCount);
    } catch (error) {
      const unknown = error instanceof RuntimeDomainRequestError && error.code === "timeout";
      return this.#record(
        response(
          attempt.message.id,
          unknown ? "unknown" : "unreachable",
          sessionId,
          unknown ? "delivery_timeout" : "runtime_unavailable",
        ),
        attempt.attemptCount,
      );
    }
  }

  async #record(result: SessionCliCommandResponse, attemptCount: number): Promise<SessionCliCommandResponse> {
    try {
      const updated = await this.#sessions.recordMessageOutcome({
        messageId: result.messageId,
        attemptCount,
        outcome: result.status as SessionMessageOutcome,
        ...(result.code ? { errorCode: result.code } : {}),
      });
      if (updated) return result;
    } catch {
      // The durable outcome remains unknown; commands never replay automatically.
    }
    return response(result.messageId, "unknown", result.sessionId, "outcome_write_failed");
  }

  #failure(messageId: string, error: unknown): SessionCliCommandResponse {
    const mapped = mapFailure(error);
    if (mapped.status === "rejected") this.#onDiagnostic?.(`SESSION_COLLABORATION_${mapped.code.toUpperCase()}`);
    return response(messageId, mapped.status, undefined, mapped.code);
  }
}

function mapDelivery(delivery: SessionMessageDeliveryResult, sessionId: string): SessionCliCommandResponse {
  if (delivery.status === "accepted") return response(delivery.messageId, "accepted", sessionId);
  if (delivery.reason === "session_busy" || delivery.reason === "agent_busy" || delivery.reason === "client_busy") {
    return response(delivery.messageId, "unreachable", sessionId, "capacity");
  }
  if (
    delivery.reason === "stale_generation" ||
    delivery.reason === "session_not_ready" ||
    delivery.reason === "stale_configuration" ||
    delivery.reason === "session_recovery_required"
  ) {
    return response(delivery.messageId, "unreachable", sessionId, "runtime_not_ready");
  }
  return response(delivery.messageId, "rejected", sessionId, delivery.reason ?? "target_unavailable");
}

function mapFailure(error: unknown): { status: "unreachable" | "rejected"; code: string } {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "SESSION_PLACEMENT_STALE" || code === "SESSION_SOURCE_UNAVAILABLE") {
    return { status: "rejected", code: "source_unavailable" };
  }
  if (code === "SESSION_TARGET_UNAVAILABLE") return { status: "rejected", code: "target_unavailable" };
  if (code === "SESSION_SCOPE_MISMATCH") return { status: "rejected", code: "scope_mismatch" };
  if (code === "SESSION_MESSAGE_CONFLICT") return { status: "rejected", code: "message_conflict" };
  return { status: "unreachable", code: "runtime_unavailable" };
}

function response(
  messageId: string,
  status: SessionCliCommandResponse["status"],
  sessionId?: string,
  code?: string,
): SessionCliCommandResponse {
  return { messageId, status, ...(sessionId ? { sessionId } : {}), ...(code ? { code } : {}) };
}
