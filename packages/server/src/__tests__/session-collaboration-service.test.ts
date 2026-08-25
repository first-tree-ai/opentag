import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";

describe("SessionCollaborationService", () => {
  it("rejects an unnegotiated command before touching Session authority", async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.handle(sendCommand(), context({ negotiatedCapabilities: {} }));
    expect(result).toMatchObject({ status: "rejected", code: "configuration_unsupported" });
    expect(fixture.sessions.authorizeAndRecordMessage).not.toHaveBeenCalled();
  });

  it("emits a body-free diagnostic for an authority rejection", async () => {
    const fixture = serviceFixture();
    fixture.sessions.authorizeAndRecordMessage.mockRejectedValue(
      Object.assign(new Error("scope mismatch"), { code: "SESSION_SCOPE_MISMATCH" }),
    );

    const result = await fixture.service.handle(sendCommand(), context());

    expect(result).toMatchObject({ status: "rejected", code: "scope_mismatch" });
    expect(fixture.onDiagnostic).toHaveBeenCalledWith("SESSION_COLLABORATION_SCOPE_MISMATCH");
  });

  it("returns a durable accepted result without reconciling or relaying it again", async () => {
    const fixture = serviceFixture({ attempt: attempt({ attemptCount: null, lastOutcome: "accepted" }) });
    const result = await fixture.service.handle(sendCommand(), context());
    expect(result).toMatchObject({ status: "accepted" });
    expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
  });

  it("keeps the created Session identity when initial delivery is unreachable", async () => {
    const created = attempt();
    const sessionId = created.route.targetSessionId;
    const fixture = serviceFixture({ createAttempt: created });
    fixture.domain.requestReconcile.mockRejectedValue(new Error("runtime unavailable"));
    const command = createCommand();

    const result = await fixture.service.handle(command, context());

    expect(result).toMatchObject({
      status: "unreachable",
      code: "runtime_not_ready",
      messageId: command.initialMessage.messageId,
      sessionId,
    });
    expect(fixture.sessions.createInternalSessionWithMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: command.initialMessage.messageId,
        initialMessage: command.initialMessage.text,
      }),
    );
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith({
      messageId: command.initialMessage.messageId,
      attemptCount: 1,
      outcome: "unreachable",
      errorCode: "runtime_not_ready",
    });
  });

  it("completes a local fast path only after the Client result is fenced into the durable fact", async () => {
    const sourceContext = context();
    const fixture = serviceFixture({
      sourceComputerId: sourceContext.computerId,
      sourceInstanceId: sourceContext.instanceId,
    });
    const command = sendCommand();
    const local = await fixture.service.handle(command, sourceContext);
    expect(local).toMatchObject({ status: "local", delivery: { messageId: command.messageId } });
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();

    const completed = await fixture.service.handleLocalDeliveryResult(
      {
        type: "session:message:deliver:result",
        requestId: local.delivery?.requestId ?? randomUUID(),
        messageId: command.messageId,
        targetSessionId: command.targetSessionId,
        placementGeneration: 1,
        status: "accepted",
      },
      sourceContext,
    );
    expect(completed).toMatchObject({ status: "accepted", requestId: command.requestId });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith({
      messageId: command.messageId,
      attemptCount: 1,
      outcome: "accepted",
    });
  });

  it("persists remote timeouts as unknown and reports an outcome-write failure as unknown", async () => {
    const fixture = serviceFixture();
    fixture.domain.requestSessionMessageDelivery.mockRejectedValue(
      new RuntimeDomainRequestError("timeout", "confirmation was lost"),
    );
    fixture.sessions.recordMessageOutcome.mockResolvedValue(false);
    const result = await fixture.service.handle(sendCommand(), context());
    expect(result).toMatchObject({ status: "unknown", code: "outcome_write_failed" });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ attemptCount: 1, outcome: "unknown", errorCode: "delivery_timeout" }),
    );
  });

  it("persists transient target admission as unreachable and allows an explicit retry attempt", async () => {
    const fixture = serviceFixture();
    const command = {
      ...sendCommand(),
      messageId: fixture.messageAttempt.message.id,
      targetSessionId: fixture.messageAttempt.route.targetSessionId,
    };
    fixture.domain.requestSessionMessageDelivery.mockResolvedValueOnce({
      type: "session:message:deliver:result",
      requestId: randomUUID(),
      messageId: command.messageId,
      targetSessionId: command.targetSessionId,
      placementGeneration: 1,
      status: "rejected",
      reason: "stale_generation",
    });

    await expect(fixture.service.handle(command, context())).resolves.toMatchObject({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    fixture.messageAttempt.attemptCount = 2;
    await expect(fixture.service.handle(command, context())).resolves.toMatchObject({ status: "accepted" });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenNthCalledWith(1, {
      messageId: command.messageId,
      attemptCount: 1,
      outcome: "unreachable",
      errorCode: "runtime_not_ready",
    });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenNthCalledWith(2, {
      messageId: command.messageId,
      attemptCount: 2,
      outcome: "accepted",
    });
  });
});

