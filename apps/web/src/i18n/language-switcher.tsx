import { useState } from "react";
import * as m from "../paraglide/messages.js";
import { KumoSelectControl } from "../ui/design-system.js";
import { getLocale, LOCALE_LABELS, type Locale, locales, setLocale } from "./locale.js";

/** A compact, keyboard-accessible locale selector shared by authenticated and public surfaces. */
export function LanguageSwitcher() {
  const [locale, setCurrentLocale] = useState<Locale>(() => getLocale());
  const label = m.shell_language_label();

  async function changeLocale(next: Locale) {
    setCurrentLocale(next);
    await setLocale(next);
  }

  return (
    <label className="inline-flex items-center gap-2 text-sm text-kumo-subtle" htmlFor="language-switcher">
      <span>{label}</span>
      <KumoSelectControl
        aria-label={label}
        id="language-switcher"
        size="sm"
        value={locale}
        onValueChange={(value) => void changeLocale(value as Locale)}
      >
        {locales.map((availableLocale) => (
          <option key={availableLocale} value={availableLocale}>
            {LOCALE_LABELS[availableLocale]}
          </option>
        ))}
      </KumoSelectControl>
    </label>
  );
}
