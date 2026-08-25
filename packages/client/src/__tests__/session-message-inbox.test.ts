import { randomUUID } from "node:crypto";
import type { InputRejectReason, SessionMessageDeliveryRequest, SessionReconcileRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../runtime/admission-controller.js";
import { buildSessionMessageInput, SessionMessageInbox } from "../runtime/session-message-inbox.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";

describe("SessionMessageInbox", () => {
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
      reconciler: inboxReconciler(),
      runtimeManager: { ensureRuntime: vi.fn(async () => runtime as never) },
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
      reconciler: inboxReconciler("session_not_ready"),
      runtimeManager: { ensureRuntime: vi.fn() },
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
      reconciler: inboxReconciler(),
      runtimeManager: { ensureRuntime: vi.fn(async () => runtime as never) },
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
      reconciler,
      runtimeManager: { ensureRuntime: vi.fn(async () => runtime as never) },
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
    const runtimeManager = { ensureRuntime: vi.fn(async () => runtime as never) };
    const inbox = new SessionMessageInbox({
      admission: new AdmissionController(),
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
    expect(input.items[0]?.text).toContain("send_session_message");
    expect(input.items[0]?.text).not.toContain("OPENTAG_PROVIDER_ENV_FILE");
    expect(input.items[1]?.text).toBe("Report the result");
  });

  it("enforces bounded capacity and rejects new work after shutdown", async () => {
    const admission = new AdmissionController();
    const targetSessionId = randomUUID();
    const agentId = randomUUID();
    const held = admission.reserve(targetSessionId, agentId);
    if (!held.accepted) throw new Error("Expected the test reservation");
    held.reservation.markActive();
    const runtimeManager = { ensureRuntime: vi.fn() };
    const inbox = new SessionMessageInbox({
      admission,
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
