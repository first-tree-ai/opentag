import { slackAppManifest } from "@opentag/shared/browser";

export { slackAppManifest, slackBotDisplayName } from "@opentag/shared/browser";

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
