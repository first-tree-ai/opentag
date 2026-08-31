import type { ImBindingSummary } from "@opentag/shared/browser";

type MessagingProvider = ImBindingSummary["provider"];

/**
 * What a messaging provider is called in the product.
 *
 * Feishu and Lark are two channels, not one product under two names, and what OpenTag carries
 * today is Feishu. A Lark channel would arrive as its own provider beside `feishu` and `slack`,
 * with its own entry below. That is why this label says Feishu alone and carries no "also called"
 * apposition: an apposition would present a channel we do not deliver as another word for one we
 * do, and the authorization code a reader is handed is minted against Feishu either way.
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
