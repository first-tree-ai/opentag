import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

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

afterEach(async () => {
  cleanup();
  // A loader that requests again after its first await keeps running once the component is gone.
  // Let those chains settle before the spy is reset, or their late request lands in the next test
  // and is attributed to it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.mocked(fetch).mockReset();
  window.history.replaceState({}, "", "/");
  // A popup that was still open when its tree unmounted leaves behind the scroll lock it applied to
  // <body>. Nothing else in these tests writes an inline body style, so the next test starts in a
  // document no earlier test has locked.
  document.body.removeAttribute("style");
});
