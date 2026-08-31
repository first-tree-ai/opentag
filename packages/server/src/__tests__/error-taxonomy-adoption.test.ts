import { StructuredErrorSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { SlackWebhookReceiptError } from "../services/im-bindings/slack/webhook-receipt-store.js";

describe("server IM error taxonomy adoption", () => {
  it("exposes a schema-valid diagnostic for provider policy failures", () => {
    const error = new ExternalCallPolicyError("IM_PROVIDER_HOST_NOT_ALLOWED", "The provider host is not allowed", {
      category: "security",
      retryability: "not_retryable",
      phase: "request",
      requestId: "request-1",
    });
    expect(StructuredErrorSchema.parse(error.structuredError)).toMatchObject({
      code: "IM_PROVIDER_HOST_NOT_ALLOWED",
      category: "authorization",
      retryability: "never",
      phase: "request",
      requestId: "request-1",
    });
  });

  it("exposes a schema-valid diagnostic for receipt failures", () => {
    const error = new SlackWebhookReceiptError("SLACK_RECEIPT_EVENT_ID_INVALID", "request-1");
    expect(StructuredErrorSchema.parse(error.structuredError)).toMatchObject({
      code: "SLACK_RECEIPT_EVENT_ID_INVALID",
      category: "validation",
      retryability: "never",
      phase: "request",
      requestId: "request-1",
    });
  });
});
