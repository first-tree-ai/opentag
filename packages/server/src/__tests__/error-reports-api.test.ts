import { HTTP_PATHS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteRateLimiter } from "../api/browser-auth.js";
import { ERROR_REPORT_RATE_LIMIT, ERROR_REPORT_RATE_LIMIT_WINDOW_MS } from "../api/error-reports.js";
import { createApp } from "../app.js";
import type { ErrorReporter } from "../observability/error-reporting.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const validReport = {
  source: "web",
  message: "Render failed: Authorization: Bearer opaque-token",
  stack: "Error: Render failed\n    at render (app.js:1:1)",
  code: "unhandled_error",
  version: "1.2.3",
  url: "https://opentag.example/agents",
  userAgent: "Mozilla/5.0",
  occurredAt: "2026-09-11T10:00:00.000Z",
};

function createRelayApp(options: { reporter?: ErrorReporter; rateLimiter?: RouteRateLimiter } = {}) {
  const chunks: string[] = [];
  const app = createApp({
    loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    errorReporting: options,
  });
  apps.push(app);
  return { app, logs: () => chunks.join("") };
}

function post(app: ReturnType<typeof createApp>, body: unknown, ip = "203.0.113.7") {
  return app.inject({
    method: "POST",
    url: HTTP_PATHS.errorReports,
    remoteAddress: ip,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("POST /api/v1/error-reports", () => {
  it("accepts an anonymous report, logs it redacted, and forwards it with the caller address", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app, logs } = createRelayApp({ reporter });

    const response = await post(app, validReport);

    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(reporter.report).toHaveBeenCalledExactlyOnceWith(
      { ...validReport, message: "Render failed: Authorization: [REDACTED]" },
      { ip: "203.0.113.7" },
    );
    expect(logs()).toContain("Client error reported");
    expect(logs()).toContain('"errorCode":"unhandled_error"');
    expect(logs()).not.toContain("opaque-token");
  });

  it("registers the relay without any reporter and still answers 202", async () => {
    const chunks: string[] = [];
    const app = createApp({ loggerStream: { write: (chunk) => chunks.push(String(chunk)) } });
    apps.push(app);

    const response = await post(app, { ...validReport, source: "cli", command: "agent create", url: undefined });

    expect(response.statusCode).toBe(202);
    expect(chunks.join("")).toContain("GOOGLE_CLOUD_PROJECT is not set");
  });

  it("rejects an invalid or non-strict body with the shared validation envelope", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app } = createRelayApp({ reporter });

    const unknownField = await post(app, { ...validReport, accessToken: "opaque" });
    const missingMessage = await post(app, { source: "web", occurredAt: validReport.occurredAt });
    const notJson = await app.inject({
      method: "POST",
      url: HTTP_PATHS.errorReports,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    for (const response of [unknownField, missingMessage, notJson]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", category: "validation" } });
    }
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it("rate limits one address without affecting another", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app } = createRelayApp({
      reporter,
      rateLimiter: new RouteRateLimiter(2, ERROR_REPORT_RATE_LIMIT_WINDOW_MS),
    });

    expect((await post(app, validReport)).statusCode).toBe(202);
    expect((await post(app, validReport)).statusCode).toBe(202);
    const limited = await post(app, validReport);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED", message: "Too many error reports" } });
    expect((await post(app, validReport, "198.51.100.2")).statusCode).toBe(202);
    expect(reporter.report).toHaveBeenCalledTimes(3);
  });

  it("defaults to a per-minute budget of thirty reports", () => {
    expect(ERROR_REPORT_RATE_LIMIT).toBe(30);
    expect(ERROR_REPORT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("still answers 202 when the reporter rejects", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockRejectedValue(new Error("tracker unavailable")) };
    const { app, logs } = createRelayApp({ reporter });

    const response = await post(app, validReport);

    expect(response.statusCode).toBe(202);
    expect(logs()).toContain("Error reporter failed");
  });
});
