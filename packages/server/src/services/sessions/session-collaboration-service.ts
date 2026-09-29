import { randomUUID } from "node:crypto";
import {
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  RUNTIME_SESSION_COLLABORATION_SCHEDULED_VERSION,
  type RunnerCloudSessionMessageReceivedFrame,
  type SessionCliCommandResponse,
  type SessionCliCreateRequest,
  type SessionCliSendRequest,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryRequestV3,
  type SessionMessageDeliveryResult,
  type SessionMessageScheduledOrigin,
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
  AuthorizedScheduledMessageRoute,
  AuthorizedSessionMessageRoute,
  ScheduledDispatchAdmissionFailure,
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
 * The Cloud delivery input for one Session message attempt: the ordinary branch carries the
 * source Session route, the scheduled branch the Server-generated origin snapshot from the claim.
 */
export type CloudSessionMessageDeliveryInput =
  | {
      route: AuthorizedSessionMessageRoute;
      message: { id: string; content: string };
      runtime: EffectiveRuntimeSnapshot;
      /** The durable attempt fencing token from the authorization transaction. */
      attemptCount: number;
    }
  | {
      route: AuthorizedScheduledMessageRoute;
      message: {
        id: string;
        content: string;
        /** The claim-frozen scheduled origin; its presence selects the scheduled wire path. */
        scheduledOrigin: SessionMessageScheduledOrigin;
        scheduleDetailUrl: string;
      };
      runtime: EffectiveRuntimeSnapshot;
      attemptCount: number;
    };

/**
 * The narrow Cloud dispatch surface the collaboration service uses for Cloud-placed targets.
 * Implemented by the Cloud session collaboration owner over the Sandbox allocation, Runner
 * channel fence, and model-grant boundary; the same dispatch admission wraps it as Local.
 */
export interface CloudSessionMessageDispatch {
  deliver(
    input: CloudSessionMessageDeliveryInput,
    /** The operation returns the Runner's receipt; the admission only fences dispatch authority. */
    admission: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame>,
  ): Promise<CloudSessionMessageOutcome>;
}

/*
 * Scheduled-origin hand-off (the trusted `dispatchScheduledMessage` entry).
 *
 * The snapshot below is the ONLY authorization a scheduled dispatch ever has: it is produced by
 * the schedule claim's committed transaction and carries the frozen origin, body, target, and the
 * management revision the final admission re-verifies. This is deliberately NOT a public API —
 * callers can never construct a scheduled origin — and it never fakes a source Session.
 */
export interface ScheduledMessageSnapshot {
  scheduleId: string;
  /** The management revision frozen at claim; any later edit invalidates the not-yet-sent send. */
  revision: number;
  agentId: string;
  targetSessionId: string;
  /** The deterministic UUIDv5 occurrence identity the claim inserted. */
  messageId: string;
  /** The frozen prompt; delivered verbatim as the SessionMessage text. */
  content: string;
  /** The frozen Server-generated origin snapshot. */
  origin: SessionMessageScheduledOrigin;
  /** The claim's database time; recorded as the summary's attemptedAt and never re-read. */
  attemptedAt: Date;
  /** The Web detail link, derived from the trusted public origin at claim time. */
  detailUrl: string;
}

/** The honest hand-off result: exactly one terminal answer per scheduled attempt. */
export interface ScheduledMessageDispatchOutcome {
  outcome: SessionMessageOutcome;
  code: string | null;
}

/** The narrow dispatch surface the schedule scheduler depends on. */
export interface ScheduleDispatch {
  dispatchScheduledMessage(
    snapshot: ScheduledMessageSnapshot,
    signal?: AbortSignal,
  ): Promise<ScheduledMessageDispatchOutcome>;
}

/*
 * The scheduled entry's total hand-off budget reuses the existing stage timeouts: Local is the
 * reconcile request timeout plus the delivery request timeout (30s + 30s), Cloud is the
 * allocation ensure timeout plus the receipt timeout (20s + 30s). The budget starts at dispatch
 * entry and covers preparation, the per-Session hand-off queue, and the receipt wait — never the
 * business execution. The ordinary entry points keep their per-stage timeouts and are not bounded
 * by this total.
 */
const SCHEDULED_LOCAL_BUDGET_MS = 60_000;
const SCHEDULED_CLOUD_BUDGET_MS = 50_000;

/** Internal sentinel: the total budget (or Server stop) fired before the transport send was marked. */
class ScheduledDispatchAbortError extends Error {
  constructor() {
    super("The scheduled dispatch budget expired before the send was marked");
    this.name = "ScheduledDispatchAbortError";
  }
}

type AbortRaceResult<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "aborted" };

