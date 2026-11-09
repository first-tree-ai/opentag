import { randomUUID } from "node:crypto";
import {
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  RUNTIME_SESSION_COLLABORATION_SCHEDULED_VERSION,
  type RunnerCloudSessionMessageReceivedFrame,
  SESSION_STOP_ANSWER_BUDGET_MS,
  type SessionCliCommandResponse,
  type SessionCliCreateRequest,
  type SessionCliSendRequest,
  type SessionCliStopExecution,
  type SessionCliStopRequest,
  type SessionCliStopResponse,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryRequestV3,
  type SessionMessageDeliveryResult,
  type SessionMessageRunOutcome,
  type SessionMessageScheduledOrigin,
  type SessionReconcileRequest,
  type SessionReconcileResult,
} from "@opentag/shared";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { type ConnectionRegistry, RuntimeRegistrySendError } from "../../runtime/connection-registry.js";
import {
  type RuntimeDispatchAdmission,
  type RuntimeDomainOwner,
  RuntimeDomainRequestError,
} from "../../runtime/runtime-domain-owner.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../runtime-config/index.js";
import type { SessionCliSourceContext } from "./session-cli-proof-service.js";
import {
  deliveryFailureNoticeMessageId,
  heldMessageCutoff,
  isDeliveryFailureNotice,
  renderDeliveryFailureNotice,
  SESSION_MESSAGE_HELD_CODE,
  SESSION_MESSAGE_HELD_EXPIRED_CODE,
  SESSION_MESSAGE_HELD_FULL_CODE,
  SESSION_MESSAGE_HELD_LIMITS,
  SESSION_MESSAGE_HELD_SUPERSEDED_CODE,
  SESSION_MESSAGE_TARGET_STOPPED_CODE,
} from "./session-held-delivery.js";
import {
  isRunOutcomeNotice,
  renderRunOutcomeNotice,
  renderSessionStoppedNotice,
  runOutcomeNoticeMessageId,
  sessionStoppedNoticeMessageId,
} from "./session-run-outcome-notice.js";
import type {
  AuthorizedHeldMessageRoute,
  AuthorizedScheduledMessageRoute,
  AuthorizedSessionMessageRoute,
  HeldSessionMessage,
  InternalSessionStopTarget,
  ScheduledDispatchAdmissionFailure,
  SessionMessageAttempt,
  SessionMessageOutcome,
  SessionService,
  StoppedInternalSession,
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
    signal?: AbortSignal,
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
  /** The next scheduled occurrence, if any, computed by the same claim. */
  nextTriggerAt: Date | null;
  /** The Web detail link, derived from the trusted public origin at claim time. */
  detailUrl: string;
  /** Set on a redelivery of a held occurrence; the claim's own hand-off is attempt 1. */
  attemptCount?: number;
}

/** The honest hand-off result: exactly one terminal answer per scheduled attempt. */
export interface ScheduledMessageDispatchOutcome {
  outcome: SessionMessageOutcome;
  code: string | null;
}

/**
 * One internal Session Run that ended without completing, as reported by the exact live Runtime
 * connection that executed it (the Local Computer connection or the Cloud Runner connection).
 * The connection facts become the notice's source authority, so a stale or foreign connection
 * can never notify a creator on the child's behalf.
 */
export interface RunOutcomeNoticeInput {
  childSessionId: string;
  messageId: string;
  outcome: SessionMessageRunOutcome;
  reason: string;
  source: { computerId: string; connectionInstanceId: string; placementGeneration: number };
}

/**
 * `notified`: the creator accepted the notice (now or earlier). `ignored`: final, nothing to
 * notify (not an internal child, ended Session, unknown message, or a final rejection).
 * `retry`: acceptance has not been confirmed to the reporter; it retains its durable report
 * and resends it under the same identity, which reuses the same notice row.
 */
export type RunOutcomeNoticeStatus = "notified" | "ignored" | "retry";

/** The narrow surface Runtime owners use to report a non-completed internal Session Run. */
export interface RunOutcomeNotifier {
  notifyRunOutcome(input: RunOutcomeNoticeInput): Promise<RunOutcomeNoticeStatus>;
}

/** The narrow dispatch surface the schedule scheduler depends on. */
export interface ScheduleDispatch {
  dispatchScheduledMessage(
    snapshot: ScheduledMessageSnapshot,
    signal?: AbortSignal,
  ): Promise<ScheduledMessageDispatchOutcome>;
}

/** A stop older than this is not sent again: a Run outlasting the Computer's absence is its Run budget's job. */
const STOP_REDELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const STOP_REDELIVERY_LIMIT = 64;
// Local reconcile + delivery. Cloud preparation + receipt, including time queued before the send.
const SCHEDULED_LOCAL_BUDGET_MS = 60_000;
const SCHEDULED_CLOUD_BUDGET_MS = 280_000;
const SCHEDULED_CLOUD_SHORT_BUDGET_MS = 20_000;
// Keep a quarter of the scheduler's 100 slots available for short hand-offs.
const SCHEDULED_CLOUD_EXTENDED_SLOTS = 75;
const MAX_BACKGROUND_OUTCOME_NOTICES = 16;

type PreparedRunOutcomeNotice = { attempt: SessionMessageAttempt; recipientSessionId: string };

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

type DispatchAdmission = <T>(
  operation: (onDispatched: () => void) => Promise<T>,
) => Promise<{ admitted: false } | { admitted: true; result: Promise<T> }>;

/** Shorter than the CLI's request timeout, and much longer than a hand-off to a healthy Client. */
const SEND_BUDGET_MS = 5_000;

/** A held occurrence that ended without reaching its Session, as the scheduler's IM notices read it. */
export interface HeldScheduledMiss {
  occurrence: {
    agentId: string;
    name: string;
    prompt: string;
    scheduleId: string;
    scheduledFor: string;
    targetSessionId: string;
    timezone: string;
  };
  outcome: SessionMessageOutcome;
  code: string;
  previous: { outcome: SessionMessageOutcome; code: string | null } | null;
}

type HeldListener = (computerId: string, options?: { flushNow: boolean }) => void;

/** Whether a first attempt that outlived its budget now belongs to the Server. */
interface HandOffCustody {
  heldByServer: boolean;
}

/** `refused`: the final admission found the authority gone and no frame left. That is not a Client outage. */
type LocalHandOff =
  | { kind: "accepted" }
  | { kind: "rejected"; code: string }
  | { kind: "temporary"; code: string }
  | { kind: "refused"; code: string }
  | { kind: "aborted" };

interface LocalHandOffInput {
  route: AuthorizedHeldMessageRoute;
  messageId: string;
  sourceSessionId: string;
  content: string;
  creatorSessionId: string | null;
  /** Offer the message inside the reconcile frame when the Client negotiated that. */
  inlineMessage?: boolean;
}

const UNCONFIRMED_HAND_OFF: LocalHandOff = { kind: "temporary", code: "delivery_timeout" };

function handOffOfDelivery(delivery: SessionMessageDeliveryResult): LocalHandOff {
  const mapped = mapScheduledDelivery(delivery);
  if (mapped.outcome === "accepted") return { kind: "accepted" };
  if (mapped.outcome === "rejected") return { kind: "rejected", code: mapped.code ?? "target_unavailable" };
  return { kind: "temporary", code: mapped.code ?? "runtime_not_ready" };
}

/**
 * Why a held occurrence must not be delivered any more, or undefined. A pause, edit or delete is someone's
 * own action and keeps its existing code, which posts nothing; a later occurrence is a miss worth telling.
 */
