import { randomUUID } from "node:crypto";
import { type DirectImMessageDeliveryRequest, RUNTIME_DIRECT_TEXT_MAX_BYTES } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeBusinessFrame } from "../runtime/runtime-connection.js";
import { openTagHostedToolDefinitions, RuntimeToolHost } from "../runtime/runtime-tool-host.js";

describe("RuntimeToolHost", () => {
  it("returns an unknown identity after timeout and reuses it only for an explicit retry", async () => {
    vi.useFakeTimers();
    try {
      let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
      const sent: Array<{ requestId: string }> = [];
      const host = new RuntimeToolHost({
        send: vi.fn(async (frame: unknown) => {
          sent.push(frame as { requestId: string });
        }),
        subscribeBusinessFrames: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      });
      const delivery = request();
      const release = host.activateRun("turn-timeout", delivery, ["opentag_message_send"]);
      const result = host.execute({
        runId: "turn-timeout",
        toolCallId: "call-timeout",
        name: "opentag_message_send",
        input: { text: "timeout" },
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const timedOut = await result;
      expect(timedOut).toMatchObject({
        success: false,
        error: { code: "tool_result_timeout", message: expect.stringContaining("timed out") },
      });
      const timeoutBody = JSON.parse((timedOut.content[0] as { text: string }).text) as {
        requestId: string;
        state: string;
        code: string;
      };
      expect(timeoutBody).toMatchObject({ state: "unknown", code: "tool_result_timeout" });
      expect(timeoutBody.requestId).toBe(sent[0]?.requestId);

      const retry = host.execute({
        runId: "turn-timeout",
        toolCallId: "call-timeout-retry",
        name: "opentag_message_send",
        input: { retryRequestId: timeoutBody.requestId, text: "timeout" },
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.requestId).toBe(timeoutBody.requestId);
      await listener?.({ type: "im:tool:result", requestId: timeoutBody.requestId, state: "succeeded" });
      await expect(retry).resolves.toMatchObject({ success: true });
      release();
      host.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds model arguments to the current delivery scope and correlates the Server result", async () => {
    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    let sentRequestId: string | undefined;
    const send = vi.fn(async (frame: unknown) => {
      const request = frame as { requestId: string };
      sentRequestId = request.requestId;
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
    const signal = new AbortController().signal;
    const release = host.activateRun("turn-1", delivery, ["opentag_message_reply"]);
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "call-1",
        name: "opentag_message_reply",
        input: {
          text: "reply",
          replyToImMessageId: delivery.imMessageId,
        },
        signal,
      }),
    ).resolves.toEqual({
      success: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ requestId: sentRequestId, state: "succeeded", providerMessageId: "provider-1" }),
        },
      ],
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "im:tool",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
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

  it("enforces the shared outbound byte limit before dispatch for send and reply", async () => {
    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    const sent: Array<{ requestId: string }> = [];
    const host = new RuntimeToolHost({
      send: async (frame: unknown) => {
        sent.push(frame as { requestId: string });
      },
      subscribeBusinessFrames: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const delivery = request();
    const release = host.activateRun("turn-byte-limit", delivery, ["opentag_message_send", "opentag_message_reply"]);
    const signal = new AbortController().signal;
    const boundaryText = "x".repeat(RUNTIME_DIRECT_TEXT_MAX_BYTES);
    const multibyteOverLimit = `${"x".repeat(RUNTIME_DIRECT_TEXT_MAX_BYTES - 2)}你`;
    expect(Buffer.byteLength(multibyteOverLimit, "utf8")).toBe(RUNTIME_DIRECT_TEXT_MAX_BYTES + 1);

    const cases = [
      { name: "opentag_message_send", input: (text: string) => ({ text }) },
      {
        name: "opentag_message_reply",
        input: (text: string) => ({ replyToImMessageId: delivery.imMessageId, text }),
      },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      const boundary = host.execute({
        runId: "turn-byte-limit",
        toolCallId: `boundary-${index}`,
        name: entry.name,
        input: entry.input(boundaryText),
        signal,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(index + 1));
      await listener?.({
        type: "im:tool:result",
        requestId: sent[index]?.requestId as string,
        state: "succeeded",
      });
      await expect(boundary).resolves.toMatchObject({ success: true });

      await expect(
        host.execute({
          runId: "turn-byte-limit",
          toolCallId: `over-limit-${index}`,
          name: entry.name,
          input: entry.input(multibyteOverLimit),
          signal,
        }),
      ).resolves.toMatchObject({ success: false, error: { code: "tool_call_failed" } });
      expect(sent).toHaveLength(index + 1);
    }
    release();
    host.close();
  });

  it("reuses an explicit retry identity and rejects conflicting reuse before send", async () => {
    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    const send = vi.fn(async (_frame: unknown) => undefined);
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
      input: { retryRequestId: requestId, text },
      signal,
    });
    const first = host.execute(call("hello", "call-1"));
    const same = host.execute(call("hello", "call-2"));
    await expect.poll(() => send.mock.calls.length).toBe(1);
    await listener?.({ type: "im:tool:result", requestId, state: "unknown", code: "provider_unknown" });
    await expect(first).resolves.toMatchObject({ success: false });
    await expect(same).resolves.toEqual(await first);
    expect(send).toHaveBeenCalledTimes(1);

    const explicitRetry = host.execute(call("hello", "call-retry"));
    await expect.poll(() => send.mock.calls.length).toBe(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ requestId, text: "hello" });
    await listener?.({ type: "im:tool:result", requestId, state: "succeeded" });
    await expect(explicitRetry).resolves.toMatchObject({ success: true });

    const conflictingId = randomUUID();
    const pending = host.execute({
      ...call("one", "call-3"),
      input: { retryRequestId: conflictingId, text: "one" },
    });
    await expect(
      host.execute({
        ...call("two", "call-4"),
        input: { retryRequestId: conflictingId, text: "two" },
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "request_id_conflict" } });
    expect(send).toHaveBeenCalledTimes(3);
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
    for (const definition of definitions) {
      const schema = definition.inputSchema as {
        properties?: Record<string, unknown>;
        required?: readonly string[];
      };
      expect(schema.properties).toHaveProperty("retryRequestId");
      expect(schema.properties).not.toHaveProperty("requestId");
      expect(schema.required).not.toContain("retryRequestId");
    }
    expect(() => openTagHostedToolDefinitions(["unknown"])).toThrow("allow-list");
    expect(() => openTagHostedToolDefinitions(["opentag_message_send", "opentag_message_send"])).toThrow("allow-list");

    let listener: ((frame: RuntimeBusinessFrame) => void | Promise<void>) | undefined;
    let sentRequestId: string | undefined;
    const host = new RuntimeToolHost({
      send: vi.fn(async (frame: unknown) => {
        sentRequestId = (frame as { requestId: string }).requestId;
      }),
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
    const first = host.execute({
      runId: "turn-1",
      toolCallId: "same-call",
      name: "opentag_message_send",
      input: { text: "one" },
      signal,
    });
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "same-call",
        name: "opentag_message_send",
        input: { text: "two" },
        signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_conflict" } });
    const same = host.execute({
      runId: "turn-1",
      toolCallId: "same-call",
      name: "opentag_message_send",
      input: { text: "one" },
      signal,
    });
    await vi.waitFor(() => expect(sentRequestId).toMatch(/^[0-9a-f-]{36}$/u));
    await listener?.({ type: "im:tool:result", requestId: sentRequestId as string, state: "succeeded" });
    await expect(first).resolves.toMatchObject({ success: true });
    await expect(same).resolves.toEqual(await first);
    expect(sentRequestId).toBeDefined();
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
        input: { text: "send" },
        operation: "send",
      },
      {
        name: "opentag_message_reply",
        input: { text: "reply", replyToImMessageId: delivery.imMessageId },
        operation: "reply",
      },
      {
        name: "opentag_message_react",
        input: { targetImMessageId: delivery.imMessageId, emoji: "👍" },
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
      const requestId = (sent.at(-1) as { requestId: string }).requestId;
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
      expect(sent.at(-1)).toMatchObject({ operation: entry.operation, requestId });
      await listener?.({
        type: "im:tool:result",
        requestId,
        state: index === 0 ? "deterministic_failed" : "succeeded",
        ...(index === 0 ? { code: "provider_failed", retryAfterSeconds: 3 } : {}),
      });
      await expect(pending).resolves.toMatchObject(
        index === 0
          ? { success: false, error: { code: "provider_failed" }, content: [expect.objectContaining({ type: "text" })] }
          : { success: true },
      );
      const resultText = ((await pending).content[0] as { text: string }).text;
      expect(JSON.parse(resultText)).toMatchObject({
        requestId,
        state: index === 0 ? "deterministic_failed" : "succeeded",
      });
    }

    const invalidInputs: unknown[] = [
      [],
      { retryRequestId: "not-uuid", text: "text" },
      { requestId: randomUUID(), text: "text" },
      { text: " " },
      { text: "x".repeat(RUNTIME_DIRECT_TEXT_MAX_BYTES + 1) },
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
        toolCallId: "aborted-invalid",
        name: "opentag_message_send",
        input: null,
        signal: aborted.signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_cancelled" } });
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "aborted",
        name: "opentag_message_send",
        input: { text: "cancel" },
        signal: aborted.signal,
      }),
    ).resolves.toMatchObject({ success: false, error: { code: "tool_call_cancelled" } });

    for (const [index, failure] of [new Error("send failed"), "non-error"].entries()) {
      sendFailure = failure;
      const sendFailureResult = await host.execute({
        runId: "turn-1",
        toolCallId: `send-failure-${index}`,
        name: "opentag_message_send",
        input: { text: "fail" },
        signal,
      });
      expect(sendFailureResult).toMatchObject({ success: false, error: { code: "runtime_send_failed" } });
      expect(JSON.parse((sendFailureResult.content[0] as { text: string }).text)).toMatchObject({
        requestId: (sent.at(-1) as { requestId: string }).requestId,
        state: "unknown",
        code: "runtime_send_failed",
      });
    }

    let requestIdReads = 0;
    const nonErrorInput = {
      get retryRequestId() {
        requestIdReads += 1;
        if (requestIdReads > 1) throw "non-error arguments failure";
        return randomUUID();
      },
      text: "fail",
    };
    const nonErrorFailure = await host.execute({
      runId: "turn-1",
      toolCallId: "non-error-arguments",
      name: "opentag_message_send",
      input: nonErrorInput,
      signal,
    });
    expect(nonErrorFailure).toMatchObject({ success: false, error: { code: "tool_call_failed" } });

    sendFailure = undefined;
    const noCodeRequestId = randomUUID();
    const noCode = host.execute({
      runId: "turn-1",
      toolCallId: "failed-without-code",
      name: "opentag_message_send",
      input: { retryRequestId: noCodeRequestId, text: "fail" },
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
      input: { retryRequestId: sharedRequestId, text: "shared" },
      signal,
    });
    const cancelledCaller = new AbortController();
    cancelledCaller.abort();
    await expect(
      host.execute({
        runId: "turn-1",
        toolCallId: "shared-cancelled-caller",
        name: "opentag_message_send",
        input: { retryRequestId: sharedRequestId, text: "shared" },
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
      input: { retryRequestId: abortRequestId, text: "cancel" },
      signal: abortDuringRequest.signal,
    });
    abortDuringRequest.abort();
    const abortedAfterDispatch = await abortPending;
    expect(abortedAfterDispatch).toMatchObject({ success: false, error: { code: "tool_call_cancelled" } });
    expect(JSON.parse((abortedAfterDispatch.content[0] as { text: string }).text)).toMatchObject({
      requestId: abortRequestId,
      state: "unknown",
      code: "tool_call_cancelled",
    });
    await listener?.({ type: "im:tool:result", requestId: abortRequestId, state: "succeeded" });

    const pendingAtClose = host.execute({
      runId: "turn-1",
      toolCallId: "pending-at-close",
      name: "opentag_message_send",
      input: { text: "pending" },
      signal,
    });
    const closeRequestId = (sent.at(-1) as { requestId: string }).requestId;
    release();
    host.close();
    const closed = await pendingAtClose;
    expect(closed).toMatchObject({ success: false, error: { code: "tool_host_closed" } });
    expect(JSON.parse((closed.content[0] as { text: string }).text)).toEqual({
      requestId: closeRequestId,
      state: "unknown",
      code: "tool_host_closed",
    });
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
