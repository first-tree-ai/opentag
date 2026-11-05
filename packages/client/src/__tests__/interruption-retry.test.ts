import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_CAPABILITY,
  type RuntimeImSteerRequest,
  type SessionRecoverRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../agent-runtime/types.js";
import { AdmissionController } from "../runtime/admission-controller.js";
import { AgentTurnRunner, buildRetryAgentInput } from "../runtime/agent-turn-runner.js";
import { InterruptedWorkRecovery } from "../runtime/interrupted-work-recovery.js";
import {
  buildContinuationNotice,
  recoverableFailure,
  type TurnRetryRecord,
  TurnRetryStore,
  turnRetryRecord,
} from "../runtime/interruption-retry.js";
import type { RuntimeConnectionState } from "../runtime/runtime-connection.js";
import type { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import type { SessionRuntimeManager } from "../runtime/session-runtime-manager.js";
import { type LiveTurnOwner, TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import type { TurnReportOwner } from "../runtime/turn-report-owner.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("interruption classification and continuation", () => {
  it("retries only the recoverable classes", () => {
    for (const reason of ["turn_timeout", "provider_rate_limited", "client_shutdown", "daemon_crash"]) {
      expect(recoverableFailure(reason)).toBe(reason);
    }
    for (const reason of [
      undefined,
      "provider_failed",
      "provider_quota_exceeded",
      "provider_authentication_failed",
      "credential_unavailable",
      "provider_start_failed",
      "turn_state_unknown",
    ]) {
      expect(recoverableFailure(reason)).toBeUndefined();
    }
  });

  it("states the reason, the retry count, and how to continue", () => {
    expect(buildContinuationNotice({ reason: "client_shutdown", at: "2026-11-05T01:00:00.000Z" })).toBe(
      "[OpenTag] Your previous turn was interrupted at 2026-11-05T01:00:00.000Z because the OpenTag daemon was restarted or upgraded (automatic retry 1/1). Before continuing, check your history and the work already done in this conversation, including replies already sent, then continue the original request. The original request follows; it may duplicate a message already in your history. Do not repeat replies or side effects that already happened.",
    );
    expect(buildContinuationNotice({ reason: "daemon_crash", at: "T" })).toContain(
      "interrupted at or before T because the OpenTag daemon stopped unexpectedly (process crash or power loss)",
    );
    expect(buildContinuationNotice({ reason: "provider_rate_limited", at: "T" })).toContain("(HTTP 429)");
  });

  it("re-includes the original input and steered messages after the notice", () => {
    const request = delivery();
    const steer = steerRequest(request, "and also this");
    const input = buildRetryAgentInput(request, [steer], { reason: "turn_timeout", at: "T" }, new Date(0));
    const texts = input.items.map((item) => (item.type === "text" ? item.text : ""));
    expect(texts[0]).toContain("because the turn reached its maximum run duration");
    expect(texts).toContain("hello");
    expect(texts.at(-1)).toContain("Messages that arrived during the interrupted turn");
    expect(texts.at(-1)).toContain("and also this");
  });
});

describe("TurnRetryStore", () => {
  it("keeps one record per Session, updates it for the same Turn, and removes it", async () => {
    const store = new TurnRetryStore(await home());
    expect(await store.list()).toEqual([]);
    const request = delivery();
    await store.write(turnRetryRecord(request, "turn-1"));
    await store.appendSteer(steerRequest(request, "steered"));
    await store.appendSteer(steerRequest(request, "steered"));
    expect(
      await store.update(request.sessionId, "other-turn", (record) => ({ ...record, retries: 9 })),
    ).toBeUndefined();
    await store.update(request.sessionId, "turn-1", (record) => ({
      ...record,
      interruption: { reason: "client_shutdown", at: "T" },
    }));
    const [stored] = await store.list();
    expect(stored).toMatchObject({
      turnId: "turn-1",
      retries: 0,
      interruption: { reason: "client_shutdown", at: "T" },
      steers: [expect.objectContaining({ deliveryId: "steer-delivery" })],
    });
    await store.remove(request.sessionId, "other-turn");
    expect(await store.read(request.sessionId)).toBeDefined();
    await store.remove(request.sessionId, "turn-1");
    await store.remove(request.sessionId, "turn-1");
    expect(await store.list()).toEqual([]);
  });
});

