import type { ImBindingSummary } from "@opentag/shared/browser";

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
 */
export function messagingProviderLabel(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? "Lark" : "Slack";
}
