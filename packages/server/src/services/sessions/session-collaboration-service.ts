import { randomUUID } from "node:crypto";
import {
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  type RunnerCloudSessionMessageReceivedFrame,
  type SessionCliCommandResponse,
  type SessionCliCreateRequest,
  type SessionCliSendRequest,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
  type SessionReconcileResult,
} from "@opentag/shared";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import {
  type RuntimeDispatchAdmission,
  type RuntimeDomainOwner,
  RuntimeDomainRequestError,
} from "../../runtime/runtime-domain-owner.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../runtime-config/index.js";
import type { SessionCliSourceContext } from "./session-cli-proof-service.js";
import type {
  AuthorizedSessionMessageRoute,
  SessionMessageAttempt,
  SessionMessageOutcome,
  SessionService,
} from "./session-service.js";

/**
 * The Cloud delivery outcome for one Session message attempt. `accepted` means the target
 * Session's Cloud Runner took durable custody of the message (journaled with fsync before its
 * receipt); `rejected` is terminal for this message; `unreachable`/`unknown` keep the existing
 * retry contract. Every Cloud dispatch path resolves one of these; it never throws for a
 * business outcome.
 */
export type CloudSessionMessageOutcome =
  | { status: "accepted" }
  | { status: "rejected"; code: string }
  | { status: "unreachable"; code: string }
  | { status: "unknown"; code: string };

/**
 * The narrow Cloud dispatch surface the collaboration service uses for Cloud-placed targets.
 * Implemented by the Cloud session collaboration owner over the Sandbox allocation, Runner
 * channel fence, and model-grant boundary; the same dispatch admission wraps it as Local.
 */
export interface CloudSessionMessageDispatch {
  deliver(
    input: {
      route: AuthorizedSessionMessageRoute;
      message: { id: string; content: string };
      runtime: EffectiveRuntimeSnapshot;
      /** The durable attempt fencing token from the authorization transaction. */
      attemptCount: number;
    },
    /** The operation returns the Runner's receipt; the admission only fences dispatch authority. */
    admission: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame>,
  ): Promise<CloudSessionMessageOutcome>;
}

export interface SessionCollaborationServiceOptions {
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  domain: Pick<RuntimeDomainOwner, "requestReconcile" | "requestSessionMessageDelivery">;
  registry: Pick<ConnectionRegistry, "capabilityVersion" | "currentInstanceId" | "supportsCapability">;
  sessions: Pick<
    SessionService,
    | "authorizeAndRecordMessage"
    | "createInternalSessionWithMessage"
    | "recordMessageOutcome"
    | "withCollaborationDispatchAdmission"
  >;
  /** E8 Cloud target dispatch; absent means Cloud-placed Sessions cannot be reached here. */
  cloud?: CloudSessionMessageDispatch;
  onDiagnostic?: (code: string) => void;
  logger?: Pick<ServiceLogger, "error">;
}

export class SessionCollaborationService {
  readonly #assembler: SessionCollaborationServiceOptions["assembler"];
  readonly #domain: SessionCollaborationServiceOptions["domain"];
  readonly #registry: SessionCollaborationServiceOptions["registry"];
  readonly #sessions: SessionCollaborationServiceOptions["sessions"];
  readonly #cloud: SessionCollaborationServiceOptions["cloud"];
  readonly #onDiagnostic: SessionCollaborationServiceOptions["onDiagnostic"];
  readonly #logger: SessionCollaborationServiceOptions["logger"];

  constructor(options: SessionCollaborationServiceOptions) {
    this.#assembler = options.assembler;
    this.#domain = options.domain;
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#cloud = options.cloud;
    this.#onDiagnostic = options.onDiagnostic;
    this.#logger = options.logger;
  }

  async create(input: SessionCliCreateRequest, source: SessionCliSourceContext): Promise<SessionCliCommandResponse> {
    try {
      const attempt = await this.#sessions.createInternalSessionWithMessage({
        creatorSessionId: source.sessionId,
        creatorInstallationId: source.installationId,
        creatorConnectionInstanceId: source.connectionInstanceId,
        creatorComputerId: source.computerId,
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
        sourceInstallationId: source.installationId,
        sourceComputerId: source.computerId,
        sourceConnectionInstanceId: source.connectionInstanceId,
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
    const runtime = await this.#assembleTargetRuntime(attempt, sessionId);
    if (!runtime) {
      return this.#record(
        response(attempt.message.id, "unreachable", sessionId, "runtime_not_ready"),
        attempt.attemptCount,
      );
    }
    // Cloud targets execute on their own Session-scoped Sandbox Runner, never on the Local
    // Computer's connection registry; there is no Local reconcile step — the assembled snapshot
    // rides in the dispatch and the allocation/Runner fence is the delivery boundary.
    if (attempt.route.targetComputerKind === "cloud") {
      return this.#deliverCloud(attempt, sessionId, runtime);
    }
    return this.#deliverLocal(attempt, sessionId, runtime, attempt.attemptCount);
  }

