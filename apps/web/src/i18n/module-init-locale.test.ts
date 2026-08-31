import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Importing application modules must not decide the reader's language for them.
 *
 * Paraglide's generated `getLocale()` persists its first resolution — it calls `setLocale(...,
 * { reload: false })`, which under the localStorage strategy writes `PARAGLIDE_LOCALE`.
 * `configureLocaleRuntime()` exists to replace that resolver before anything reads a message, so
 * storage is written only by an explicit choice in the locale selector.
 *
 * That invariant is easy to break by accident and invisible when you do: calling a message at module
 * scope — `detail: m.some_message()` in a copy table, or a message inside a `Record` of error
 * strings — resolves the locale the moment the module is imported. `main.tsx` imports `App` before
 * its body configures the runtime, so such a call runs first and silently pins the language a
 * first-time visitor happens to arrive with. Nothing else in the suite would notice: the rendered
 * English is identical either way.
 */
describe("importing application modules before the locale runtime is configured", () => {
  const written: string[] = [];
  let restore: (() => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    written.length = 0;
    // The shared setup already installs an in-memory `window.localStorage`; this wraps that one
    // rather than replacing the global, so the suite's own teardown is left intact.
    const real = window.localStorage;
    const spy = vi.spyOn(real, "setItem").mockImplementation((key: string, value: string) => {
      written.push(key);
      Object.getPrototypeOf(real).setItem?.call(real, key, value);
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => {
    restore?.();
    window.localStorage.clear();
  });

  it.each([
    ["onboarding copy", () => import("../onboarding-v2/copy.js")],
    ["Slack configuration", () => import("../im/slack-configuration.js")],
    ["Agent presentation", () => import("../features/agents/agent-presentation.js")],
    ["the Computer picker", () => import("../features/agents/agent-computer-choice.js")],
    ["Agent settings sections", () => import("../features/agents/agent-settings/sections.js")],
  ])(
    "does not write a locale preference: %s",
    async (_label, load) => {
      await load();

      expect(written).not.toContain("PARAGLIDE_LOCALE");
      expect(window.localStorage.getItem("PARAGLIDE_LOCALE")).toBeNull();
    },
    // These import real application modules, so the cost is a module graph rather than any wait the
    // test controls. The Slack surface pulls the largest one and crosses the 5s default on a loaded
    // machine; the budget is generous because a timeout here would report a locale defect that is
    // really a slow import.
    30_000,
  );
});
