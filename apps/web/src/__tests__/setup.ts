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
});
