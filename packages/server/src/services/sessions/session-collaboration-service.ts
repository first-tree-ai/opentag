import { randomUUID } from "node:crypto";
import {
  type ClientRuntimeBusinessFrame,
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  type SessionCollaborationCommandResult,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
  type SessionReconcileResult,
} from "@opentag/shared";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { type RuntimeDomainOwner, RuntimeDomainRequestError } from "../../runtime/runtime-domain-owner.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../runtime-config/index.js";
import type { SessionMessageAttempt, SessionMessageOutcome, SessionService } from "./session-service.js";

type CollaborationCommand = Extract<
  ClientRuntimeBusinessFrame,
  { type: "session:internal:create" | "session:message" }
>;

interface LocalAttempt {
  attemptCount: number;
  commandRequestId: string;
  computerId: string;
  workspaceComputerId: string;
  instanceId: string;
  messageId: string;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionCollaborationServiceOptions {
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  domain: Pick<RuntimeDomainOwner, "requestReconcile" | "requestSessionMessageDelivery">;
  registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability">;
  sessions: Pick<
    SessionService,
    "authorizeAndRecordMessage" | "createInternalSessionWithMessage" | "recordMessageOutcome"
  >;
  onDiagnostic?: (code: string) => void;
  localResultTimeoutMs?: number;
}

export class SessionCollaborationService {
  readonly #assembler: SessionCollaborationServiceOptions["assembler"];
  readonly #domain: SessionCollaborationServiceOptions["domain"];
  readonly #registry: SessionCollaborationServiceOptions["registry"];
  readonly #sessions: SessionCollaborationServiceOptions["sessions"];
  readonly #localResultTimeoutMs: number;
  readonly #onDiagnostic: SessionCollaborationServiceOptions["onDiagnostic"];
  readonly #localAttempts = new Map<string, LocalAttempt>();

  constructor(options: SessionCollaborationServiceOptions) {
    this.#assembler = options.assembler;
    this.#domain = options.domain;
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#onDiagnostic = options.onDiagnostic;
    this.#localResultTimeoutMs = options.localResultTimeoutMs ?? 30_000;
  }