const swallow = (): void => undefined;

/** A budget timer that aborts the controller; unref'd so it never keeps the process alive. */
function startBudgetTimer(controller: AbortController, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return timer;
}

/**
 * Await work under the dispatch budget. On abort the underlying work is never left unobserved —
 * its later settlement is swallowed — and no new frame may leave afterwards: every send boundary
 * re-checks the signal. A send that already marked cannot be unsent, so an abort during the
 * receipt wait resolves as an honest `unknown`.
 */
async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<AbortRaceResult<T>> {
  if (signal.aborted) {
    void work.then(swallow, swallow);
    return { kind: "aborted" };
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      void work.then(swallow, swallow);
      resolve({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "ok", value });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "error", error });
      },
    );
  });
}

/** One admission-wrapped transport stage (reconcile or business delivery) for a scheduled dispatch. */
type ScheduledStageResult<T> =
  | { kind: "completed"; result: T }
  | { kind: "rejected"; reason: ScheduledDispatchAdmissionFailure }
  | { kind: "aborted"; sent: boolean }
  | { kind: "failed"; error: unknown; sent: boolean };

export interface SessionCollaborationServiceOptions {
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  domain: Pick<RuntimeDomainOwner, "requestReconcile" | "requestSessionMessageDelivery">;
  registry: Pick<ConnectionRegistry, "capabilityVersion" | "currentInstanceId" | "supportsCapability">;
  sessions: Pick<
    SessionService,
    | "authorizeAndRecordMessage"
    | "beginScheduledMessageAttempt"
    | "createInternalSessionWithMessage"
    | "disableScheduleForInvalidTarget"
    | "hasAcceptedScheduledMessage"
    | "recordMessageOutcome"
    | "resolveScheduledMessageRoute"
    | "withCollaborationDispatchAdmission"
    | "withScheduledDispatchAdmission"
  >;
  /** E8 Cloud target dispatch; absent means Cloud-placed Sessions cannot be reached here. */
  cloud?: CloudSessionMessageDispatch;
  /** Test seam for the scheduled total budgets; production uses the stage-timeout sums. */
  scheduledBudgets?: { localMs?: number; cloudMs?: number };
  onDiagnostic?: (code: string) => void;
  logger?: Pick<ServiceLogger, "error">;
}

export class SessionCollaborationService {
  readonly #assembler: SessionCollaborationServiceOptions["assembler"];
  readonly #domain: SessionCollaborationServiceOptions["domain"];
  readonly #registry: SessionCollaborationServiceOptions["registry"];
  readonly #sessions: SessionCollaborationServiceOptions["sessions"];
  readonly #cloud: SessionCollaborationServiceOptions["cloud"];
  readonly #scheduledLocalBudgetMs: number;
  readonly #scheduledCloudBudgetMs: number;
  readonly #onDiagnostic: SessionCollaborationServiceOptions["onDiagnostic"];
  readonly #logger: SessionCollaborationServiceOptions["logger"];

  constructor(options: SessionCollaborationServiceOptions) {
    this.#assembler = options.assembler;
    this.#domain = options.domain;
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#cloud = options.cloud;
    this.#scheduledLocalBudgetMs = options.scheduledBudgets?.localMs ?? SCHEDULED_LOCAL_BUDGET_MS;
    this.#scheduledCloudBudgetMs = options.scheduledBudgets?.cloudMs ?? SCHEDULED_CLOUD_BUDGET_MS;
    this.#onDiagnostic = options.onDiagnostic;
    this.#logger = options.logger;
  }

