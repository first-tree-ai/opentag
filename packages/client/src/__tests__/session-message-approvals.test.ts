import { RUNTIME_CAPABILITY, type RuntimeApprovalRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AgentRuntimeEvent } from "../agent-runtime/types.js";
import {
  routeApprovalDecision,
  SESSION_MESSAGE_APPROVAL_DECLINED,
  SESSION_MESSAGE_APPROVAL_EXPIRED,
  SESSION_MESSAGE_APPROVAL_TIMEOUT_MS,
  SESSION_MESSAGE_APPROVAL_UNAVAILABLE,
  SessionMessageApprovals,
} from "../runtime/session-message-approvals.js";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = `session-message-${MESSAGE_ID}`;

function harness(options: { observeError?: Error; capability?: number; connection?: boolean } = {}) {
  let sink: ((event: AgentRuntimeEvent) => Promise<void>) | undefined;
  const stop = vi.fn();
  const runtimeManager = {
    observe: vi.fn((_sessionId: string, next: (event: AgentRuntimeEvent) => Promise<void>) => {
      if (options.observeError) throw options.observeError;
      sink = next;
      return stop;
    }),
  };
  const sent: RuntimeApprovalRequest[] = [];
  const connection = {
    send: vi.fn(async (frame: RuntimeApprovalRequest) => {
      sent.push(frame);
    }),
    capabilityVersion: vi.fn((name: string) =>
      name === RUNTIME_CAPABILITY.sessionMessageApproval ? options.capability : undefined,
    ),
  };
  const respond = vi.fn(async () => undefined);
  const runtime = { respond } as unknown as AgentRuntime;
  const logger = { debug: vi.fn() };
  const approvals = new SessionMessageApprovals({
    runtimeManager,
    logger,
    ...(options.connection === false ? {} : { connection }),
  });
  const emit = async (event: AgentRuntimeEvent) => {
    await sink?.(event);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { approvals, connection, emit, logger, respond, runtime, runtimeManager, sent, stop };
}

const request = (kind: "approval" | "question", requestId = "r1", runId = RUN_ID) => ({
  type: "interaction_requested" as const,
  runId,
  request: { requestId, kind, title: "Approve Bash", details: { command: "ps -ax" } },
});

const decision = (sent: RuntimeApprovalRequest, answer: "accept" | "decline") => ({
  type: "approval:decision" as const,
  requestId: sent.requestId,
  turnId: sent.turnId,
  sessionId: sent.sessionId,
  deliveryId: sent.deliveryId,
  placementGeneration: sent.placementGeneration,
  source: "session-message" as const,
  decision: answer,
});

afterEach(() => vi.useRealTimers());

describe("SessionMessageApprovals without a route to a person", () => {
  it("declines an approval at once and tells the model why, and cancels a question", async () => {
    const h = harness({ connection: false });
    const stop = h.approvals.watch("session-1", RUN_ID, h.runtime, 1);
    await h.emit(request("approval"));
    expect(h.respond).toHaveBeenCalledWith({
      expectedRunId: RUN_ID,
      requestId: "r1",
      kind: "approval",
      decision: "decline",
      reason: SESSION_MESSAGE_APPROVAL_UNAVAILABLE,
    });
    await h.emit(request("question", "q1"));
    expect(h.respond).toHaveBeenLastCalledWith({
      expectedRunId: RUN_ID,
      requestId: "q1",
      kind: "question",
      decision: "cancel",
    });
    await h.emit({ ...request("approval", "other"), runId: "run-2" });
    await h.emit({ type: "run_started", runId: RUN_ID });
    expect(h.respond).toHaveBeenCalledTimes(2);
    stop();
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the Server lacks the capability", { capability: undefined }, RUN_ID, 1],
    ["the Run is not a Session message's own Run", { capability: 1 }, "turn-1", 1],
    ["the placement is unknown", { capability: 1 }, RUN_ID, undefined],
  ] as const)("declines at once when %s", async (_case, options, runId, generation) => {
    const h = harness(options);
    h.approvals.watch("session-1", runId, h.runtime, generation);
    await h.emit(request("approval", "r1", runId));
    expect(h.sent).toHaveLength(0);
    expect(h.respond).toHaveBeenCalledWith(expect.objectContaining({ reason: SESSION_MESSAGE_APPROVAL_UNAVAILABLE }));
  });

  it("leaves requests to an existing observer, and logs a decline the runtime refuses", async () => {
    const busy = harness({ observeError: new Error("already observed") });
    expect(() => busy.approvals.watch("session-1", RUN_ID, busy.runtime, 1)()).not.toThrow();
    expect(busy.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ code: "session_message_approvals_unobserved" }),
      expect.any(String),
    );
    const h = harness({ connection: false });
    h.respond.mockRejectedValueOnce(new Error("expired"));
    h.approvals.watch("session-1", RUN_ID, h.runtime, 1);
    await h.emit(request("approval"));
    expect(h.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ code: "session_message_approval_unanswered" }),
      expect.any(String),
    );
  });
});

