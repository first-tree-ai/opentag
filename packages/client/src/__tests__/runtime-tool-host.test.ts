import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeBusinessFrame } from "../runtime/runtime-connection.js";
import { RuntimeToolHost } from "../runtime/runtime-tool-host.js";

describe("RuntimeToolHost", () => {
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
    await expect(
      host.execute(delivery, {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "opentag_message_reply",
        arguments: {
          requestId,
          text: "reply",
          replyToImMessageId: delivery.imMessageId,
          sessionId: randomUUID(),
          placementGeneration: 999,
        },
      }),
    ).resolves.toEqual({
      success: true,
      text: JSON.stringify({ state: "succeeded", providerMessageId: "provider-1" }),
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
    const call = (text: string, callId: string) => ({
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: null,
      tool: "opentag_message_send",
      arguments: { requestId, text },
    });
    const first = host.execute(delivery, call("hello", "call-1"));
    const same = host.execute(delivery, call("hello", "call-2"));
    await expect.poll(() => send.mock.calls.length).toBe(1);
    await listener?.({ type: "im:tool:result", requestId, state: "unknown", code: "provider_unknown" });
    await expect(first).resolves.toMatchObject({ success: false });
    await expect(same).resolves.toEqual(await first);

    const conflictingId = randomUUID();
    const pending = host.execute(delivery, {
      ...call("one", "call-3"),
      arguments: { requestId: conflictingId, text: "one" },
    });
    await expect(
      host.execute(delivery, {
        ...call("two", "call-4"),
        arguments: { requestId: conflictingId, text: "two" },
      }),
    ).rejects.toThrow("request ID conflicts");
    expect(send).toHaveBeenCalledTimes(2);
    await listener?.({ type: "im:tool:result", requestId: conflictingId, state: "succeeded" });
    await expect(pending).resolves.toMatchObject({ success: true });
    host.close();
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