  /* ------------------------------------------------------------------------------------------
   * Scheduled-origin dispatch: the schedule scheduler's trusted one-shot hand-off.
   * ---------------------------------------------------------------------------------------- */

  /**
   * Dispatch one claimed scheduled occurrence exactly once. The claim already committed the
   * message row at attempt 0; this entry fences it to 1 (never replayed, never retried), reuses
   * the existing Local/Cloud transport with the schedule-gated final admission, and records the
   * honest outcome — `accepted` only when the receiver took custody, `rejected` for authority and
   * schedule-gate refusals, `unreachable` when provably nothing was sent, `unknown` when the send
   * may have landed. The schedule summary updates only while it still points at this occurrence.
   */
  async dispatchScheduledMessage(
    snapshot: ScheduledMessageSnapshot,
    parentSignal?: AbortSignal,
  ): Promise<ScheduledMessageDispatchOutcome> {
    const record = (outcome: SessionMessageOutcome, code?: string): Promise<ScheduledMessageDispatchOutcome> =>
      this.#recordScheduled(snapshot, outcome, code);
    // A dispatch cancelled before its fence keeps the claim's untouched unknown row: exactly the
    // accepted crash window between commit and hand-off, never replayed.
    if (parentSignal?.aborted) return { outcome: "unknown", code: null };
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener("abort", onParentAbort);
    /*
     * The total budget starts at dispatch ENTRY and covers fencing, route resolution, runtime
     * assembly, and every transport stage (Local reconcile + delivery; Cloud ensure + queue +
     * receipt). The provisional timer uses the larger Local budget until the target kind is
     * known; the corrected timer then anchors the exact remaining budget to the entry time.
     */
    const startedAt = Date.now();
    let timer = startBudgetTimer(controller, Math.max(this.#scheduledLocalBudgetMs, this.#scheduledCloudBudgetMs));
    try {
      const signal = controller.signal;
      const fenced = await raceWithAbort(this.#sessions.beginScheduledMessageAttempt(snapshot.messageId), signal);
      if (fenced.kind === "aborted") return record("unreachable", "delivery_timeout");
      if (fenced.kind === "error") throw fenced.error;
      if (!fenced.value) {
        // The message is gone or was already fenced: a duplicate dispatcher can never send.
        this.#logInternalFailure("SESSION_COLLABORATION_SCHEDULED_FENCE_LOST", {
          messageId: snapshot.messageId,
          scheduleId: snapshot.scheduleId,
          targetSessionId: snapshot.targetSessionId,
        });
        return { outcome: "unknown", code: null };
      }
      const resolved = await raceWithAbort(
        this.#sessions.resolveScheduledMessageRoute(snapshot.targetSessionId, snapshot.agentId),
        signal,
      );
      if (resolved.kind === "aborted") return record("unreachable", "delivery_timeout");
      if (resolved.kind === "error") throw resolved.error;
      const resolution = resolved.value;
      if (resolution.kind === "permanent") {
        await this.#sessions.disableScheduleForInvalidTarget(snapshot.scheduleId);
        return record("rejected", resolution.code);
      }
      if (resolution.kind === "temporary") {
        return record("unreachable", resolution.code);
      }
      const route = resolution.route;
      const budgetMs =
        route.targetComputerKind === "cloud" ? this.#scheduledCloudBudgetMs : this.#scheduledLocalBudgetMs;
      clearTimeout(timer);
      timer = startBudgetTimer(controller, Math.max(0, budgetMs - (Date.now() - startedAt)));
      const assembly = await this.#assembleScheduledRuntime(snapshot, signal);
      if (assembly.kind === "aborted") return record("unreachable", "delivery_timeout");
      if (assembly.kind === "failed") return record("unreachable", "runtime_not_ready");
      if (route.targetComputerKind === "cloud") {
        return await this.#deliverScheduledCloud(snapshot, route, assembly.runtime, signal, record);
      }
      return await this.#deliverScheduledLocal(snapshot, route, assembly.runtime, signal, record);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  /** Local target scheduled dispatch over the existing reconcile + delivery boundaries. */
  async #deliverScheduledLocal(
    snapshot: ScheduledMessageSnapshot,
    route: AuthorizedScheduledMessageRoute,
    runtime: EffectiveRuntimeSnapshot,
    signal: AbortSignal,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
  ): Promise<ScheduledMessageDispatchOutcome> {
    const gate = this.#scheduledLocalGate(route);
    if ("code" in gate) return record("unreachable", gate.code);
    const fence = { scheduleId: snapshot.scheduleId, revision: snapshot.revision };
    const reconcile = await this.#admitScheduled(route, fence, signal, (onDispatched) =>
      this.#domain.requestReconcile(
        route.targetComputerId,
        gate.instanceId,
        {
          type: "session:reconcile",
          requestId: randomUUID(),
          installationId: route.targetInstallationId,
          sessionId: route.targetSessionId,
          agentId: route.agentId,
          placementGeneration: route.targetPlacementGeneration,
          ...(route.targetSessionKind === "internal" ? { sessionKind: "internal" as const } : {}),
          desired: "ready",
          runtime,
        },
        onDispatched,
        undefined,
        signal,
      ),
    );
    // The reconcile frame is preparation, never the business message: any pre-delivery failure
    // means the scheduled message provably never left, so the honest outcome is unreachable.
    if (reconcile.kind === "aborted") return record("unreachable", "delivery_timeout");
    if (reconcile.kind === "rejected") return this.#recordScheduledAdmissionFailure(reconcile.reason, record);
    if (reconcile.kind === "failed") return record("unreachable", "runtime_not_ready");
    if (!new Set(["ready", "running", "reporting"]).has(reconcile.result.status)) {
      return record("unreachable", "runtime_not_ready");
    }
    const delivery = await this.#admitScheduled(route, fence, signal, (onDispatched) => {
      const request: SessionMessageDeliveryRequestV3 = {
        type: "session:message:deliver",
        requestId: randomUUID(),
        messageId: snapshot.messageId,
        scheduledOrigin: snapshot.origin,
        // The send timestamp is assigned immediately before the transport send and is never part
        // of the message's semantic identity.
        sentAt: new Date().toISOString(),
        scheduleDetailUrl: snapshot.detailUrl,
        targetSessionId: route.targetSessionId,
        agentId: route.agentId,
        placementGeneration: route.targetPlacementGeneration,
        content: { kind: "text", text: snapshot.content },
        runtime,
      };
      return this.#domain.requestSessionMessageDelivery(
        route.targetComputerId,
        gate.instanceId,
        request,
        onDispatched,
        undefined,
        signal,
      );
    });
    return this.#finishScheduledDelivery(delivery, record);
  }

  /**
   * The pre-transport gate for a Local scheduled target: a current instance, the negotiated
   * session-collaboration v3 capability, and the v2 credential grant for visible targets. Every
   * refusal here happens before a single frame exists.
   */
  #scheduledLocalGate(
    route: AuthorizedScheduledMessageRoute,
  ): { code: string; instanceId?: never } | { code?: never; instanceId: string } {
    const targetInstanceId = this.#registry.currentInstanceId(route.targetComputerId);
    const collaborationVersion = targetInstanceId
      ? this.#registry.capabilityVersion(
          route.targetComputerId,
          targetInstanceId,
          RUNTIME_CAPABILITY.sessionCollaboration,
        )
      : undefined;
    if (!targetInstanceId || collaborationVersion === undefined) return { code: "runtime_unavailable" };
    // Only a peer that negotiated session-collaboration v3 may ever receive a scheduled-origin
    // frame; a v2 peer is answered honestly and no frame leaves.
    if (collaborationVersion < RUNTIME_SESSION_COLLABORATION_SCHEDULED_VERSION) {
      return { code: "unsupported_schedule_origin" };
    }
    if (
      route.targetSessionKind !== "internal" &&
      this.#registry.capabilityVersion(
        route.targetComputerId,
        targetInstanceId,
        RUNTIME_CAPABILITY.imCredentialGrant,
      ) !== 2
    ) {
      return { code: "outbox_unavailable" };
    }
    return { instanceId: targetInstanceId };
  }

  /**
   * The business-delivery result. `accepted`/`rejected` come only from an explicit receiver
   * answer; a failure before the send mark is unreachable, and any failure after the mark — the
   * frame's fate is no longer provable — is honestly unknown, never a retry and never disguised
   * as unreachable.
   */
  #finishScheduledDelivery(
    delivery: ScheduledStageResult<SessionMessageDeliveryResult>,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
  ): Promise<ScheduledMessageDispatchOutcome> {
    if (delivery.kind === "aborted") {
      return record(delivery.sent ? "unknown" : "unreachable", "delivery_timeout");
    }
    if (delivery.kind === "rejected") return this.#recordScheduledAdmissionFailure(delivery.reason, record);
    if (delivery.kind === "failed") {
      if (!delivery.sent) return record("unreachable", "runtime_unavailable");
      const timeout = delivery.error instanceof RuntimeDomainRequestError && delivery.error.code === "timeout";
      return record("unknown", timeout ? "delivery_timeout" : "delivery_uncertain");
    }
    const mapped = mapScheduledDelivery(delivery.result);
    return record(mapped.outcome, mapped.code);
  }

  /** Cloud target scheduled dispatch over the existing allocation + Runner channel boundary. */
  async #deliverScheduledCloud(
    snapshot: ScheduledMessageSnapshot,
    route: AuthorizedScheduledMessageRoute,
    runtime: EffectiveRuntimeSnapshot,
    signal: AbortSignal,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
  ): Promise<ScheduledMessageDispatchOutcome> {
    const cloud = this.#cloud;
    if (!cloud) return record("unreachable", "runtime_unavailable");
    const fence = { scheduleId: snapshot.scheduleId, revision: snapshot.revision };
    let admissionFailure: ScheduledDispatchAdmissionFailure | undefined;
    let sent = false;
    const work = cloud.deliver(
      {
        route,
        message: {
          id: snapshot.messageId,
          content: snapshot.content,
          scheduledOrigin: snapshot.origin,
          scheduleDetailUrl: snapshot.detailUrl,
        },
        runtime,
        attemptCount: 1,
      },
      async (operation) => {
        const admitted = await this.#sessions.withScheduledDispatchAdmission(route, fence, (markDispatched) => {
          if (signal.aborted) throw new ScheduledDispatchAbortError();
          return operation(() => {
            sent = true;
            markDispatched();
          });
        });
        if (!admitted.admitted) admissionFailure = admitted.reason;
        return admitted;
      },
    );
    const settled = await raceWithAbort(work, signal);
    if (admissionFailure !== undefined) return this.#recordScheduledAdmissionFailure(admissionFailure, record);
    return this.#finishScheduledCloudDelivery(settled, sent, snapshot, route, record);
  }

  #finishScheduledCloudDelivery(
    settled: AbortRaceResult<CloudSessionMessageOutcome>,
    sent: boolean,
    snapshot: ScheduledMessageSnapshot,
    route: AuthorizedScheduledMessageRoute,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
  ): Promise<ScheduledMessageDispatchOutcome> {
    if (settled.kind === "aborted") return record(sent ? "unknown" : "unreachable", "delivery_timeout");
    if (settled.kind === "error") {
      return this.#recordFailedScheduledCloud(settled.error, sent, snapshot, route, record);
    }
    const outcome = settled.value;
    // The owner can lose the allocation or fail its post-receipt permission step after the
    // business frame left. Except for an explicit Runner capacity refusal, that result no
    // longer proves the scheduled message was never received.
    if (sent && outcome.status === "unreachable" && outcome.code !== "capacity") {
      return record("unknown", "delivery_uncertain");
    }
    return record(outcome.status, "code" in outcome ? outcome.code : undefined);
  }

  #recordFailedScheduledCloud(
    error: unknown,
    sent: boolean,
    snapshot: ScheduledMessageSnapshot,
    route: AuthorizedScheduledMessageRoute,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
  ): Promise<ScheduledMessageDispatchOutcome> {
    if (error instanceof ScheduledDispatchAbortError) {
      return record(sent ? "unknown" : "unreachable", "delivery_timeout");
    }
    this.#logInternalFailure("SESSION_COLLABORATION_CLOUD_DISPATCH_FAILED", {
      messageId: snapshot.messageId,
      scheduleId: snapshot.scheduleId,
      targetSessionId: route.targetSessionId,
    });
    // Once the send was marked, a transport failure is no longer provably undelivered.
    return record(sent ? "unknown" : "unreachable", sent ? "delivery_uncertain" : "runtime_unavailable");
  }

  /**
   * One transport stage under the schedule-gated admission and the total budget. The admission's
   * row locks are held only until the send is marked; the budget abort is re-checked at the send
   * boundary so no frame can leave after it fires.
   */
  async #admitScheduled<T>(
    route: AuthorizedScheduledMessageRoute,
    fence: { scheduleId: string; revision: number },
    signal: AbortSignal,
    operation: (onDispatched: () => void) => Promise<T>,
  ): Promise<ScheduledStageResult<T>> {
    if (signal.aborted) return { kind: "aborted", sent: false };
    let sent = false;
    const work = this.#sessions.withScheduledDispatchAdmission(route, fence, (markDispatched) => {
      if (signal.aborted) throw new ScheduledDispatchAbortError();
      return operation(() => {
        sent = true;
        markDispatched();
      });
    });
    const admitted = await raceWithAbort(work, signal);
    if (admitted.kind === "aborted") return { kind: "aborted", sent };
    if (admitted.kind === "error") {
      if (admitted.error instanceof ScheduledDispatchAbortError) return { kind: "aborted", sent };
      // The domain owner's send boundary refused a cancelled request without sending a frame.
      if (admitted.error instanceof RuntimeDomainRequestError && admitted.error.code === "aborted") {
        return { kind: "aborted", sent };
      }
      return { kind: "failed", error: admitted.error, sent };
    }
    if (!admitted.value.admitted) return { kind: "rejected", reason: admitted.value.reason };
    const receipt = await raceWithAbort(admitted.value.result, signal);
    if (receipt.kind === "aborted") return { kind: "aborted", sent };
    if (receipt.kind === "error") {
      // The domain send boundary refused a cancelled request without ever sending a frame.
      if (receipt.error instanceof RuntimeDomainRequestError && receipt.error.code === "aborted") {
        return { kind: "aborted", sent };
      }
      return { kind: "failed", error: receipt.error, sent };
    }
    return { kind: "completed", result: receipt.value };
  }

  #recordScheduledAdmissionFailure(
    reason: ScheduledDispatchAdmissionFailure,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
  ): Promise<ScheduledMessageDispatchOutcome> {
    switch (reason) {
      case "schedule_deleted":
      case "schedule_disabled":
      case "schedule_changed":
      case "agent_deleted":
      case "binding_invalid":
      case "target_invalid":
        return record("rejected", reason);
      case "agent_suspended":
      case "authority_unavailable":
        return record("unreachable", reason);
    }
  }

  /** Assemble the target Session's runtime under the budget; a failure is runtime_not_ready. */
  async #assembleScheduledRuntime(
    snapshot: ScheduledMessageSnapshot,
    signal: AbortSignal,
  ): Promise<{ kind: "ok"; runtime: EffectiveRuntimeSnapshot } | { kind: "failed" } | { kind: "aborted" }> {
    if (signal.aborted) return { kind: "aborted" };
    const assembled = await raceWithAbort(this.#assembler.assembleForSession(snapshot.targetSessionId), signal);
    if (assembled.kind === "aborted") return { kind: "aborted" };
    if (assembled.kind === "error") {
      this.#logInternalFailure("SESSION_COLLABORATION_RUNTIME_ASSEMBLY_FAILED", {
        messageId: snapshot.messageId,
        scheduleId: snapshot.scheduleId,
        targetSessionId: snapshot.targetSessionId,
      });
      return { kind: "failed" };
    }
    return { kind: "ok", runtime: assembled.value };
  }

  /**
   * Record the hand-off outcome: the message row through the existing attempt-fenced write, and
   * the schedule's latest summary only while it still points at exactly this occurrence
   * (scheduleId + scheduledFor + messageId), so a late receipt never overwrites a newer claim.
   */
  async #recordScheduled(
    snapshot: ScheduledMessageSnapshot,
    outcome: SessionMessageOutcome,
    code?: string,
  ): Promise<ScheduledMessageDispatchOutcome> {
    try {
      const updated = await this.#sessions.recordMessageOutcome({
        messageId: snapshot.messageId,
        attemptCount: 1,
        outcome,
        ...(code ? { errorCode: code } : {}),
        scheduleSummary: {
          scheduleId: snapshot.scheduleId,
          scheduledFor: snapshot.origin.scheduledFor,
          attemptedAt: snapshot.attemptedAt.toISOString(),
        },
      });
      if (updated) return { outcome, code: code ?? null };
      if (await this.#sessions.hasAcceptedScheduledMessage(snapshot.messageId, 1)) {
        return { outcome: "accepted", code: null };
      }
    } catch {
      // The durable outcome remains unknown; scheduled hand-offs never replay automatically.
    }
    this.#logInternalFailure("SESSION_COLLABORATION_OUTCOME_WRITE_FAILED", {
      attemptCount: 1,
      code,
      messageId: snapshot.messageId,
      outcome,
      scheduleId: snapshot.scheduleId,
      sessionId: snapshot.targetSessionId,
    });
    return { outcome: "unknown", code: "outcome_write_failed" };
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

