import { createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSlackInteractionsRoute } from "../api/slack-interactions.js";
import { legacyFeishuFeedbackAction } from "../services/im/im-feedback-callback.js";

describe("feedback native callbacks", () => {
  it("acknowledges legacy card buttons and preserves strict approval validation", async () => {
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
    const decide = vi.fn();
    registerSlackInteractionsRoute(app, {
      imBindings: { findSlackInstallationIngress: async () => installation } as never,
      inbox: {} as never,
      createAdapter: vi.fn(),
      now: () => now,
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
      for (const action of ["opentag_feedback_retry", "opentag_feedback_discard", "opentag_feedback_details"])
        expect((await click(action, `${id}:4`)).statusCode).toBe(200);
      expect((await click("opentag_feedback_retry", "bad")).statusCode).toBe(200);
      expect(decide).not.toHaveBeenCalled();
      expect((await click("opentag_approval_accept", "invalid")).statusCode).toBe(400);
      expect((await click("opentag_feedback_retry", `${id}:4`, true)).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("answers a legacy Feishu Retry button with a toast and leaves other callbacks to approvals", () => {
    const event = {
      operator: { open_id: "human" },
      action: { value: { feedbackId: randomUUID(), revision: 2, kind: "retry_task" } },
      context: { open_message_id: "card", open_chat_id: "channel" },
    };
    for (const input of [event, { event }])
      expect(legacyFeishuFeedbackAction(input)).toMatchObject({ toast: { type: "error" } });
    expect(
      legacyFeishuFeedbackAction({ ...event, action: { value: { ...event.action.value, kind: "discard" } } }),
    ).toBeUndefined();
    expect(
      legacyFeishuFeedbackAction({ ...event, action: { value: { approvalId: randomUUID(), decision: "accept" } } }),
    ).toBeUndefined();
  });
});
