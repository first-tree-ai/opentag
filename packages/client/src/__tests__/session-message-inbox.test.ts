import { randomUUID } from "node:crypto";
import type { InputRejectReason, SessionMessageDeliveryRequest, SessionReconcileRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../runtime/admission-controller.js";
import {
  type DurableFailure,
  type DurableWorkRecord,
  MemoryRuntimeDurabilityStore,
  RuntimeDurabilityMetrics,
  type RuntimeRetryScheduler,
} from "../runtime/runtime-durability.js";
import { buildSessionMessageInput, SessionMessageInbox } from "../runtime/session-message-inbox.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";

describe("SessionMessageInbox", () => {
  it("rejects new messages while quiesced but drains messages accepted before the pause", async () => {
    const admission = new AdmissionController();
    const targetSessionId = randomUUID();
    const agentId = randomUUID();
    const held = admission.reserve(targetSessionId, agentId);
    if (!held.accepted) throw new Error("Expected the test reservation");
    const prompt = vi.fn(async () => ({ runId: "run", status: "completed" as const, output: [] }));
    const inbox = new SessionMessageInbox({
      admission,
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: vi.fn(async () => ({ waitForIdle: vi.fn(async () => undefined), prompt }) as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    expect((await inbox.accept(delivery({ targetSessionId, agentId, text: "accepted before pause" }))).status).toBe(
      "accepted",
    );

    admission.pause();
    await expect(inbox.accept(delivery({ text: "new during pause" }))).resolves.toMatchObject({
      status: "rejected",
      reason: "client_busy",
    });
    held.reservation.release();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    await inbox.settled();
    inbox.stop();
  });

  it("rejects accepted work when the durable admission write fails", async () => {
    const logger = { warn: vi.fn() };
    const persistence = {
      list: vi.fn(async () => []),
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      logger,
      persistence,
      reconciler: inboxReconciler(),
      runtimeManager: { ensureRuntime: vi.fn(), sessionKind: vi.fn(() => "internal" as const) },
    });
    const request = delivery();

    await expect(inbox.accept(request)).resolves.toMatchObject({
      status: "rejected",
      reason: "provider_unavailable",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId: request.messageId }),
      "Session message persistence failed",
    );
    inbox.stop();
  });

  it("records terminal failures and rejects duplicate delivery attempts", async () => {
    const logger = { warn: vi.fn() };
    const failures: unknown[] = [];
    const request = delivery();
    const terminalError = {
      category: "runtime",
      code: "runtime_blocked",
      message: "runtime policy blocked the turn",
      phase: "runtime",
      requestId: request.requestId,
      retryability: "terminal",
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      logger,
      maxRememberedMessages: 2,
      onFailure: (failure) => failures.push(failure),
      reconciler: inboxReconciler(),
      retryPolicy: { maxAttempts: 5, maxAgeMs: 10_000 },
      runtimeManager: {
        ensureRuntime: vi.fn(async () => {
          throw terminalError;
        }),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });

    await expect(inbox.accept(request)).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(inbox.getState(request.messageId)?.status).toBe("failed");
    expect(failures).toEqual([
      expect.objectContaining({
        code: "runtime_blocked",
        category: "unavailable",
        phase: "transport",
        retryability: "never",
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "runtime_blocked", messageId: request.messageId, status: "failed" }),
      "Session message failed permanently",
    );
    await expect(inbox.accept({ ...request, requestId: randomUUID() })).resolves.toMatchObject({
      status: "rejected",
      reason: "provider_unavailable",
    });
    inbox.stop();
  });

  it("logs credential preparation failures before retrying visible work", async () => {
    const logger = { warn: vi.fn() };
    const credentials = {
      cleanup: vi.fn(async () => undefined),
      prepare: vi.fn(async () => {
        throw new Error("credential store unavailable");
      }),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentials,
      imCredentialGrantVersion: () => 2,
      logger,
      reconciler: inboxReconciler(),
      retryPolicy: { maxAttempts: 1, maxAgeMs: 10_000 },
      runtimeManager: { ensureRuntime: vi.fn(), sessionKind: vi.fn(() => "visible" as const) },
    });

    const request = delivery();
    await expect(inbox.accept(request)).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(credentials.prepare).toHaveBeenCalledOnce();
    expect(credentials.cleanup).not.toHaveBeenCalled();
    expect(inbox.getState(request.messageId)?.status).toBe("dead-letter");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED", messageId: request.messageId }),
      "Visible Session collaboration outbox preparation failed",
    );
    inbox.stop();
  });

  it("dead-letters a non-completed prompt result", async () => {
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      retryPolicy: { maxAttempts: 1, maxAgeMs: 10_000 },
      runtimeManager: {
        ensureRuntime: vi.fn(
          async () =>
            ({
              waitForIdle: vi.fn(async () => undefined),
              prompt: vi.fn(async () => ({ status: "failed", error: { message: "provider rejected input" } })),
            }) as never,
        ),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    const request = delivery();

    await expect(inbox.accept(request)).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(inbox.getState(request.messageId)?.status).toBe("dead-letter");
    inbox.stop();
  });

  it("reconciles succeeded, failed, expired, and running persisted records", async () => {
    let now = 10_000;
    const store = new MemoryRuntimeDurabilityStore();
    const succeeded = delivery({ text: "succeeded" });
    const failed = delivery({ text: "failed" });
    const expired = delivery({ text: "expired" });
    const running = delivery({ text: "running" });
    await Promise.all([
      store.write(recordFor(succeeded, "succeeded")),
      store.write(recordFor(failed, "failed", { attempts: 1, lastError: failureFor(failed, "runtime_failed") })),
      store.write(recordFor(expired, "accepted", { acceptedAt: 1, attempts: 0 })),
      store.write(recordFor(running, "running")),
    ]);
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async ({ runId }: { runId: string }) => ({ runId, status: "completed", output: [] })),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      logger: { warn: vi.fn() },
      maxQueuedPerSession: 8,
      now: () => now,
      persistence: store,
      reconciler: inboxReconciler(),
      retryPolicy: { maxAttempts: 5, maxAgeMs: 100 },
      runtimeManager: {
        ensureRuntime: vi.fn(async () => runtime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });

    await inbox.ready();
    await inbox.settled();
    expect(inbox.getState(succeeded.messageId)?.status).toBe("succeeded");
    expect(inbox.getState(failed.messageId)?.status).toBe("failed");
    expect(inbox.getState(expired.messageId)?.status).toBe("dead-letter");
    expect(inbox.getState(running.messageId)?.status).toBe("succeeded");
    expect(runtime.prompt).toHaveBeenCalledOnce();
    now += 1_000;
    inbox.stop();
  });

  it("bounds hydrated recovery and logs when the queue is full", async () => {
    const store = new MemoryRuntimeDurabilityStore();
    const first = delivery({ text: "first recovery" });
    const second = delivery({
      text: "second recovery",
      agentId: first.agentId,
      targetSessionId: first.targetSessionId,
    });
    await store.write(recordFor(first, "retryable"));
    await store.write(recordFor(second, "retryable"));
    const admission = new AdmissionController();
    const held = admission.reserve(first.targetSessionId, first.agentId);
    if (!held.accepted) throw new Error("Expected the test reservation");
    held.reservation.markActive();
    const logger = { warn: vi.fn() };
    const inbox = new SessionMessageInbox({
      admission,
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      logger,
      maxQueuedPerSession: 1,
      now: () => 10_000,
      persistence: store,
      reconciler: inboxReconciler(),
      runtimeManager: { ensureRuntime: vi.fn(), sessionKind: vi.fn(() => "internal" as const) },
    });

    await inbox.ready();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: second.messageId, sessionId: second.targetSessionId }),
      "Durable inbox capacity delayed recovery",
    );
    held.reservation.release();
    inbox.stop();
    await inbox.settled();
  });

  it("keeps retry state observable when retry persistence fails and evicts old receipts", async () => {
    const logger = { warn: vi.fn() };
    const first = delivery({ text: "first" });
    const persistence = {
      list: vi.fn(async () => []),
      write: vi.fn(async (record: { key: string; status: string }) => {
        if (record.key === `${first.targetSessionId}:${first.messageId}` && record.status === "retryable") {
          throw new Error("disk full during retry");
        }
      }),
    };
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      logger,
      persistence,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: vi.fn(async () => runtime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    await expect(inbox.accept(first)).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_MESSAGE_PERSISTENCE_FAILED", status: "retryable" }),
      "Session message retry state could not be persisted",
    );
    expect(inbox.getState(first.messageId)?.status).toBe("retryable");
    inbox.stop();

    const remembered = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      maxRememberedMessages: 1,
      reconciler: inboxReconciler("invalid_input"),
      runtimeManager: { ensureRuntime: vi.fn(), sessionKind: vi.fn(() => "internal" as const) },
    });
    await remembered.accept(delivery({ text: "receipt one" }));
    await remembered.accept(delivery({ text: "receipt two" }));
    remembered.stop();
  });

  it("normalizes structured failure fields and bounded receipt memory", async () => {
    const request = delivery();
    const structured = {
      category: "provider",
      code: "provider_failed",
      phase: "prompt",
      requestId: request.requestId,
      retryability: "retryable",
      message: "x".repeat(400),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      maxRememberedMessages: 1,
      onFailure: (failure) => expect(failure).toMatchObject({ code: "provider_failed", message: "x".repeat(256) }),
      reconciler: inboxReconciler(),
      retryPolicy: { maxAttempts: 1, maxAgeMs: 10_000 },
      runtimeManager: {
        ensureRuntime: vi.fn(
          async () =>
            ({
              waitForIdle: vi.fn(async () => undefined),
              prompt: vi.fn(async () => {
                throw structured;
              }),
            }) as never,
        ),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });

    await expect(inbox.accept(request)).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(inbox.getState(request.messageId)?.lastError?.message).toHaveLength(256);
    inbox.stop();
  });

  it("persists running work, retries with an injected scheduler, and dead-letters after bounded attempts", async () => {
    let now = 1_000;
    const scheduled: Array<() => void> = [];
    const scheduler: RuntimeRetryScheduler = {
      schedule(_delay, task) {
        scheduled.push(task);
        return { cancel: () => undefined };
      },
    };
    const store = new MemoryRuntimeDurabilityStore();
    const metrics = new RuntimeDurabilityMetrics();
    const request = delivery({ text: "retry me" });
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      maxRememberedMessages: 10,
      metrics,
      now: () => now,
      persistence: store,
      retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2, maxAgeMs: 100 },
      scheduler,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: vi.fn(async () => runtime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    await expect(inbox.accept(request)).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(inbox.getState(request.messageId)?.status).toBe("retryable");
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
    await inbox.settled();
    expect(inbox.getState(request.messageId)?.status).toBe("dead-letter");
    expect(inbox.metricsSnapshot()).toMatchObject({ retries: 1, deadLetters: 1 });
    now += 1_000;
    inbox.stop();
  });

  it("reconciles a running message after restart without reporting success from queue admission", async () => {
    const store = new MemoryRuntimeDurabilityStore();
    const request = delivery({ text: "resume me" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstRuntime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async () => {
        await gate;
        return { runId: "first", status: "completed", output: [] };
      }),
    };
    const first = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      persistence: store,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: vi.fn(async () => firstRuntime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    await expect(first.accept(request)).resolves.toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(firstRuntime.prompt).toHaveBeenCalledOnce());
    expect(first.getState(request.messageId)?.status).toBe("running");
    first.stop();
    release();
    await first.settled();

    const resumedRuntime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async ({ runId }: { runId: string }) => ({ runId, status: "completed", output: [] })),
    };
    const second = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      persistence: store,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: vi.fn(async () => resumedRuntime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    await second.ready();
    await second.settled();
    expect(resumedRuntime.prompt).toHaveBeenCalledOnce();
    expect(second.getState(request.messageId)?.status).toBe("succeeded");
    second.stop();
  });

  it("accepts immediately, waits for shared admission, and drains one Session in FIFO order", async () => {
    const admission = new AdmissionController();
    const targetSessionId = randomUUID();
    const agentId = randomUUID();
    const held = admission.reserve(targetSessionId, agentId);
    if (!held.accepted) throw new Error("Expected the test reservation");
    held.reservation.markActive();
    const prompts: string[] = [];
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async (request: { input: { items: readonly { text: string }[] } }) => {
        prompts.push(request.input.items.at(-1)?.text ?? "");
        return { runId: "run", status: "completed", output: [] };
      }),
    };
    const inbox = new SessionMessageInbox({
      admission,
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: vi.fn(async () => runtime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    const first = delivery({ targetSessionId, agentId, text: "first" });
    const second = delivery({ targetSessionId, agentId, text: "second" });
    expect((await inbox.accept(first)).status).toBe("accepted");
    expect((await inbox.accept(second)).status).toBe("accepted");
    expect(prompts).toEqual([]);
    held.reservation.release();
    await vi.waitFor(() => expect(prompts).toEqual(["first", "second"]));
    await inbox.settled();
    inbox.stop();
  });

  it("deduplicates the same logical payload and rejects a conflicting retry", async () => {
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler("session_not_ready"),
      runtimeManager: { ensureRuntime: vi.fn(), sessionKind: vi.fn(() => "internal" as const) },
    });
    const original = delivery({ text: "same" });
    await expect(inbox.accept(original)).resolves.toMatchObject({ status: "rejected", reason: "session_not_ready" });
    await expect(inbox.accept({ ...original, requestId: randomUUID() })).resolves.toMatchObject({
      status: "rejected",
      reason: "session_not_ready",
    });
    await expect(
      inbox.accept({ ...original, requestId: randomUUID(), content: { kind: "text", text: "different" } }),
    ).resolves.toMatchObject({ status: "rejected", reason: "input_conflict" });
    inbox.stop();
  });

  it("keeps logical-message deduplication stable across route snapshot refreshes", async () => {
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async (request: { runId: string }) => ({ runId: request.runId, status: "completed", output: [] })),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      runtimeManager: {
        ensureRuntime: vi.fn(async () => runtime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    const original = delivery({ text: "same logical message" });
    expect((await inbox.accept(original)).status).toBe("accepted");
    await expect(
      inbox.accept({
        ...original,
        requestId: randomUUID(),
        placementGeneration: original.placementGeneration + 1,
        runtime: {
          ...original.runtime,
          revision: {
            ...original.runtime.revision,
            session: { sequence: 2, id: "c".repeat(64) },
          },
        },
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(runtime.prompt).toHaveBeenCalledOnce();
    inbox.stop();
  });

  it("keeps capability-changing reconcile busy until an active SessionMessage Run settles", async () => {
    const computerId = randomUUID();
    const request = delivery();
    let capabilityChanged = false;
    const preparation = {
      prepareAgent: vi.fn(async () => undefined),
      prepareSession: vi.fn(async () => undefined),
      requiresSessionPreparation: vi.fn(() => capabilityChanged),
      stopSession: vi.fn(async () => undefined),
    };
    const reconciler = new SessionReconciler({ computerId, preparation });
    const reconcile = reconcileFor(computerId, request);
    await expect(reconciler.reconcile(reconcile)).resolves.toMatchObject({ status: "ready" });

    let finishPrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    const promptStarted = vi.fn();
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async ({ runId }: { runId: string }) => {
        promptStarted();
        await promptGate;
        return { runId, status: "completed", output: [] };
      }),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      reconciler,
      runtimeManager: {
        ensureRuntime: vi.fn(async () => runtime as never),
        sessionKind: vi.fn(() => "internal" as const),
      },
    });
    expect((await inbox.accept(request)).status).toBe("accepted");
    await vi.waitFor(() => expect(promptStarted).toHaveBeenCalledOnce());

    capabilityChanged = true;
    await expect(reconciler.reconcile({ ...reconcile, requestId: randomUUID() })).resolves.toMatchObject({
      status: "running",
      turn: { deliveryId: request.messageId, turnId: `session-message-${request.messageId}` },
    });
    expect(preparation.prepareSession).toHaveBeenCalledOnce();

    finishPrompt();
    await inbox.settled();
    await expect(reconciler.reconcile({ ...reconcile, requestId: randomUUID() })).resolves.toMatchObject({
      status: "ready",
    });
    expect(preparation.prepareSession).toHaveBeenCalledTimes(2);
    inbox.stop();
  });

  it("rejects a delivery when an earlier stop reconcile wins the agent lock", async () => {
    const computerId = randomUUID();
    const request = delivery();
    let stopStarted!: () => void;
    const stopStart = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const preparation = {
      prepareAgent: vi.fn(async () => undefined),
      prepareSession: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => {
        stopStarted();
        await stopGate;
      }),
    };
    const reconciler = new SessionReconciler({ computerId, preparation });
    const reconcile = reconcileFor(computerId, request);
    await expect(reconciler.reconcile(reconcile)).resolves.toMatchObject({ status: "ready" });
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async ({ runId }: { runId: string }) => ({ runId, status: "completed", output: [] })),
    };
    const runtimeManager = {
      ensureRuntime: vi.fn(async () => runtime as never),
      sessionKind: vi.fn(() => "internal" as const),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      reconciler,
      runtimeManager,
    });

    const stopping = reconciler.reconcile({
      ...reconcile,
      requestId: randomUUID(),
      desired: "stopped",
      runtime: undefined,
    });
    await stopStart;
    let acceptSettled = false;
    const accepting = inbox.accept(request).finally(() => {
      acceptSettled = true;
    });
    await Promise.resolve();
    expect(acceptSettled).toBe(false);

    finishStop();
    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    await expect(accepting).resolves.toMatchObject({ status: "rejected", reason: "session_not_ready" });
    expect(runtimeManager.ensureRuntime).not.toHaveBeenCalled();

    const moved = { ...reconcile, requestId: randomUUID(), placementGeneration: 2 };
    await expect(reconciler.reconcile(moved)).resolves.toMatchObject({ status: "ready" });
    const retry = { ...request, requestId: randomUUID(), placementGeneration: 2 };
    await expect(inbox.accept(retry)).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    await expect(inbox.accept({ ...retry, requestId: randomUUID() })).resolves.toMatchObject({ status: "accepted" });
    expect(runtimeManager.ensureRuntime).toHaveBeenCalledOnce();
    expect(runtime.prompt).toHaveBeenCalledOnce();
    inbox.stop();
  });

  it("builds managed collaboration context without IM provider references", () => {
    const input = buildSessionMessageInput(delivery({ text: "Report the result" }));
    expect(input.items[0]?.text).toContain("final text is not returned automatically");
    expect(input.items[0]?.text).toContain("opentag session send");
    expect(input.items[0]?.text).toContain("Message ID:");
    expect(input.items[0]?.text).not.toContain("OPENTAG_PROVIDER_ENV_FILE");
    expect(input.items[1]?.text).toBe("Report the result");
  });

  it("prepares visible Session outbox resources before Provider start and cleans them after the Run", async () => {
    const order: string[] = [];
    const credentials = {
      prepare: vi.fn(async () => {
        order.push("prepare");
        return {
          path: "/tmp/provider-env.sh",
          provider: "slack" as const,
          outboxContext: {
            provider: "slack" as const,
            sessionKind: "thread" as const,
            channelId: "C-visible",
            threadTs: "1710000000.000001",
          },
        };
      }),
      cleanup: vi.fn(async () => {
        order.push("cleanup");
      }),
    };
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async (request: { runId: string; input: { items: readonly { text: string }[] } }) => {
        order.push("prompt");
        expect(request.input.items[0]?.text).toContain("OPENTAG_PROVIDER_ENV_FILE");
        expect(request.input.items[0]?.text).toContain('"threadTs":"1710000000.000001"');
        expect(request.input.items[0]?.text).toContain("Do not wait for another IM message");
        return { runId: request.runId, status: "completed", output: [] };
      }),
    };
    const runtimeManager = {
      ensureRuntime: vi.fn(async () => {
        order.push("runtime");
        return runtime as never;
      }),
      sessionKind: vi.fn(() => "visible" as const),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentials,
      imCredentialGrantVersion: () => 2,
      reconciler: inboxReconciler(),
      runtimeManager,
    });

    expect((await inbox.accept(delivery())).status).toBe("accepted");
    await inbox.settled();
    expect(order).toEqual(["prepare", "runtime", "prompt", "cleanup"]);
    expect(credentials.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ placementGeneration: 1 }),
      expect.any(AbortSignal),
    );
    inbox.stop();
  });

  it("rejects a visible callback before ACK under grant v1 and accepts the same message after v2 is restored", async () => {
    let grantVersion = 1;
    const credentials = {
      prepare: vi.fn(async () => ({
        path: "/tmp/provider-env.sh",
        provider: "slack" as const,
        outboxContext: {
          provider: "slack" as const,
          sessionKind: "channel" as const,
          channelId: "C-visible",
        },
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const runtime = {
      waitForIdle: vi.fn(async () => undefined),
      prompt: vi.fn(async (request: { runId: string }) => ({
        runId: request.runId,
        status: "completed" as const,
        output: [],
      })),
    };
    const runtimeManager = {
      ensureRuntime: vi.fn(async () => runtime as never),
      sessionKind: vi.fn(() => "visible" as const),
    };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentials,
      imCredentialGrantVersion: () => grantVersion,
      reconciler: inboxReconciler(),
      runtimeManager,
    });
    const request = delivery();

    await expect(inbox.accept(request)).resolves.toMatchObject({
      status: "rejected",
      reason: "session_not_ready",
    });
    expect(credentials.prepare).not.toHaveBeenCalled();
    expect(runtimeManager.ensureRuntime).not.toHaveBeenCalled();

    grantVersion = 2;
    await expect(inbox.accept({ ...request, requestId: randomUUID() })).resolves.toMatchObject({ status: "accepted" });
    await inbox.settled();
    expect(credentials.prepare).toHaveBeenCalledOnce();
    expect(runtime.prompt).toHaveBeenCalledOnce();
    inbox.stop();
  });

  it("fails closed before Provider start when a v2 credential grant omits visible Session outbox context", async () => {
    const credentials = {
      prepare: vi.fn(async () => ({ path: "/tmp/provider-env.sh", provider: "slack" as const })),
      cleanup: vi.fn(async () => undefined),
    };
    const runtimeManager = {
      ensureRuntime: vi.fn(),
      sessionKind: vi.fn(() => "visible" as const),
    };
    const logger = { warn: vi.fn() };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
      credentialEnvironment: credentials,
      imCredentialGrantVersion: () => 2,
      logger,
      reconciler: inboxReconciler(),
      runtimeManager,
    });

    expect((await inbox.accept(delivery())).status).toBe("accepted");
    await inbox.settled();
    expect(runtimeManager.ensureRuntime).not.toHaveBeenCalled();
    expect(credentials.cleanup).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED" }),
      expect.any(String),
    );
    inbox.stop();
  });

  it("enforces bounded capacity and rejects new work after shutdown", async () => {
    const admission = new AdmissionController();
    const targetSessionId = randomUUID();
    const agentId = randomUUID();
    const held = admission.reserve(targetSessionId, agentId);
    if (!held.accepted) throw new Error("Expected the test reservation");
    held.reservation.markActive();
    const runtimeManager = { ensureRuntime: vi.fn(), sessionKind: vi.fn(() => "internal" as const) };
    const inbox = new SessionMessageInbox({
      admission,
      credentialEnvironment: credentialEnvironment(),
      imCredentialGrantVersion: () => 2,
      maxQueuedPerSession: 1,
      maxQueuedTotal: 1,
      reconciler: inboxReconciler(),
      runtimeManager,
    });
    expect((await inbox.accept(delivery({ targetSessionId, agentId, text: "queued" }))).status).toBe("accepted");
    await expect(inbox.accept(delivery({ targetSessionId, agentId, text: "over capacity" }))).resolves.toMatchObject({
      status: "rejected",
      reason: "client_busy",
    });
    inbox.stop();
    await expect(inbox.accept(delivery({ targetSessionId, agentId, text: "after stop" }))).resolves.toMatchObject({
      status: "rejected",
      reason: "client_busy",
    });
    held.reservation.release();
    await inbox.settled();
    expect(runtimeManager.ensureRuntime).not.toHaveBeenCalled();
  });
});

