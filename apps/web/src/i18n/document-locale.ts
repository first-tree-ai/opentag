import { getLocale, getTextDirection } from "./locale.js";

export function applyDocumentLocale(): void {
  const locale = getLocale();
  document.documentElement.lang = locale;
  document.documentElement.dir = getTextDirection(locale);
}
