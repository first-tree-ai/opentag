import { baseLocale, getLocale, getTextDirection } from "./locale.js";

export function applyDocumentLocale(): void {
  // Resolve the negotiated app locale for generated messages, but keep the document English until
  // the visible document copy has completed the next migration wave.
  getLocale();
  document.documentElement.lang = baseLocale;
  document.documentElement.dir = getTextDirection(baseLocale);
}