function heldScheduleReplacement(
  schedule: Awaited<ReturnType<SessionService["readHeldSchedule"]>>,
  message: { id: string; content: string },
): string | undefined {
  if (!schedule) return "schedule_deleted";
  if (!schedule.enabled) return "schedule_disabled";
  if (schedule.prompt !== message.content) return "schedule_changed";
  return schedule.lastDispatch?.messageId === message.id ? undefined : SESSION_MESSAGE_HELD_SUPERSEDED_CODE;
}

function isAdmissionRefusal(error: unknown): boolean {
  return error instanceof RuntimeDomainRequestError && error.code === "authority_unavailable";
}

/** Failures a redelivery can overcome. `outbox_unavailable` waits on a negotiated grant, not on recovery. */
const HOLDABLE_LOCAL_CODES: ReadonlySet<string> = new Set([
  "agent_busy",
  "client_busy",
  "delivery_timeout",
  "runtime_not_ready",
  "runtime_unavailable",
  "session_busy",
]);

export interface SessionCollaborationServiceOptions {
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  domain: Pick<RuntimeDomainOwner, "requestReconcile" | "requestSessionMessageDelivery">;
  registry: Pick<ConnectionRegistry, "capabilityVersion" | "currentInstanceId" | "supportsCapability">;
  sessions: Pick<
    SessionService,
    | "authorizeAndRecordMessage"
    | "beginHeldAttempt"
    | "beginScheduledMessageAttempt"
    | "createInternalSessionWithMessage"
    | "disableScheduleForInvalidTarget"
    | "hasAcceptedScheduledMessage"
    | "hasOlderHeldMessage"
    | "heldHasRoom"
    | "markMessageHeld"
    | "readHeldSchedule"
    | "readPreviousScheduledOutcome"
    | "recordDeliveryFailureNotice"
    | "recordMessageOutcome"
    | "resolveRunOutcomeNotice"
    | "recentlyEndedInternalSessions"
    | "resolveScheduledMessageRoute"
    | "stopInternalSession"
    | "withCollaborationDispatchAdmission"
    | "withHeldDispatchAdmission"
    | "withScheduledDispatchAdmission"
  >;
  /** Test seam for the hold limits; production uses {@link SESSION_MESSAGE_HELD_LIMITS}. */
  heldLimits?: { perTarget: number; perComputer: number };
  /** Test seam for how long a Local send waits for its hand-off before answering. */
  sendBudgetMs?: number;
  /** The Web detail link for a redelivered scheduled occurrence. */
  scheduleDetailUrl?: (agentId: string, scheduleId: string) => string;
  /** E8 Cloud target dispatch; absent means Cloud-placed Sessions cannot be reached here. */
  cloud?: CloudSessionMessageDispatch;
  /** Tells the execution side of ended internal Sessions to stop; absent means a stop stays `pending`. */
  stopEnded?: (targets: InternalSessionStopTarget[]) => Promise<Map<string, SessionCliStopExecution>>;
  /** Test seam for how long a stop waits for its execution side before answering `pending`. */
  stopAnswerBudgetMs?: number;
  /** Test seam for the scheduled total budgets; production uses the stage-timeout sums. */
  scheduledBudgets?: { localMs?: number; cloudMs?: number; cloudExtendedSlots?: number };
  onDiagnostic?: (code: string) => void;
  logger?: Pick<ServiceLogger, "error">;
}
export class SessionCollaborationService {
  readonly #assembler: SessionCollaborationServiceOptions["assembler"];
  readonly #domain: SessionCollaborationServiceOptions["domain"];
  readonly #registry: SessionCollaborationServiceOptions["registry"];
  readonly #sessions: SessionCollaborationServiceOptions["sessions"];
  readonly #cloud: SessionCollaborationServiceOptions["cloud"];
  readonly #stopEnded: SessionCollaborationServiceOptions["stopEnded"];
  readonly #scheduledLocalBudgetMs: number;
  readonly #scheduledCloudBudgetMs: number;
  readonly #scheduledCloudExtendedSlots: number;
  #cloudExtendedInFlight = 0;
  readonly #onDiagnostic: SessionCollaborationServiceOptions["onDiagnostic"];
  readonly #logger: SessionCollaborationServiceOptions["logger"];
  readonly #scheduleDetailUrl: SessionCollaborationServiceOptions["scheduleDetailUrl"];
  readonly #sendBudgetMs: number;
  readonly #heldLimits: { perTarget: number; perComputer: number };
  readonly #inFlightHandOffs = new Set<string>();
  #onHeld: HeldListener | undefined;
  #onHeldScheduledMiss: ((miss: HeldScheduledMiss) => void) | undefined;
  readonly #outcomeNotices = new Map<string, { controller: AbortController; done: Promise<void> }>();
  readonly #stopWork = new Set<Promise<void>>();
  readonly #stopAnswerBudgetMs: number;
  #closing = false;

  constructor(options: SessionCollaborationServiceOptions) {
    this.#assembler = options.assembler;
    this.#domain = options.domain;
    this.#registry = options.registry;
    this.#sessions = options.sessions;
    this.#cloud = options.cloud;
    this.#stopEnded = options.stopEnded;
    this.#stopAnswerBudgetMs = options.stopAnswerBudgetMs ?? SESSION_STOP_ANSWER_BUDGET_MS;
    this.#scheduledLocalBudgetMs = options.scheduledBudgets?.localMs ?? SCHEDULED_LOCAL_BUDGET_MS;
    this.#scheduledCloudBudgetMs = options.scheduledBudgets?.cloudMs ?? SCHEDULED_CLOUD_BUDGET_MS;
    this.#scheduledCloudExtendedSlots = options.scheduledBudgets?.cloudExtendedSlots ?? SCHEDULED_CLOUD_EXTENDED_SLOTS;
    this.#onDiagnostic = options.onDiagnostic;
    this.#logger = options.logger;
    this.#scheduleDetailUrl = options.scheduleDetailUrl;
    this.#sendBudgetMs = options.sendBudgetMs ?? SEND_BUDGET_MS;
    this.#heldLimits = options.heldLimits ?? SESSION_MESSAGE_HELD_LIMITS;
  }

  /** Tell the scheduler's IM notices that a held occurrence ended without reaching its Session. */
  setHeldScheduledMissListener(listener: (miss: HeldScheduledMiss) => void): void {
    this.#onHeldScheduledMiss = listener;
  }

  /** Tell the delivery worker a Computer now has a held message. */
  setHeldListener(listener: HeldListener): void {
    this.#onHeld = listener;
  }

  /* ------------------------------------------------------------------------------------------
   * Scheduled-origin dispatch: the schedule scheduler's trusted one-shot hand-off.
   * ---------------------------------------------------------------------------------------- */

