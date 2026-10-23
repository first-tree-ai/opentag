import { randomUUID } from "node:crypto";
import type { SessionMessageDeliveryResult, SessionReconcileResult } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RuntimeDispatchAdmission, RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import {
  type ScheduledMessageSnapshot,
  SessionCollaborationService,
} from "../services/sessions/session-collaboration-service.js";
import type { AuthorizedScheduledMessageRoute } from "../services/sessions/session-service.js";

/*
 * The scheduled hand-off with a mocked Session service: the one-shot fence, the trusted-origin
 * resolution branches, the v3 capability gate, the total-budget AbortSignal (including a hang in
 * the admission wait and in the receipt wait), and the Cloud short-circuit. No fake here ever
 * hangs a real database transaction, so these can probe the abort boundaries precisely.
 */

const T0 = new Date("2026-09-28T01:00:00.000Z");

function snapshotFixture(): { snapshot: ScheduledMessageSnapshot; route: AuthorizedScheduledMessageRoute } {
  const scheduleId = randomUUID();
  const route: AuthorizedScheduledMessageRoute = {
    agentId: randomUUID(),
    imBindingId: randomUUID(),
    targetSessionId: randomUUID(),
    targetSessionKind: "channel",
    targetInstallationId: randomUUID(),
    targetComputerId: randomUUID(),
    targetComputerKind: "local",
    targetPlacementGeneration: 1,
  };
  return {
    route,
    snapshot: {
      scheduleId,
      revision: 7,
      agentId: route.agentId,
      targetSessionId: route.targetSessionId,
      messageId: randomUUID(),
      content: "Check the build.",
      origin: {
        scheduleId,
        scheduledFor: T0.toISOString(),
        timezone: "Asia/Shanghai",
        name: "Daily check",
      },
      attemptedAt: T0,
      detailUrl: `https://opentag.example.com/agents/${route.agentId}?schedule=${scheduleId}`,
    },
  };
}

