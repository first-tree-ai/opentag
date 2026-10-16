import { SLACK_REQUIRED_BOT_SCOPES, SLACK_SUBSCRIBED_BOT_EVENTS } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { slackAppCreateUrl, slackAppManifest, slackBotConversationUrl } from "./slack-app-manifest.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const eventsUrl = `https://opentag.example/api/v1/agents/${agentId}/im-binding/slack/events`;

describe("new Slack App creation configuration", () => {
  it("prefills one complete, credential-free Manifest with the current contract and Agent URL", () => {
    const url = new URL(slackAppCreateUrl(agentId, "研发助理", eventsUrl));
    const manifest = JSON.parse(url.searchParams.get("manifest_json") ?? "null");
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_REQUIRED_BOT_SCOPES]);
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: eventsUrl,
      bot_events: [...SLACK_SUBSCRIBED_BOT_EVENTS],
    });
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(false);
    expect(manifest.settings.interactivity).toEqual({
      is_enabled: true,
      request_url: "https://opentag.example/api/v1/im-bindings/slack/interactions",
    });
    expect(Object.keys(manifest)).not.toContain("credentials");
    expect(JSON.stringify(manifest)).not.toMatch(/signingSecret|botAccessToken|client_secret/);
  });

  it.each([
    ["slack-staging-a-1013", "slack-staging-a-1013"],
    ["QA Agent", "qa-agent"],
    ["研发助理", `opentag-${agentId.slice(0, 8)}`],
    ["slackbot", `opentag-${agentId.slice(0, 8)}`],
  ])("uses the Agent name for its Bot within Slack's rules: %s", (name, expected) => {
    expect(slackAppManifest(agentId, name, eventsUrl).features.bot_user.display_name).toBe(expected);
  });

  it("bounds Bot names and App names without splitting Unicode", () => {
    const manifest = slackAppManifest(agentId, "🧑‍💻".repeat(50), eventsUrl);
    expect([...manifest.display_information.name]).toHaveLength(35);
    expect(manifest.features.bot_user.display_name).toMatch(/^[a-z0-9_.-]{1,80}$/);
    expect(slackAppManifest(agentId, "a".repeat(90), eventsUrl).features.bot_user.display_name).toBe("a".repeat(80));
  });

  it("targets the identified App and Team in the Bot conversation link", () => {
    const url = new URL(slackBotConversationUrl("A1", "T_LOCAL"));
    expect(url.origin + url.pathname).toBe("https://slack.com/app_redirect");
    expect([...url.searchParams]).toEqual([
      ["app", "A1"],
      ["team", "T_LOCAL"],
    ]);
  });
});
