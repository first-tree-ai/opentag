import { randomUUID } from "node:crypto";
import type { SessionCliCreateRequest, SessionCliSendRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { RuntimeRegistrySendError } from "../runtime/connection-registry.js";
import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import type { SessionCliSourceContext } from "../services/sessions/session-cli-proof-service.js";
import { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";

describe("SessionCollaborationService", () => {
  it("returns an already accepted durable message without reconciling or delivering again", async () => {
    const fixture = serviceFixture({ attemptCount: null, lastOutcome: "accepted" });

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "accepted",
    });
    expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
  });

  it("preserves the created Session identity when its first reconcile fails", async () => {
    const fixture = serviceFixture();
    fixture.domain.requestReconcile.mockRejectedValue(new Error("runtime unavailable"));
    const request = createRequest(fixture);

    await expect(fixture.service.create(request, fixture.source)).resolves.toEqual({
      status: "unreachable",
      code: "runtime_not_ready",
      messageId: request.messageId,
      sessionId: fixture.targetSessionId,
    });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith({
      messageId: request.messageId,
      attemptCount: 1,
      outcome: "unreachable",
      errorCode: "runtime_not_ready",
    });
  });

  it("logs an assembler failure while preserving the runtime_not_ready response", async () => {
    const fixture = serviceFixture();
    fixture.assembler.assembleForSession.mockRejectedValue(new Error("assembler failed"));

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "SESSION_COLLABORATION_RUNTIME_ASSEMBLY_FAILED",
        messageId: fixture.messageId,
        sessionId: fixture.targetSessionId,
        targetSessionId: fixture.targetSessionId,
      }),
      "Session collaboration internal failure",
    );
  });

  it("records a busy target as unreachable capacity", async () => {
    const fixture = serviceFixture();
    fixture.domain.requestSessionMessageDelivery.mockResolvedValue({
      type: "session:message:deliver:result",
      requestId: randomUUID(),
      messageId: fixture.messageId,
      targetSessionId: fixture.targetSessionId,
      placementGeneration: 1,
      status: "rejected",
      reason: "session_busy",
    });

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unreachable",
      code: "capacity",
    });
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unreachable", errorCode: "capacity" }),
    );
  });

  it("records reconcile failure as unreachable without attempting delivery", async () => {
    const fixture = serviceFixture();
    fixture.domain.requestReconcile.mockResolvedValue({
      type: "session:reconcile:result",
      requestId: randomUUID(),
      sessionId: fixture.targetSessionId,
      placementGeneration: 1,
      status: "failed",
      errorCode: "provider_failed",
    });

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
  });

  it("returns the owner-elsewhere code when runtime delivery reaches a different owner", async () => {
    const fixture = serviceFixture();
    fixture.domain.requestReconcile.mockRejectedValue(
      new RuntimeRegistrySendError("instance_replaced", "The Computer instance is not current"),
    );

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unreachable",
      code: "RUNTIME_OWNER_ELSEWHERE",
    });
  });

  it("fails closed before reconcile when a visible target lacks credential grant v2", async () => {
    const fixture = serviceFixture({ targetSessionKind: "channel" });
    fixture.registry.capabilityVersion.mockReturnValue(1);

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unreachable",
      code: "outbox_unavailable",
    });
    expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unreachable", errorCode: "outbox_unavailable" }),
    );
  });

  it("records an uncertain delivery timeout as unknown and keeps it unknown if outcome fencing fails", async () => {
    const fixture = serviceFixture();
    fixture.domain.requestSessionMessageDelivery.mockRejectedValue(
      new RuntimeDomainRequestError("timeout", "confirmation was lost"),
    );
    fixture.sessions.recordMessageOutcome.mockResolvedValue(false);

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unknown",
      code: "outcome_write_failed",
    });
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "SESSION_COLLABORATION_OUTCOME_WRITE_FAILED",
        messageId: fixture.messageId,
        outcome: "unknown",
      }),
      "Session collaboration internal failure",
    );
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", errorCode: "delivery_timeout" }),
    );
  });

  it("maps source authority failures without exposing their details", async () => {
    const fixture = serviceFixture();
    fixture.sessions.authorizeAndRecordMessage.mockRejectedValue(
      Object.assign(new Error("placement is stale"), { code: "SESSION_PLACEMENT_STALE" }),
    );

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "rejected",
      code: "source_unavailable",
    });
    expect(fixture.onDiagnostic).toHaveBeenCalledWith("SESSION_COLLABORATION_SOURCE_UNAVAILABLE");
  });
});