  async handle(
    command: CollaborationCommand,
    context: RuntimeBusinessContext,
  ): Promise<SessionCollaborationCommandResult> {
    const messageId = command.type === "session:internal:create" ? command.initialMessage.messageId : command.messageId;
    if (context.negotiatedCapabilities?.[RUNTIME_CAPABILITY.sessionCollaboration] === undefined) {
      return result(command.requestId, messageId, "rejected", { code: "configuration_unsupported" });
    }

    try {
      let attempt: SessionMessageAttempt;
      let sessionId: string;
      if (command.type === "session:internal:create") {
        const created = await this.#sessions.createInternalSessionWithMessage({
          creatorSessionId: command.sourceSessionId,
          creatorComputerId: context.computerId,
          creatorWorkspaceComputerId: context.workspaceComputerId,
          creatorPlacementGeneration: command.sourcePlacementGeneration,
          messageId,
          initialMessage: command.initialMessage.text,
          overrides: command.overrides,
        });
        attempt = created;
        sessionId = created.session.id;
      } else {
        attempt = await this.#sessions.authorizeAndRecordMessage({
          messageId,
          sourceSessionId: command.sourceSessionId,
          sourceComputerId: context.computerId,
          sourceWorkspaceComputerId: context.workspaceComputerId,
          sourcePlacementGeneration: command.sourcePlacementGeneration,
          targetSessionId: command.targetSessionId,
          content: command.content.text,
        });
        sessionId = attempt.route.targetSessionId;
      }
      if (attempt.attemptCount === null) {
        return result(command.requestId, messageId, attempt.message.lastOutcome, {
          sessionId,
          ...(attempt.message.lastErrorCode ? { code: attempt.message.lastErrorCode } : {}),
        });
      }
      let runtime: EffectiveRuntimeSnapshot;
      try {
        runtime = await this.#assembler.assembleForSession(attempt.route.targetSessionId);
      } catch {
        return this.#recordOutcome(
          result(command.requestId, messageId, "unreachable", { sessionId, code: "runtime_not_ready" }),
          attempt.attemptCount,
        );
      }
      return await this.#deliver(command, attempt, runtime, context, sessionId);
    } catch (error) {
      const mapped = mapFailure(error);
      if (mapped.status === "rejected") {
        this.#onDiagnostic?.(`SESSION_COLLABORATION_${mapped.code.toUpperCase()}`);
      }
      return result(command.requestId, messageId, mapped.status, { code: mapped.code });
    }
  }

  async handleLocalDeliveryResult(
    delivery: SessionMessageDeliveryResult,
    context: RuntimeBusinessContext,
  ): Promise<SessionCollaborationCommandResult | undefined> {
    const pending = this.#localAttempts.get(delivery.requestId);
    if (
      !pending ||
      pending.messageId !== delivery.messageId ||
      pending.sessionId !== delivery.targetSessionId ||
      pending.computerId !== context.computerId ||
      pending.workspaceComputerId !== context.workspaceComputerId ||
      pending.instanceId !== context.instanceId
    ) {
      return undefined;
    }
    this.#localAttempts.delete(delivery.requestId);
    clearTimeout(pending.timer);
    const visible = mapDeliveryResult(pending.commandRequestId, delivery, pending.sessionId);
    return this.#recordOutcome(visible, pending.attemptCount);
  }

  async #deliver(
    command: CollaborationCommand,
    attempt: SessionMessageAttempt,
    runtime: EffectiveRuntimeSnapshot,
    context: RuntimeBusinessContext,
    sessionId: string,
  ): Promise<SessionCollaborationCommandResult> {
    const { route } = attempt;
    const attemptCount = attempt.attemptCount;
    if (attemptCount === null) throw new Error("A deduplicated Session message cannot be delivered again");
    const targetInstanceId = this.#registry.currentInstanceId(route.targetWorkspaceComputerId);
    if (
      !targetInstanceId ||
      !this.#registry.supportsCapability(
        route.targetWorkspaceComputerId,
        targetInstanceId,
        RUNTIME_CAPABILITY.sessionCollaboration,
      )
    ) {
      return this.#recordOutcome(
        result(command.requestId, attempt.message.id, "unreachable", { sessionId, code: "runtime_unavailable" }),
        attemptCount,
      );
    }

    let reconciled: SessionReconcileResult;
    try {
      reconciled = await this.#domain.requestReconcile(route.targetWorkspaceComputerId, targetInstanceId, {
        type: "session:reconcile",
        requestId: randomUUID(),
        computerId: route.targetComputerId,
        sessionId: route.targetSessionId,
        agentId: route.agentId,
        placementGeneration: route.targetPlacementGeneration,
        ...(route.targetSessionKind === "internal" ? { sessionKind: "internal" as const } : {}),
        desired: "ready",
        runtime,
      });
    } catch {
      return this.#recordOutcome(
        result(command.requestId, attempt.message.id, "unreachable", { sessionId, code: "runtime_not_ready" }),
        attemptCount,
      );
    }
    if (!new Set(["ready", "running", "reporting"]).has(reconciled.status)) {
      return this.#recordOutcome(
        result(command.requestId, attempt.message.id, "unreachable", { sessionId, code: "runtime_not_ready" }),
        attemptCount,
      );
    }

    const delivery: SessionMessageDeliveryRequest = {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: attempt.message.id,
      sourceSessionId: route.sourceSessionId,
      targetSessionId: route.targetSessionId,
      agentId: route.agentId,
      placementGeneration: route.targetPlacementGeneration,
      content: { kind: "text", text: attempt.message.content },
      runtime,
    };
    if (route.targetWorkspaceComputerId === context.workspaceComputerId && targetInstanceId === context.instanceId) {
      this.#rememberLocal(delivery.requestId, {
        attemptCount,
        commandRequestId: command.requestId,
        computerId: context.computerId,
        workspaceComputerId: context.workspaceComputerId,
        instanceId: context.instanceId,
        messageId: attempt.message.id,
        sessionId,
      });
      return result(command.requestId, attempt.message.id, "local", { sessionId, delivery });
    }

    try {
      const delivered = await this.#domain.requestSessionMessageDelivery(
        route.targetWorkspaceComputerId,
        targetInstanceId,
        delivery,
      );
      return this.#recordOutcome(mapDeliveryResult(command.requestId, delivered, sessionId), attemptCount);
    } catch (error) {
      const unknown = error instanceof RuntimeDomainRequestError && error.code === "timeout";
      return this.#recordOutcome(
        result(command.requestId, attempt.message.id, unknown ? "unknown" : "unreachable", {
          sessionId,
          code: unknown ? "delivery_timeout" : "runtime_unavailable",
        }),
        attemptCount,
      );
    }
  }

  async #recordOutcome(
    visible: SessionCollaborationCommandResult,
    attemptCount: number,
  ): Promise<SessionCollaborationCommandResult> {
    if (visible.status === "local") return visible;
    try {
      const updated = await this.#sessions.recordMessageOutcome({
        messageId: visible.messageId,
        attemptCount,
        outcome: visible.status as SessionMessageOutcome,
        ...(visible.code ? { errorCode: visible.code } : {}),
      });
      if (updated) return visible;
    } catch {
      // The durable fact remains unknown and is never replayed automatically.
    }
    return result(visible.requestId, visible.messageId, "unknown", {
      ...(visible.sessionId ? { sessionId: visible.sessionId } : {}),
      code: "outcome_write_failed",
    });
  }

  #rememberLocal(requestId: string, input: Omit<LocalAttempt, "timer">): void {
    const timer = setTimeout(() => this.#localAttempts.delete(requestId), this.#localResultTimeoutMs);
    timer.unref();
    this.#localAttempts.set(requestId, { ...input, timer });
  }
}

function mapDeliveryResult(
  requestId: string,
  delivery: SessionMessageDeliveryResult,
  sessionId: string,
): SessionCollaborationCommandResult {
  if (delivery.status === "accepted") return result(requestId, delivery.messageId, "accepted", { sessionId });
  if (delivery.reason === "session_busy" || delivery.reason === "agent_busy" || delivery.reason === "client_busy") {
    return result(requestId, delivery.messageId, "unreachable", { sessionId, code: "capacity" });
  }
  if (
    delivery.reason === "stale_generation" ||
    delivery.reason === "session_not_ready" ||
    delivery.reason === "stale_configuration" ||
    delivery.reason === "session_recovery_required"
  ) {
    return result(requestId, delivery.messageId, "unreachable", { sessionId, code: "runtime_not_ready" });
  }
  return result(requestId, delivery.messageId, "rejected", {
    sessionId,
    code: delivery.reason ?? "target_unavailable",
  });
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

function result(
  requestId: string,
  messageId: string,
  status: SessionCollaborationCommandResult["status"],
  fields: Pick<SessionCollaborationCommandResult, "code" | "delivery" | "sessionId"> = {},
): SessionCollaborationCommandResult {
  return {
    type: "session:collaboration:result",
    requestId,
    messageId,
    status,
    ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
    ...(fields.code ? { code: fields.code } : {}),
    ...(fields.delivery ? { delivery: fields.delivery } : {}),
  };
}