describe("AgentTurnRunner automatic retry", () => {
  it("retries a timed-out Turn once in place with the continuation notice and reports the retry", async () => {
    const h = runnerHarness();
    h.request.runtime.budget = { maxDurationMs: 20 };
    h.records.set(h.request.sessionId, {
      ...turnRetryRecord(h.request, "turn-1"),
      steers: [steerRequest(h.request, "steered in")],
    });
    h.prompt
      .mockImplementationOnce(abortedOnSignal)
      .mockImplementationOnce(async () => ({ runId: "turn-1", status: "completed", output: [] }));
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    const retryItems = promptItems(h.prompt, 1);
    expect(retryItems[0]?.text).toContain("maximum run duration (automatic retry 1/1)");
    expect(retryItems.at(-1)?.text).toContain("steered in");
    expect(h.records.get(h.request.sessionId)).toMatchObject({ retries: 1 });
    expect(h.records.get(h.request.sessionId)?.interruption).toBeUndefined();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it("reports the failure when the one retry also times out", async () => {
    const h = runnerHarness();
    h.request.runtime.budget = { maxDurationMs: 20 };
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.prompt.mockImplementation(abortedOnSignal);
    h.runner.start(owner(h.request));
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", errorReason: "turn_timeout" }),
      3,
    );
  });

  it("waits before retrying a rate-limited Turn", async () => {
    vi.useFakeTimers();
    const h = runnerHarness();
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    h.prompt
      .mockImplementationOnce(async () => ({
        runId: "turn-1",
        status: "failed",
        output: [],
        error: { code: "provider_rate_limited", message: "429" },
      }))
      .mockImplementationOnce(async () => ({ runId: "turn-1", status: "completed", output: [] }));
    h.runner.start(owner(h.request));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.prompt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.prompt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await h.runner.settled();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
  });

  it("does not retry non-recoverable failures, spent retries, or Turns without durable input", async () => {
    for (const scenario of ["provider_failed", "spent", "no-record"] as const) {
      const h = runnerHarness();
      h.request.runtime.budget = { maxDurationMs: 20 };
      if (scenario !== "no-record")
        h.records.set(h.request.sessionId, {
          ...turnRetryRecord(h.request, "turn-1"),
          retries: scenario === "spent" ? 1 : 0,
        });
      h.prompt.mockImplementation(
        scenario === "provider_failed"
          ? async () => ({
              runId: "turn-1",
              status: "failed",
              output: [],
              error: { code: "provider_error", message: "no" },
            })
          : abortedOnSignal,
      );
      h.runner.start(owner(h.request));
      await h.runner.settled();
      expect(h.prompt).toHaveBeenCalledOnce();
      expect(h.create).toHaveBeenCalledOnce();
    }
  });

  it("leaves a Turn interrupted by an orderly stop for the restarted daemon", async () => {
    const h = runnerHarness({ restartRetry: true });
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.prompt.mockImplementation((input) => {
      started();
      return abortedOnSignal(input);
    });
    h.runner.start(owner(h.request));
    await running;
    h.runner.stop();
    await h.runner.settled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.markReporting).not.toHaveBeenCalled();
    expect(h.records.get(h.request.sessionId)).toMatchObject({
      retries: 0,
      interruption: { reason: "client_shutdown" },
    });
  });

  it("reports an orderly stop as cancelled when the Server cannot recover Sessions", async () => {
    const h = runnerHarness({ restartRetry: false });
    h.records.set(h.request.sessionId, turnRetryRecord(h.request, "turn-1"));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.prompt.mockImplementation((input) => {
      started();
      return abortedOnSignal(input);
    });
    h.runner.start(owner(h.request));
    await running;
    h.runner.stop();
    await h.runner.settled();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "cancelled", errorReason: "client_shutdown" }),
      3,
    );
  });

  it("starts a restart retry with the continuation notice and without moving the custody phase back", async () => {
    const h = runnerHarness();
    h.records.set(h.request.sessionId, { ...turnRetryRecord(h.request, "turn-1"), retries: 1 });
    h.runner.start(owner(h.request), { continuation: { reason: "daemon_crash", at: "T" } });
    await h.runner.settled();
    const items = promptItems(h.prompt, 0);
    expect(items[0]?.text).toContain("interrupted at or before T");
    expect(h.updateUnresolved).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "turn-1", "starting");
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "completed" }), 3);
  });
});