function runtimeSnapshot(agentId: string) {
  return {
    contextTrees: [],
    revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never" as const, networkAccess: true },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
}

interface Fixture {
  service: SessionCollaborationService;
  sessions: {
    beginScheduledMessageAttempt: ReturnType<typeof vi.fn>;
    resolveScheduledMessageRoute: ReturnType<typeof vi.fn>;
    disableScheduleForInvalidTarget: ReturnType<typeof vi.fn>;
    recordMessageOutcome: ReturnType<typeof vi.fn>;
    withScheduledDispatchAdmission: ReturnType<typeof vi.fn>;
  };
  domain: {
    requestReconcile: ReturnType<typeof vi.fn>;
    requestSessionMessageDelivery: ReturnType<typeof vi.fn>;
  };
  registry: {
    currentInstanceId: ReturnType<typeof vi.fn>;
    capabilityVersion: ReturnType<typeof vi.fn>;
    supportsCapability: ReturnType<typeof vi.fn>;
  };
  cloud: { deliver: ReturnType<typeof vi.fn> };
  logger: { error: ReturnType<typeof vi.fn> };
}

async function dispatchWithAdmission<T>(
  operation: () => Promise<T>,
  admission?: RuntimeDispatchAdmission<T>,
  onDispatched?: () => void,
): Promise<T> {
  const send = (mark?: () => void) => {
    mark?.();
    onDispatched?.();
    return operation();
  };
  if (!admission) return send();
  const admitted = await admission(send);
  if (!admitted.admitted) throw new RuntimeDomainRequestError("authority_unavailable", "Admission rejected");
  return admitted.result;
}

function makeFixture(
  route: AuthorizedScheduledMessageRoute,
  options: {
    budgets?: { localMs?: number; cloudMs?: number };
    /** Refuse the admission with `dispatch_not_marked` from this stage number onwards. */
    refuseFrom?: number;
  } = {},
): Fixture {
  let admissionCalls = 0;
  const sessions = {
    beginScheduledMessageAttempt: vi.fn(async () => ({ id: "fenced" })),
    resolveScheduledMessageRoute: vi.fn(async () => ({ kind: "route" as const, route })),
    disableScheduleForInvalidTarget: vi.fn(async () => undefined),
    recordMessageOutcome: vi.fn(async () => true),
    withScheduledDispatchAdmission: vi.fn(
      async (
        _route: AuthorizedScheduledMessageRoute,
        _fence: unknown,
        operation: (onDispatched: () => void) => Promise<unknown>,
      ) => {
        // Mirror the real admission: the operation runs under the "locks" and the outer promise
        // resolves once the send is marked, while the result promise carries the receipt wait.
        admissionCalls += 1;
        if (options.refuseFrom !== undefined && admissionCalls >= options.refuseFrom) {
          // The real refusal happens after the transport was already asked to send, and the mark
          // never arrives inside the window.
          const abandoned = operation(() => undefined);
          void abandoned.catch(() => undefined);
          return { admitted: false as const, reason: "dispatch_not_marked" as const };
        }
        let mark: () => void = () => undefined;
        const dispatched = new Promise<void>((resolve) => (mark = resolve));
        const result = operation(mark);
        void result.catch(() => mark());
        await dispatched;
        return { admitted: true as const, result };
      },
    ),
  };
  const domain = {
    requestReconcile: vi.fn(
      (
        _c: string,
        _i: string,
        request: { requestId: string },
        onDispatched?: () => void,
        admission?: RuntimeDispatchAdmission<SessionReconcileResult>,
      ) =>
        dispatchWithAdmission<SessionReconcileResult>(
          async () => ({
            type: "session:reconcile:result",
            requestId: request.requestId,
            sessionId: route.targetSessionId,
            placementGeneration: 1,
            status: "ready",
          }),
          admission,
          onDispatched,
        ),
    ),
    requestSessionMessageDelivery: vi.fn(
      (
        _c: string,
        _i: string,
        request: { requestId: string; messageId: string },
        onDispatched?: () => void,
        admission?: RuntimeDispatchAdmission<SessionMessageDeliveryResult>,
      ) => {
        const result: SessionMessageDeliveryResult = {
          type: "session:message:deliver:result",
          requestId: request.requestId,
          messageId: request.messageId,
          targetSessionId: route.targetSessionId,
          placementGeneration: 1,
          status: "accepted",
        };
        return dispatchWithAdmission(async () => result, admission, onDispatched);
      },
    ),
  };
  const registry = {
    currentInstanceId: vi.fn(() => randomUUID()),
    capabilityVersion: vi.fn((_computerId: string, _instanceId: string, capability: string) => {
      if (capability === "runtime.sessionCollaboration") return 3;
      if (capability === "runtime.imCredentialGrant") return 2;
      return undefined;
    }),
    supportsCapability: vi.fn(() => true),
  };
  const cloud = { deliver: vi.fn(async () => ({ status: "accepted" as const })) };
  const logger = { error: vi.fn() };
  const service = new SessionCollaborationService({
    assembler: { assembleForSession: vi.fn(async () => runtimeSnapshot(route.agentId)) },
    domain: domain as never,
    registry: registry as never,
    sessions: sessions as never,
    cloud: cloud as never,
    logger,
    scheduledBudgets: options.budgets,
  });
  return { service, sessions, domain, registry, cloud, logger };
}

describe("SessionCollaborationService.dispatchScheduledMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers through reconcile + delivery with the frozen origin and detail link", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "accepted", code: null });
    const frame = fixture.domain.requestSessionMessageDelivery.mock.calls[0]?.[2];
    expect(frame).toMatchObject({
      type: "session:message:deliver",
      messageId: snapshot.messageId,
      scheduledOrigin: snapshot.origin,
      scheduleDetailUrl: snapshot.detailUrl,
      targetSessionId: snapshot.targetSessionId,
      content: { kind: "text", text: "Check the build." },
    });
    expect(frame.sourceSessionId).toBeUndefined();
    expect(typeof frame.sentAt).toBe("string");
    // The ordinary retry ladder is untouched: the scheduled fence admits exactly one attempt.
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: snapshot.messageId,
        attemptCount: 1,
        outcome: "accepted",
        scheduleSummary: {
          scheduleId: snapshot.scheduleId,
          scheduledFor: snapshot.origin.scheduledFor,
          attemptedAt: snapshot.attemptedAt.toISOString(),
        },
      }),
    );
  });

  it("never sends when the one-shot fence is already taken or the message is gone", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.sessions.beginScheduledMessageAttempt.mockResolvedValue(undefined);
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unknown", code: null });
    expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
  });

  it("keeps the claim row untouched when the dispatch was cancelled before the fence", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    const controller = new AbortController();
    controller.abort();
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot, controller.signal);
    expect(outcome).toEqual({ outcome: "unknown", code: null });
    expect(fixture.sessions.beginScheduledMessageAttempt).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
  });

  it("auto-disables and rejects on a permanently invalid target at resolution", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.sessions.resolveScheduledMessageRoute.mockResolvedValue({ kind: "permanent", code: "target_invalid" });
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "rejected", code: "target_invalid" });
    expect(fixture.sessions.disableScheduleForInvalidTarget).toHaveBeenCalledWith(snapshot.scheduleId);
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "rejected", errorCode: "target_invalid" }),
    );
  });

  it("skips with unreachable on a temporary authority gap at resolution", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.sessions.resolveScheduledMessageRoute.mockResolvedValue({ kind: "temporary", code: "agent_suspended" });
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unreachable", code: "agent_suspended" });
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
  });

  it("refuses a v2-only peer without a single frame", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.registry.capabilityVersion.mockReturnValue(2);
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unreachable", code: "unsupported_schedule_origin" });
    expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
  });

  it("rejects with the admission's schedule gate codes and never sends", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.sessions.withScheduledDispatchAdmission.mockResolvedValue({
      admitted: false,
      reason: "schedule_changed",
    });
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "rejected", code: "schedule_changed" });
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
  });

  it("converges a hung admission wait at the budget with no frame and no unhandled rejection", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route, { budgets: { localMs: 1_000 } });
    // The admission never resolves: a stuck lock wait. The budget must cut it before any send.
    fixture.sessions.withScheduledDispatchAdmission.mockImplementation(() => new Promise(() => undefined));
    const dispatch = fixture.service.dispatchScheduledMessage(snapshot);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(dispatch).resolves.toEqual({ outcome: "unreachable", code: "delivery_timeout" });
    expect(fixture.domain.requestReconcile).toHaveBeenCalledOnce();
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unreachable", errorCode: "delivery_timeout" }),
    );
  });

  it("converges a hung receipt wait as unknown once the send was marked", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route, { budgets: { localMs: 1_000 } });
    fixture.domain.requestSessionMessageDelivery.mockImplementation((_c, _i, _request, onDispatched, admission) =>
      dispatchWithAdmission(() => new Promise(() => undefined), admission, onDispatched),
    );
    const dispatch = fixture.service.dispatchScheduledMessage(snapshot);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(dispatch).resolves.toEqual({ outcome: "unknown", code: "delivery_timeout" });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", errorCode: "delivery_timeout" }),
    );
  });

  it("covers preparation in the entry-anchored budget: a hung route resolve never sends", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route, { budgets: { localMs: 1_000, cloudMs: 1_000 } });
    // The route resolution hangs: the budget started at dispatch entry must still converge this.
    fixture.sessions.resolveScheduledMessageRoute.mockImplementation(() => new Promise(() => undefined));
    const dispatch = fixture.service.dispatchScheduledMessage(snapshot);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(dispatch).resolves.toEqual({ outcome: "unreachable", code: "delivery_timeout" });
    expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
  });

  it("treats a transport failure after the send mark as unknown, never unreachable", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.domain.requestSessionMessageDelivery.mockImplementation((_c, _i, _request, onDispatched, admission) =>
      dispatchWithAdmission(() => Promise.reject(new Error("socket collapsed")), admission, onDispatched),
    );
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unknown", code: "delivery_uncertain" });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", errorCode: "delivery_uncertain" }),
    );
  });

  it("treats a send-boundary abort from the domain owner as a provable non-send", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.domain.requestSessionMessageDelivery.mockRejectedValue(
      new RuntimeDomainRequestError("aborted", "The runtime request was aborted before it was sent"),
    );
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unreachable", code: "delivery_timeout" });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unreachable", errorCode: "delivery_timeout" }),
    );
  });

  it("maps a rejected domain timeout during the receipt wait to unknown", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.domain.requestSessionMessageDelivery.mockImplementation((_c, _i, _request, onDispatched, admission) =>
      dispatchWithAdmission(
        () => Promise.reject(new RuntimeDomainRequestError("timeout", "confirmation was lost")),
        admission,
        onDispatched,
      ),
    );
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unknown", code: "delivery_timeout" });
  });

  it("records a refused reconcile frame as unreachable: the message provably never left", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route, { refuseFrom: 1 });
    await expect(fixture.service.dispatchScheduledMessage(snapshot)).resolves.toEqual({
      outcome: "unreachable",
      code: "delivery_timeout",
    });
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unreachable", errorCode: "delivery_timeout" }),
    );
  });

  it("never records a refused business frame as unreachable: its fate is unprovable", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route, { refuseFrom: 2 });
    await expect(fixture.service.dispatchScheduledMessage(snapshot)).resolves.toEqual({
      outcome: "unknown",
      code: "delivery_timeout",
    });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", errorCode: "delivery_timeout" }),
    );
  });

  it("answers a negotiated Cloud v1 scheduled dispatch with unsupported origin", async () => {
    const { snapshot, route } = snapshotFixture();
    route.targetComputerKind = "cloud";
    const fixture = makeFixture(route);
    fixture.cloud.deliver.mockResolvedValue({ status: "unreachable", code: "unsupported_schedule_origin" });
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unreachable", code: "unsupported_schedule_origin" });
    // The Cloud input carries the scheduled origin and the detail link, never a source Session.
    expect(fixture.cloud.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ targetSessionId: snapshot.targetSessionId }),
        message: expect.objectContaining({
          id: snapshot.messageId,
          scheduledOrigin: snapshot.origin,
          scheduleDetailUrl: snapshot.detailUrl,
        }),
        attemptCount: 1,
      }),
      expect.any(Function),
    );
  });

  it("records a post-send Cloud owner refusal as unknown unless the Runner explicitly rejected capacity", async () => {
    const { snapshot, route } = snapshotFixture();
    route.targetComputerKind = "cloud";
    const fixture = makeFixture(route);
    fixture.cloud.deliver.mockImplementation(
      async (_input: unknown, admission: (operation: never) => Promise<unknown>) => {
        await admission((async (onDispatched: () => void) => {
          onDispatched();
          return {};
        }) as never);
        return { status: "unreachable", code: "runtime_not_ready" };
      },
    );
    await expect(fixture.service.dispatchScheduledMessage(snapshot)).resolves.toEqual({
      outcome: "unknown",
      code: "delivery_uncertain",
    });

    const second = snapshotFixture();
    second.route.targetComputerKind = "cloud";
    const capacity = makeFixture(second.route);
    capacity.cloud.deliver.mockImplementation(
      async (_input: unknown, admission: (operation: never) => Promise<unknown>) => {
        await admission((async (onDispatched: () => void) => {
          onDispatched();
          return {};
        }) as never);
        return { status: "unreachable", code: "capacity" };
      },
    );
    await expect(capacity.service.dispatchScheduledMessage(second.snapshot)).resolves.toEqual({
      outcome: "unreachable",
      code: "capacity",
    });
  });

  it("cuts a hung Cloud cold start at the Cloud budget and reports unreachable", async () => {
    const { snapshot, route } = snapshotFixture();
    route.targetComputerKind = "cloud";
    const fixture = makeFixture(route, { budgets: { cloudMs: 500 } });
    // A cold start that never reaches the send: the budget covers preparation and the queue.
    fixture.cloud.deliver.mockImplementation(() => new Promise(() => undefined));
    const dispatch = fixture.service.dispatchScheduledMessage(snapshot);
    await vi.advanceTimersByTimeAsync(500);
    await expect(dispatch).resolves.toEqual({ outcome: "unreachable", code: "delivery_timeout" });
  });

  it("restores the schedule gate truth when the Cloud owner denies through the admission", async () => {
    const { snapshot, route } = snapshotFixture();
    route.targetComputerKind = "cloud";
    const fixture = makeFixture(route);
    fixture.sessions.withScheduledDispatchAdmission.mockResolvedValue({
      admitted: false,
      reason: "schedule_deleted",
    });
    // The owner maps a denied admission to its generic unreachable; the scheduled reason wins.
    fixture.cloud.deliver.mockImplementation(async (_input: unknown, admission: (op: never) => unknown) => {
      await admission((() => Promise.resolve()) as never);
      return { status: "unreachable", code: "runtime_unavailable" };
    });
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "rejected", code: "schedule_deleted" });
  });

  it("reports outcome_write_failed honestly when the durable write is lost", async () => {
    const { snapshot, route } = snapshotFixture();
    const fixture = makeFixture(route);
    fixture.sessions.recordMessageOutcome.mockResolvedValue(false);
    const outcome = await fixture.service.dispatchScheduledMessage(snapshot);
    expect(outcome).toEqual({ outcome: "unknown", code: "outcome_write_failed" });
  });
});