describe("SessionMessageApprovals routed to a person", () => {
  it("sends the request, then applies an approval and a decline with its reason", async () => {
    const h = harness({ capability: 1 });
    h.approvals.watch("session-1", RUN_ID, h.runtime, 3);
    await h.emit(request("approval", "p1"));
    expect(h.sent).toEqual([
      expect.objectContaining({
        type: "approval:request",
        source: "session-message",
        turnId: RUN_ID,
        sessionId: "session-1",
        deliveryId: MESSAGE_ID,
        placementGeneration: 3,
        title: "Approve Bash",
        commandPresentation: { command: "ps -ax", reason: "" },
      }),
    ]);
    expect(h.respond).not.toHaveBeenCalled();
    const first = h.sent[0] as RuntimeApprovalRequest;
    expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(SESSION_MESSAGE_APPROVAL_TIMEOUT_MS - 5_000);
    await expect(h.approvals.respondToApproval(decision(first, "accept"))).resolves.toMatchObject({
      type: "approval:result",
      status: "applied",
      source: "session-message",
    });
    expect(h.respond).toHaveBeenCalledWith({
      expectedRunId: RUN_ID,
      requestId: "p1",
      kind: "approval",
      decision: "accept",
      scope: "run",
    });
    // An answered request is gone: a repeat decision is stale.
    await expect(h.approvals.respondToApproval(decision(first, "accept"))).resolves.toMatchObject({ status: "stale" });

    await h.emit(request("approval", "p2"));
    await h.approvals.respondToApproval(decision(h.sent[1] as RuntimeApprovalRequest, "decline"));
    expect(h.respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: "p2", decision: "decline", reason: SESSION_MESSAGE_APPROVAL_DECLINED }),
    );
  });

  it("refuses a decision for another identity, and reports one the runtime no longer accepts as stale", async () => {
    const h = harness({ capability: 1 });
    h.approvals.watch("session-1", RUN_ID, h.runtime, 3);
    await h.emit(request("approval", "p1"));
    const sent = h.sent[0] as RuntimeApprovalRequest;
    for (const change of [
      { sessionId: "session-2" },
      { placementGeneration: 4 },
      { deliveryId: "other" },
      { turnId: "x" },
    ]) {
      await expect(h.approvals.respondToApproval({ ...decision(sent, "accept"), ...change })).resolves.toMatchObject({
        status: "stale",
      });
    }
    h.respond.mockRejectedValueOnce(new Error("Run ended"));
    await expect(h.approvals.respondToApproval(decision(sent, "accept"))).resolves.toMatchObject({ status: "stale" });
  });

  it("declines a request nobody answers in time, and ignores a late decision", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness({ capability: 1 });
    h.approvals.watch("session-1", RUN_ID, h.runtime, 3);
    await h.emit(request("approval", "p1"));
    await vi.advanceTimersByTimeAsync(SESSION_MESSAGE_APPROVAL_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.respond).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "p1", decision: "decline", reason: SESSION_MESSAGE_APPROVAL_EXPIRED }),
    );
    await expect(
      h.approvals.respondToApproval(decision(h.sent[0] as RuntimeApprovalRequest, "accept")),
    ).resolves.toMatchObject({ status: "stale" });
  });

  it("declines when the request cannot be sent, and forgets open requests when the Run ends", async () => {
    const failing = harness({ capability: 1 });
    failing.connection.send.mockRejectedValueOnce(new Error("socket closed"));
    failing.approvals.watch("session-1", RUN_ID, failing.runtime, 3);
    await failing.emit(request("approval", "p1"));
    expect(failing.respond).toHaveBeenCalledWith(
      expect.objectContaining({ reason: SESSION_MESSAGE_APPROVAL_UNAVAILABLE }),
    );

    const h = harness({ capability: 1 });
    const stop = h.approvals.watch("session-1", RUN_ID, h.runtime, 3);
    await h.emit(request("approval", "p1"));
    stop();
    await expect(
      h.approvals.respondToApproval(decision(h.sent[0] as RuntimeApprovalRequest, "accept")),
    ).resolves.toMatchObject({ status: "stale" });
    expect(h.respond).not.toHaveBeenCalled();
  });
});

describe("routeApprovalDecision", () => {
  it("sends Session message decisions here and IM Turn decisions to the runner", async () => {
    const sessionMessages = { respondToApproval: vi.fn(async () => ({ status: "applied" }) as never) };
    const turns = { respondToApproval: vi.fn(async () => ({ status: "stale" }) as never) };
    const route = routeApprovalDecision(sessionMessages, turns);
    const base = {
      type: "approval:decision" as const,
      requestId: "r1",
      turnId: "t",
      sessionId: "s",
      deliveryId: "d",
      placementGeneration: 1,
      decision: "accept" as const,
    };
    await route({ ...base, source: "session-message" });
    await route(base);
    expect(sessionMessages.respondToApproval).toHaveBeenCalledTimes(1);
    expect(turns.respondToApproval).toHaveBeenCalledWith(base);
  });
});
