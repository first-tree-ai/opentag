import type { ImBindingSummary } from "@opentag/shared/browser";

type MessagingProvider = ImBindingSummary["provider"];

/** Maps provider ids to the product names users should see. */
export function messagingProviderLabel(provider: MessagingProvider): string {
  switch (provider) {
    case "feishu":
      return "Feishu";
    case "slack":
      return "Slack";
    default:
      return assertNeverProvider(provider);
  }
}

function assertNeverProvider(provider: never): never {
  throw new Error(`Unlabelled messaging provider: ${String(provider)}`);
}

/** Formats the complete provider set for user-facing alternatives. */
export function messagingProviderChoices(): string {
  const labels = (["feishu", "slack"] as const).map(messagingProviderLabel);
  const last = labels.at(-1) ?? "";
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${last}` : last;
}
