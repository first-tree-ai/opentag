import type { ImBindingSummary } from "@opentag/shared/browser";
import { getLocale } from "../i18n/locale.js";

type MessagingProvider = ImBindingSummary["provider"];

/**
 * What a messaging channel is called, in the reader's locale.
 *
 * Feishu and Lark are the same channel under two regional brands, and a single connect code works
 * for both: the vendor detects the tenant's brand during authorization and switches domains itself.
 * So there is no "correct" name in the abstract — there is the name this reader knows the product
 * by. A Chinese reader knows it as 飞书; an English reader knows it as Lark. Neither is a
 * translation of the other, which is why this is a brand choice rather than a catalogue string.
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
      return getLocale() === "zh" ? "飞书" : "Lark";
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
 * The other regional brand of the same channel — Feishu to an English reader, Lark to a Chinese one.
 *
 * A single connect code serves both, so the picker says so out loud rather than making a reader guess
 * whether their tenant is covered. It lives here for the same reason the primary label does: the
 * catalogue owns the sentence, this owns every brand name inside it.
 */
export function messagingProviderAlternateBrand(): string {
  return getLocale() === "zh" ? "Lark" : "Feishu";
}

/**
 * The label as it should sit *inside* a Chinese sentence.
 *
 * Chinese sets no space between Chinese characters and one space either side of Latin text, so a
 * template cannot carry the spacing: the same `{provider}` slot receives 飞书 in one branch and
 * Slack in the next. The label knows its own script, so it carries its own boundary — CJK joins the
 * sentence directly, Latin brings the spaces Chinese typography expects. In `en` this is the label
 * unchanged, because English already spaces every word.
 *
 * Only interpolation sites use this. A label rendered on its own — an Agent card, a button — wants
 * `messagingProviderLabel`, which has no padding to trim.
 */
export function messagingProviderLabelInSentence(provider: MessagingProvider): string {
  const label = messagingProviderLabel(provider);
  return getLocale() === "zh" && !/^[\u3400-\u9fff]/.test(label) ? ` ${label} ` : label;
}

/** The counterpart brand, spaced for a Chinese sentence on the same rule. */
export function messagingProviderAlternateBrandInSentence(): string {
  const brand = messagingProviderAlternateBrand();
  return getLocale() === "zh" ? ` ${brand} ` : brand;
}