describe("TurnCustodyOwner automatic retry custody", () => {
  it("records durable input on acceptance, resumes the Turn, and removes the input when recorded", async () => {
    const request = delivery();
    const retries = { write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    const start = vi.fn();
    const reconciler = new SessionReconciler({ installationId: "installation" });
    const recordResult = vi.fn(async () => undefined);
    const custody = new TurnCustodyOwner({
      bindingStore: { recordResult } as unknown as SessionBindingStore,
      reconciler,
      retries,
      start,
    });
    expect(custody.resume(request, "turn-1", { continuation: { reason: "daemon_crash", at: "T" } })).toBe(true);
    expect(start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ turnId: "turn-1", request }),
      expect.objectContaining({ continuation: { reason: "daemon_crash", at: "T" } }),
    );
    expect(reconciler.protectedWorkSnapshot().activities).toEqual([
      expect.objectContaining({ sessionId: request.sessionId, turnId: "turn-1", phase: "running" }),
    ]);
    // A second resume of the same Turn, or another Turn in a busy Session, does not start.
    expect(custody.resume(request, "turn-1", { continuation: { reason: "daemon_crash", at: "T" } })).toBe(false);
    expect(
      custody.resume({ ...request, deliveryId: "other" }, "turn-2", {
        continuation: { reason: "daemon_crash", at: "T" },
      }),
    ).toBe(false);
    await custody.recordResult("turn-1", "a".repeat(64));
    expect(retries.remove).toHaveBeenCalledExactlyOnceWith(request.sessionId, "turn-1");
    expect(custody.admission.snapshot().sessions).toBe(0);
  });
});

describe("InterruptedWorkRecovery", () => {
  it("spends the retry on startup, asks the Server to recover, and resumes on the ready reconcile", async () => {
    const f = recoveryFixture();
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "running" });
    await f.recovery.start();
    expect(f.records.get(request.sessionId)).toMatchObject({ retries: 1, interruption: { reason: "daemon_crash" } });
    expect(f.reconciler.setRecovery).toHaveBeenCalledWith(request.sessionId, {
      deliveryId: request.deliveryId,
      turnId: "turn-1",
    });
    const turn = { deliveryId: request.deliveryId, turnId: "turn-1" };
    // Until the connection negotiates recovery, nothing is pending (an older Server reports instead).
    expect(f.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(false);
    f.version = 1;
    expect(f.recovery.pending(request.sessionId, turn)).toBe(true);
    expect(f.recovery.pendingCount).toBe(1);

    f.inbox.awaiting = [{ sessionId: "child-session", agentId: request.agentId, placementGeneration: 1 }];
    f.setState("registered");
    expect(f.sent).toEqual([
      expect.objectContaining({ type: "session:recover", sessionId: "child-session", agentId: request.agentId }),
      expect.objectContaining({
        type: "session:recover",
        sessionId: request.sessionId,
        deliveryId: request.deliveryId,
        turnId: "turn-1",
      }),
    ]);
    const visibleFrame = f.sent[1] as SessionRecoverRequest;
    f.recovery.handleResult({
      type: "session:recover:result",
      requestId: visibleFrame.requestId,
      sessionId: request.sessionId,
      status: "scheduled",
    });
    expect(f.recovery.resume(request.sessionId, turn)).toBe(true);
    expect(f.custody.resume).toHaveBeenCalledExactlyOnceWith(request, "turn-1", {
      continuation: expect.objectContaining({ reason: "daemon_crash" }),
      steers: [],
    });
    expect(f.recovery.pending(request.sessionId, turn)).toBe(false);

    const childFrame = f.sent[0] as SessionRecoverRequest;
    f.recovery.handleResult({
      type: "session:recover:result",
      requestId: childFrame.requestId,
      sessionId: "child-session",
      status: "rejected",
      reason: "session_ended",
    });
    await vi.waitFor(() =>
      expect(f.inbox.failAwaitingPreparation).toHaveBeenCalledWith("child-session", "session_ended"),
    );
    f.recovery.stop();
  });

  it("keeps the recorded reason of an orderly stop and leaves spent or recorded Turns to report recovery", async () => {
    const f = recoveryFixture();
    const stopped = delivery("session-stopped");
    const spent = delivery("session-spent");
    const recorded = delivery("session-recorded");
    f.records.set(stopped.sessionId, {
      ...turnRetryRecord(stopped, "turn-stopped"),
      interruption: { reason: "client_shutdown", at: "T" },
    });
    f.records.set(spent.sessionId, { ...turnRetryRecord(spent, "turn-spent"), retries: 1 });
    f.records.set(recorded.sessionId, turnRetryRecord(recorded, "turn-recorded"));
    f.unresolved.set(stopped.sessionId, { turnId: "turn-stopped", deliveryId: stopped.deliveryId, phase: "running" });
    f.unresolved.set(spent.sessionId, { turnId: "turn-spent", deliveryId: spent.deliveryId, phase: "running" });
    await f.recovery.start();
    f.version = 1;
    expect(f.records.get(stopped.sessionId)).toMatchObject({
      retries: 1,
      interruption: { reason: "client_shutdown", at: "T" },
    });
    expect(f.recovery.isPendingRetry(stopped.sessionId, "turn-stopped")).toBe(true);
    expect(f.recovery.isPendingRetry(spent.sessionId, "turn-spent")).toBe(false);
    expect(f.records.has(recorded.sessionId)).toBe(false);
    expect(f.reconciler.setRecovery).toHaveBeenCalledOnce();
  });

  it("falls back to failure reporting when the Server cannot recover or never answers", async () => {
    vi.useFakeTimers();
    const f = recoveryFixture();
    const request = delivery();
    f.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    f.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "starting" });
    await f.recovery.start();
    // An older Server: nothing pending, every waiting Session message fails with a notice.
    f.inbox.awaiting = [{ sessionId: "child-session", agentId: request.agentId, placementGeneration: 1 }];
    f.setState("registered");
    expect(f.sent).toEqual([]);
    expect(f.inbox.failAwaitingPreparation).toHaveBeenCalledWith("child-session", "session_recovery_unavailable");

    const g = recoveryFixture();
    g.records.set(request.sessionId, turnRetryRecord(request, "turn-1"));
    g.unresolved.set(request.sessionId, { turnId: "turn-1", deliveryId: request.deliveryId, phase: "starting" });
    await g.recovery.start();
    g.version = 1;
    g.setState("registered");
    const frame = g.sent[0] as SessionRecoverRequest;
    g.recovery.handleResult({
      type: "session:recover:result",
      requestId: frame.requestId,
      sessionId: request.sessionId,
      status: "retry",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.sent).toHaveLength(2);
    // Every later attempt goes unanswered until the bounded attempts run out.
    await vi.advanceTimersByTimeAsync(40_000 * 30);
    expect(g.recovery.isPendingRetry(request.sessionId, "turn-1")).toBe(false);
    expect(g.inbox.failAwaitingPreparation).toHaveBeenCalledWith(request.sessionId, "session_recovery_timeout");
    g.recovery.stop();
  });
});

