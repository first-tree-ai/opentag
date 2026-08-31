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
import { getLocale, getLocaleForUrl, overwriteGetLocale } from "../paraglide/runtime.js";

const defaultGetLocale = getLocale;
let localeRuntimeConfigured = false;

/**
 * Resolve browser locales without invoking Paraglide's initial persistence hook.
 *
 * Paraglide's generated `getLocale()` calls `setLocale()` after its first resolution. The URL-aware
 * resolver performs the same strategy lookup without that write, so localStorage is changed only by
 * an explicit `setLocale()` call from a locale selector.
 */
export function configureLocaleRuntime(): void {
  if (localeRuntimeConfigured) return;

  overwriteGetLocale(() => {
    if (typeof window !== "undefined") return getLocaleForUrl(window.location.href);
    return defaultGetLocale();
  });
  localeRuntimeConfigured = true;
}

/** Each language is named in its own language so the selector remains understandable. */
export const LOCALE_LABELS: Record<Locale, string> = { en: "English", zh: "中文" };

/** Intl needs a region subtag for sensible date and collation defaults. */
export function intlLocale(locale: Locale = getLocale()): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}