function serviceFixture(
  options: {
    attempt?: ReturnType<typeof attempt>;
    createAttempt?: ReturnType<typeof attempt>;
    sourceComputerId?: string;
    sourceInstanceId?: string;
  } = {},
) {
  const messageAttempt = options.attempt ?? attempt();
  if (options.sourceComputerId) messageAttempt.route.targetComputerId = options.sourceComputerId;
  const sessions = {
    authorizeAndRecordMessage: vi
      .fn()
      .mockImplementation(
        async (input: { content: string; messageId: string; sourceSessionId: string; targetSessionId: string }) => ({
          ...messageAttempt,
          route: {
            ...messageAttempt.route,
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
          },
          message: {
            ...messageAttempt.message,
            id: input.messageId,
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
            content: input.content,
          },
        }),
      ),
    createInternalSessionWithMessage: vi.fn(async (input: { initialMessage: string; messageId: string }) => {
      const created = options.createAttempt ?? messageAttempt;
      return {
        ...created,
        session: {
          id: created.route.targetSessionId,
          imBindingId: randomUUID(),
          channelId: "C1",
          conversationKind: "channel" as const,
          kind: "internal" as const,
          threadKey: null,
          createdBySessionId: created.route.sourceSessionId,
          runtimeModel: null,
          runtimeReasoningEffort: null,
          runtimeMaxDurationMs: null,
          endedAt: null,
          revision: 1,
          createdAt: new Date().toISOString(),
        },
        placement: {
          sessionId: created.route.targetSessionId,
          computerId: created.route.targetComputerId,
          generation: 1,
          updatedAt: new Date().toISOString(),
        },
        message: { ...created.message, id: input.messageId, content: input.initialMessage },
      };
    }),
    recordMessageOutcome: vi.fn().mockResolvedValue(true),
  };
  const domain = {
    requestReconcile: vi.fn().mockResolvedValue({
      type: "session:reconcile:result",
      requestId: randomUUID(),
      sessionId: messageAttempt.route.targetSessionId,
      placementGeneration: 1,
      status: "ready",
    }),
    requestSessionMessageDelivery: vi.fn().mockResolvedValue({
      type: "session:message:deliver:result",
      requestId: randomUUID(),
      messageId: messageAttempt.message.id,
      targetSessionId: messageAttempt.route.targetSessionId,
      placementGeneration: 1,
      status: "accepted",
    }),
  };
  const targetInstanceId = options.sourceInstanceId ?? randomUUID();
  const registry = {
    currentInstanceId: vi.fn().mockReturnValue(targetInstanceId),
    supportsCapability: vi.fn().mockReturnValue(true),
  };
  const onDiagnostic = vi.fn();
  return {
    domain,
    messageAttempt,
    onDiagnostic,
    sessions,
    service: new SessionCollaborationService({
      assembler: { assembleForSession: vi.fn().mockResolvedValue(snapshot(messageAttempt.route.agentId)) },
      domain: domain as never,
      onDiagnostic,
      registry,
      sessions: sessions as never,
      localResultTimeoutMs: 1_000,
    }),
  };
}

function attempt(
  overrides: { attemptCount?: number | null; lastOutcome?: "accepted" | "rejected" | "unknown" | "unreachable" } = {},
) {
  const sourceSessionId = randomUUID();
  const targetSessionId = randomUUID();
  const agentId = randomUUID();
  return {
    route: {
      agentId,
      sourceSessionId,
      targetSessionId,
      targetComputerId: String(randomUUID()),
      targetPlacementGeneration: 1,
      targetSessionKind: "internal" as const,
    },
    message: {
      id: randomUUID(),
      sourceSessionId,
      targetSessionId,
      content: "hello",
      contentHash: "a".repeat(64),
      lastOutcome: overrides.lastOutcome ?? "unknown",
      lastErrorCode: null,
      attemptCount: overrides.attemptCount === undefined ? 1 : (overrides.attemptCount ?? 1),
      lastAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    deduplicated: overrides.attemptCount === null,
    attemptCount: overrides.attemptCount === undefined ? 1 : overrides.attemptCount,
  };
}

function sendCommand() {
  return {
    type: "session:message" as const,
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    sourcePlacementGeneration: 1,
    targetSessionId: randomUUID(),
    content: { kind: "text" as const, text: "hello" },
  };
}

function createCommand() {
  return {
    type: "session:internal:create" as const,
    requestId: randomUUID(),
    sourceSessionId: randomUUID(),
    sourcePlacementGeneration: 1,
    initialMessage: { messageId: randomUUID(), text: "Investigate" },
  };
}

function context(overrides: Partial<RuntimeBusinessContext> = {}): RuntimeBusinessContext {
  return {
    computerId: randomUUID(),
    instanceId: randomUUID(),
    negotiatedCapabilities: { [RUNTIME_CAPABILITY.sessionCollaboration]: 1 },
    signal: new AbortController().signal,
    userId: randomUUID(),
    ...overrides,
  };
}

function snapshot(agentId: string) {
  return {
    revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never" as const, networkAccess: true },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
}
