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
    await expect(
      host.execute(delivery, {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "opentag_message_reply",
        arguments: {
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
});

function request(): DirectImMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: randomUUID(),
    imMessageId: randomUUID(),
    imMessageRevision: 1,
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