function serviceFixture(
  options: {
    attemptCount?: number | null;
    lastOutcome?: "accepted" | "unknown";
    targetSessionKind?: "channel" | "thread" | "internal";
  } = {},
) {
  const sourceSessionId = randomUUID();
  const targetSessionId = randomUUID();
  const messageId = randomUUID();
  const agentId = randomUUID();
  const imBindingId = randomUUID();
  const targetComputerId = randomUUID();
  const targetInstallationId = randomUUID();
  const instanceId = randomUUID();
  const source: SessionCliSourceContext = {
    agentId,
    computerId: randomUUID(),
    connectionInstanceId: randomUUID(),
    placementGeneration: 1,
    sessionId: sourceSessionId,
    sessionKind: "channel",
    installationId: randomUUID(),
  };
  const attempt = {
    route: {
      agentId,
      imBindingId,
      sourceSessionId,
      targetSessionId,
      targetComputerId,
      targetInstallationId,
      targetPlacementGeneration: 1,
      targetSessionKind: options.targetSessionKind ?? ("internal" as const),
      targetCreatorSessionId: sourceSessionId,
    },
    message: {
      id: messageId,
      sourceSessionId,
      targetSessionId,
      content: "hello",
      contentHash: "a".repeat(64),
      lastOutcome: options.lastOutcome ?? "unknown",
      lastErrorCode: null,
      attemptCount: options.attemptCount === null ? 1 : (options.attemptCount ?? 1),
      lastAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    deduplicated: options.attemptCount === null,
    attemptCount: options.attemptCount === undefined ? 1 : options.attemptCount,
  };
  const sessions = {
    authorizeAndRecordMessage: vi.fn().mockImplementation(async (input: { content: string; messageId: string }) => ({
      ...attempt,
      message: { ...attempt.message, id: input.messageId, content: input.content },
    })),
    createInternalSessionWithMessage: vi
      .fn()
      .mockImplementation(async (input: { initialMessage: string; messageId: string }) => ({
        ...attempt,
        session: { id: targetSessionId },
        placement: { sessionId: targetSessionId },
        message: { ...attempt.message, id: input.messageId, content: input.initialMessage },
      })),
    recordMessageOutcome: vi.fn().mockResolvedValue(true),
    withCollaborationDispatchAdmission: vi.fn(),
  };
  const domain = {
    requestReconcile: vi.fn().mockResolvedValue({
      type: "session:reconcile:result",
      requestId: randomUUID(),
      sessionId: targetSessionId,
      placementGeneration: 1,
      status: "ready",
    }),
    requestSessionMessageDelivery: vi.fn().mockResolvedValue({
      type: "session:message:deliver:result",
      requestId: randomUUID(),
      messageId,
      targetSessionId,
      placementGeneration: 1,
      status: "accepted",
    }),
  };
  const onDiagnostic = vi.fn();
  const logger = { error: vi.fn() };
  const registry = {
    capabilityVersion: vi.fn().mockReturnValue(2),
    currentInstanceId: vi.fn().mockReturnValue(instanceId),
    supportsCapability: vi.fn().mockReturnValue(true),
  };
  const assembler = { assembleForSession: vi.fn().mockResolvedValue(snapshot(agentId)) };
  return {
    assembler,
    domain,
    messageId,
    onDiagnostic,
    logger,
    registry,
    sessions,
    source,
    targetSessionId,
    service: new SessionCollaborationService({
      assembler,
      domain: domain as never,
      onDiagnostic,
      registry,
      sessions: sessions as never,
      logger,
    }),
  };
}

function sendRequest(fixture: ReturnType<typeof serviceFixture>): SessionCliSendRequest {
  return { messageId: fixture.messageId, targetSessionId: fixture.targetSessionId, message: "hello" };
}

function createRequest(fixture: ReturnType<typeof serviceFixture>): SessionCliCreateRequest {
  return { messageId: fixture.messageId, message: "investigate" };
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
