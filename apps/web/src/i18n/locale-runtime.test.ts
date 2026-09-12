import { afterEach, describe, expect, it, vi } from "vitest";
import { withLocale } from "../__tests__/support/with-locale.js";
import { intlLocale, LOCALE_LABELS } from "./locale.js";

/**
 * `configureLocaleRuntime()` swaps Paraglide's persisting resolver for a read-only one, once per
 * module instance. Each case loads a fresh instance so the one-time guard is observed from a clean
 * slate, and pins the fresh runtime's `setLocale()` so no case can persist or navigate.
 */
async function loadLocaleRuntime() {
  vi.resetModules();
  const runtime = await import("../paraglide/runtime.js");
  runtime.overwriteSetLocale(() => undefined);
  const locale = await import("./locale.js");
  return { locale, runtime };
}

describe("configureLocaleRuntime", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("resolves the browser locale from the URL-aware strategies without persisting a preference", async () => {
    const { locale } = await loadLocaleRuntime();
    locale.configureLocaleRuntime();

    expect(locale.getLocale()).toBe("en");
    // Paraglide's own resolver would have written its first resolution here; the read-only one does not.
    expect(window.localStorage.getItem("PARAGLIDE_LOCALE")).toBeNull();

    // A stored preference is still honoured on the next read, so an explicit selector choice wins.
    window.localStorage.setItem("PARAGLIDE_LOCALE", "zh");
    expect(locale.getLocale()).toBe("zh");
  });

  it("configures the resolver only once", async () => {
    const { locale, runtime } = await loadLocaleRuntime();
    locale.configureLocaleRuntime();
    runtime.overwriteGetLocale(() => "zh");

    locale.configureLocaleRuntime();

    // A second call must not replace whatever resolver is installed by then.
    expect(locale.getLocale()).toBe("zh");
  });

  it("falls back to the default resolver when no window exists", async () => {
    const { locale } = await loadLocaleRuntime();
    locale.configureLocaleRuntime();
    // The shared setup stubs other globals through `vi.stubGlobal`, so only `window` is hidden here
    // and restored by hand rather than through `vi.unstubAllGlobals()`.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    try {
      expect(locale.getLocale()).toBe("en");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    }
    expect(window.localStorage.getItem("PARAGLIDE_LOCALE")).toBeNull();
  });
});

describe("locale presentation helpers", () => {
  it("names each language in itself", () => {
    expect(LOCALE_LABELS).toEqual({ en: "English", zh: "中文" });
  });

  it("adds the region subtag Intl needs", () => {
    expect(intlLocale("en")).toBe("en-US");
    expect(intlLocale("zh")).toBe("zh-CN");
  });

  it("defaults to the current locale", () => {
    withLocale("zh", () => {
      expect(intlLocale()).toBe("zh-CN");
    });
    withLocale("en", () => {
      expect(intlLocale()).toBe("en-US");
    });
  });
});
