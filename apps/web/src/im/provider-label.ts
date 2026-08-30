import type { ImBindingSummary } from "@opentag/shared/browser";

type MessagingProvider = ImBindingSummary["provider"];

/**
 * What a messaging provider is called in the product.
 *
 * Lark is the name this product goes by in English; Feishu is the same app under its mainland
 * China name. Only the reader-facing label changes here — the provider id stays `feishu`, because
 * that is the Server's own vocabulary, and it reaches this file through schemas, routes, API paths
 * and error codes that no rename should disturb.
 *
 * This exists because the label used to be derived with `titleCase(provider)`, which turns the id
 * straight into reader-facing text and so renders "Feishu" from nine separate call sites. A label
 * computed from an identifier cannot be corrected by editing strings: it has to stop being
 * computed from the identifier. Display code calls this; nothing displays a raw provider id.
 *
 * Written as an exhaustive switch rather than a ternary because this function is the one place a
 * provider becomes reader-facing text, so the cost of it being quietly wrong is every surface at
 * once. A ternary would answer for a provider it had never heard of; this fails to compile
 * instead, which is the only reminder that survives the person who wrote it.
 */
export function messagingProviderLabel(provider: MessagingProvider): string {
  switch (provider) {
    case "feishu":
      return "Lark";
    case "slack":
      return "Slack";
    default:
      return assertNeverProvider(provider);
  }
}

function assertNeverProvider(provider: never): never {
  throw new Error(`Unlabelled messaging provider: ${String(provider)}`);
}
