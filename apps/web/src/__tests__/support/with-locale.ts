import { overwriteGetLocale } from "../../paraglide/runtime.js";

/**
 * Run one assertion under a locale, then put the locale back.
 *
 * Locale is process-wide state, so a test that sets it and throws would leave every test after it
 * reading the wrong language. The restore is in a `finally` for that reason, and it restores to the
 * base locale rather than to whatever was set before, because a test that depends on the locale a
 * previous test happened to leave behind is a test that passes for the wrong reason.
 */
export function withLocale(locale: "en" | "zh", callback: () => void): void {
  overwriteGetLocale(() => locale);
  try {
    callback();
  } finally {
    overwriteGetLocale(() => "en");
  }
}

/**
 * The async twin of `withLocale`, for a locale that has to hold across a render and its awaits.
 *
 * A rendered assertion is the only kind that observes the component's own composition rather than a
 * copy of it, and rendering is asynchronous, so the synchronous form above cannot express it.
 */
export async function withLocaleAsync(locale: "en" | "zh", callback: () => Promise<void>): Promise<void> {
  overwriteGetLocale(() => locale);
  try {
    await callback();
  } finally {
    overwriteGetLocale(() => "en");
  }
}
