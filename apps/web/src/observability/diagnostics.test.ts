import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportBoundaryError } from "../features/error-boundary.js";
import {
  createDiagnosticEnvelope,
  DiagnosticReporter,
  installWindowDiagnosticHandlers,
  normalizeError,
  routeTemplate,
} from "./diagnostics.js";
import { createErrorReportSink, setErrorReportSink } from "./error-reporting.js";

describe("web diagnostics", () => {
  const originalLocation = window.location;
  let reload = vi.fn();

  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        get href() {
          return originalLocation.href;
        },
        get origin() {
          return originalLocation.origin;
        },
        get pathname() {
          return originalLocation.pathname;
        },
        reload,
      },
    });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    window.sessionStorage.clear();
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
      dedupeKey: "resource_load_failed",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("opaque");
  });

  it("includes routeTemplate and up to 3 formatted issues when relaying invalid_response_schema to /api/v1/error-reports", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    setErrorReportSink(
      createErrorReportSink({
        fetchImpl,
        target: () => ({ location: { href: "https://opentag.example/" } as Location, navigator: window.navigator }),
      }),
    );
    const reporter = new DiagnosticReporter({ error: () => undefined });

    reporter.report(
      {
        source: "api",
        code: "invalid_response_schema",
        routeTemplate: "/api/v1/sessions",
        issues: [{ path: ["tasks", 0, "status"], code: "invalid_enum_value" }],
      },
      "error",
    );
    // Repeated failure on the same route inside cooldown is deduplicated by invalid_response_schema:/api/v1/sessions.
    reporter.report(
      {
        source: "api",
        code: "invalid_response_schema",
        routeTemplate: "/api/v1/sessions",
        issues: [{ path: ["tasks", 1, "status"], code: "invalid_enum_value" }],
      },
      "error",
    );
    // Different route with >3 issues and a root-level issue is relayed separately and capped at 3 issues.
    reporter.report(
      {
        source: "api",
        code: "invalid_response_schema",
        routeTemplate: "/api/v1/agents",
        issues: [
          { path: [], code: "unrecognized_keys" },
          { path: ["agents", 0, "status"], code: "invalid_enum_value" },
          { path: ["agents", 0, "activity", "state"], code: "invalid_literal" },
          { path: ["agents", 0, "extra"], code: "invalid_type" },
        ],
      },
      "error",
    );
    // Empty issues array on a route omits parenthesized issue list; string path, missing code, non-object entry, and empty routeTemplate fall back cleanly.
    reporter.report(
      {
        source: "api",
        code: "invalid_response_schema",
        routeTemplate: "/api/v1/me",
        issues: [],
      },
      "error",
    );
    reporter.report(
      {
        source: "api",
        code: "invalid_response_schema",
        routeTemplate: "/api/v1/computers",
        issues: [null, { path: "computers.0.status" }, { code: "custom_error" }],
      },
      "error",
    );
    reporter.report(
      {
        source: "api",
        code: "invalid_response_schema",
        routeTemplate: "",
      },
      "error",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { message: string });
    expect(bodies.map((body) => body.message)).toEqual([
      "invalid_response_schema: /api/v1/sessions (tasks.0.status:invalid_enum_value)",
      "invalid_response_schema: /api/v1/agents (<root>:unrecognized_keys, agents.0.status:invalid_enum_value, agents.0.activity.state:invalid_literal)",
      "invalid_response_schema: /api/v1/me",
      "invalid_response_schema: /api/v1/computers (computers.0.status:invalid, <root>:custom_error)",
      "invalid_response_schema",
    ]);
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

  it("relays two different failures with one code inside the console cooldown, and a duplicate once", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    setErrorReportSink(
      createErrorReportSink({
        fetchImpl,
        target: () => ({ location: { href: "https://opentag.example/" } as Location, navigator: window.navigator }),
      }),
    );
    const error = vi.fn();
    const remove = installWindowDiagnosticHandlers(window, new DiagnosticReporter({ error }));

    for (const message of ["first failure", "second failure", "first failure"]) {
      const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
      Object.defineProperty(rejection, "reason", { value: new Error(message) });
      window.dispatchEvent(rejection);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(error).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { message: string });
    expect(bodies.map((body) => body.message)).toEqual(["first failure", "second failure"]);
    remove();
  });

  it("reports an uncaught exception outside React with its stack", () => {
    const sink = vi.fn();
    setErrorReportSink(sink);
    const error = vi.fn();
    const remove = installWindowDiagnosticHandlers(window, new DiagnosticReporter({ error }));
    const thrown = Object.assign(new Error("timer callback failed: token=opaque-timer"), { code: "TIMER_FAILED" });
    thrown.stack = "Error: timer callback failed\n    at tick (app.js:9:9)";

    window.dispatchEvent(new ErrorEvent("error", { error: thrown, message: thrown.message }));

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ code: "TIMER_FAILED", routeTemplate: "window", source: "window" });
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      code: "TIMER_FAILED",
      message: expect.stringContaining("timer callback failed: token=[REDACTED]"),
      stack: expect.stringContaining("at tick (app.js:9:9)"),
    });
    expect(JSON.stringify([error.mock.calls, sink.mock.calls])).not.toContain("opaque-timer");
    remove();
  });

  it("records unhandled rejections and capture-phase resource failures", () => {
    let now = 1_000;
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new Error("background failure") });
    window.dispatchEvent(rejection);

    const script = document.createElement("script");
    script.src = "/assets/chunk.js?token=opaque-query";
    document.body.append(script);
    script.dispatchEvent(new ErrorEvent("error"));
    expect(reload).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(1);

    // A second failure after the unload grace window inside the 60s reload guard window skips reload and reports the failure.
    now += 1_000;
    script.dispatchEvent(new ErrorEvent("error"));

    expect(reload).toHaveBeenCalledOnce();
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

  it("reloads once on a stale /assets/* failure, reports on repeat within 60s, and reloads again after cooldown", () => {
    let now = 10_000;
    const sink = vi.fn();
    setErrorReportSink(sink);
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/login-C2nNPNJE.css";
    document.head.append(link);

    link.dispatchEvent(new ErrorEvent("error"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem("opentag:stale-asset-reload") ?? "{}")).toEqual({
      pathname: "/",
      at: 10_000,
    });

    now += 59_999;
    link.dispatchEvent(new ErrorEvent("error"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      code: "resource_load_failed",
      resourceType: "link",
      resourcePath: "/assets/login-C2nNPNJE.css",
    });
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      code: "resource_load_failed",
      message: "resource_load_failed: /assets/login-C2nNPNJE.css",
      dedupeKey: "resource_load_failed",
    });

    now += 1;
    link.dispatchEvent(new ErrorEvent("error"));
    expect(reload).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
    remove();
  });

  it("prevents default and reloads once on vite:preloadError, then reports on repeat", () => {
    let now = 5_000;
    const sink = vi.fn();
    setErrorReportSink(sink);
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const firstPreloadError = new Event("vite:preloadError", { cancelable: true });
    Object.defineProperty(firstPreloadError, "payload", {
      value: new Error("Unable to preload CSS for /assets/login-C2nNPNJE.css"),
    });
    window.dispatchEvent(firstPreloadError);

    expect(firstPreloadError.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();

    now += 1_000;
    const secondPreloadError = new Event("vite:preloadError", { cancelable: true });
    Object.defineProperty(secondPreloadError, "payload", {
      value: new Error("Unable to preload CSS for /assets/login-C2nNPNJE.css"),
    });
    window.dispatchEvent(secondPreloadError);

    expect(reload).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      code: "resource_load_failed",
      routeTemplate: "window",
      resourcePath: "/assets/login-C2nNPNJE.css",
    });
    expect(sink).toHaveBeenCalledOnce();
    remove();
  });

  it("reloads once on unhandledrejection for stale /assets/* CSS preload or dynamic import", () => {
    let now = 20_000;
    const sink = vi.fn();
    setErrorReportSink(sink);
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const cssRejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(cssRejection, "reason", {
      value: new Error("Unable to preload CSS for https://opentag.example/assets/login-C2nNPNJE.css"),
    });
    window.dispatchEvent(cssRejection);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();

    now += 10_000;
    window.dispatchEvent(cssRejection);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      code: "resource_load_failed",
      routeTemplate: "window",
      resourcePath: "/assets/login-C2nNPNJE.css",
    });
    expect(sink).toHaveBeenCalledOnce();

    now += 60_000;
    const chunkRejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(chunkRejection, "reason", {
      value: new TypeError(
        `Failed to fetch dynamically imported module: ${window.location.origin}/assets/route-AbCdEf12.js`,
      ),
    });
    window.dispatchEvent(chunkRejection);

    expect(reload).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    remove();
  });

  it("suppresses companion link error and lazyRouteComponent TypeError fallout during a vite:preloadError reload", () => {
    let now = 30_000;
    const sink = vi.fn();
    setErrorReportSink(sink);
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const preloadError = new Event("vite:preloadError", { cancelable: true });
    Object.defineProperty(preloadError, "payload", {
      value: new TypeError(
        `Failed to fetch dynamically imported module: ${window.location.origin}/assets/agents.computers-GzrmCa8z.js`,
      ),
    });
    window.dispatchEvent(preloadError);
    expect(preloadError.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();

    // Calling preventDefault on vite:preloadError resolves Vite's preload wrapper to undefined,
    // causing TanStack Router's lazyRouteComponent to throw before location.reload() unloads the tab.
    now += 10;
    const fallout = new TypeError("Cannot read properties of undefined (reading 'component')");
    fallout.stack = `TypeError: Cannot read properties of undefined (reading 'component')\n    at ${window.location.origin}/assets/lazyRouteComponent-CybyN3Fx.js:1:4031`;
    reportBoundaryError("root", fallout);

    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: fallout });
    window.dispatchEvent(rejection);

    // Companion <link rel="modulepreload"> error firing 10ms later in the same unloading window.
    now += 10;
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = "/assets/agents.computers-GzrmCa8z.js";
    document.head.append(link);
    link.dispatchEvent(new ErrorEvent("error"));

    expect(reload).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    remove();
  });

  it("suppresses lazyRouteComponent TypeError fallout when a link error precedes vite:preloadError", () => {
    let now = 40_000;
    const sink = vi.fn();
    setErrorReportSink(sink);
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = "/assets/login-BcRjvb9R.js";
    document.head.append(link);
    link.dispatchEvent(new ErrorEvent("error"));
    expect(reload).toHaveBeenCalledOnce();

    now += 5;
    const preloadError = new Event("vite:preloadError", { cancelable: true });
    Object.defineProperty(preloadError, "payload", {
      value: new TypeError(
        `Failed to fetch dynamically imported module: ${window.location.origin}/assets/login-BcRjvb9R.js`,
      ),
    });
    window.dispatchEvent(preloadError);
    expect(preloadError.defaultPrevented).toBe(true);

    now += 5;
    const fallout = new TypeError("Cannot read properties of undefined (reading 'component')");
    fallout.stack = `TypeError: Cannot read properties of undefined (reading 'component')\n    at ${window.location.origin}/assets/lazyRouteComponent-CybyN3Fx.js:1:4031`;
    reportBoundaryError("route", fallout);

    expect(reload).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    remove();
  });

  it("suppresses multiple same-source stale-asset failures within the 500ms unload grace window and reports after it elapses", () => {
    let now = 50_000;
    const sink = vi.fn();
    setErrorReportSink(sink);
    const error = vi.fn();
    const reporter = new DiagnosticReporter({ now: () => now, error });
    const remove = installWindowDiagnosticHandlers(window, reporter);

    const firstLink = document.createElement("link");
    firstLink.rel = "modulepreload";
    firstLink.href = "/assets/route-parent-AaBbCc11.js";
    document.head.append(firstLink);
    firstLink.dispatchEvent(new ErrorEvent("error"));
    expect(reload).toHaveBeenCalledOnce();

    now += 10;
    const secondLink = document.createElement("link");
    secondLink.rel = "modulepreload";
    secondLink.href = "/assets/route-child-DdEeFf22.js";
    document.head.append(secondLink);
    secondLink.dispatchEvent(new ErrorEvent("error"));

    now += 10;
    const firstPreload = new Event("vite:preloadError", { cancelable: true });
    Object.defineProperty(firstPreload, "payload", {
      value: new TypeError(
        `Failed to fetch dynamically imported module: ${window.location.origin}/assets/route-parent-AaBbCc11.js`,
      ),
    });
    window.dispatchEvent(firstPreload);
    expect(firstPreload.defaultPrevented).toBe(true);

    now += 10;
    const secondPreload = new Event("vite:preloadError", { cancelable: true });
    Object.defineProperty(secondPreload, "payload", {
      value: new TypeError(
        `Failed to fetch dynamically imported module: ${window.location.origin}/assets/route-child-DdEeFf22.js`,
      ),
    });
    window.dispatchEvent(secondPreload);
    expect(secondPreload.defaultPrevented).toBe(true);

    expect(reload).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();

    // After the 500ms unload grace window elapses, a subsequent failure within the 60s reload cooldown is reported.
    now += 10_000;
    secondLink.dispatchEvent(new ErrorEvent("error"));

    expect(reload).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      code: "resource_load_failed",
      resourceType: "link",
      resourcePath: "/assets/route-child-DdEeFf22.js",
    });
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      code: "resource_load_failed",
      message: "resource_load_failed: /assets/route-child-DdEeFf22.js",
      dedupeKey: "resource_load_failed",
    });
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