  /**
   * Dispatch one claimed scheduled occurrence exactly once. The claim already committed the
   * message row at attempt 0; this entry fences it to 1 (it never replays itself), reuses
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
    const shortCloudBudget = Math.min(this.#scheduledCloudBudgetMs, SCHEDULED_CLOUD_SHORT_BUDGET_MS);
    let timer = startBudgetTimer(controller, Math.max(this.#scheduledLocalBudgetMs, shortCloudBudget));
    let releaseExtendedCloud: (() => void) | undefined;
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
      releaseExtendedCloud = this.#reserveExtendedCloudSlot(route.targetComputerKind);
      const cloudBudget = releaseExtendedCloud ? this.#scheduledCloudBudgetMs : shortCloudBudget;
      const deadline = this.#scheduledDeadline(snapshot, route.targetComputerKind, startedAt, cloudBudget);
      clearTimeout(timer);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return record("unreachable", "delivery_timeout");
      timer = startBudgetTimer(controller, remaining);
      const assembly = await this.#assembleScheduledRuntime(snapshot, signal);
      const local = route.targetComputerKind !== "cloud";
      const settle = local ? this.#holdingScheduledRecord(snapshot, route.targetComputerId, record) : record;
      if (assembly.kind === "aborted") return settle("unreachable", "delivery_timeout");
      if (assembly.kind === "failed") return settle("unreachable", "runtime_not_ready");
      if (!local) return await this.#deliverScheduledCloud(snapshot, route, assembly.runtime, signal, record);
      return await this.#deliverScheduledLocal(snapshot, route, assembly.runtime, signal, settle);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      releaseExtendedCloud?.();
    }
  }

  /** A Local occurrence that provably never reached the Client is held instead of being missed. */
  #holdingScheduledRecord(
    snapshot: ScheduledMessageSnapshot,
    computerId: string,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
  ): (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome> {
    return async (outcome, code) => {
      if (outcome !== "unreachable" || !code || !this.#canHold(computerId, { code })) return record(outcome, code);
      // Full: a miss like any other, which the scheduler reports to the conversation.
      if (!(await this.#heldHasRoom(snapshot.targetSessionId, computerId))) {
        return record("unreachable", SESSION_MESSAGE_HELD_FULL_CODE);
      }
      const held = await this.#recordScheduled(snapshot, "unknown", SESSION_MESSAGE_HELD_CODE);
      if (held.code === SESSION_MESSAGE_HELD_CODE) this.#onHeld?.(computerId);
      return held;
    };
  }

  #reserveExtendedCloudSlot(target: "local" | "cloud"): (() => void) | undefined {
    if (target !== "cloud" || this.#cloudExtendedInFlight >= this.#scheduledCloudExtendedSlots) return;
    this.#cloudExtendedInFlight += 1;
    return () => {
      this.#cloudExtendedInFlight -= 1;
    };
  }

  #scheduledDeadline(
    snapshot: ScheduledMessageSnapshot,
    target: "local" | "cloud",
    startedAt: number,
    cloudBudget: number,
  ): number {
    if (target === "local") return startedAt + this.#scheduledLocalBudgetMs;
    const deadline = startedAt + cloudBudget;
    return Math.min(deadline, snapshot.nextTriggerAt?.getTime() ?? deadline);
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
    const reconcile = await this.#admitScheduled<SessionReconcileResult>(route, fence, signal, (admission) =>
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
          ...(route.targetSessionKind === "internal" && route.targetCreatorSessionId
            ? { sessionKind: "internal" as const, creatorSessionId: route.targetCreatorSessionId }
            : {}),
          desired: "ready",
          runtime,
        },
        undefined,
        admission,
        signal,
      ),
    );
    // The reconcile frame is preparation, never the business message: any pre-delivery failure
    // means the scheduled message provably never left, so the honest outcome is unreachable.
    if (reconcile.kind === "aborted") return record("unreachable", "delivery_timeout");
    if (reconcile.kind === "rejected") {
      return this.#recordScheduledAdmissionFailure(reconcile.reason, record, false);
    }
    if (reconcile.kind === "failed") return record("unreachable", "runtime_not_ready");
    if (!new Set(["ready", "running", "reporting"]).has(reconcile.result.status)) {
      return record("unreachable", "runtime_not_ready");
    }
    const delivery = await this.#admitScheduled<SessionMessageDeliveryResult>(route, fence, signal, (admission) => {
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
        undefined,
        admission,
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
    if (delivery.kind === "rejected") {
      return this.#recordScheduledAdmissionFailure(delivery.reason, record, true);
    }
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
          if (signal.aborted || (snapshot.nextTriggerAt && snapshot.nextTriggerAt.getTime() <= Date.now())) {
            throw new ScheduledDispatchAbortError();
          }
          return operation(() => {
            sent = true;
            markDispatched();
          });
        });
        if (!admitted.admitted) admissionFailure = admitted.reason;
        return admitted;
      },
      signal,
    );
    const settled = await raceWithAbort(work, signal);
    if (admissionFailure !== undefined) {
      return this.#recordScheduledAdmissionFailure(admissionFailure, record, true);
    }
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
    if (sent && outcome.status === "unreachable" && outcome.code !== "client_busy") {
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
   * Domain preparation runs before admission: proof minting locks the placement in its own
   * transaction. Final admission rechecks authority and holds its locks only until the send mark.
   */
  async #admitScheduled<T>(
    route: AuthorizedScheduledMessageRoute,
    fence: { scheduleId: string; revision: number },
    signal: AbortSignal,
    operation: (admission: RuntimeDispatchAdmission<T>) => Promise<T>,
  ): Promise<ScheduledStageResult<T>> {
    if (signal.aborted) return { kind: "aborted", sent: false };
    let sent = false;
    let rejected: ScheduledDispatchAdmissionFailure | undefined;
    const admission: RuntimeDispatchAdmission<T> = async (send) => {
      const admitted = await this.#sessions.withScheduledDispatchAdmission(route, fence, (markDispatched) => {
        if (signal.aborted) throw new ScheduledDispatchAbortError();
        return send(() => {
          sent = true;
          markDispatched();
        });
      });
      if (!admitted.admitted) rejected = admitted.reason;
      return admitted;
    };
    const receipt = await raceWithAbort(
      Promise.resolve().then(() => operation(admission)),
      signal,
    );
    if (receipt.kind === "aborted") return { kind: "aborted", sent };
    if (receipt.kind === "error") {
      if (rejected) return { kind: "rejected", reason: rejected };
      if (receipt.error instanceof ScheduledDispatchAbortError) return { kind: "aborted", sent };
      // The domain owner's send boundary refused a cancelled request without sending a frame.
      if (receipt.error instanceof RuntimeDomainRequestError && receipt.error.code === "aborted") {
        return { kind: "aborted", sent };
      }
      return { kind: "failed", error: receipt.error, sent };
    }
    return { kind: "completed", result: receipt.value };
  }

  /**
   * The recorded outcome of a refused admission. `carriedMessage` says whether the refused frame was
   * the scheduled message itself or only its preparation: a refused reconcile leaves the message
   * provably unsent, a refused business frame may already be at the transport.
   */
  #recordScheduledAdmissionFailure(
    reason: ScheduledDispatchAdmissionFailure,
    record: (outcome: SessionMessageOutcome, code?: string) => Promise<ScheduledMessageDispatchOutcome>,
    carriedMessage: boolean,
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
      case "dispatch_not_marked":
        // The admission gave up waiting for the send mark and refused the dispatch. The transport had
        // already been asked to send by then, so a business frame's fate is unprovable: never claim it
        // as unreachable. A refused reconcile frame still leaves the message provably unsent.
        return record(carriedMessage ? "unknown" : "unreachable", "delivery_timeout");
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
        attemptCount: snapshot.attemptCount ?? 1,
        outcome,
        ...(code ? { errorCode: code } : {}),
        scheduleSummary: {
          scheduleId: snapshot.scheduleId,
          scheduledFor: snapshot.origin.scheduledFor,
          attemptedAt: snapshot.attemptedAt.toISOString(),
        },
      });
      if (updated) return { outcome, code: code ?? null };
      if (await this.#sessions.hasAcceptedScheduledMessage(snapshot.messageId, snapshot.attemptCount ?? 1)) {
        return { outcome: "accepted", code: null };
      }
    } catch {
      // The durable outcome remains unknown; scheduled hand-offs never replay automatically.
    }
    this.#logInternalFailure("SESSION_COLLABORATION_OUTCOME_WRITE_FAILED", {
      attemptCount: snapshot.attemptCount ?? 1,
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
        ...(source.userTaskSource ? { userTaskSource: source.userTaskSource } : {}),
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
        ...(source.userTaskSource ? { userTaskSource: source.userTaskSource } : {}),
        sourceInstallationId: source.installationId,
        sourceComputerId: source.computerId,
        sourceConnectionInstanceId: source.connectionInstanceId,
        sourcePlacementGeneration: source.placementGeneration,
        targetSessionId: input.targetSessionId,
        content: input.message,
      });
      return await this.#deliver(attempt, input.targetSessionId, { inlineLocalMessage: true });
    } catch (error) {
      return this.#failure(input.messageId, error);
    }
  }

  /**
   * Stop an internal Session and all its descendants for good on behalf of an ancestor. They end first, so a
   * stop that cannot reach their execution side still takes away their authority. Only the target's creator can
   * hear of it: every other creator in the tree has ended too. A creator that asked for the stop has its answer
   * here and is not woken for it; a creator someone else overruled gets one notice for the whole tree.
   */
  async stop(input: SessionCliStopRequest, source: SessionCliSourceContext): Promise<SessionCliStopResponse> {
    const sessionId = input.targetSessionId;
    let stopped: StoppedInternalSession;
    try {
      stopped = await this.#sessions.stopInternalSession({
        sourceSessionId: source.sessionId,
        sourceInstallationId: source.installationId,
        sourceConnectionInstanceId: source.connectionInstanceId,
        sourceComputerId: source.computerId,
        sourcePlacementGeneration: source.placementGeneration,
        targetSessionId: sessionId,
      });
    } catch (error) {
      const mapped = mapExpectedFailure(error);
      if (mapped) return { status: mapped.status, sessionId, code: mapped.code };
      this.#onDiagnostic?.("SESSION_COLLABORATION_RUNTIME_UNAVAILABLE");
      return { status: "unreachable", sessionId, code: "runtime_unavailable" };
    }
    for (const computerId of stopped.heldNoticeComputerIds) this.#onHeld?.(computerId, { flushNow: true });
    // The stop already took effect, so a Client that does not answer delays only the news: the work goes on
    // in the background, and the caller gets `pending` before its own request times out.
    let execution: SessionCliStopExecution = "pending";
    // Recorded before the answer: after a successful stop the caller has no reason to ask again.
    const notice =
      stopped.target.creatorSessionId === source.sessionId ? undefined : await this.#recordStopNotice(stopped, source);
    const finished = this.#trackStopWork(async () => {
      const executions = await this.#stopEnded?.(stopped.targets);
      execution = leastReachedExecution(stopped.targets, executions);
      if (notice && !this.#closing) await this.#deliverStopNotice(notice, stopped.target);
    });
    await this.#withinStopAnswerBudget(finished);
    return {
      status: "stopped",
      sessionId,
      execution,
      alreadyStopped: stopped.alreadyStopped,
      stoppedDescendantCount: stopped.stoppedDescendantCount,
    };
  }

  #trackStopWork(work: () => Promise<void>): Promise<void> {
    const done: Promise<void> = work()
      .catch(() => this.#onDiagnostic?.("SESSION_STOP_BACKGROUND_FAILED"))
      .finally(() => this.#stopWork.delete(done));
    this.#stopWork.add(done);
    return done;
  }

  async #withinStopAnswerBudget(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#stopAnswerBudgetMs);
      timer.unref?.();
    });
    await Promise.race([work, budget]);
    clearTimeout(timer);
  }

  /** A reconnected Computer may have missed a stop. Repeating one is harmless, so nothing tracks which did. */
  async redeliverStops(computerId: string): Promise<void> {
    if (!this.#stopEnded) return;
    const targets = await this.#sessions.recentlyEndedInternalSessions(
      computerId,
      new Date(Date.now() - STOP_REDELIVERY_WINDOW_MS),
      STOP_REDELIVERY_LIMIT,
    );
    if (targets.length > 0) await this.#stopEnded(targets);
  }

  async #recordStopNotice(
    { target, descendantCount }: StoppedInternalSession,
    source: SessionCliSourceContext,
  ): Promise<SessionMessageAttempt | undefined> {
    const noticeId = sessionStoppedNoticeMessageId(target.sessionId);
    try {
      return await this.#sessions.authorizeAndRecordMessage({
        messageId: noticeId,
        sourceSessionId: source.sessionId,
        sourceInstallationId: source.installationId,
        sourceComputerId: source.computerId,
        sourceConnectionInstanceId: source.connectionInstanceId,
        sourcePlacementGeneration: source.placementGeneration,
        targetSessionId: target.creatorSessionId,
        content: renderSessionStoppedNotice(target.sessionId, descendantCount),
        serverDerivedId: true,
      });
    } catch (error) {
      this.#logStopNoticeFailure(target, noticeId, this.#failure(noticeId, error).code);
      return undefined;
    }
  }

  async #deliverStopNotice(attempt: SessionMessageAttempt, target: InternalSessionStopTarget): Promise<void> {
    let result: SessionCliCommandResponse;
    try {
      result = await this.#deliver(attempt, target.creatorSessionId);
    } catch (error) {
      result = this.#failure(attempt.message.id, error);
    }
    if (result.status !== "accepted") this.#logStopNoticeFailure(target, attempt.message.id, result.code);
  }

  #logStopNoticeFailure(target: InternalSessionStopTarget, noticeId: string, code: string | undefined): void {
    this.#logInternalFailure("SESSION_STOP_NOTICE_NOT_DELIVERED", { childSessionId: target.sessionId, code, noticeId });
  }

  /**
   * Tell a message's sender that its Run ended without completing. The notice is an ordinary
   * SessionMessage from the target to the sender with a deterministic id, so it reuses the existing
   * authorization, lock order, idempotency, activity projection, and delivery (including
   * visible-Session callback rules). `resolveRunOutcomeNotice` picks the recipient, and a failed
   * notice is never reported back to its own sender, so notices cannot echo between two Sessions.
   */
  async notifyRunOutcome(input: RunOutcomeNoticeInput): Promise<RunOutcomeNoticeStatus> {
    const prepared = await this.#prepareRunOutcomeNotice(input);
    if (typeof prepared === "string") return prepared;
    return this.#deliverRunOutcomeNotice(prepared, input);
  }

  /** Local reporters retain their durable report on `retry`; these tasks never take custody. */
  async notifyRunOutcomeInBackground(input: RunOutcomeNoticeInput): Promise<RunOutcomeNoticeStatus> {
    const noticeId = runOutcomeNoticeMessageId(input.childSessionId, input.messageId);
    if (this.#closing || this.#outcomeNotices.has(noticeId)) return "retry";
    if (this.#outcomeNotices.size >= MAX_BACKGROUND_OUTCOME_NOTICES) return "retry";
    const controller = new AbortController();
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#outcomeNotices.set(noticeId, { controller, done });
    const release = () => {
      this.#outcomeNotices.delete(noticeId);
      finish();
    };
    let delivering = false;
    try {
      const prepared = await this.#prepareRunOutcomeNotice(input);
      if (typeof prepared === "string") return prepared;
      if (controller.signal.aborted) return "retry";
      delivering = true;
      void this.#deliverRunOutcomeNotice(prepared, input, controller.signal).then(release, () => {
        release();
        this.#logInternalFailure("SESSION_RUN_OUTCOME_BACKGROUND_FAILED", { noticeId });
      });
      return "retry";
    } finally {
      if (!delivering) release();
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const { controller } of this.#outcomeNotices.values()) controller.abort();
    await Promise.all([...this.#outcomeNotices.values()].map(({ done }) => done));
    await Promise.all(this.#stopWork);
  }

  async #prepareRunOutcomeNotice(
    input: RunOutcomeNoticeInput,
  ): Promise<PreparedRunOutcomeNotice | RunOutcomeNoticeStatus> {
    const noticeId = runOutcomeNoticeMessageId(input.childSessionId, input.messageId);
    try {
      const notice = await this.#sessions.resolveRunOutcomeNotice({
        childSessionId: input.childSessionId,
        messageId: input.messageId,
      });
      if (!notice) return "ignored";
      const attempt = await this.#sessions.authorizeAndRecordMessage({
        messageId: noticeId,
        sourceSessionId: input.childSessionId,
        sourceInstallationId: notice.installationId,
        sourceComputerId: input.source.computerId,
        sourceConnectionInstanceId: input.source.connectionInstanceId,
        sourcePlacementGeneration: input.source.placementGeneration,
        targetSessionId: notice.recipientSessionId,
        content: renderRunOutcomeNotice(input),
        serverDerivedId: true,
      });
      if (attempt.attemptCount === null) {
        return this.#runOutcomeNoticeStatus(
          response(
            noticeId,
            attempt.message.lastOutcome,
            notice.recipientSessionId,
            attempt.message.lastErrorCode ?? undefined,
          ),
          input,
        );
      }
      return { attempt, recipientSessionId: notice.recipientSessionId };
    } catch (error) {
      return this.#runOutcomeNoticeStatus(this.#failure(noticeId, error), input);
    }
  }

  async #deliverRunOutcomeNotice(
    prepared: PreparedRunOutcomeNotice,
    input: RunOutcomeNoticeInput,
    signal?: AbortSignal,
  ): Promise<RunOutcomeNoticeStatus> {
    try {
      return this.#runOutcomeNoticeStatus(
        await this.#deliver(prepared.attempt, prepared.recipientSessionId, { signal }),
        input,
      );
    } catch (error) {
      return this.#runOutcomeNoticeStatus(
        this.#failure(runOutcomeNoticeMessageId(input.childSessionId, input.messageId), error),
        input,
      );
    }
  }

  #runOutcomeNoticeStatus(result: SessionCliCommandResponse, input: RunOutcomeNoticeInput): RunOutcomeNoticeStatus {
    if (result.status === "accepted") return "notified";
    if (result.status === "rejected") {
      this.#logInternalFailure("SESSION_RUN_OUTCOME_NOTICE_REJECTED", {
        childSessionId: input.childSessionId,
        code: result.code,
        messageId: input.messageId,
        noticeId: result.messageId,
      });
      return "ignored";
    }
    return "retry";
  }

  async #deliver(
    attempt: SessionMessageAttempt,
    sessionId: string,
    { signal, inlineLocalMessage = false }: { signal?: AbortSignal; inlineLocalMessage?: boolean } = {},
  ): Promise<SessionCliCommandResponse> {
    if (attempt.attemptCount === null) {
      return response(
        attempt.message.id,
        attempt.message.lastOutcome,
        sessionId,
        attempt.message.lastErrorCode ?? undefined,
      );
    }
    if (signal?.aborted) return response(attempt.message.id, "unknown", sessionId, "runtime_unavailable");
    const local = attempt.route.targetComputerKind !== "cloud";
    if (
      local &&
      this.#canHold(attempt.route.targetComputerId, { code: "client_busy" }) &&
      (await this.#sessions.hasOlderHeldMessage(
        attempt.route.targetSessionId,
        attempt.message,
        heldMessageCutoff(Date.now()),
      ))
    ) {
      return this.#hold(attempt.message.id, sessionId, attempt.attemptCount, attempt.route.targetComputerId);
    }
    const runtime = await this.#assembleTargetRuntime(attempt, sessionId);
    if (signal?.aborted) return response(attempt.message.id, "unknown", sessionId, "runtime_unavailable");
    if (!runtime) {
      if (local && this.#canHold(attempt.route.targetComputerId, { code: "runtime_not_ready" })) {
        return this.#hold(attempt.message.id, sessionId, attempt.attemptCount, attempt.route.targetComputerId);
      }
      return this.#record(
        response(attempt.message.id, "unreachable", sessionId, "runtime_not_ready"),
        attempt.attemptCount,
      );
    }
    // Cloud targets execute on their own Session-scoped Sandbox Runner, never on the Local
    // Computer's connection registry; there is no Local reconcile step — the assembled snapshot
    // rides in the dispatch and the allocation/Runner fence is the delivery boundary.
    if (attempt.route.targetComputerKind === "cloud") {
      return this.#deliverCloud(attempt, sessionId, runtime, signal);
    }
    return this.#deliverLocalWithinBudget(
      attempt,
      sessionId,
      runtime,
      attempt.attemptCount,
      inlineLocalMessage,
      signal,
    );
  }

  /**
   * A sender gets its answer quickly even when the Client does not respond. Past the budget the row is
   * marked held first, so a Server that stops now still delivers, and the hand-off keeps going. A failure
   * it finds later reaches the sender as a notice, because the sender has already been told `accepted`.
   */
  async #deliverLocalWithinBudget(
    attempt: SessionMessageAttempt,
    sessionId: string,
    runtime: EffectiveRuntimeSnapshot,
    attemptCount: number,
    inlineLocalMessage: boolean,
    signal?: AbortSignal,
  ): Promise<SessionCliCommandResponse> {
    const custody: HandOffCustody = { heldByServer: false };
    const messageId = attempt.message.id;
    this.#inFlightHandOffs.add(messageId);
    const work = this.#deliverLocal(
      attempt,
      sessionId,
      runtime,
      attemptCount,
      inlineLocalMessage,
      custody,
      signal,
    ).finally(() => {
      this.#inFlightHandOffs.delete(messageId);
    });
    // A signal means background work with no waiting sender, whose owner must drain it before shutdown.
    if (signal) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.#sendBudgetMs);
      timer.unref?.();
    });
    const answered = await Promise.race([work, budget]);
    clearTimeout(timer);
    if (answered) return answered;
    const computerId = attempt.route.targetComputerId;
    if (!this.#canHold(computerId, { code: "runtime_not_ready" })) return work;
    // From here the sender holds an `accepted` and may disconnect, so its connection stops being authority.
    custody.heldByServer = true;
    await this.#sessions.markMessageHeld(messageId, attemptCount);
    void work
      .then((result) => this.#notifyAfterLateFailure(attempt, attemptCount, result))
      .catch(() => {
        this.#logInternalFailure("SESSION_HELD_LATE_HAND_OFF_FAILED", { messageId });
      })
      // Only now may a redelivery run: this attempt no longer owns the row, and later messages can go.
      .finally(() => this.#onHeld?.(computerId, { flushNow: true }));
    return response(messageId, "accepted", sessionId);
  }

  async #notifyAfterLateFailure(
    attempt: SessionMessageAttempt,
    attemptCount: number,
    result: SessionCliCommandResponse,
  ): Promise<void> {
    // A lost attempt fence means a redelivery took over, and that redelivery owns the final answer.
    if (result.status === "accepted" || result.code === "outcome_write_failed") return;
    await this.#notifySenderOfFailure(
      {
        id: attempt.message.id,
        sourceSessionId: attempt.route.sourceSessionId,
        scheduledOrigin: null,
        targetSessionId: attempt.route.targetSessionId,
        targetCreatorSessionId: attempt.route.targetCreatorSessionId,
        agentId: attempt.route.agentId,
        content: attempt.message.content,
        attemptCount,
        createdAt: attempt.message.createdAt,
        lastAttemptAt: attempt.message.lastAttemptAt,
      },
      result.code ?? "target_unavailable",
    );
  }

  /** Local target dispatch; a temporary failure is held for a Client that can be redelivered to. */
  async #deliverLocal(
    attempt: SessionMessageAttempt,
    sessionId: string,
    runtime: EffectiveRuntimeSnapshot,
    attemptCount: number,
    inlineLocalMessage: boolean,
    custody: HandOffCustody,
    signal?: AbortSignal,
  ): Promise<SessionCliCommandResponse> {
    const handOff = await this.#handOffLocal(
      {
        route: attempt.route,
        messageId: attempt.message.id,
        sourceSessionId: attempt.route.sourceSessionId,
        content: attempt.message.content,
        creatorSessionId: attempt.route.targetCreatorSessionId ?? attempt.route.sourceSessionId,
        inlineMessage: inlineLocalMessage,
      },
      runtime,
      (operation) =>
        custody.heldByServer
          ? this.#sessions.withHeldDispatchAdmission(attempt.route, operation)
          : this.#sessions.withCollaborationDispatchAdmission(attempt.route, operation),
      signal,
    );
    // Cancelled before the offer: no frame left, and the caller keeps its own custody and retries.
    if (handOff.kind === "aborted") return response(attempt.message.id, "unknown", sessionId, "runtime_unavailable");
    if (handOff.kind === "accepted") {
      return this.#record(response(attempt.message.id, "accepted", sessionId), attemptCount);
    }
    if (handOff.kind === "rejected") {
      return this.#record(response(attempt.message.id, "rejected", sessionId, handOff.code), attemptCount);
    }
    const heldAnyway = handOff.kind === "refused" && custody.heldByServer;
    if (heldAnyway || (handOff.kind === "temporary" && this.#canHold(attempt.route.targetComputerId, handOff))) {
      return this.#hold(attempt.message.id, sessionId, attemptCount, attempt.route.targetComputerId);
    }
    const uncertain = handOff.code === "delivery_timeout";
    return this.#record(
      response(attempt.message.id, uncertain ? "unknown" : "unreachable", sessionId, handOff.code),
      attemptCount,
    );
  }

  /** Prepare the target and offer it the message over the reconcile and delivery boundaries. */
  async #handOffLocal(
    input: LocalHandOffInput,
    runtime: EffectiveRuntimeSnapshot,
    admission: DispatchAdmission,
    signal?: AbortSignal,
  ): Promise<LocalHandOff> {
    const gate = this.#localHandOffGate(input.route);
    if ("code" in gate) return { kind: "temporary", code: gate.code };
    const answered = await this.#reconcileForHandOff(input, gate.instanceId, runtime, admission, signal);
    if (answered) return answered;
    if (signal?.aborted) return { kind: "aborted" };
    return this.#offerLocal(input, gate.instanceId, runtime, admission, signal);
  }

  #localHandOffGate(route: AuthorizedHeldMessageRoute): { instanceId: string } | { code: string } {
    const instanceId = this.#registry.currentInstanceId(route.targetComputerId);
    if (
      !instanceId ||
      !this.#registry.supportsCapability(route.targetComputerId, instanceId, RUNTIME_CAPABILITY.sessionCollaboration)
    ) {
      return { code: "runtime_unavailable" };
    }
    const grant = this.#registry.capabilityVersion(
      route.targetComputerId,
      instanceId,
      RUNTIME_CAPABILITY.imCredentialGrant,
    );
    if (route.targetSessionKind !== "internal" && grant !== 2) return { code: "outbox_unavailable" };
    return { instanceId };
  }

  /** Answers undefined when the message still needs its own delivery frame. */
  async #reconcileForHandOff(
    input: LocalHandOffInput,
    instanceId: string,
    runtime: EffectiveRuntimeSnapshot,
    admission: DispatchAdmission,
    signal?: AbortSignal,
  ): Promise<LocalHandOff | undefined> {
    const { route, creatorSessionId } = input;
    const inline =
      input.inlineMessage === true &&
      this.#registry.capabilityVersion(
        route.targetComputerId,
        instanceId,
        RUNTIME_CAPABILITY.sessionMessageReconcile,
      ) === 1;
    const prepared = await this.#sendHandOffReconcile(
      route,
      instanceId,
      {
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: route.targetInstallationId,
        sessionId: route.targetSessionId,
        agentId: route.agentId,
        placementGeneration: route.targetPlacementGeneration,
        ...(route.targetSessionKind === "internal" && creatorSessionId
          ? { sessionKind: "internal" as const, creatorSessionId }
          : {}),
        desired: "ready",
        runtime,
        ...(inline
          ? {
              sessionMessage: {
                messageId: input.messageId,
                sourceSessionId: input.sourceSessionId,
                content: { kind: "text" as const, text: input.content },
              },
            }
          : {}),
      },
      admission,
      signal,
    );
    if ("handOff" in prepared) return prepared.handOff;
    const { result } = prepared;
    if (!["ready", "running", "reporting"].includes(result.status)) {
      return { kind: "temporary", code: "runtime_not_ready" };
    }
    if (result.sessionMessage && result.sessionMessage !== "deferred") return handOffOfDelivery(result.sessionMessage);
    return undefined;
  }

  /**
   * A combined frame the Client may have taken has no provable outcome. Held delivery can offer it again,
   * because the Client deduplicates by message ID; without holding it stays `unknown`, and is not resent.
   */
  async #sendHandOffReconcile(
    route: AuthorizedHeldMessageRoute,
    instanceId: string,
    request: SessionReconcileRequest,
    admission: DispatchAdmission,
    signal?: AbortSignal,
  ): Promise<{ result: SessionReconcileResult } | { handOff: LocalHandOff }> {
    const send = (frame: SessionReconcileRequest, onDispatched?: () => void) =>
      this.#domain.requestReconcile(route.targetComputerId, instanceId, frame, onDispatched, admission, signal, {
        joinSettlement: Boolean(signal),
      });
    let inline = request.sessionMessage !== undefined;
    let dispatched = false;
    const onDispatched = () => {
      dispatched = true;
    };
    try {
      const result = await send(request, inline ? onDispatched : undefined).catch((error: unknown) => {
        if (!(inline && error instanceof RuntimeRegistrySendError && error.code === "frame_too_large")) throw error;
        // The registry refused this frame before sending. Each of the original frames can still fit.
        inline = false;
        return send({ ...request, requestId: randomUUID(), sessionMessage: undefined });
      });
      if (inline && result.sessionMessage === undefined) return { handOff: UNCONFIRMED_HAND_OFF };
      return { result };
    } catch (error) {
      if (isAdmissionRefusal(error)) return { handOff: { kind: "refused", code: "runtime_not_ready" } };
      const unconfirmed =
        dispatched ||
        deliveryOutcomeUnknown(error, signal) ||
        (error instanceof RuntimeRegistrySendError && error.mayHaveSent) ||
        (error instanceof RuntimeDomainRequestError && error.code === "delivery_unconfirmed");
      if (inline && unconfirmed) return { handOff: UNCONFIRMED_HAND_OFF };
      return { handOff: { kind: "temporary", code: "runtime_not_ready" } };
    }
  }

  async #offerLocal(
    input: LocalHandOffInput,
    instanceId: string,
    runtime: EffectiveRuntimeSnapshot,
    admission: DispatchAdmission,
    signal?: AbortSignal,
  ): Promise<LocalHandOff> {
    const { route } = input;
    const delivery: SessionMessageDeliveryRequest = {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: input.messageId,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: route.targetSessionId,
      agentId: route.agentId,
      placementGeneration: route.targetPlacementGeneration,
      content: { kind: "text", text: input.content },
      runtime,
    };
    try {
      return handOffOfDelivery(
        await this.#domain.requestSessionMessageDelivery(
          route.targetComputerId,
          instanceId,
          delivery,
          undefined,
          admission,
          ...(signal ? ([signal] as const) : []),
        ),
      );
    } catch (error) {
      if (isAdmissionRefusal(error)) return { kind: "refused", code: "runtime_unavailable" };
      return {
        kind: "temporary",
        code: deliveryOutcomeUnknown(error, signal) ? "delivery_timeout" : "runtime_unavailable",
      };
    }
  }

  /**
   * Whether a temporary failure may be held. A Client older than the replay fix answers a replay of
   * a message it refused with a false `accepted`, so a refusal from a connected Client is held only
   * once it has negotiated `runtime.sessionRecovery`. That capability shipped just before the fix. With
   * no connection nothing was refused, so the first redelivery is safe whatever the Client turns out to be.
   */
  #canHold(computerId: string, handOff: { code: string }): boolean {
    if (!HOLDABLE_LOCAL_CODES.has(handOff.code)) return false;
    const instanceId = this.#registry.currentInstanceId(computerId);
    if (!instanceId) return true;
    return this.#registry.supportsCapability(computerId, instanceId, RUNTIME_CAPABILITY.sessionRecovery);
  }

  #heldHasRoom(targetSessionId: string, computerId: string): Promise<boolean> {
    return this.#sessions.heldHasRoom(targetSessionId, computerId, heldMessageCutoff(Date.now()), this.#heldLimits);
  }

  /**
   * Keep the message and answer the sender as received: from here a delivery failure reaches the
   * sender only as a later notice.
   */
  async #hold(
    messageId: string,
    sessionId: string,
    attemptCount: number,
    computerId: string,
  ): Promise<SessionCliCommandResponse> {
    // A full hold answers now: the sender has not been told `accepted` yet, so this is its notice.
    if (!(await this.#heldHasRoom(sessionId, computerId))) {
      return this.#record(response(messageId, "unreachable", sessionId, SESSION_MESSAGE_HELD_FULL_CODE), attemptCount);
    }
    const held = await this.#record(response(messageId, "unknown", sessionId, SESSION_MESSAGE_HELD_CODE), attemptCount);
    if (held.code !== SESSION_MESSAGE_HELD_CODE) return held;
    this.#onHeld?.(computerId);
    return response(messageId, "accepted", sessionId);
  }

  /**
   * Offer one held message to its target again. `held` means it stays held and later messages to the
   * same target must wait; `settled` means it has a final answer and the next one may go.
   */
  async redeliverHeld(message: HeldSessionMessage): Promise<"held" | "settled"> {
    if (!message.agentId || this.#inFlightHandOffs.has(message.id)) return "held";
    const resolved = await this.#sessions.resolveScheduledMessageRoute(message.targetSessionId, message.agentId);
    if (resolved.kind === "temporary") return "held";
    if (resolved.kind === "permanent") {
      return this.#giveUpHeld(message, message.attemptCount, "rejected", resolved.code);
    }
    if (resolved.route.targetComputerKind !== "local") {
      return this.#giveUpHeld(message, message.attemptCount, "unreachable", "runtime_unavailable");
    }
    const attemptCount = await this.#sessions.beginHeldAttempt(message.id, message.attemptCount);
    if (attemptCount === undefined) return "held";
    const route: AuthorizedHeldMessageRoute = {
      ...resolved.route,
      targetCreatorSessionId: message.targetCreatorSessionId,
    };
    return message.scheduledOrigin
      ? this.#redeliverHeldScheduled(message, message.scheduledOrigin, route, attemptCount)
      : this.#redeliverHeldOrdinary(message, route, attemptCount);
  }

  async #redeliverHeldOrdinary(
    message: HeldSessionMessage,
    route: AuthorizedHeldMessageRoute,
    attemptCount: number,
  ): Promise<"held" | "settled"> {
    if (!message.sourceSessionId) return "held";
    const runtime = await this.#assembleHeldRuntime(message);
    if (!runtime) return "held";
    const handOff = await this.#handOffLocal(
      {
        route,
        messageId: message.id,
        sourceSessionId: message.sourceSessionId,
        content: message.content,
        creatorSessionId: message.targetCreatorSessionId,
      },
      runtime,
      (operation) => this.#sessions.withHeldDispatchAdmission(route, operation),
    );
    if (handOff.kind === "accepted") {
      const recorded = await this.#record(response(message.id, "accepted", message.targetSessionId), attemptCount);
      return recorded.status === "accepted" ? "settled" : "held";
    }
    if (handOff.kind === "rejected") return this.#giveUpHeld(message, attemptCount, "rejected", handOff.code);
    // A refused admission is the target's authority, not the Client: it recovers, or the route or expiry settles it.
    if (handOff.kind === "refused" || handOff.kind === "aborted" || this.#canHold(route.targetComputerId, handOff)) {
      return "held";
    }
    return this.#giveUpHeld(message, attemptCount, "unreachable", handOff.code);
  }

  async #redeliverHeldScheduled(
    message: HeldSessionMessage,
    origin: SessionMessageScheduledOrigin,
    route: AuthorizedHeldMessageRoute,
    attemptCount: number,
  ): Promise<"held" | "settled"> {
    const schedule = await this.#sessions.readHeldSchedule(origin.scheduleId);
    const replaced = heldScheduleReplacement(schedule, message);
    if (replaced) return this.#giveUpHeld(message, attemptCount, "unreachable", replaced);
    const detailUrl = this.#scheduleDetailUrl?.(route.agentId, origin.scheduleId);
    if (!detailUrl) return "held";
    const snapshot: ScheduledMessageSnapshot = {
      scheduleId: origin.scheduleId,
      revision: schedule?.revision ?? 0,
      agentId: route.agentId,
      targetSessionId: message.targetSessionId,
      messageId: message.id,
      content: message.content,
      origin,
      attemptedAt: new Date(),
      detailUrl,
      attemptCount,
      // Only a Cloud hand-off reads this deadline; held delivery is Local, and it bounds itself by the next occurrence.
      nextTriggerAt: null,
    };
    const runtime = await this.#assembleHeldRuntime(message);
    if (!runtime) return "held";
    let stillHeld = false;
    const controller = new AbortController();
    const timer = startBudgetTimer(controller, this.#scheduledLocalBudgetMs);
    try {
      await this.#deliverScheduledLocal(snapshot, route, runtime, controller.signal, (outcome, code) => {
        if (outcome === "unreachable" && code && this.#canHold(route.targetComputerId, { code })) {
          stillHeld = true;
          return Promise.resolve({ outcome: "unknown", code: SESSION_MESSAGE_HELD_CODE });
        }
        return this.#recordScheduled(snapshot, outcome, code).then(async (recorded) => {
          stillHeld = recorded.code === "outcome_write_failed";
          if (!stillHeld && code) await this.#reportHeldScheduledMiss(message, origin, outcome, code);
          return recorded;
        });
      });
    } finally {
      clearTimeout(timer);
    }
    return stillHeld ? "held" : "settled";
  }

  async #assembleHeldRuntime(message: HeldSessionMessage): Promise<EffectiveRuntimeSnapshot | undefined> {
    try {
      return await this.#assembler.assembleForSession(message.targetSessionId);
    } catch {
      this.#logInternalFailure("SESSION_COLLABORATION_RUNTIME_ASSEMBLY_FAILED", {
        messageId: message.id,
        targetSessionId: message.targetSessionId,
      });
      return undefined;
    }
  }

  /** Give up a message past its expiry; a concurrent final answer wins the attempt fence. */
  async expireHeld(message: HeldSessionMessage): Promise<void> {
    await this.#giveUpHeld(message, message.attemptCount, "unreachable", SESSION_MESSAGE_HELD_EXPIRED_CODE);
  }

  async #giveUpHeld(
    message: HeldSessionMessage,
    attemptCount: number,
    outcome: "rejected" | "unreachable",
    code: string,
  ): Promise<"held" | "settled"> {
    const updated = await this.#sessions.recordMessageOutcome({
      messageId: message.id,
      attemptCount,
      outcome,
      errorCode: code,
      expectHeld: true,
      ...(message.scheduledOrigin
        ? {
            scheduleSummary: {
              scheduleId: message.scheduledOrigin.scheduleId,
              scheduledFor: message.scheduledOrigin.scheduledFor,
              attemptedAt: new Date().toISOString(),
            },
          }
        : {}),
    });
    if (!updated) return "held";
    if (message.scheduledOrigin) await this.#reportHeldScheduledMiss(message, message.scheduledOrigin, outcome, code);
    await this.#notifySenderOfFailure(message, code);
    return "settled";
  }

  /** A message that became held after its target ended, such as a first hand-off in flight during a stop. */
  async settleEndedTargetHeld(message: HeldSessionMessage): Promise<void> {
    await this.#giveUpHeld(message, message.attemptCount, "rejected", SESSION_MESSAGE_TARGET_STOPPED_CODE);
  }

  /**
   * Drop a held occurrence that a later occurrence or a schedule change replaced, even while its
   * Computer is offline, so the conversation hears about it without waiting for the Client or the expiry.
   */
  async settleReplacedHeld(message: HeldSessionMessage): Promise<void> {
    if (!message.scheduledOrigin) return;
    const replaced = heldScheduleReplacement(
      await this.#sessions.readHeldSchedule(message.scheduledOrigin.scheduleId),
      message,
    );
    if (replaced) await this.#giveUpHeld(message, message.attemptCount, "unreachable", replaced);
  }

  /**
   * A held occurrence ends here, not in the scheduler, so its conversation hears about it through this
   * path. The previous occurrence stands in for the summary a later claim has overwritten.
   */
  async #reportHeldScheduledMiss(
    message: HeldSessionMessage,
    origin: SessionMessageScheduledOrigin,
    outcome: SessionMessageOutcome,
    code: string,
  ): Promise<void> {
    if (!this.#onHeldScheduledMiss || outcome === "accepted") return;
    this.#onHeldScheduledMiss({
      occurrence: {
        agentId: message.agentId ?? "",
        name: origin.name,
        prompt: message.content,
        scheduleId: origin.scheduleId,
        scheduledFor: origin.scheduledFor,
        targetSessionId: message.targetSessionId,
        timezone: origin.timezone,
      },
      outcome,
      code,
      previous: await this.#sessions.readPreviousScheduledOutcome(message.targetSessionId, origin.scheduleId, message),
    });
  }

  /**
   * Tell the sender a message it was told was received will not arrive. A scheduled message has no
   * sender, its schedule summary carries the answer. A failed notice is only logged, so two Sessions
   * can never exchange notices. A sender that ended, or that is not on a Local Computer, is logged too.
   */
  async #notifySenderOfFailure(message: HeldSessionMessage, code: string): Promise<void> {
    const failure = { code, messageId: message.id, targetSessionId: message.targetSessionId };
    if (!message.sourceSessionId) return;
    if (isDeliveryFailureNotice(message) || isRunOutcomeNotice(message)) {
      this.#logInternalFailure("SESSION_DELIVERY_FAILURE_NOTICE_UNDELIVERED", failure);
      return;
    }
    const recorded = await this.#sessions.recordDeliveryFailureNotice({
      noticeId: deliveryFailureNoticeMessageId(message.id),
      failedTargetSessionId: message.targetSessionId,
      senderSessionId: message.sourceSessionId,
      content: renderDeliveryFailureNotice({ messageId: message.id, targetSessionId: message.targetSessionId, code }),
    });
    if (recorded) this.#onHeld?.(recorded.computerId);
    else this.#logInternalFailure("SESSION_DELIVERY_FAILURE_NOTICE_UNROUTABLE", failure);
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
    signal?: AbortSignal,
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
        ...(signal ? ([signal] as const) : []),
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
    const mapped = mapExpectedFailure(error);
    if (mapped) return response(messageId, mapped.status, undefined, mapped.code);
    this.#onDiagnostic?.("SESSION_COLLABORATION_RUNTIME_UNAVAILABLE");
    return response(messageId, "unreachable", undefined, "runtime_unavailable");
  }
}

