export type { Locale } from "../paraglide/runtime.js";
export {
  baseLocale,
  getLocale,
  getTextDirection,
  isLocale,
  locales,
  setLocale,
  toLocale,
} from "../paraglide/runtime.js";

import type { Locale } from "../paraglide/runtime.js";
import { getLocale } from "../paraglide/runtime.js";

/** Each language is named in its own language so the selector remains understandable. */
export const LOCALE_LABELS: Record<Locale, string> = { en: "English", zh: "中文" };

/** Intl needs a region subtag for sensible date and collation defaults. */
export function intlLocale(locale: Locale = getLocale()): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}
