import { describe, expect, it } from "vitest";
import {
  createErrorReport,
  ERROR_REPORT_FIELD_MAX_LENGTH,
  ERROR_REPORT_MESSAGE_MAX_LENGTH,
  ERROR_REPORT_STACK_MAX_LENGTH,
  ErrorReportRequestSchema,
  sanitizeErrorReportUrl,
} from "../error-report.js";
import { HTTP_PATHS } from "../http-paths.js";

const occurredAt = "2026-09-11T10:00:00.000Z";

/** Assembled at runtime so no credential-bearing URL sits in the source tree for a scanner to find. */
function urlWithCredentials(): string {
  const url = new URL("https://opentag.example/agents/1?token=opaque#frag");
  url.username = "user";
  url.password = "pass";
  return url.toString();
}

describe("ErrorReportRequestSchema", () => {
  it("publishes the relay path under the versioned API prefix", () => {
    expect(HTTP_PATHS.errorReports).toBe("/api/v1/error-reports");
  });

  it("accepts a web report and a CLI report", () => {
    expect(
      ErrorReportRequestSchema.parse({
        source: "web",
        message: "boom",
        stack: "Error: boom\n    at render (app.js:1:1)",
        code: "unhandled_error",
        version: "1.2.3",
        environment: "production",
        url: "https://opentag.example/agents",
        userAgent: "Mozilla/5.0",
        occurredAt,
      }).source,
    ).toBe("web");
    expect(
      ErrorReportRequestSchema.parse({
        source: "cli",
        message: "boom",
        version: "0.0.4",
        channel: "dev",
        command: "agent create",
        occurredAt,
      }).command,
    ).toBe("agent create");
  });

  it("accepts the diagnostic context a web report and a CLI report each carry", () => {
    expect(
      ErrorReportRequestSchema.parse({
        source: "web",
        message: "boom",
        occurredAt,
        reportId: "6f1c2f3a-0000-4000-8000-000000000000",
        userId: "a1b2c3d4-0000-4000-8000-000000000000",
        route: "/agents/:agentId",
      }).route,
    ).toBe("/agents/:agentId");
    expect(
      ErrorReportRequestSchema.parse({
        source: "cli",
        message: "boom",
        occurredAt,
        platform: "darwin arm64 node-v24.15.0",
        computerId: "c0000000-0000-4000-8000-000000000000",
        installationId: "i0000000-0000-4000-8000-000000000000",
        agentId: "a0000000-0000-4000-8000-000000000000",
        sessionId: "s0000000-0000-4000-8000-000000000000",
        turnId: "t0000000-0000-4000-8000-000000000000",
        provider: "claude-code",
      }).provider,
    ).toBe("claude-code");
  });

  it("enforces the URL contract on parse: credentials, query, and fragment are stripped", () => {
    expect(
      ErrorReportRequestSchema.parse({ source: "web", message: "boom", url: urlWithCredentials(), occurredAt }).url,
    ).toBe("https://opentag.example/agents/1");
  });

  it.each([
    { source: "web", message: "boom", occurredAt, url: "javascript:alert(1)" },
    { source: "web", message: "boom", occurredAt, url: "not a url" },
    { source: "server", message: "boom", occurredAt },
    { source: "web", message: "", occurredAt },
    { source: "web", message: "boom", occurredAt: "yesterday" },
    { source: "web", message: "boom", occurredAt, accessToken: "opaque" },
    { source: "web", message: "boom", occurredAt, channel: "canary" },
    { source: "web", message: "boom", occurredAt, code: "9 not a code" },
    { source: "web", message: "boom", occurredAt, userId: "x".repeat(ERROR_REPORT_FIELD_MAX_LENGTH + 1) },
    { source: "cli", message: "boom", occurredAt, platform: "" },
    { source: "web", message: "x".repeat(ERROR_REPORT_MESSAGE_MAX_LENGTH + 1), occurredAt },
    { source: "web", message: "boom", stack: "x".repeat(ERROR_REPORT_STACK_MAX_LENGTH + 1), occurredAt },
  ])("rejects an invalid report: %o", (value) => {
    expect(ErrorReportRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe("sanitizeErrorReportUrl", () => {
  it("drops the query string, fragment, and credentials", () => {
    expect(sanitizeErrorReportUrl(urlWithCredentials())).toBe("https://opentag.example/agents/1");
  });

  it("rejects non-HTTP and malformed URLs", () => {
    expect(sanitizeErrorReportUrl("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeErrorReportUrl("not a url")).toBeUndefined();
  });
});

describe("createErrorReport", () => {
  it("redacts the message and stack, keeps a valid code, and strips the URL query", () => {
    const error = Object.assign(new Error("Authorization: Bearer opaque-token failed"), { code: "REQUEST_FAILED" });
    error.stack = "Error: token=opaque-stack-token\n    at run (cli.js:1:1)";
    const report = createErrorReport(error, {
      source: "web",
      version: "1.0.0",
      environment: "production",
      url: "https://opentag.example/agents?token=opaque-query",
      userAgent: "Mozilla/5.0",
      occurredAt,
    });

    expect(report).toEqual({
      source: "web",
      message: "Authorization: [REDACTED]",
      stack: "Error: token=[REDACTED]\n    at run (cli.js:1:1)",
      code: "REQUEST_FAILED",
      version: "1.0.0",
      environment: "production",
      url: "https://opentag.example/agents",
      userAgent: "Mozilla/5.0",
      occurredAt,
    });
    expect(ErrorReportRequestSchema.safeParse(report).success).toBe(true);
  });

  it("bounds oversized text and drops metadata that would fail validation", () => {
    const error = new Error("m".repeat(ERROR_REPORT_MESSAGE_MAX_LENGTH * 2));
    error.stack = "s".repeat(ERROR_REPORT_STACK_MAX_LENGTH * 2);
    const report = createErrorReport(error, {
      source: "cli",
      code: "not a valid code!",
      channel: "prod",
      command: "",
      version: undefined,
      url: "not a url",
    });

    expect(report.message.length).toBe(ERROR_REPORT_MESSAGE_MAX_LENGTH);
    expect(report.message.endsWith("...[TRUNCATED]")).toBe(true);
    expect(report.stack?.length).toBe(ERROR_REPORT_STACK_MAX_LENGTH);
    expect(report.code).toBeUndefined();
    expect(report.command).toBeUndefined();
    expect(report.url).toBeUndefined();
    expect(report.channel).toBe("prod");
    expect(Date.parse(report.occurredAt)).not.toBeNaN();
    expect(ErrorReportRequestSchema.safeParse(report).success).toBe(true);
  });

  it("carries every diagnostic field through, redacted and bounded like the rest", () => {
    const report = createErrorReport(new Error("boom"), {
      source: "cli",
      reportId: "6f1c2f3a-0000-4000-8000-000000000000",
      userId: "a1b2c3d4-0000-4000-8000-000000000000",
      platform: "darwin arm64 node-v24.15.0",
      computerId: "c0000000-0000-4000-8000-000000000000",
      installationId: "i0000000-0000-4000-8000-000000000000",
      agentId: "a0000000-0000-4000-8000-000000000000",
      sessionId: "s0000000-0000-4000-8000-000000000000",
      turnId: "t0000000-0000-4000-8000-000000000000",
      provider: "claude-code",
      route: "/agents/:agentId",
      occurredAt,
    });

    expect(report).toMatchObject({
      reportId: "6f1c2f3a-0000-4000-8000-000000000000",
      userId: "a1b2c3d4-0000-4000-8000-000000000000",
      platform: "darwin arm64 node-v24.15.0",
      computerId: "c0000000-0000-4000-8000-000000000000",
      installationId: "i0000000-0000-4000-8000-000000000000",
      agentId: "a0000000-0000-4000-8000-000000000000",
      sessionId: "s0000000-0000-4000-8000-000000000000",
      turnId: "t0000000-0000-4000-8000-000000000000",
      provider: "claude-code",
      route: "/agents/:agentId",
    });
    expect(ErrorReportRequestSchema.safeParse(report).success).toBe(true);

    const bounded = createErrorReport(new Error("boom"), {
      source: "cli",
      userId: "u".repeat(ERROR_REPORT_FIELD_MAX_LENGTH * 2),
      platform: "token=opaque-platform",
      route: "",
      occurredAt,
    });
    expect(bounded.userId?.length).toBe(ERROR_REPORT_FIELD_MAX_LENGTH);
    expect(bounded.platform).toBe("token=[REDACTED]");
    expect(bounded.route).toBeUndefined();
    expect(ErrorReportRequestSchema.safeParse(bounded).success).toBe(true);
  });

  it("describes non-Error values without inventing a stack", () => {
    expect(createErrorReport("plain failure", { source: "cli", occurredAt })).toEqual({
      source: "cli",
      message: "plain failure",
      occurredAt,
    });
    expect(createErrorReport(undefined, { source: "cli", occurredAt }).message).toBe("Unknown error");
    expect(createErrorReport(new Error(""), { source: "cli", occurredAt }).message).toBe("Error");
    expect(
      createErrorReport({ message: "object failure", stack: "at x", code: "OBJ" }, { source: "web", occurredAt }),
    ).toEqual({ source: "web", message: "object failure", stack: "at x", code: "OBJ", occurredAt });
  });
});
