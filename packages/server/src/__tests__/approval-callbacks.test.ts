import { createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSlackInteractionsRoute } from "../api/slack-interactions.js";
import { handleFeishuApprovalAction } from "../runtime/feishu-approval-action.js";

describe("Approval callbacks", () => {
  it.each(["/api/v1/im-bindings/slack/interactions", "/api/v1/agents/agent/im-binding/slack/interactions"])(
    "authenticates the exact Slack form body at %s",
    async (url) => {
      const app = Fastify();
      const now = new Date();
      const installation = {
        installationId: randomUUID(),
        appId: "A1",
        teamId: "T1",
        generation: 2,
        signingSecret: "test-secret",
      };
      const decide = vi.fn(async () => "recorded" as const);
      registerSlackInteractionsRoute(app, {
        imBindings: {
          findSlackInstallationIngress: async () => installation,
          findSlackInstallationIngressForAgent: async () => installation,
        } as never,
        inbox: {} as never,
        createAdapter: () => {
          throw new Error("unused");
        },
        now: () => now,
        approvalOwner: { decide },
      });
      const approvalId = randomUUID();
      const body = new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          api_app_id: "A1",
          team: { id: "T1" },
          user: { id: "U1" },
          channel: { id: "C1" },
          message: { ts: "1.2" },
          actions: [{ action_id: "opentag_approval_accept", value: approvalId }],
        }),
      }).toString();
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const signature = `v0=${createHmac("sha256", installation.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
      const request = {
        method: "POST" as const,
        url,
        payload: body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
      };
      try {
        expect((await app.inject(request)).statusCode).toBe(200);
        expect(decide).toHaveBeenCalledWith({
          approvalId,
          decision: "accept",
          provider: "slack",
          userId: "U1",
          generation: 2,
          installationId: installation.installationId,
          messageId: "1.2",
          channelId: "C1",
        });
        decide.mockClear();
        expect((await app.inject({ ...request, payload: body.replace("U1", "U2") })).statusCode).toBe(401);
        expect(
          (await app.inject({ ...request, headers: { ...request.headers, "x-slack-request-timestamp": "1" } }))
            .statusCode,
        ).toBe(401);
        expect((await app.inject({ ...request, payload: "payload=bad" })).statusCode).toBe(400);
        expect(decide).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("extracts Feishu card authority and reports unavailable decisions", async () => {
    const approvalId = randomUUID();
    const decide = vi.fn(async () => "recorded" as "recorded" | "unavailable");
    const event = {
      operator: { open_id: "ou_owner" },
      action: { value: { approvalId, decision: "decline" } },
      context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
    };
    expect(await handleFeishuApprovalAction({ decide }, { event }, "binding", 3)).toMatchObject({
      toast: { type: "success" },
    });
    expect(decide).toHaveBeenCalledWith({
      approvalId,
      decision: "decline",
      provider: "feishu",
      userId: "ou_owner",
      imBindingId: "binding",
      generation: 3,
      messageId: "om_card",
      channelId: "oc_chat",
    });
    decide.mockResolvedValue("unavailable");
    expect(await handleFeishuApprovalAction({ decide }, event, "binding", 3)).toMatchObject({
      toast: { type: "error" },
    });
    decide.mockClear();
    expect(await handleFeishuApprovalAction({ decide }, {}, "binding", 3)).toMatchObject({ toast: { type: "error" } });
    expect(decide).not.toHaveBeenCalled();
  });
});
