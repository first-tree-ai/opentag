import {
  ERROR_REPORT_FIELD_MAX_LENGTH,
  ERROR_REPORT_MESSAGE_MAX_LENGTH,
  ERROR_REPORT_STACK_MAX_LENGTH,
  ERROR_REPORT_URL_MAX_LENGTH,
  HTTP_PATHS,
  STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteRateLimiter } from "../api/browser-auth.js";
import {
  ERROR_REPORT_BODY_LIMIT_BYTES,
  ERROR_REPORT_RATE_LIMIT,
  ERROR_REPORT_RATE_LIMIT_WINDOW_MS,
} from "../api/error-reports.js";
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

function createRelayApp(
  options: { reporter?: ErrorReporter; rateLimiter?: RouteRateLimiter; trustProxy?: boolean | string[] } = {},
) {
  const chunks: string[] = [];
  const { trustProxy, ...errorReporting } = options;
  const app = createApp({
    loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    errorReporting,
    ...(trustProxy === undefined ? {} : { trustProxy }),
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
    await new Promise((resolve) => setTimeout(resolve, 0));

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

  it("lifts the identifiers an operator filters on out of the nested report", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app, logs } = createRelayApp({ reporter });

    const response = await post(app, {
      ...validReport,
      reportId: "6f1c2f3a-0000-4000-8000-000000000000",
      userId: "a1b2c3d4-0000-4000-8000-000000000000",
      route: "/agents/:agentId",
    });

    expect(response.statusCode).toBe(202);
    expect(logs()).toContain('"reportId":"6f1c2f3a-0000-4000-8000-000000000000"');
    expect(logs()).toContain('"userId":"a1b2c3d4-0000-4000-8000-000000000000"');
    // The rest of the context stays where the tracker cannot keep it: the nested payload.
    expect(logs()).toContain('"route":"/agents/:agentId"');
  });

  it("scrubs the lifted identifiers as hard as the nested payload", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app, logs } = createRelayApp({ reporter });

    // The relay is anonymous, so either identifier is whatever the caller chose to post.
    const response = await post(app, {
      ...validReport,
      reportId: "token=fixture-report-secret",
      userId: "Bearer fixture-user-secret",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.statusCode).toBe(202);
    const line = logs()
      .split("\n")
      .find((entry) => entry.includes("Client error reported"));
    expect(line).toBeDefined();
    expect(line).not.toContain("fixture-report-secret");
    expect(line).not.toContain("fixture-user-secret");
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      reportId: "token=[REDACTED]",
      userId: "Bearer [REDACTED]",
      errorReport: { reportId: "token=[REDACTED]", userId: "Bearer [REDACTED]" },
    });
  });

  it("accepts a maximal report written entirely in CJK", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app } = createRelayApp({ reporter });
    // Every bound is in UTF-16 code units; a CJK character costs three bytes on the wire.
    const cjk = (length: number) => "错".repeat(length);
    const url = `https://opentag.example/${encodeURIComponent(cjk(200))}`;
    expect(url.length).toBeLessThanOrEqual(ERROR_REPORT_URL_MAX_LENGTH);
    const report = {
      source: "cli",
      message: cjk(ERROR_REPORT_MESSAGE_MAX_LENGTH),
      stack: cjk(ERROR_REPORT_STACK_MAX_LENGTH),
      code: "unhandled_error",
      version: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      environment: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      command: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      platform: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      reportId: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      userId: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      computerId: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      installationId: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      agentId: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      sessionId: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      turnId: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      provider: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      userAgent: cjk(ERROR_REPORT_FIELD_MAX_LENGTH),
      url,
      occurredAt: validReport.occurredAt,
    };
    const bytes = Buffer.byteLength(JSON.stringify(report), "utf8");
    expect(bytes).toBeGreaterThan(64 * 1024);
    expect(bytes).toBeLessThanOrEqual(ERROR_REPORT_BODY_LIMIT_BYTES);

    const response = await post(app, report);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.statusCode).toBe(202);
    expect(reporter.report).toHaveBeenCalledTimes(1);
  });

  it("refuses a body far larger than any report the schema would accept", async () => {
    const { app } = createRelayApp({ reporter: { report: vi.fn().mockResolvedValue(undefined) } });

    const response = await post(app, { ...validReport, stack: "x".repeat(ERROR_REPORT_BODY_LIMIT_BYTES) });

    expect(response.statusCode).toBe(413);
  });

  it("registers the relay without any reporter and still answers 202", async () => {
    const chunks: string[] = [];
    const app = createApp({ loggerStream: { write: (chunk) => chunks.push(String(chunk)) } });
    apps.push(app);

    const response = await post(app, { ...validReport, source: "cli", command: "agent create", url: undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));

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

  it("strips credentials and query from the URL before logging or forwarding, and rejects non-HTTP URLs", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app, logs } = createRelayApp({ reporter });

    // Assembled at runtime so the fixture is not itself a credential-bearing URL in the source tree.
    const withCredentials = new URL("https://opentag.example/agents?token=opaque#f");
    withCredentials.username = "user";
    withCredentials.password = "pass";
    const stripped = await post(app, { ...validReport, url: withCredentials.toString() });
    const rejected = await post(app, { ...validReport, url: "javascript:alert(1)" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stripped.statusCode).toBe(202);
    expect(rejected.statusCode).toBe(400);
    expect(vi.mocked(reporter.report).mock.calls[0]?.[0].url).toBe("https://opentag.example/agents");
    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(logs()).not.toContain("opaque");
    expect(logs()).not.toContain("user:pass");
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reporter.report).toHaveBeenCalledTimes(3);
  });

  it("keys the budget on the forwarded client only when the proxy is trusted", async () => {
    const viaProxy = (app: ReturnType<typeof createApp>, client: string) =>
      app.inject({
        method: "POST",
        url: HTTP_PATHS.errorReports,
        remoteAddress: "10.0.1.5",
        headers: { "content-type": "application/json", "x-forwarded-for": client },
        payload: JSON.stringify(validReport),
      });
    const limiter = () => new RouteRateLimiter(1, ERROR_REPORT_RATE_LIMIT_WINDOW_MS);
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };

    const trusted = createRelayApp({ reporter, rateLimiter: limiter(), trustProxy: ["uniquelocal"] }).app;
    expect((await viaProxy(trusted, "203.0.113.7")).statusCode).toBe(202);
    expect((await viaProxy(trusted, "198.51.100.2")).statusCode).toBe(202);
    expect((await viaProxy(trusted, "203.0.113.7")).statusCode).toBe(429);

    const untrusted = createRelayApp({ reporter, rateLimiter: limiter() }).app;
    expect((await viaProxy(untrusted, "203.0.113.7")).statusCode).toBe(202);
    expect((await viaProxy(untrusted, "198.51.100.2")).statusCode).toBe(429);

    // A peer outside the trusted list cannot pick its own address by sending the header.
    const direct = createRelayApp({ reporter, rateLimiter: limiter(), trustProxy: ["uniquelocal"] }).app;
    const spoof = (client: string) =>
      direct.inject({
        method: "POST",
        url: HTTP_PATHS.errorReports,
        remoteAddress: "203.0.113.9",
        headers: { "content-type": "application/json", "x-forwarded-for": client },
        payload: JSON.stringify(validReport),
      });
    expect((await spoof("192.0.2.1")).statusCode).toBe(202);
    expect((await spoof("192.0.2.2")).statusCode).toBe(429);
  });

  it("defaults to a per-minute budget of thirty reports", () => {
    expect(ERROR_REPORT_RATE_LIMIT).toBe(30);
    expect(ERROR_REPORT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("forwards the full stack while the log line stays capped per field", async () => {
    const reporter: ErrorReporter = { report: vi.fn().mockResolvedValue(undefined) };
    const { app, logs } = createRelayApp({ reporter });
    const frames = Array.from(
      { length: 150 },
      (_value, index) =>
        `    at frame${index} (https://opentag.example/assets/very/long/path/to/module-${index}.js:${index}:1)`,
    );
    const stack = ["Error: Render failed", ...frames].join("\n");
    expect(stack.length).toBeGreaterThan(STRUCTURED_ERROR_LOG_FIELD_MAX_BYTES * 2);
    expect(stack.length).toBeLessThan(ERROR_REPORT_STACK_MAX_LENGTH);

    const response = await post(app, { ...validReport, stack });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.statusCode).toBe(202);
    const forwarded = vi.mocked(reporter.report).mock.calls[0]?.[0];
    expect(forwarded?.stack).toHaveLength(stack.length);
    expect(forwarded?.stack?.endsWith(frames.at(-1) ?? "")).toBe(true);
    expect(logs()).toContain("[TRUNCATED]");
    expect(logs()).not.toContain("frame149 ");
  });

  it("answers 202 without waiting for the forward and logs a reporter that rejects", async () => {
    const held: ErrorReporter = { report: vi.fn(() => new Promise<void>(() => undefined)) };
    const { app } = createRelayApp({ reporter: held });

    const outcome = await Promise.race([
      post(app, validReport).then((response) => response.statusCode),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(outcome).toBe(202);
    expect(held.report).toHaveBeenCalledTimes(1);

    const rejecting: ErrorReporter = { report: vi.fn().mockRejectedValue(new Error("tracker unavailable")) };
    const relay = createRelayApp({ reporter: rejecting });
    const response = await post(relay.app, validReport);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.statusCode).toBe(202);
    expect(relay.logs()).toContain("Error reporter failed");
    expect(relay.logs()).toContain("tracker unavailable");
  });
});
