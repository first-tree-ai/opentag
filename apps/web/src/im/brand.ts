import type { FeishuBrand } from "@opentag/shared/browser";
import { getLocale, type Locale } from "../i18n/locale.js";

/**
 * Which regional brand of the one Feishu channel to mint a first connect code against.
 *
 * The brand belongs to the *tenant*, not to the person: a Chinese speaker can work at a Lark
 * company and an English speaker at a Feishu one. The interface language is only the best signal
 * available before anyone has authorized anything — the Server sees no country, and the binding
 * that would know has not been created yet. So this decides the default, and the connect screen
 * lets the reader overrule it. Guessing wrong costs one click; not guessing at all costs a code
 * their account cannot authorize.
 *
 * The locale is what the reader is actually being spoken to in — a stored choice from the language
 * selector when they made one, otherwise their browser's preferred language.
 */
export function defaultFeishuBrand(locale: Locale = getLocale()): FeishuBrand {
  return locale === "zh" ? "feishu" : "lark";
}

/** The brand a reader looking at one brand's code can switch to. There are only ever two. */
export function otherFeishuBrand(brand: FeishuBrand): FeishuBrand {
  return brand === "feishu" ? "lark" : "feishu";
}
