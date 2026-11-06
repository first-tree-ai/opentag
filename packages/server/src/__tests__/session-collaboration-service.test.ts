import { randomUUID } from "node:crypto";
import {
  HTTP_PATHS,
  SESSION_CLI_PROOF_HEADER,
  type SessionCliCreateRequest,
  type SessionCliSendRequest,
} from "@opentag/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRuntimeSessionRoutes } from "../api/runtime-sessions.js";
import { createServerDiagnosticReporter } from "../observability/diagnostics.js";
import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import type { SessionCliSourceContext } from "../services/sessions/session-cli-proof-service.js";
import { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";
import { runOutcomeNoticeMessageId } from "../services/sessions/session-run-outcome-notice.js";
import { SessionServiceError } from "../services/sessions/session-service.js";

describe("SessionCollaborationService", () => {
  describe("internal Session Run outcome notices", () => {
    function noticeInput(fixture: ReturnType<typeof serviceFixture>) {
      return {
        childSessionId: fixture.source.sessionId,
        messageId: randomUUID(),
        outcome: "timed_out" as const,
        reason: "turn_timeout",
        source: {
          computerId: fixture.source.computerId,
          connectionInstanceId: fixture.source.connectionInstanceId,
          placementGeneration: 3,
        },
      };
    }

    it("sends a deterministic child-to-creator notice under the reporting connection's authority", async () => {
      const fixture = serviceFixture();
      const input = noticeInput(fixture);

      await expect(fixture.service.notifyRunOutcome(input)).resolves.toBe("notified");
      expect(fixture.sessions.resolveRunOutcomeNotice).toHaveBeenCalledWith({
        childSessionId: input.childSessionId,
        messageId: input.messageId,
      });
      const recorded = fixture.sessions.authorizeAndRecordMessage.mock.calls[0]?.[0];
      expect(recorded).toMatchObject({
        messageId: runOutcomeNoticeMessageId(input.childSessionId, input.messageId),
        sourceSessionId: input.childSessionId,
        sourceComputerId: input.source.computerId,
        sourceConnectionInstanceId: input.source.connectionInstanceId,
        sourcePlacementGeneration: 3,
        targetSessionId: fixture.targetSessionId,
      });
      expect(recorded.content).toContain(`Session: ${input.childSessionId}`);
      expect(recorded.content).toContain("Outcome: timed_out (reason: turn_timeout)");
      expect(recorded.content).toContain(`opentag session send ${input.childSessionId} --message`);
      expect(fixture.domain.requestSessionMessageDelivery).toHaveBeenCalledOnce();

      // A replay produces the identical id and content, so the row is reused, never duplicated.
      await fixture.service.notifyRunOutcome(input);
      const replayed = fixture.sessions.authorizeAndRecordMessage.mock.calls[1]?.[0];
      expect(replayed).toEqual(recorded);
    });

    it("ignores a report the Server cannot attribute to an active internal child", async () => {
      const fixture = serviceFixture();
      fixture.sessions.resolveRunOutcomeNotice.mockResolvedValue(undefined);

      await expect(fixture.service.notifyRunOutcome(noticeInput(fixture))).resolves.toBe("ignored");
      expect(fixture.sessions.authorizeAndRecordMessage).not.toHaveBeenCalled();
      expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    });

    it("ignores a child whose authority is gone and asks for a retry when the creator is busy", async () => {
      const ended = serviceFixture();
      ended.sessions.authorizeAndRecordMessage.mockRejectedValue(
        Object.assign(new Error("source ended"), { code: "SESSION_SOURCE_UNAVAILABLE" }),
      );
      await expect(ended.service.notifyRunOutcome(noticeInput(ended))).resolves.toBe("ignored");

      const busy = serviceFixture();
      busy.domain.requestSessionMessageDelivery.mockResolvedValue({
        type: "session:message:deliver:result",
        requestId: randomUUID(),
        messageId: busy.messageId,
        targetSessionId: busy.targetSessionId,
        placementGeneration: 1,
        status: "rejected",
        reason: "session_busy",
      });
      await expect(busy.service.notifyRunOutcome(noticeInput(busy))).resolves.toBe("retry");

      const transient = serviceFixture();
      transient.sessions.resolveRunOutcomeNotice.mockRejectedValue(new Error("database unavailable"));
      await expect(transient.service.notifyRunOutcome(noticeInput(transient))).resolves.toBe("retry");
    });

    it("treats an already accepted notice as notified without delivering again", async () => {
      const fixture = serviceFixture({ attemptCount: null, lastOutcome: "accepted" });

      await expect(fixture.service.notifyRunOutcome(noticeInput(fixture))).resolves.toBe("notified");
      expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    });

    it.each(["reconcile", "delivery"] as const)(
      "answers retry before a slow %s, without starting duplicate attempts",
      async (stage) => {
        const fixture = serviceFixture();
        const input = noticeInput(fixture);
        const gate = deferred<void>();
        const method =
          stage === "reconcile" ? fixture.domain.requestReconcile : fixture.domain.requestSessionMessageDelivery;
        const result = await method();
        method.mockImplementationOnce(async () => {
          await gate.promise;
          return result;
        });
        method.mockClear();

        await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
        await flush();
        expect(method).toHaveBeenCalledOnce();
        expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
        await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
        expect(fixture.sessions.authorizeAndRecordMessage).toHaveBeenCalledOnce();
        gate.resolve();
        await flush();
        expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "accepted" }),
        );

        fixture.sessions.authorizeAndRecordMessage.mockResolvedValue({
          ...fixture.attempt,
          attemptCount: null,
          message: { ...fixture.attempt.message, lastOutcome: "accepted" },
        });
        await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("notified");
        expect(method).toHaveBeenCalledOnce();
        await fixture.service.close();
      },
    );

    it("waits for the database and never dispatches after a failed or unknown commit", async () => {
      const fixture = serviceFixture();
      const input = noticeInput(fixture);
      const gate = deferred<never>();
      fixture.sessions.authorizeAndRecordMessage.mockReturnValueOnce(gate.promise);
      const pending = fixture.service.notifyRunOutcomeInBackground(input);
      await flush();
      expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
      gate.reject(new Error("COMMIT response lost"));
      await expect(pending).resolves.toBe("retry");
      expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
      // A replay reconciles the same durable identity before any dispatch.
      fixture.sessions.authorizeAndRecordMessage.mockResolvedValue({
        ...fixture.attempt,
        attemptCount: null,
        message: { ...fixture.attempt.message, lastOutcome: "accepted" },
      });
      await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("notified");
      expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
      await fixture.service.close();
    });

    it.each(["runtime_unavailable", "timeout", "write_failed"] as const)(
      "keeps reporter custody after %s",
      async (failure) => {
        const fixture = serviceFixture();
        const input = noticeInput(fixture);
        if (failure === "runtime_unavailable") fixture.registry.currentInstanceId.mockReturnValue(undefined);
        if (failure === "timeout")
          fixture.domain.requestSessionMessageDelivery.mockRejectedValue(
            new RuntimeDomainRequestError("timeout", "lost receipt"),
          );
        if (failure === "write_failed")
          fixture.sessions.recordMessageOutcome.mockRejectedValue(new Error("write failed"));
        await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
        await flush();
        await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
        await fixture.service.close();
        expect(fixture.sessions.authorizeAndRecordMessage).toHaveBeenCalledTimes(2);
      },
    );

    it("bounds background work and leaves excess reports with their reporters", async () => {
      const fixture = serviceFixture();
      const gate = deferred<void>();
      const ready = await fixture.domain.requestReconcile();
      fixture.domain.requestReconcile.mockImplementation(async () => {
        await gate.promise;
        return ready;
      });
      fixture.domain.requestReconcile.mockClear();
      await Promise.all(
        Array.from({ length: 20 }, () => fixture.service.notifyRunOutcomeInBackground(noticeInput(fixture))),
      );
      expect(fixture.sessions.authorizeAndRecordMessage).toHaveBeenCalledTimes(16);
      gate.resolve();
      await flush();
      await expect(fixture.service.notifyRunOutcomeInBackground(noticeInput(fixture))).resolves.toBe("retry");
      await fixture.service.close();
      expect(fixture.sessions.authorizeAndRecordMessage).toHaveBeenCalledTimes(17);
    });

    it("cancels a slow reconcile and drains its outcome write before closing", async () => {
      const fixture = serviceFixture();
      const input = noticeInput(fixture);
      const write = deferred<boolean>();
      fixture.sessions.recordMessageOutcome.mockReturnValueOnce(write.promise);
      fixture.domain.requestReconcile.mockImplementation(
        (...args: unknown[]) =>
          new Promise((_, reject) => {
            const signal = args[5] as AbortSignal;
            signal.addEventListener("abort", () => reject(new RuntimeDomainRequestError("stopped", "stopping")), {
              once: true,
            });
          }),
      );
      await fixture.service.notifyRunOutcomeInBackground(input);
      await flush();
      let closed = false;
      const closing = fixture.service.close().then(() => {
        closed = true;
      });
      await flush();
      expect(closed).toBe(false);
      expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
      write.resolve(true);
      await closing;
      await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
      expect(fixture.sessions.authorizeAndRecordMessage).toHaveBeenCalledOnce();
    });

    it.each(["authorization", "assembly"] as const)(
      "waits for pending %s at shutdown without sending a late frame",
      async (stage) => {
        const fixture = serviceFixture();
        const gate = deferred<void>();
        if (stage === "authorization") {
          const authorize = fixture.sessions.authorizeAndRecordMessage.getMockImplementation();
          fixture.sessions.authorizeAndRecordMessage.mockImplementationOnce(async (input) => {
            await gate.promise;
            return authorize?.(input);
          });
        } else {
          fixture.assembler.assembleForSession.mockImplementationOnce(async () => {
            await gate.promise;
            return snapshot(fixture.source.agentId);
          });
        }
        const reporting = fixture.service.notifyRunOutcomeInBackground(noticeInput(fixture));
        await flush();
        let closed = false;
        const closing = fixture.service.close().then(() => {
          closed = true;
        });
        await flush();
        expect(closed).toBe(false);
        gate.resolve();
        await reporting;
        await closing;
        expect(fixture.domain.requestReconcile).not.toHaveBeenCalled();
      },
    );

    it("does not wait for a Cloud target's cold start and passes shutdown cancellation to it", async () => {
      const fixture = serviceFixture({ targetComputerKind: "cloud" });
      const input = noticeInput(fixture);
      fixture.cloud.deliver.mockImplementation(
        (_input, _admission, signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
          }),
      );
      await expect(fixture.service.notifyRunOutcomeInBackground(input)).resolves.toBe("retry");
      await flush();
      expect(fixture.cloud.deliver).toHaveBeenCalledOnce();
      expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
      await fixture.service.close();
      expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "unreachable" }),
      );
    });

    it("drains a receipt that resolves while only the collaboration service is closing", async () => {
      const fixture = serviceFixture();
      const receipt = deferred<void>();
      const result = await fixture.domain.requestSessionMessageDelivery();
      fixture.domain.requestSessionMessageDelivery.mockImplementationOnce(async () => {
        await receipt.promise;
        return result;
      });
      await expect(fixture.service.notifyRunOutcomeInBackground(noticeInput(fixture))).resolves.toBe("retry");
      await flush();
      let closed = false;
      const closing = fixture.service.close().then(() => {
        closed = true;
      });
      await flush();
      expect(closed).toBe(false);
      receipt.resolve();
      await closing;
      expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "accepted" }),
      );
    });
  });

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

  it.each(["session_busy", "agent_busy", "client_busy"] as const)(
    "records a %s refusal as unreachable with that cause",
    async (reason) => {
      const fixture = serviceFixture();
      fixture.domain.requestSessionMessageDelivery.mockResolvedValue({
        type: "session:message:deliver:result",
        requestId: randomUUID(),
        messageId: fixture.messageId,
        targetSessionId: fixture.targetSessionId,
        placementGeneration: 1,
        status: "rejected",
        reason,
      });

      await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
        status: "unreachable",
        code: reason,
      });
      expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "unreachable", errorCode: reason }),
      );
    },
  );

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

  it.each([
    ["SESSION_PLACEMENT_STALE", "source_unavailable"],
    ["SESSION_SOURCE_UNAVAILABLE", "source_unavailable"],
    ["SESSION_TARGET_UNAVAILABLE", "target_unavailable"],
    ["SESSION_SCOPE_MISMATCH", "scope_mismatch"],
    ["SESSION_MESSAGE_CONFLICT", "message_conflict"],
  ])("maps %s without reporting an internal failure", async (errorCode, responseCode) => {
    const fixture = serviceFixture();
    fixture.sessions.authorizeAndRecordMessage.mockRejectedValue(
      new SessionServiceError(errorCode, "private refusal detail"),
    );

    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toEqual({
      messageId: fixture.messageId,
      status: "rejected",
      code: responseCode,
    });
    expect(fixture.onDiagnostic).not.toHaveBeenCalled();
    expect(fixture.diagnosticLogger.error).not.toHaveBeenCalled();
    expect(fixture.logger.error).not.toHaveBeenCalled();
    expect(fixture.assembler.assembleForSession).not.toHaveBeenCalled();
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
  });

  it("keeps a scope refusal as HTTP 200 without a Server diagnostic", async () => {
    const fixture = serviceFixture();
    fixture.sessions.authorizeAndRecordMessage.mockRejectedValue(
      new SessionServiceError("SESSION_SCOPE_MISMATCH", "private scope detail"),
    );
    const app = Fastify();
    registerRuntimeSessionRoutes(app, {
      collaboration: fixture.service,
      proofs: { authenticate: async () => fixture.source },
      sessions: { listInternalSessions: vi.fn() },
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: HTTP_PATHS.runtimeSessionMessages,
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof" },
        payload: sendRequest(fixture),
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toEqual({ messageId: fixture.messageId, status: "rejected", code: "scope_mismatch" });
      expect(fixture.diagnosticLogger.error).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  describe.each(["create", "send"] as const)("unexpected %s failures", (method) => {
    it.each([
      new Error("private database failure"),
      Object.assign(new Error("private dependency failure"), { code: "SESSION_UNEXPECTED_FAILURE" }),
      "private non-Error failure",
    ])("reports one safe Server diagnostic for %s", async (error) => {
      const fixture = serviceFixture();
      fixture.sessions.createInternalSessionWithMessage.mockRejectedValue(error);
      fixture.sessions.authorizeAndRecordMessage.mockRejectedValue(error);
      const result =
        method === "create"
          ? fixture.service.create(createRequest(fixture), fixture.source)
          : fixture.service.send(sendRequest(fixture), fixture.source);

      await expect(result).resolves.toEqual({
        messageId: fixture.messageId,
        status: "unreachable",
        code: "runtime_unavailable",
      });
      expect(fixture.onDiagnostic).toHaveBeenCalledExactlyOnceWith("SESSION_COLLABORATION_RUNTIME_UNAVAILABLE");
      expect(fixture.diagnosticLogger.error).toHaveBeenCalledExactlyOnceWith(
        { code: "SESSION_COLLABORATION_RUNTIME_UNAVAILABLE", errorCode: "SESSION_COLLABORATION_RUNTIME_UNAVAILABLE" },
        "Server diagnostic",
      );
    });
  });

  it("maps Router model override admission to the model_unavailable outcomes", async () => {
    const rejected = serviceFixture();
    rejected.sessions.createInternalSessionWithMessage.mockRejectedValue(
      Object.assign(new Error("not offered"), { code: "SESSION_MODEL_UNAVAILABLE" }),
    );
    await expect(rejected.service.create(createRequest(rejected), rejected.source)).resolves.toMatchObject({
      status: "rejected",
      code: "model_unavailable",
    });
    expect(rejected.onDiagnostic).not.toHaveBeenCalled();
    expect(rejected.diagnosticLogger.error).not.toHaveBeenCalled();
    expect(rejected.logger.error).not.toHaveBeenCalled();

    const unreachable = serviceFixture();
    unreachable.sessions.createInternalSessionWithMessage.mockRejectedValue(
      Object.assign(new Error("catalog down"), { code: "SESSION_MODEL_CATALOG_UNAVAILABLE" }),
    );
    await expect(unreachable.service.create(createRequest(unreachable), unreachable.source)).resolves.toMatchObject({
      status: "unreachable",
      code: "model_unavailable",
    });
    expect(unreachable.onDiagnostic).not.toHaveBeenCalled();
    expect(unreachable.diagnosticLogger.error).not.toHaveBeenCalled();
  });
});

function serviceFixture(
  options: {
    attemptCount?: number | null;
    lastOutcome?: "accepted" | "unknown";
    targetSessionKind?: "channel" | "thread" | "internal";
    targetComputerKind?: "local" | "cloud";
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
    proofId: crypto.randomUUID(),
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
      targetComputerKind: options.targetComputerKind ?? "local",
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
    resolveRunOutcomeNotice: vi
      .fn()
      .mockResolvedValue({ creatorSessionId: targetSessionId, installationId: targetInstallationId }),
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
  const diagnosticLogger = { error: vi.fn() };
  const onDiagnostic = vi.fn(createServerDiagnosticReporter(() => diagnosticLogger as never));
  const logger = { error: vi.fn() };
  const registry = {
    capabilityVersion: vi.fn().mockReturnValue(2),
    currentInstanceId: vi.fn().mockReturnValue(instanceId),
    supportsCapability: vi.fn().mockReturnValue(true),
  };
  const assembler = { assembleForSession: vi.fn().mockResolvedValue(snapshot(agentId)) };
  const cloud = {
    deliver: vi
      .fn<
        NonNullable<
          import("../services/sessions/session-collaboration-service.js").SessionCollaborationServiceOptions["cloud"]
        >["deliver"]
      >()
      .mockResolvedValue({ status: "accepted" }),
  };
  return {
    attempt,
    cloud,
    assembler,
    domain,
    diagnosticLogger,
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
      cloud,
    }),
  };
}

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function sendRequest(fixture: ReturnType<typeof serviceFixture>): SessionCliSendRequest {
  return { messageId: fixture.messageId, targetSessionId: fixture.targetSessionId, message: "hello" };
}

function createRequest(fixture: ReturnType<typeof serviceFixture>): SessionCliCreateRequest {
  return { messageId: fixture.messageId, message: "investigate" };
}

function snapshot(agentId: string) {
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
