import { afterEach, describe, expect, it } from "vitest";
import { withLocale } from "../__tests__/support/with-locale.js";
import { applyDocumentLocale } from "./document-locale.js";

describe("document language", () => {
  afterEach(() => {
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
  });

  it.each(["zh", "en"] as const)("identifies %s copy to assistive technology", (locale) => {
    document.documentElement.lang = locale === "zh" ? "en" : "zh";
    document.documentElement.dir = "rtl";
    withLocale(locale, applyDocumentLocale);
    expect(document.documentElement.lang).toBe(locale);
    expect(document.documentElement.dir).toBe("ltr");
  });
});
