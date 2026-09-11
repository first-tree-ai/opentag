import { afterEach, describe, expect, it } from "vitest";
import { appendGtagScript, dataLayerSink, GTAG_SCRIPT_ORIGIN } from "./gtag.js";

type GtagScope = Window & { dataLayer?: unknown[]; gtag?: unknown };

afterEach(() => {
  const scope = window as GtagScope;
  scope.dataLayer = undefined;
  scope.gtag = undefined;
  for (const script of document.head.querySelectorAll("script")) script.remove();
});

describe("gtag transport", () => {
  it("queues each command as an arguments object, the way the published snippet does", () => {
    const send = dataLayerSink(window);

    send(["config", "G-EXAMPLE", { send_page_view: false }]);
    send(["event", "agent_created", { runtime_provider: "codex" }]);

    const queue = (window as GtagScope).dataLayer ?? [];
    expect(queue).toHaveLength(2);
    // An arguments object, not an array: gtag.js reads the queued entry positionally and the two
    // are not the same value.
    expect(Array.isArray(queue[0])).toBe(false);
    expect(Array.from(queue[0] as ArrayLike<unknown>)).toEqual(["config", "G-EXAMPLE", { send_page_view: false }]);
    expect(Array.from(queue[1] as ArrayLike<unknown>)).toEqual([
      "event",
      "agent_created",
      { runtime_provider: "codex" },
    ]);
  });

  it("keeps a queue the tag has already installed instead of replacing it", () => {
    const scope = window as GtagScope;
    const existing: unknown[] = [{ preexisting: true }];
    scope.dataLayer = existing;

    dataLayerSink(window)(["js", new Date(0)]);

    expect(scope.dataLayer).toBe(existing);
    expect(existing).toHaveLength(2);
  });

  it("requests the tag asynchronously for the measurement id it was given", () => {
    const script = appendGtagScript("G-EXAMPLE", window);

    expect(script.async).toBe(true);
    expect(script.src).toBe(`${GTAG_SCRIPT_ORIGIN}/gtag/js?id=G-EXAMPLE`);
    expect(document.head.contains(script)).toBe(true);
  });
});
