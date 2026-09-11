import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetReportedMilestones } from "../analytics/milestones.js";
import { overwriteGetLocale, overwriteSetLocale } from "../paraglide/runtime.js";

// Tests assert the published English copy; pin locale resolution and disable navigation in jsdom.
overwriteGetLocale(() => "en");
overwriteSetLocale(() => undefined);

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: memoryStorage(),
});

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// The router scrolls to the top of every navigation, which jsdom does not implement and reports as
// an unhandled error on each route change. Scroll position is not something these tests assert on.
Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });

if (!Element.prototype.getAnimations) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  // Model the static index.html scaffold: OpenTag's namespaced theme identity is present and the
  // generic attributes are absent. Tests that exercise the theme integrity notice rewrite them.
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.setAttribute("data-opentag-theme", "opentag");
  document.documentElement.setAttribute("data-opentag-mode", "light");
});

afterEach(async () => {
  cleanup();
  // A loader that requests again after its first await keeps running once the component is gone.
  // Let those chains settle before the spy is reset, or their late request lands in the next test
  // and is attributed to it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.mocked(fetch).mockReset();
  window.history.replaceState({}, "", "/");
  // memoryStorage() is shared by every test file, so clear the generated locale preference between tests.
  window.localStorage.clear();
  // Milestones are reported once per document as well as once per browser, and the per-document
  // floor is module state that outlives a render.
  resetReportedMilestones();
  // A popup that was still open when its tree unmounted leaves behind the scroll lock it applied to
  // <body>. Nothing else in these tests writes an inline body style, so the next test starts in a
  // document no earlier test has locked.
  document.body.removeAttribute("style");
});
