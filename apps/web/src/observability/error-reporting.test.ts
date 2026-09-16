import { ErrorReportRequestSchema, HTTP_PATHS } from "@opentag/shared/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorReportSink, forwardErrorReport, setErrorReportSink } from "./error-reporting.js";

const target = () => ({
  location: { href: "https://opentag.example/agents/42?token=opaque-query#frag" } as Location,
  navigator: { userAgent: "Mozilla/5.0 (test)" } as Navigator,
});

describe("web error report sink", () => {
  afterEach(() => {
    setErrorReportSink(undefined);
  });

  it("posts a redacted, anonymous report to the relay", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const sink = createErrorReportSink({ fetchImpl, version: "1.2.3", environment: "production", target });

    sink({
      code: "unhandled_error",
      message: "Render failed: token=opaque-token",
      stack: "Error: Render failed\n    at render (app.js:1:1)",
    });
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(HTTP_PATHS.errorReports);
    expect(init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "omit",
      headers: { "content-type": "application/json" },
    });
    const body = JSON.parse(String(init?.body));
    expect(ErrorReportRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      source: "web",
      code: "unhandled_error",
      message: "Render failed: token=[REDACTED]",
      stack: "Error: Render failed\n    at render (app.js:1:1)",
      version: "1.2.3",
      environment: "production",
      url: "https://opentag.example/agents/42",
      userAgent: "Mozilla/5.0 (test)",
    });
    expect(String(init?.body)).not.toContain("opaque");
  });

  it("sends an identical failure once per cooldown", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const sink = createErrorReportSink({ fetchImpl, target, cooldownMs: 30_000, now: () => now });

    sink({ code: "unhandled_error", message: "same" });
    sink({ code: "unhandled_error", message: "same" });
    sink({ code: "unhandled_error", message: "different" });
    now += 30_000;
    sink({ code: "unhandled_error", message: "same" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("forgets the oldest failures once the table is full and dedupes on an explicit key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const sink = createErrorReportSink({ fetchImpl, target, cooldownMs: 60_000, now: () => 1_000 });

    for (let index = 0; index <= 200; index += 1) sink({ code: "unhandled_error", message: `failure ${index}` });
    sink({ code: "unhandled_error", message: "failure 0" });
    sink({ code: "unhandled_error", message: "failure 200" });
    sink({
      code: "resource_load_failed",
      message: "resource_load_failed: /assets/a.js",
      dedupeKey: "resource_load_failed",
    });
    sink({
      code: "resource_load_failed",
      message: "resource_load_failed: /assets/b.js",
      dedupeKey: "resource_load_failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 201 distinct failures, then "failure 0" again (evicted, so sent), "failure 200" (still tracked), one resource failure.
    expect(fetchImpl).toHaveBeenCalledTimes(201 + 1 + 1);
  });

  it("swallows a rejected request, a throwing fetch, and a missing target", async () => {
    const rejecting = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const throwing = vi.fn<typeof fetch>().mockImplementation(() => {
      throw new Error("no fetch");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => createErrorReportSink({ fetchImpl: rejecting, target })({ code: "c", message: "m" })).not.toThrow();
    expect(() => createErrorReportSink({ fetchImpl: throwing, target })({ code: "c", message: "m" })).not.toThrow();
    expect(() =>
      createErrorReportSink({
        fetchImpl: rejecting,
        target: () => {
          throw new Error("no window");
        },
      })({ code: "c", message: "m" }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rejecting).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("forwards only while a sink is installed", () => {
    const sink = vi.fn();
    forwardErrorReport({ code: "c", message: "before" });
    setErrorReportSink(sink);
    forwardErrorReport({ code: "c", message: "during" });
    setErrorReportSink(undefined);
    forwardErrorReport({ code: "c", message: "after" });

    expect(sink).toHaveBeenCalledExactlyOnceWith({ code: "c", message: "during" });
  });
});