/** The same delivery-result mapping as the ordinary path, minus the CLI response envelope. */
function mapScheduledDelivery(delivery: SessionMessageDeliveryResult): {
  outcome: SessionMessageOutcome;
  code: string | undefined;
} {
  if (delivery.status === "accepted") return { outcome: "accepted", code: undefined };
  if (delivery.reason === "session_busy" || delivery.reason === "agent_busy" || delivery.reason === "client_busy") {
    return { outcome: "unreachable", code: "capacity" };
  }
  if (
    delivery.reason === "stale_generation" ||
    delivery.reason === "session_not_ready" ||
    delivery.reason === "stale_configuration" ||
    delivery.reason === "session_recovery_required"
  ) {
    return { outcome: "unreachable", code: "runtime_not_ready" };
  }
  return { outcome: "rejected", code: delivery.reason ?? "target_unavailable" };
}

function mapFailure(error: unknown): { status: "unreachable" | "rejected"; code: string } {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "SESSION_PLACEMENT_STALE" || code === "SESSION_SOURCE_UNAVAILABLE") {
    return { status: "rejected", code: "source_unavailable" };
  }
  if (code === "SESSION_TARGET_UNAVAILABLE") return { status: "rejected", code: "target_unavailable" };
  if (code === "SESSION_SCOPE_MISMATCH") return { status: "rejected", code: "scope_mismatch" };
  if (code === "SESSION_MESSAGE_CONFLICT") return { status: "rejected", code: "message_conflict" };
  // Router model admission for a Cloud Session override: an unoffered model is a deterministic
  // rejection; an unconfirmable model list is transient and unreachable.
  if (code === "SESSION_MODEL_UNAVAILABLE") return { status: "rejected", code: "model_unavailable" };
  if (code === "SESSION_MODEL_CATALOG_UNAVAILABLE") return { status: "unreachable", code: "model_unavailable" };
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
