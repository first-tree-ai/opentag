import { createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSlackInteractionsRoute } from "../api/slack-interactions.js";
import { handleFeishuFeedbackAction } from "../services/im/im-feedback-callback.js";

describe("feedback native callbacks", () => {
  it("authenticates the Slack installation and preserves strict approval validation", async () => {
    const app = Fastify();
    const now = new Date();
    const id = randomUUID();
    const installation = {
      installationId: randomUUID(),
      appId: "A",
      teamId: "T",
      generation: 3,
      signingSecret: "unit-secret",
    };
    const submitNativeRetry = vi.fn(async () => "recorded" as const);
    const decide = vi.fn();
    registerSlackInteractionsRoute(app, {
      imBindings: { findSlackInstallationIngress: async () => installation } as never,
      inbox: {} as never,
      createAdapter: vi.fn(),
      now: () => now,
      imFeedback: { submitNativeRetry } as never,
      approvalOwner: { decide },
    });
    async function click(action_id: string, value?: string, tamper = false) {
      const body = new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          api_app_id: "A",
          team: { id: "T" },
          user: { id: "original" },
          channel: { id: "channel" },
          message: { ts: "card" },
          actions: [{ action_id, value }],
        }),
      }).toString();
      const timestamp = String(Math.floor(now.getTime() / 1_000));
      const signature = `v0=${createHmac("sha256", installation.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
      return app.inject({
        method: "POST",
        url: "/api/v1/im-bindings/slack/interactions",
        payload: tamper ? `${body}x` : body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
      });
    }
    try {
      expect((await click("opentag_feedback_retry", `${id}:4`)).statusCode).toBe(200);
      expect(submitNativeRetry).toHaveBeenCalledExactlyOnceWith({
        feedbackId: id,
        revision: 4,
        provider: "slack",
        userId: "original",
        generation: 3,
        installationId: installation.installationId,
        channelId: "channel",
        messageId: "card",
      });
      expect((await click("opentag_feedback_discard")).statusCode).toBe(200);
      expect(submitNativeRetry).toHaveBeenCalledOnce();
      expect(decide).not.toHaveBeenCalled();
      expect((await click("opentag_approval_accept", "invalid")).statusCode).toBe(400);
      expect((await click("opentag_feedback_retry", `${id}:4`, true)).statusCode).toBe(400);
      expect((await click("opentag_feedback_retry", "bad")).statusCode).toBe(200);
      expect(submitNativeRetry).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
  it("extracts exact Feishu authority, returns a private result, and never handles discard", async () => {
    const feedbackId = randomUUID();
    const submitNativeRetry = vi.fn(async () => "unavailable" as "recorded" | "unavailable");
    const service = { submitNativeRetry } as never;
    const event = {
      operator: { open_id: "human" },
      action: { value: { feedbackId, revision: 2, kind: "retry_task" } },
      context: { open_message_id: "card", open_chat_id: "channel" },
    };
    expect(await handleFeishuFeedbackAction(service, { event }, "binding", 3)).toMatchObject({
      toast: { type: "error" },
    });
    expect(submitNativeRetry).toHaveBeenCalledWith({
      feedbackId,
      revision: 2,
      provider: "feishu",
      userId: "human",
      bindingId: "binding",
      generation: 3,
      channelId: "channel",
      messageId: "card",
    });
    submitNativeRetry.mockResolvedValue("recorded");
    expect(await handleFeishuFeedbackAction(service, event, "binding", 3)).toMatchObject({
      toast: { type: "success" },
    });
    expect(
      await handleFeishuFeedbackAction(
        service,
        { ...event, action: { value: { ...event.action.value, kind: "discard" } } },
        "binding",
        3,
      ),
    ).toBeUndefined();
    expect(submitNativeRetry).toHaveBeenCalledTimes(2);
  });
});
