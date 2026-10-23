import { readConfig } from "../src/config.ts";

export const config = readConfig({
  GOOGLE_CLOUD_PROJECT: "test-project",
  ALERT_POLICY_IDS: "1234567890",
  FEISHU_APP_ID: "cli_example",
  FEISHU_CHAT_ID: "oc_example",
  FEISHU_USER_ID_TYPE: "open_id",
  FEISHU_URGENT_USER_IDS: "ou_first,ou_second",
  FEISHU_APP_SECRET: "test-secret",
  WEBHOOK_USERNAME: "monitoring",
  WEBHOOK_PASSWORD: "password-for-local-tests-only-123456",
});

export const payload = (state = "open", renotify = false) => ({
  version: "1.2",
  incident: {
    incident_id: "incident-123",
    state,
    renotify,
    started_at: 1_792_700_000,
    ...(state === "closed" ? { ended_at: 1_792_700_100 } : {}),
    scoping_project_id: config.project,
    policy_name: "Readiness",
    summary: "Multi-region readiness failed",
    condition: { name: `projects/${config.project}/alertPolicies/1234567890/conditions/99` },
  },
});

export function testFeishu() {
  const calls = { messages: 0, sms: 0 };
  return {
    calls,
    token: async () => "test-feishu-token",
    send: async () => {
      calls.messages += 1;
      return "om_test";
    },
    urgent: async (_messageId: string, recipients: string[]) => {
      calls.sms += 1;
      return recipients;
    },
  };
}
