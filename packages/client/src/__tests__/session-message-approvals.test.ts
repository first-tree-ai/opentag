import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AgentRuntimeEvent } from "../agent-runtime/types.js";
import { SESSION_MESSAGE_APPROVAL_UNAVAILABLE, SessionMessageApprovals } from "../runtime/session-message-approvals.js";

function harness(observeError?: Error) {
  let sink: ((event: AgentRuntimeEvent) => Promise<void>) | undefined;
  const stop = vi.fn();
  const runtimeManager = {
    observe: vi.fn((_sessionId: string, next: (event: AgentRuntimeEvent) => Promise<void>) => {
      if (observeError) throw observeError;
      sink = next;
      return stop;
    }),
  };
  const respond = vi.fn(async () => undefined);
  const runtime = { respond } as unknown as AgentRuntime;
  const logger = { debug: vi.fn() };
  const approvals = new SessionMessageApprovals({ runtimeManager, logger });
  const emit = async (event: AgentRuntimeEvent) => {
    await sink?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { approvals, emit, logger, respond, runtime, runtimeManager, stop };
}

const request = (kind: "approval" | "question", requestId = "r1") => ({
  type: "interaction_requested" as const,
  runId: "run-1",
  request: { requestId, kind, title: "Run a command" },
});

describe("SessionMessageApprovals", () => {
  it("declines a Run's approval request at once and tells the model why", async () => {
    const h = harness();
    const stop = h.approvals.watch("session-1", "run-1", h.runtime);
    expect(h.runtimeManager.observe).toHaveBeenCalledWith("session-1", expect.any(Function));
    await h.emit(request("approval"));
    expect(h.respond).toHaveBeenCalledWith({
      expectedRunId: "run-1",
      requestId: "r1",
      kind: "approval",
      decision: "decline",
      reason: SESSION_MESSAGE_APPROVAL_UNAVAILABLE,
    });
    stop();
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a question, and ignores other Runs' requests and other events", async () => {
    const h = harness();
    h.approvals.watch("session-1", "run-1", h.runtime);
    await h.emit({ ...request("approval", "other"), runId: "run-2" });
    await h.emit({ type: "run_started", runId: "run-1" });
    expect(h.respond).not.toHaveBeenCalled();
    await h.emit(request("question", "q1"));
    expect(h.respond).toHaveBeenCalledWith({
      expectedRunId: "run-1",
      requestId: "q1",
      kind: "question",
      decision: "cancel",
    });
  });

  it("leaves requests to an existing observer, and logs a decline the runtime refuses", async () => {
    const busy = harness(new Error("The Session Agent Runtime already has an active observer"));
    expect(() => busy.approvals.watch("session-1", "run-1", busy.runtime)()).not.toThrow();
    expect(busy.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ code: "session_message_approvals_unobserved" }),
      expect.any(String),
    );

    const h = harness();
    h.respond.mockRejectedValueOnce(new Error("expired"));
    h.approvals.watch("session-1", "run-1", h.runtime);
    await h.emit(request("approval"));
    expect(h.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ code: "session_message_approval_unanswered", runId: "run-1" }),
      expect.any(String),
    );
  });
});
