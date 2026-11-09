import { randomUUID } from "node:crypto";
import {
  HTTP_PATHS,
  RUNTIME_CAPABILITY,
  SESSION_CLI_PROOF_HEADER,
  type SessionCliCreateRequest,
  type SessionCliSendRequest,
  type SessionReconcileRequest,
} from "@opentag/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRuntimeSessionRoutes } from "../api/runtime-sessions.js";
import { createServerDiagnosticReporter } from "../observability/diagnostics.js";
import { RuntimeRegistrySendError } from "../runtime/connection-registry.js";
import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import type { SessionCliSourceContext } from "../services/sessions/session-cli-proof-service.js";
import { SessionCollaborationService } from "../services/sessions/session-collaboration-service.js";
import {
  renderSessionStoppedNotice,
  runOutcomeNoticeMessageId,
  sessionStoppedNoticeMessageId,
} from "../services/sessions/session-run-outcome-notice.js";
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

    it("sends a deterministic notice to the recipient under the reporting connection's authority", async () => {
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

    it("ignores a report the Server cannot attribute to a recipient", async () => {
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

  describe("session stop", () => {
    function stopped(
      fixture: ReturnType<typeof serviceFixture>,
      creatorSessionId: string,
      childSessionId = randomUUID(),
    ) {
      const target = { sessionId: childSessionId, creatorSessionId, computerKind: "local" };
      fixture.sessions.stopInternalSession.mockResolvedValue({
        target,
        targets: [target],
        alreadyStopped: false,
        descendantCount: 2,
        stoppedDescendantCount: 2,
      });
      return childSessionId;
    }

    it("tells the execution side and does not wake the creator that asked", async () => {
      const fixture = serviceFixture();
      const sessionId = stopped(fixture, fixture.source.sessionId);

      await expect(fixture.service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toEqual({
        status: "stopped",
        sessionId,
        execution: "stopped",
        alreadyStopped: false,
        stoppedDescendantCount: 2,
      });
      expect(fixture.sessions.stopInternalSession).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSessionId: fixture.source.sessionId, targetSessionId: sessionId }),
      );
      expect(fixture.stopEnded).toHaveBeenCalledWith([expect.objectContaining({ sessionId })]);
      expect(fixture.sessions.authorizeAndRecordMessage).not.toHaveBeenCalled();
    });

    it("sends a creator another ancestor overruled one deterministic notice", async () => {
      const fixture = serviceFixture();
      const creator = randomUUID();
      const sessionId = stopped(fixture, creator);

      await expect(fixture.service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toMatchObject({
        status: "stopped",
      });
      const notice = fixture.sessions.authorizeAndRecordMessage.mock.calls[0]?.[0];
      expect(notice).toMatchObject({
        messageId: sessionStoppedNoticeMessageId(sessionId),
        serverDerivedId: true,
        sourceSessionId: fixture.source.sessionId,
        targetSessionId: creator,
      });
      expect(notice.content).toBe(renderSessionStoppedNotice(sessionId, 2));
      expect(notice.content).toContain("The 2 descendant Session(s) below it were stopped with it.");
      expect(notice.content).toContain("cannot receive messages");
      expect(fixture.domain.requestSessionMessageDelivery).toHaveBeenCalledOnce();
      expect(fixture.logger.error).not.toHaveBeenCalled();
    });

    it("still answers stopped when the notice cannot be delivered, and logs it", async () => {
      const fixture = serviceFixture();
      const sessionId = stopped(fixture, randomUUID());
      fixture.sessions.authorizeAndRecordMessage.mockRejectedValue(
        new SessionServiceError("SESSION_TARGET_UNAVAILABLE", "the creator ended"),
      );

      await expect(fixture.service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toMatchObject({
        status: "stopped",
      });
      expect(fixture.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: "SESSION_STOP_NOTICE_NOT_DELIVERED", childSessionId: sessionId }),
        expect.any(String),
      );
    });

    it("reports a stop nothing could carry out as pending", async () => {
      const fixture = serviceFixture();
      const sessionId = stopped(fixture, fixture.source.sessionId);
      fixture.stopEnded.mockResolvedValue(new Map());

      await expect(fixture.service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toMatchObject({
        status: "stopped",
        execution: "pending",
      });
    });

    describe("a Client that does not answer", () => {
      function frozen(fixture: ReturnType<typeof serviceFixture>) {
        const answer = deferred<Map<string, "stopped">>();
        fixture.stopEnded.mockReturnValue(answer.promise as never);
        const service = new SessionCollaborationService({
          assembler: fixture.assembler,
          domain: fixture.domain as never,
          logger: fixture.logger,
          onDiagnostic: fixture.onDiagnostic,
          registry: fixture.registry,
          sessions: fixture.sessions as never,
          stopEnded: fixture.stopEnded as never,
          stopAnswerBudgetMs: 5,
        });
        return { answer, service };
      }

      it("answers pending within the budget, which is below the CLI's timeout", async () => {
        const fixture = serviceFixture();
        const sessionId = stopped(fixture, fixture.source.sessionId);
        const { answer, service } = frozen(fixture);

        await expect(service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toMatchObject({
          status: "stopped",
          sessionId,
          execution: "pending",
        });

        answer.resolve(new Map([[sessionId, "stopped"]]));
        await service.close();
      });

      it("records another ancestor's notice under its server-derived ID before answering pending", async () => {
        const fixture = serviceFixture();
        const creator = randomUUID();
        const sessionId = stopped(fixture, creator);
        const { answer, service } = frozen(fixture);

        await expect(service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toMatchObject({
          execution: "pending",
        });

        expect(fixture.sessions.authorizeAndRecordMessage).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            messageId: sessionStoppedNoticeMessageId(sessionId),
            targetSessionId: creator,
            serverDerivedId: true,
          }),
        );
        // Delivery stays behind the frozen Client, and is not lost once it answers.
        expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
        answer.resolve(new Map([[sessionId, "stopped"]]));
        await vi.waitFor(() => expect(fixture.domain.requestSessionMessageDelivery).toHaveBeenCalledOnce());
        await service.close();
      });

      it("does not let a slow notice delivery hide the confirmed execution, and logs a failed one", async () => {
        const fixture = serviceFixture();
        const sessionId = stopped(fixture, randomUUID());
        const delivery = deferred<never>();
        fixture.domain.requestSessionMessageDelivery.mockReturnValue(delivery.promise);
        const service = new SessionCollaborationService({
          assembler: fixture.assembler,
          domain: fixture.domain as never,
          logger: fixture.logger,
          registry: fixture.registry,
          sessions: fixture.sessions as never,
          stopEnded: fixture.stopEnded as never,
          stopAnswerBudgetMs: 5,
        });

        await expect(service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toMatchObject({
          execution: "stopped",
        });
        delivery.reject(new RuntimeDomainRequestError("timeout", "confirmation was lost"));
        await service.close();
        expect(fixture.logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ code: "SESSION_STOP_NOTICE_NOT_DELIVERED", childSessionId: sessionId }),
          expect.any(String),
        );
      });

      it("makes shutdown wait for the late answer, skips delivery, and reports a failure", async () => {
        const fixture = serviceFixture();
        const sessionId = stopped(fixture, randomUUID());
        const { answer, service } = frozen(fixture);
        await service.stop({ targetSessionId: sessionId }, fixture.source);

        let closed = false;
        const closing = service.close().then(() => {
          closed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(closed).toBe(false);
        answer.reject(new Error("the domain closed"));
        await closing;
        expect(fixture.sessions.authorizeAndRecordMessage).toHaveBeenCalledOnce();
        expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
        expect(fixture.onDiagnostic).toHaveBeenCalledWith("SESSION_STOP_BACKGROUND_FAILED");
      });
    });

    it.each([
      [["stopped", "stopped"], "stopped"],
      [["stopped", "requested"], "requested"],
      [["requested", "pending"], "pending"],
      [["pending", "not_interrupted"], "not_interrupted"],
      [["stopped", undefined], "pending"],
    ] as const)("answers %j for the tree as %s, the Session reached least", async (reached, answer) => {
      const fixture = serviceFixture();
      const sessionId = stopped(fixture, fixture.source.sessionId);
      const descendant = randomUUID();
      const stop = await fixture.sessions.stopInternalSession();
      fixture.sessions.stopInternalSession.mockResolvedValue({
        ...stop,
        targets: [stop.target, { ...stop.target, sessionId: descendant }],
      });
      fixture.stopEnded.mockResolvedValue(
        new Map([[sessionId, reached[0]], ...(reached[1] ? ([[descendant, reached[1]]] as const) : [])]) as never,
      );

      await expect(fixture.service.stop({ targetSessionId: sessionId }, fixture.source)).resolves.toMatchObject({
        execution: answer,
      });
      expect(fixture.stopEnded).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ sessionId: descendant })]),
      );
    });

    it("maps refusals and hides unexpected failures", async () => {
      const fixture = serviceFixture();
      const targetSessionId = randomUUID();
      fixture.sessions.stopInternalSession.mockRejectedValueOnce(
        new SessionServiceError("SESSION_STOP_NOT_ANCESTOR", "private detail"),
      );
      await expect(fixture.service.stop({ targetSessionId }, fixture.source)).resolves.toEqual({
        status: "rejected",
        sessionId: targetSessionId,
        code: "not_ancestor",
      });
      expect(fixture.onDiagnostic).not.toHaveBeenCalled();
      fixture.sessions.stopInternalSession.mockRejectedValueOnce(new Error("database down"));
      await expect(fixture.service.stop({ targetSessionId }, fixture.source)).resolves.toEqual({
        status: "unreachable",
        sessionId: targetSessionId,
        code: "runtime_unavailable",
      });
      expect(fixture.onDiagnostic).toHaveBeenCalledWith("SESSION_COLLABORATION_RUNTIME_UNAVAILABLE");
      expect(fixture.stopEnded).not.toHaveBeenCalled();
    });

    it("repeats recent stops for a registering Computer, and nothing when there are none", async () => {
      const fixture = serviceFixture();
      const computerId = randomUUID();
      await fixture.service.redeliverStops(computerId);
      expect(fixture.stopEnded).not.toHaveBeenCalled();
      const target = { sessionId: randomUUID() };
      fixture.sessions.recentlyEndedInternalSessions.mockResolvedValue([target]);
      await fixture.service.redeliverStops(computerId);
      expect(fixture.sessions.recentlyEndedInternalSessions).toHaveBeenCalledWith(computerId, expect.any(Date), 64);
      expect(fixture.stopEnded).toHaveBeenCalledWith([target]);
    });

    it("has nothing to repeat without an execution side", async () => {
      const fixture = serviceFixture();
      const service = new SessionCollaborationService({
        assembler: fixture.assembler,
        domain: fixture.domain as never,
        registry: fixture.registry,
        sessions: fixture.sessions as never,
      });
      await service.redeliverStops(randomUUID());
      expect(fixture.sessions.recentlyEndedInternalSessions).not.toHaveBeenCalled();
    });
  });

  it("waits for two serial round trips on the existing Local send path", async () => {
    const fixture = serviceFixture();
    const reconcile = await fixture.domain.requestReconcile();
    const delivery = await fixture.domain.requestSessionMessageDelivery();
    fixture.domain.requestReconcile.mockClear().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return reconcile;
    });
    fixture.domain.requestSessionMessageDelivery.mockClear().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return delivery;
    });

    vi.useFakeTimers();
    try {
      const start = Date.now();
      const response = fixture.service.send(sendRequest(fixture), fixture.source);
      await vi.advanceTimersByTimeAsync(499);
      expect(fixture.domain.requestReconcile).toHaveBeenCalledOnce();
      expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(fixture.domain.requestSessionMessageDelivery).toHaveBeenCalledOnce();
      expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(response).resolves.toMatchObject({ status: "accepted" });
      expect(Date.now() - start).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a warm compatible Local send after one 500 ms round trip", async () => {
    const fixture = serviceFixture({ inlineMessages: true });
    fixture.domain.requestReconcile.mockImplementation(
      async (_computerId, _instanceId, request: SessionReconcileRequest) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          ...reconcileReceipt(request),
          sessionMessage: {
            type: "session:message:deliver:result",
            requestId: request.requestId,
            messageId: request.sessionMessage?.messageId,
            targetSessionId: request.sessionId,
            placementGeneration: request.placementGeneration,
            status: "accepted",
          },
        };
      },
    );

    vi.useFakeTimers();
    try {
      const response = fixture.service.send(sendRequest(fixture), fixture.source);
      await vi.advanceTimersByTimeAsync(499);
      expect(fixture.sessions.recordMessageOutcome).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(response).resolves.toMatchObject({ status: "accepted" });
      expect(fixture.domain.requestReconcile).toHaveBeenCalledOnce();
      expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
      expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messageId: fixture.messageId, outcome: "accepted", attemptCount: 1 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers separately only after the Client explicitly defers a prepared target", async () => {
    const fixture = serviceFixture({ inlineMessages: true });
    fixture.domain.requestReconcile.mockImplementation(
      async (_computerId, _instanceId, request: SessionReconcileRequest) => ({
        ...reconcileReceipt(request),
        sessionMessage: "deferred",
      }),
    );
    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "accepted",
    });
    expect(fixture.domain.requestSessionMessageDelivery).toHaveBeenCalledOnce();
    const reconcile = fixture.domain.requestReconcile.mock.calls[0]?.[2];
    const delivery = fixture.domain.requestSessionMessageDelivery.mock.calls[0]?.[2];
    expect(reconcile.sessionMessage.messageId).toBe(delivery.messageId);
    expect(reconcile.runtime).toBe(delivery.runtime);
    expect(reconcile.requestId).not.toBe(delivery.requestId);
  });

  it("uses two ordinary frames if the combined frame exceeds the wire limit", async () => {
    const fixture = serviceFixture({ inlineMessages: true });
    fixture.domain.requestReconcile.mockRejectedValueOnce(new RuntimeRegistrySendError("frame_too_large", "too large"));
    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "accepted",
    });
    expect(fixture.domain.requestReconcile.mock.calls[0]?.[2].sessionMessage).toBeDefined();
    expect(fixture.domain.requestReconcile.mock.calls[1]?.[2].sessionMessage).toBeUndefined();
    expect(fixture.domain.requestSessionMessageDelivery).toHaveBeenCalledOnce();
  });

  it.each([
    new RuntimeDomainRequestError("timeout", "lost acknowledgement"),
    new RuntimeDomainRequestError("delivery_unconfirmed", "owner stopped"),
    new RuntimeRegistrySendError("instance_replaced", "connection replaced during send", true),
  ])("leaves a potentially delivered combined request unknown after %s", async (error) => {
    const fixture = serviceFixture({ inlineMessages: true });
    fixture.domain.requestReconcile.mockRejectedValue(error);
    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unknown",
      code: "delivery_timeout",
    });
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
    expect(fixture.sessions.recordMessageOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "unknown", errorCode: "delivery_timeout" }),
    );
  });

  it("records a refused combined admission as unreachable without sending another frame", async () => {
    const fixture = serviceFixture({ inlineMessages: true });
    fixture.domain.requestReconcile.mockRejectedValue(new RuntimeDomainRequestError("authority_unavailable", "denied"));
    await expect(fixture.service.send(sendRequest(fixture), fixture.source)).resolves.toMatchObject({
      status: "unreachable",
      code: "runtime_not_ready",
    });
    expect(fixture.domain.requestSessionMessageDelivery).not.toHaveBeenCalled();
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

function reconcileReceipt(request: SessionReconcileRequest) {
  return {
    type: "session:reconcile:result",
    requestId: request.requestId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status: "ready",
  };
}

function serviceFixture(
  options: {
    attemptCount?: number | null;
    lastOutcome?: "accepted" | "unknown";
    targetSessionKind?: "channel" | "thread" | "internal";
    targetComputerKind?: "local" | "cloud";
    inlineMessages?: boolean;
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
    recentlyEndedInternalSessions: vi.fn().mockResolvedValue([]),
    recordMessageOutcome: vi.fn().mockResolvedValue(true),
    stopInternalSession: vi.fn(),
    resolveRunOutcomeNotice: vi
      .fn()
      .mockResolvedValue({ recipientSessionId: targetSessionId, installationId: targetInstallationId }),
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
    capabilityVersion: vi.fn((_computer: string, _instance: string, capability: string) =>
      capability === RUNTIME_CAPABILITY.sessionMessageReconcile ? (options.inlineMessages ? 1 : undefined) : 2,
    ),
    currentInstanceId: vi.fn().mockReturnValue(instanceId),
    supportsCapability: vi.fn().mockReturnValue(true),
  };
  const assembler = { assembleForSession: vi.fn().mockResolvedValue(snapshot(agentId)) };
  const stopEnded = vi.fn(
    async (targets: { sessionId: string }[]) =>
      new Map(targets.map(({ sessionId }) => [sessionId, "stopped" as const])),
  );
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
    stopEnded,
    targetSessionId,
    service: new SessionCollaborationService({
      stopEnded: stopEnded as never,
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
