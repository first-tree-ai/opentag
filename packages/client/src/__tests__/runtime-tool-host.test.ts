import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeBusinessFrame } from "../runtime/runtime-connection.js";
import { openTagHostedToolDefinitions, RuntimeToolHost } from "../runtime/runtime-tool-host.js";

describe("RuntimeToolHost", () => {
  it("settles a missing Server result as a deterministic hosted-tool timeout", async () => {
    vi.useFakeTimers();
    try {
      const host = new RuntimeToolHost({
        send: vi.fn(async () => undefined),
        subscribeBusinessFrames: () => () => undefined,
      });
      const delivery = request();
      const release = host.activateRun("turn-timeout", delivery, ["opentag_message_send"]);
      const result = host.execute({
        runId: "turn-timeout",
        toolCallId: "call-timeout",
        name: "opentag_message_send",
        input: { requestId: randomUUID(), text: "timeout" },
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(result).resolves.toMatchObject({
        success: false,
        error: { code: "tool_call_failed", message: expect.stringContaining("timed out") },
      });
      release();
      host.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds model arguments to the current delivery scope and correlates the Server result", async () => {
    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    const send = vi.fn(async (frame: unknown) => {
      const request = frame as { requestId: string };
      queueMicrotask(() =>
        listener?.({
          type: "im:tool:result",
          requestId: request.requestId,
          state: "succeeded",
          providerMessageId: "provider-1",
        }),
      );
    });
    const host = new RuntimeToolHost({
      send,
      subscribeBusinessFrames: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const delivery = request();
    const requestId = randomUUID();
    const signal = new AbortController().signal;
    const release = host.activateRun("turn-1", delivery, ["opentag_message_reply"]);
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "call-1",
        name: "opentag_message_reply",
        input: {
          requestId,
          text: "reply",
          replyToImMessageId: delivery.imMessageId,
          sessionId: randomUUID(),
          placementGeneration: 999,
        },
        signal,
      }),
    ).resolves.toEqual({
      success: true,
      content: [{ type: "text", text: JSON.stringify({ state: "succeeded", providerMessageId: "provider-1" }) }],
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "im:tool",
        requestId,
        sessionId: delivery.sessionId,
        agentId: delivery.agentId,
        placementGeneration: delivery.placementGeneration,
        expectedLatestImMessageId: delivery.imMessageId,
        operation: "reply",
      }),
      expect.objectContaining({ priority: "result" }),
    );
    release();
    host.close();
  });

  it("shares one pending owner for the same request intent and rejects conflicting reuse before send", async () => {
    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    const send = vi.fn(async () => undefined);
    const host = new RuntimeToolHost({
      send,
      subscribeBusinessFrames: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const delivery = request();
    const requestId = randomUUID();
    const release = host.activateRun("turn-1", delivery, ["opentag_message_send"]);
    const signal = new AbortController().signal;
    const call = (text: string, callId: string) => ({
      runId: "turn-1",
      toolCallId: callId,
      name: "opentag_message_send",
      input: { requestId, text },
      signal,
    });
    const first = host.execute(call("hello", "call-1"));
    const same = host.execute(call("hello", "call-2"));
    await expect.poll(() => send.mock.calls.length).toBe(1);
    await listener?.({ type: "im:tool:result", requestId, state: "unknown", code: "provider_unknown" });
    await expect(first).resolves.toMatchObject({ success: false });
    await expect(same).resolves.toEqual(await first);

    const conflictingId = randomUUID();
    const pending = host.execute({
      ...call("one", "call-3"),
      input: { requestId: conflictingId, text: "one" },
    });
    await expect(
      host.execute({
        ...call("two", "call-4"),
        input: { requestId: conflictingId, text: "two" },
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_failed" } });
    expect(send).toHaveBeenCalledTimes(2);
    await listener?.({ type: "im:tool:result", requestId: conflictingId, state: "succeeded" });
    await expect(pending).resolves.toMatchObject({ success: true });
    release();
    host.close();
  });

  it("owns canonical definitions, active Run identity, and tool-call idempotency", async () => {
    const definitions = openTagHostedToolDefinitions([
      "opentag_message_react",
      "opentag_message_send",
      "opentag_message_reply",
    ]);
    expect(definitions.map((definition) => definition.name)).toEqual([
      "opentag_message_send",
      "opentag_message_reply",
      "opentag_message_react",
    ]);
    expect(definitions.every((definition) => (definition.inputSchema as { type?: string }).type === "object")).toBe(
      true,
    );
    expect(() => openTagHostedToolDefinitions(["unknown"])).toThrow("allow-list");
    expect(() => openTagHostedToolDefinitions(["opentag_message_send", "opentag_message_send"])).toThrow("allow-list");

    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    const host = new RuntimeToolHost({
      send: vi.fn(async () => undefined),
      subscribeBusinessFrames: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    expect(host.hostedTools(["opentag_message_send"]).definitions).toHaveLength(1);
    const delivery = request();
    const release = host.activateRun("turn-1", delivery, ["opentag_message_send"]);
    expect(() => host.activateRun("turn-1", delivery, ["opentag_message_send"])).toThrow("already active");
    expect(() => host.activateRun("invalid", delivery, ["unknown"])).toThrow("allow-list");
    expect(() => host.activateRun("duplicate", delivery, ["opentag_message_send", "opentag_message_send"])).toThrow(
      "allow-list",
    );
    const signal = new AbortController().signal;
    await expect(
      host.execute({ runId: "missing", toolCallId: "one", name: "opentag_message_send", input: {}, signal }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_not_authorized" } });
    const requestId = randomUUID();
    const first = host.execute({
      runId: "turn-1",
      toolCallId: "same-call",
      name: "opentag_message_send",
      input: { requestId, text: "one" },
      signal,
    });
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "same-call",
        name: "opentag_message_send",
        input: { requestId, text: "two" },
        signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_conflict" } });
    const same = host.execute({
      runId: "turn-1",
      toolCallId: "same-call",
      name: "opentag_message_send",
      input: { requestId, text: "one" },
      signal,
    });
    await listener?.({ type: "im:tool:result", requestId, state: "succeeded" });
    await expect(first).resolves.toMatchObject({ success: true });
    await expect(same).resolves.toEqual(await first);
    release();
    release();
    host.close();
  });

  it("maps send, reply, react, deterministic failures, cancellation, and transport errors", async () => {
    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    const sent: unknown[] = [];
    let sendFailure: unknown;
    const host = new RuntimeToolHost({
      send: async (frame) => {
        sent.push(frame);
        if (sendFailure !== undefined) throw sendFailure;
      },
      subscribeBusinessFrames: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const delivery = request();
    const release = host.activateRun("turn-1", delivery, [
      "opentag_message_send",
      "opentag_message_reply",
      "opentag_message_react",
    ]);
    await expect(
      host.hostedTools(["opentag_message_send"]).handler({
        runId: "missing",
        toolCallId: "hosted-handler",
        name: "opentag_message_send",
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_not_authorized" } });
    const signal = new AbortController().signal;
    const cases = [
      {
        name: "opentag_message_send",
        input: { requestId: randomUUID(), text: "send" },
        operation: "send",
      },
      {
        name: "opentag_message_reply",
        input: { requestId: randomUUID(), text: "reply", replyToImMessageId: delivery.imMessageId },
        operation: "reply",
      },
      {
        name: "opentag_message_react",
        input: { requestId: randomUUID(), targetImMessageId: delivery.imMessageId, emoji: "👍" },
        operation: "react",
      },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      const pending = host.execute({
        runId: "turn-1",
        toolCallId: `call-${index}`,
        name: entry.name,
        input: entry.input,
        signal,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(index + 1));
      expect(sent.at(-1)).toMatchObject({ operation: entry.operation });
      await listener?.({
        type: "im:tool:result",
        requestId: entry.input.requestId,
        state: index === 0 ? "deterministic_failed" : "succeeded",
        ...(index === 0 ? { code: "provider_failed", retryAfterSeconds: 3 } : {}),
      });
      await expect(pending).resolves.toMatchObject(
        index === 0
          ? { success: false, error: { code: "provider_failed" }, content: [expect.objectContaining({ type: "text" })] }
          : { success: true },
      );
    }

    const invalidInputs: unknown[] = [
      [],
      { requestId: "not-uuid", text: "text" },
      { requestId: randomUUID(), text: " " },
      { requestId: randomUUID(), text: "x".repeat(24 * 1024 + 1) },
    ];
    for (const [index, input] of invalidInputs.entries()) {
      await expect(
        host.execute({
          runId: "turn-1",
          toolCallId: `invalid-${index}`,
          name: "opentag_message_send",
          input: input as never,
          signal,
        }),
      ).resolves.toMatchObject({ success: false, error: { code: "tool_call_failed" } });
    }
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "aborted",
        name: "opentag_message_send",
        input: { requestId: randomUUID(), text: "cancel" },
        signal: aborted.signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_cancelled" } });

    for (const [index, failure] of [new Error("send failed"), "non-error"].entries()) {
      sendFailure = failure;
      await expect(
        host.execute({
          runId: "turn-1",
          toolCallId: `send-failure-${index}`,
          name: "opentag_message_send",
          input: { requestId: randomUUID(), text: "fail" },
          signal,
        }),
      ).resolves.toMatchObject({ success: false, error: { code: "tool_call_failed" } });
    }

    let requestIdReads = 0;
    const nonErrorInput = {
      get requestId() {
        requestIdReads += 1;
        if (requestIdReads > 1) throw "non-error arguments failure";
        return randomUUID();
      },
      text: "fail",
    };
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "non-error-arguments",
        name: "opentag_message_send",
        input: nonErrorInput,
        signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_failed" } });

    sendFailure = undefined;
    const noCodeRequestId = randomUUID();
    const noCode = host.execute({
      runId: "turn-1",
      toolCallId: "failed-without-code",
      name: "opentag_message_send",
      input: { requestId: noCodeRequestId, text: "fail" },
      signal,
    });
    await listener?.({ type: "im:tool:result", requestId: noCodeRequestId, state: "deterministic_failed" });
    await expect(noCode).resolves.toMatchObject({ success: false, error: { code: "deterministic_failed" } });

    await listener?.({ type: "not-a-tool-result" } as never);

    const sharedRequestId = randomUUID();
    const shared = host.execute({
      runId: "turn-1",
      toolCallId: "shared-owner",
      name: "opentag_message_send",
      input: { requestId: sharedRequestId, text: "shared" },
      signal,
    });
    const cancelledCaller = new AbortController();
    cancelledCaller.abort();
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "shared-cancelled-caller",
        name: "opentag_message_send",
        input: { requestId: sharedRequestId, text: "shared" },
        signal: cancelledCaller.signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_cancelled" } });
    await listener?.({ type: "im:tool:result", requestId: sharedRequestId, state: "succeeded" });
    await shared;

    const abortDuringRequest = new AbortController();
    const abortRequestId = randomUUID();
    const abortPending = host.execute({
      runId: "turn-1",
      toolCallId: "abort-during-request",
      name: "opentag_message_send",
      input: { requestId: abortRequestId, text: "cancel" },
      signal: abortDuringRequest.signal,
    });
    abortDuringRequest.abort();
    await expect(abortPending).resolves.toMatchObject({ success: false, error: { code: "tool_call_cancelled" } });
    await listener?.({ type: "im:tool:result", requestId: abortRequestId, state: "succeeded" });

    const pendingAtClose = host.execute({
      runId: "turn-1",
      toolCallId: "pending-at-close",
      name: "opentag_message_send",
      input: { requestId: randomUUID(), text: "pending" },
      signal,
    });
    release();
    host.close();
    await expect(pendingAtClose).resolves.toMatchObject({ success: false, error: { code: "tool_call_failed" } });
  });
});

function request(): DirectImMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    sessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello" },
    runtime: {
      revision: {
        agent: { sequence: 1, id: agentId },
        session: { sequence: 1, id: "session-1" },
      },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      allowedTools: ["opentag_message_reply"],
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
    },
  };
}
