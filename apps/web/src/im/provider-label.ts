import { type FeishuBrand, type ImBindingSummary, ImProviderSchema } from "@opentag/shared/browser";

type MessagingProvider = ImBindingSummary["provider"];

/**
 * What a messaging provider is called in the product.
 *
 * Feishu and Lark are one channel behind a regional switch, not two providers: the same `feishu`
 * binding is delivered to either the Feishu or the Lark domain according to the team's brand. That
 * brand is decided before the code is minted, and confirmed afterwards from the authorization
 * result, so the name follows it: a reader connecting a Lark tenant is told Lark throughout. Where
 * no brand is known yet — a picker offering the channel before anything has been chosen, a binding
 * summary that never carried one — the name falls back to Feishu, which is what an unqualified
 * `feishu` binding was minted against.
 *
 * Labels used to be derived with `titleCase(provider)`, which turns the identifier straight into
 * reader-facing text. That happens to read correctly for `feishu`, which is why nothing looked
 * broken — but it is the wrong shape for a product that intends to add channels: a new provider
 * would name itself, in whatever casing its identifier happened to have, without anyone ever
 * choosing how it should read. Display code calls this instead; nothing displays a raw id.
 *
 * The switch is exhaustive rather than a ternary because this is the one place a provider becomes
 * reader-facing text, so the cost of it being quietly wrong is every surface at once. Adding a
 * provider fails to compile here until somebody gives it a name.
 */
export function messagingProviderLabel(provider: MessagingProvider, brand?: FeishuBrand): string {
  switch (provider) {
    case "feishu":
      return brand === "lark" ? "Lark" : "Feishu";
    case "slack":
      return "Slack";
    default:
      return assertNeverProvider(provider);
  }
}

function assertNeverProvider(provider: never): never {
  throw new Error(`Unlabelled messaging provider: ${String(provider)}`);
}

/**
 * Every channel OpenTag can connect, named and joined into prose: "Feishu or Slack".
 *
 * Sentences that offer the reader a choice used to write the set out by hand. Each name was correct,
 * so the exhaustive switch above looked like it covered them -- but that switch only guarantees every
 * provider *has* a name, not that every sentence listing them knows a new one exists. A third channel
 * would compile clean while these sentences kept telling readers there were two.
 *
 * Driving it from `ImProviderSchema.options` moves the set to the same source as the names: adding a
 * provider to the schema changes what these sentences say, without anyone remembering to come here.
 */
export function messagingProviderChoices(): string {
  const labels = ImProviderSchema.options.map((provider) => messagingProviderLabel(provider));
  const last = labels.at(-1) ?? "";
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${last}` : last;
}
