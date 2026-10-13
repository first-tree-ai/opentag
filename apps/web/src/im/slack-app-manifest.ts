import {
  SLACK_INTERACTIONS_PATH,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
} from "@opentag/shared/browser";

export function slackBotDisplayName(agentId: string, displayName: string): string {
  const name = displayName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return name && name !== "slackbot" ? name : `opentag-${agentId.slice(0, 8)}`;
}

/** One complete configuration for a newly created App. Never apply it over an existing customer's App. */
export function slackAppManifest(agentId: string, displayName: string, eventsUrl: string) {
  return {
    _metadata: { major_version: 1, minor_version: 3 },
    display_information: { name: [...displayName].slice(0, 35).join("") || "OpenTag Agent" },
    features: {
      bot_user: { display_name: slackBotDisplayName(agentId, displayName), always_online: false },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: { scopes: { bot: [...SLACK_REQUIRED_BOT_SCOPES] } },
    settings: {
      interactivity: { is_enabled: true, request_url: new URL(SLACK_INTERACTIONS_PATH, eventsUrl).toString() },
      event_subscriptions: { request_url: eventsUrl, bot_events: [...SLACK_SUBSCRIBED_BOT_EVENTS] },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function slackAppCreateUrl(agentId: string, displayName: string, eventsUrl: string): string {
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(slackAppManifest(agentId, displayName, eventsUrl)));
  return url.toString();
}

export function slackBotConversationUrl(appId: string, teamId: string): string {
  const url = new URL("https://slack.com/app_redirect");
  url.searchParams.set("app", appId);
  url.searchParams.set("team", teamId);
  return url.toString();
}
