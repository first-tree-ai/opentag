import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticEnvelope,
  DiagnosticReporter,
  installWindowDiagnosticHandlers,
  normalizeError,
  routeTemplate,
} from "./diagnostics.js";
import { setErrorReportSink } from "./error-reporting.js";

describe("web diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setErrorReportSink(undefined);
  });

  it("relays error-level diagnostics to the installed sink with redacted text", () => {
    const sink = vi.fn();
    setErrorReportSink(sink);
    const reporter = new DiagnosticReporter({ warn: () => undefined, error: () => undefined });

    reporter.report({ source: "api", code: "SERVICE_UNAVAILABLE", routeTemplate: "/api/v1/agents" });
    reporter.report(
      {
        source: "window",
        code: "unhandled_rejection",
        routeTemplate: "window",
        error: {
          name: "Error",
          message: "Authorization: Bearer opaque-token",
          stack: "Error: token=opaque-stack\n    at run (app.js:1:1)",
        },
      },
      "error",
    );
    reporter.report(
      { source: "window", code: "resource_load_failed", routeTemplate: "window", resourcePath: "/assets/chunk.js" },
      "error",
    );

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledWith({
      code: "unhandled_rejection",
      message: "Authorization: [REDACTED]",
      stack: expect.stringContaining("at run (app.js:1:1)"),
    });
    expect(sink).toHaveBeenCalledWith({
      code: "resource_load_failed",
      message: "resource_load_failed: /assets/chunk.js",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("opaque");
  });

  it("uses route templates and cools down duplicate error codes", () => {
    let now = 100;
    const warn = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, cooldownMs: 1_000, warn });
    const input = {
      source: "api" as const,
      code: "SERVICE_UNAVAILABLE",
      routeTemplate: routeTemplate("/api/v1/agents/123"),
    };

    expect(reporter.report(input)).toBe(true);
    expect(reporter.report(input)).toBe(false);
    now += 1_000;
    expect(reporter.report(input)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(input.routeTemplate).toBe("/api/v1/agents/:id");
  });

  it("layers flat-string and structured redaction", () => {
    const diagnostic = createDiagnosticEnvelope({
      source: "ui",
      code: "unhandled_error",
      routeTemplate: "ui",
      error: { name: "Error", message: "Authorization: Bearer opaque-token" },
      componentStack: 'Set-Cookie: sid=opaque-cookie\n{"token":"opaque-json-token"}',
      metadata: { authorization: "Bearer opaque-structured-token" },
    });

    expect(JSON.stringify(diagnostic)).not.toContain("opaque-token");
    expect(JSON.stringify(diagnostic)).not.toContain("opaque-cookie");
    expect(JSON.stringify(diagnostic)).not.toContain("opaque-json-token");
    expect(JSON.stringify(diagnostic)).not.toContain("opaque-structured-token");
    expect((diagnostic.error as { message: string }).message).toBe("Authorization: [REDACTED]");
  });

  it("uses a stable code for non-error values instead of localized copy", () => {
    expect(normalizeError("Translated application failure").code).toBe("unhandled_error");
    expect(normalizeError(new Error("Translated application failure")).code).toBe("unhandled_error");
    expect(normalizeError(Object.assign(new Error("request stopped"), { code: "REQUEST_STOPPED" })).code).toBe(
      "REQUEST_STOPPED",
    );
  });

  it("records unhandled rejections and capture-phase resource failures", () => {
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new Error("background failure") });
    window.dispatchEvent(rejection);

    const script = document.createElement("script");
    script.src = "/assets/chunk.js?token=opaque-query";
    document.body.append(script);
    script.dispatchEvent(new ErrorEvent("error"));

    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ code: "unhandled_rejection", routeTemplate: "window" });
    expect(error.mock.calls[1]?.[1]).toMatchObject({
      code: "resource_load_failed",
      resourceType: "script",
      resourcePath: "/assets/chunk.js",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("opaque-query");
    remove();
  });

  it("leaves a third-party resource failure unreported", () => {
    const error = vi.fn();
    const remove = installWindowDiagnosticHandlers(window, new DiagnosticReporter({ error }));

    const script = document.createElement("script");
    script.src = "https://www.googletagmanager.com/gtag/js?id=G-EXAMPLE";
    document.body.append(script);
    script.dispatchEvent(new ErrorEvent("error"));

    // A blocked analytics tag is somebody's content blocker, not this application failing, and a
    // console error here fails every end-to-end test.
    expect(error).not.toHaveBeenCalled();
    remove();
  });
});