  /** Local target dispatch over the existing reconcile + runtime-domain delivery boundaries. */
  async #deliverLocal(
    attempt: SessionMessageAttempt,
    sessionId: string,
    runtime: EffectiveRuntimeSnapshot,
    attemptCount: number,
  ): Promise<SessionCliCommandResponse> {
    const targetInstanceId = this.#registry.currentInstanceId(attempt.route.targetComputerId);
    if (
      !targetInstanceId ||
      !this.#registry.supportsCapability(
        attempt.route.targetComputerId,
        targetInstanceId,
        RUNTIME_CAPABILITY.sessionCollaboration,
      )
    ) {
      return this.#record(response(attempt.message.id, "unreachable", sessionId, "runtime_unavailable"), attemptCount);
    }
    if (
      attempt.route.targetSessionKind !== "internal" &&
      this.#registry.capabilityVersion(
        attempt.route.targetComputerId,
        targetInstanceId,
        RUNTIME_CAPABILITY.imCredentialGrant,
      ) !== 2
    ) {
      return this.#record(response(attempt.message.id, "unreachable", sessionId, "outbox_unavailable"), attemptCount);
    }
    let reconciled: SessionReconcileResult;
    try {
      reconciled = await this.#domain.requestReconcile(
        attempt.route.targetComputerId,
        targetInstanceId,
        {
          type: "session:reconcile",
          requestId: randomUUID(),
          installationId: attempt.route.targetInstallationId,
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
      return this.#record(response(attempt.message.id, "unreachable", sessionId, "runtime_not_ready"), attemptCount);
    }
    if (!new Set(["ready", "running", "reporting"]).has(reconciled.status)) {
      return this.#record(response(attempt.message.id, "unreachable", sessionId, "runtime_not_ready"), attemptCount);
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
        attempt.route.targetComputerId,
        targetInstanceId,
        delivery,
        undefined,
        (operation) => this.#sessions.withCollaborationDispatchAdmission(attempt.route, operation),
      );
      return this.#record(mapDelivery(delivered, sessionId), attemptCount);
    } catch (error) {
      const unknown = error instanceof RuntimeDomainRequestError && error.code === "timeout";
      return this.#record(
        response(
          attempt.message.id,
          unknown ? "unknown" : "unreachable",
          sessionId,
          unknown ? "delivery_timeout" : "runtime_unavailable",
        ),
        attemptCount,
      );
    }
  }

  /** Assemble the target Session's current runtime; a failure is recorded as runtime_not_ready. */
  async #assembleTargetRuntime(
    attempt: SessionMessageAttempt,
    sessionId: string,
  ): Promise<EffectiveRuntimeSnapshot | undefined> {
    try {
      return await this.#assembler.assembleForSession(attempt.route.targetSessionId);
    } catch {
      this.#logInternalFailure("SESSION_COLLABORATION_RUNTIME_ASSEMBLY_FAILED", {
        messageId: attempt.message.id,
        sessionId,
        targetSessionId: attempt.route.targetSessionId,
      });
      return undefined;
    }
  }

  /**
   * Cloud target dispatch. The same durable attempt/admission/outcome boundaries as the Local
   * path; only the transport (allocation + Runner control channel) differs. A deployment without
   * Cloud support answers unreachable instead of pretending the message was delivered.
   */
  async #deliverCloud(
    attempt: SessionMessageAttempt,
    sessionId: string,
    runtime: EffectiveRuntimeSnapshot,
  ): Promise<SessionCliCommandResponse> {
    const attemptCount = attempt.attemptCount;
    if (attemptCount === null) {
      return response(
        attempt.message.id,
        attempt.message.lastOutcome,
        sessionId,
        attempt.message.lastErrorCode ?? undefined,
      );
    }
    const cloud = this.#cloud;
    if (!cloud) {
      return this.#record(response(attempt.message.id, "unreachable", sessionId, "runtime_unavailable"), attemptCount);
    }
    let outcome: CloudSessionMessageOutcome;
    try {
      outcome = await cloud.deliver(
        {
          route: attempt.route,
          message: { id: attempt.message.id, content: attempt.message.content },
          runtime,
          attemptCount,
        },
        (operation) => this.#sessions.withCollaborationDispatchAdmission(attempt.route, operation),
      );
    } catch (error) {
      this.#logInternalFailure("SESSION_COLLABORATION_CLOUD_DISPATCH_FAILED", {
        messageId: attempt.message.id,
        sessionId,
        targetSessionId: attempt.route.targetSessionId,
        code: error instanceof Error && "code" in error ? error.code : undefined,
      });
      return this.#record(response(attempt.message.id, "unreachable", sessionId, "runtime_unavailable"), attemptCount);
    }
    const code = "code" in outcome ? outcome.code : undefined;
    return this.#record(response(attempt.message.id, outcome.status, sessionId, code), attemptCount);
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
    this.#logInternalFailure("SESSION_COLLABORATION_OUTCOME_WRITE_FAILED", {
      attemptCount,
      code: result.code,
      messageId: result.messageId,
      outcome: result.status,
      sessionId: result.sessionId,
    });
    return response(result.messageId, "unknown", result.sessionId, "outcome_write_failed");
  }

  #logInternalFailure(code: string, bindings: Record<string, unknown>): void {
    this.#logger?.error({ ...bindings, code }, "Session collaboration internal failure");
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