function recoveryFixture() {
  const records = new Map<string, TurnRetryRecord>();
  const unresolved = new Map<string, { turnId: string; deliveryId: string; phase: string }>();
  const sent: unknown[] = [];
  let listener: (state: RuntimeConnectionState) => void = () => undefined;
  const fixture = {
    records,
    unresolved,
    sent,
    version: undefined as number | undefined,
    inbox: {
      awaiting: [] as Array<{ sessionId: string; agentId: string; placementGeneration: number }>,
      sessionsAwaitingPreparation: () => fixture.inbox.awaiting,
      failAwaitingPreparation: vi.fn(async () => undefined),
    },
    custody: { resume: vi.fn(() => true) },
    reconciler: { setRecovery: vi.fn(), clearRecovery: vi.fn(() => true) },
    setState: (state: RuntimeConnectionState) => listener(state),
    recovery: undefined as unknown as InterruptedWorkRecovery,
  };
  fixture.recovery = new InterruptedWorkRecovery({
    bindingStore: {
      read: async (_agentId: string, sessionId: string) =>
        (unresolved.has(sessionId) ? { unresolvedTurn: unresolved.get(sessionId) } : undefined) as never,
    },
    connection: {
      capabilityVersion: (capability) =>
        capability === RUNTIME_CAPABILITY.sessionRecovery ? fixture.version : undefined,
      send: vi.fn(async (frame: unknown) => {
        sent.push(frame);
      }),
      subscribeState: (next) => {
        listener = next;
        return () => undefined;
      },
    },
    custody: fixture.custody,
    inbox: fixture.inbox,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => Date.parse("2026-11-05T00:00:00.000Z"),
    reconciler: fixture.reconciler,
    retries: {
      list: async () => [...records.values()],
      write: async (record) => {
        records.set(record.sessionId, record);
      },
      remove: async (sessionId) => {
        records.delete(sessionId);
      },
    },
  });
  return fixture;
}