function delivery(
  overrides: Partial<SessionMessageDeliveryRequest> & { text?: string } = {},
): SessionMessageDeliveryRequest {
  const { content, text, ...frameOverrides } = overrides;
  const agentId = overrides.agentId ?? randomUUID();
  return {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    runtime: {
      revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
    },
    ...frameOverrides,
    content: { kind: "text", text: text ?? content?.text ?? "work" },
  };
}

function reconcileFor(computerId: string, request: SessionMessageDeliveryRequest): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: request.targetSessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    desired: "ready",
    sessionKind: "internal",
    creatorSessionId: request.sourceSessionId,
    runtime: request.runtime,
  };
}

function inboxReconciler(reason?: InputRejectReason) {
  return {
    checkSessionMessageDelivery: () => reason,
    clearActivity: () => true,
    setActivity: () => undefined,
    withAgentLock: async <T>(_agentId: string, task: () => Promise<T>) => task(),
  };
}

function credentialEnvironment() {
  return {
    cleanup: vi.fn(async () => undefined),
    prepare: vi.fn(async () => {
      throw new Error("Internal Sessions must not prepare provider credentials");
    }),
  };
}

function recordFor(
  request: SessionMessageDeliveryRequest,
  status: DurableWorkRecord["status"],
  overrides: Partial<DurableWorkRecord<SessionMessageDeliveryRequest>> = {},
): DurableWorkRecord<SessionMessageDeliveryRequest> {
  return {
    acceptedAt: 10_000,
    attempts: 0,
    key: `${request.targetSessionId}:${request.messageId}`,
    kind: "session-message",
    payload: request,
    status,
    updatedAt: 10_000,
    ...overrides,
  };
}

function failureFor(request: SessionMessageDeliveryRequest, code: string): DurableFailure {
  return {
    category: "unavailable",
    code,
    message: code,
    phase: "transport",
    requestId: request.requestId,
    retryability: "backoff",
  };
}
