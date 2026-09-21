import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Harmless local Slack CLI substitute for E1 only.
 *
 * Answers the catalog probe contract and auth.test identity check. It never
 * contacts Slack. Identity constants are shared with the fixture IM binding.
 */
export const SLACK_FIXTURE = {
  appId: "A0E1LOCALPI",
  teamId: "T0E1LOCALPI",
  botUserId: "U0E1LOCALPI",
  botId: "B0E1LOCALPI",
  teamName: "E1 Local Pi Fixture",
  botDisplayName: "OpenTag E1 Bot",
  botAccessToken: "xoxb-e1-local-pi-fixture-not-a-real-token",
  signingSecret: "e1-fixture-signing-secret-not-real",
};

export const SLACK_REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "team:read",
  "users:read",
];

export const SLACK_STUB_PATH = join(dirname(fileURLToPath(import.meta.url)), "slack-stub.sh");