function runnerHarness(options: { restartRetry?: boolean } = {}) {
  const request = delivery();
  const records = new Map<string, TurnRetryRecord>();
  const retries = {
    read: async (sessionId: string) => records.get(sessionId),
    update: async (sessionId: string, turnId: string, change: (record: TurnRetryRecord) => TurnRetryRecord) => {
      const current = records.get(sessionId);
      if (!current || current.turnId !== turnId) return undefined;
      const next = change(current);
      records.set(sessionId, next);
      return next;
    },
    appendSteer: async () => undefined,
  };
  const create = vi.fn((input: Parameters<TurnReportOwner["create"]>[0]) => ({
    ...input,
    type: "turn:report" as const,
    requestId: randomUUID(),
    resultHash: "c".repeat(64),
  }));
  const markReporting = vi.fn(async () => undefined);
  const submit = vi.fn(async () => undefined);
  const updateUnresolved = vi.fn(async () => undefined);
  const prompt = vi.fn(
    async (_input: { signal?: AbortSignal }): Promise<AgentRunResult> => ({
      runId: "turn-1",
      status: "completed",
      output: [],
    }),
  );
  const logs: RecordedLog[] = [];
  const runner = new AgentTurnRunner({
    bindingStore: { updateUnresolved } as unknown as SessionBindingStore,
    connection: { send: vi.fn(async () => undefined), capabilityVersion: () => 3 },
    custody: { markReporting, recordResult: vi.fn() } as unknown as TurnCustodyOwner,
    reportOwner: { create, submit } as unknown as TurnReportOwner,
    runtimeManager: {
      sessionKind: () => "internal",
      providerId: () => "codex",
      ensureRuntime: async () => ({ prompt }),
      observe: () => () => undefined,
    } as unknown as SessionRuntimeManager,
    credentialEnvironment: {
      prepare: vi.fn(async () => ({ path: "/tmp/provider-env.sh" })),
      cleanup: vi.fn(async () => undefined),
    },
    logger: recordingLogger(logs),
    retries,
    restartRetryAvailable: () => options.restartRetry ?? false,
  });
  return { request, records, runner, prompt, create, markReporting, submit, updateUnresolved };
}

function promptItems(prompt: { mock: { calls: unknown[][] } }, call: number): Array<{ text: string }> {
  const request = prompt.mock.calls[call]?.[0] as { input: { items: Array<{ text: string }> } } | undefined;
  if (!request) throw new Error(`prompt call ${call} is missing`);
  return request.input.items;
}

function abortedOnSignal(input: { signal?: AbortSignal }): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    input.signal?.addEventListener("abort", () => resolve({ runId: "turn-1", status: "aborted", output: [] }), {
      once: true,
    });
  });
}

function owner(request: DirectImMessageDeliveryRequest): LiveTurnOwner {
  const admission = new AdmissionController().reserve(request.sessionId, request.agentId);
  if (!admission.accepted) throw new Error("reservation");
  return { inputHash: "a".repeat(64), request, reservation: admission.reservation, turnId: "turn-1" };
}

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opentag-turn-retry-"));
  homes.push(path);
  return path;
}

function delivery(sessionId: string = randomUUID()): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId,
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "team-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: "1710000000.000001",
      },
    },
    runtime: {
      contextTrees: [],
      revision: { agent: { sequence: 1, id: "agent-revision" }, session: { sequence: 1, id: "session-revision" } },
      agentId: "agent-1",
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: true },
      workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    },
  };
}

function steerRequest(root: DirectImMessageDeliveryRequest, text: string): RuntimeImSteerRequest {
  return {
    type: "im:steer",
    requestId: randomUUID(),
    deliveryId: "steer-delivery",
    imMessageId: randomUUID(),
    rootDeliveryId: root.deliveryId,
    expectedTurnId: "turn-1",
    sessionId: root.sessionId,
    agentId: root.agentId,
    placementGeneration: root.placementGeneration,
    attention: "direct",
    content: { ...root.content, text },
  } as RuntimeImSteerRequest;
}