function deliveryOutcomeUnknown(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof RuntimeDomainRequestError && error.code === "timeout");
}

/** The answer speaks for the whole tree, so it reports the Session the stop reached least. */
function leastReachedExecution(
  targets: readonly InternalSessionStopTarget[],
  executions: ReadonlyMap<string, SessionCliStopExecution> | undefined,
): SessionCliStopExecution {
  const reached = targets.map(({ sessionId }) => executions?.get(sessionId) ?? "pending");
  return (["not_interrupted", "pending", "requested"] as const).find((value) => reached.includes(value)) ?? "stopped";
}

/** The delivery result as an outcome and a stable code. */
function mapScheduledDelivery(delivery: SessionMessageDeliveryResult): {
  outcome: SessionMessageOutcome;
  code: string | undefined;
} {
  if (delivery.status === "accepted") return { outcome: "accepted", code: undefined };
  if (delivery.reason === "session_busy" || delivery.reason === "agent_busy" || delivery.reason === "client_busy") {
    return { outcome: "unreachable", code: delivery.reason };
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

function mapExpectedFailure(error: unknown): { status: "unreachable" | "rejected"; code: string } | undefined {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "SESSION_PLACEMENT_STALE" || code === "SESSION_SOURCE_UNAVAILABLE") {
    return { status: "rejected", code: "source_unavailable" };
  }
  if (code === "SESSION_STOP_NOT_ANCESTOR") return { status: "rejected", code: "not_ancestor" };
  if (code === "SESSION_TARGET_UNAVAILABLE") return { status: "rejected", code: "target_unavailable" };
  if (code === "SESSION_SCOPE_MISMATCH") return { status: "rejected", code: "scope_mismatch" };
  if (code === "SESSION_MESSAGE_CONFLICT") return { status: "rejected", code: "message_conflict" };
  if (code === "SESSION_MESSAGE_ID_RESERVED") return { status: "rejected", code: "message_id_reserved" };
  // Router model admission for a Cloud Session override: an unoffered model is a deterministic
  // rejection; an unconfirmable model list is transient and unreachable.
  if (code === "SESSION_MODEL_UNAVAILABLE") return { status: "rejected", code: "model_unavailable" };
  if (code === "SESSION_MODEL_CATALOG_UNAVAILABLE") return { status: "unreachable", code: "model_unavailable" };
  return undefined;
}

function response(
  messageId: string,
  status: SessionCliCommandResponse["status"],
  sessionId?: string,
  code?: string,
): SessionCliCommandResponse {
  return { messageId, status, ...(sessionId ? { sessionId } : {}), ...(code ? { code } : {}) };
}
