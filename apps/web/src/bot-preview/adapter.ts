import type { AgentSetupAdapter } from "../onboarding-v2/setup-adapter.js";
import { createLabSlackSetup } from "../onboarding-v2/setup-lab-slack.js";
import type { MemorySetupAdapter } from "../onboarding-v2/setup-memory-adapter.js";

export type PreviewFailure = "unknown" | "service" | "permissions" | "expired";

const FAILURE_CODES = {
  feishu: {
    unknown: null,
    service: "FEISHU_UPSTREAM_UNAVAILABLE",
    permissions: "FEISHU_SCOPE_REAUTH_REQUIRED",
    expired: "FEISHU_SETUP_EXPIRED",
  },
  slack: {
    unknown: null,
    service: "SLACK_UPSTREAM_UNAVAILABLE",
    permissions: "SLACK_SCOPE_REAUTH_REQUIRED",
    expired: null,
  },
} as const;

/** Keep even the QR payload inert if somebody scans it on another device. */
export function createBotPreviewAdapter(memory: MemorySetupAdapter, failure?: PreviewFailure): AgentSetupAdapter {
  const slack = createLabSlackSetup(memory);
  let ticketVersion = 0;
  return {
    ...memory.adapter,
    slackSetup: {
      ...slack,
      async autoSetupSlack(agentId, input) {
        if (input.action === "authorize") {
          ticketVersion += 1;
          return { status: "authorization_required", ticket: `review-lab-${ticketVersion}` };
        }
        if (input.challenge === "demo-invalid") return { status: "failed", code: "authorization_failed" };
        return slack.autoSetupSlack(agentId, input);
      },
    },
    async readSnapshot(agentId) {
      const snapshot = await memory.adapter.readSnapshot(agentId);
      if (snapshot.messaging.kind === "blocked" && failure) {
        const errorCode = FAILURE_CODES[snapshot.messaging.provider][failure];
        return { ...snapshot, messaging: { ...snapshot.messaging, code: "provider-error" as const, errorCode } };
      }
      if (snapshot.messaging.kind !== "authorizing" || snapshot.messaging.provider !== "feishu") return snapshot;
      return {
        ...snapshot,
        messaging: {
          ...snapshot.messaging,
          qrUrl: snapshot.messaging.qrUrl ? "https://preview.invalid/bot-connection/demo-only" : null,
        },
      };
    },
  };
}
