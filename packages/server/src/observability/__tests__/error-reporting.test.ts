import type { ErrorReportRequest } from "@opentag/shared";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createErrorReporter,
  type ErrorReportingClient,
  reportedMessage,
  toReportedError,
} from "../error-reporting.js";

const occurredAt = "2026-09-11T10:00:00.000Z";

function fakeLogger() {
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { logger, resolve: () => logger as unknown as FastifyBaseLogger };
}

const webEvent: ErrorReportRequest = {
  source: "web",
  message: "Render failed",
  stack: "Error: Render failed\n    at render (app.js:1:1)",
  code: "unhandled_error",
  version: "1.2.3",
  url: "https://opentag.example/agents",
  userAgent: "Mozilla/5.0",
  occurredAt,
};

describe("createErrorReporter", () => {
  it("only announces once that reports stay in the log when no project is configured", async () => {
    const { logger, resolve } = fakeLogger();
    const reporter = createErrorReporter({ logger: resolve });

    await reporter.report(webEvent);
    await reporter.report(webEvent);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[1]).toContain("GOOGLE_CLOUD_PROJECT");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("constructs the client lazily and maps a web report onto the SDK call", async () => {
    const { resolve } = fakeLogger();
    const client: ErrorReportingClient = {
      report: vi.fn((_error, _request, callback: (error: Error | null) => void) => callback(null)),
    };
    const createClient = vi.fn(() => client);
    const reporter = createErrorReporter({ projectId: "opentag-staging", logger: resolve, createClient });
    expect(createClient).not.toHaveBeenCalled();

    await reporter.report(webEvent, { ip: "203.0.113.7" });
    await reporter.report(webEvent, { ip: "203.0.113.7" });

    expect(createClient).toHaveBeenCalledExactlyOnceWith("opentag-staging");
    expect(client.report).toHaveBeenCalledTimes(2);
    expect(client.report).toHaveBeenCalledWith(
      {
        stack: "Error: Render failed\n    at render (app.js:1:1)",
        serviceContext: { service: "opentag-web", version: "1.2.3" },
      },
      { method: "GET", url: "https://opentag.example/agents", userAgent: "Mozilla/5.0", remoteAddress: "203.0.113.7" },
      expect.any(Function),
    );
  });

  it("redacts before forwarding and never sets a user", async () => {
    const { resolve } = fakeLogger();
    const client: ErrorReportingClient = {
      report: vi.fn((_error, _request, callback: (error: Error | null) => void) => callback(null)),
    };
    const reporter = createErrorReporter({ projectId: "p", logger: resolve, createClient: () => client });

    await reporter.report({
      source: "cli",
      message: "Request failed: Authorization: Bearer opaque-token",
      code: "REQUEST_FAILED",
      version: "0.0.4",
      channel: "dev",
      command: "agent create",
      occurredAt,
    });

    const [error, request] = vi.mocked(client.report).mock.calls[0] ?? [];
    expect(JSON.stringify(error)).not.toContain("opaque-token");
    expect(error).toEqual({
      message: "Request failed: Authorization: [REDACTED]",
      filePath: "agent create",
      lineNumber: 0,
      functionName: "REQUEST_FAILED",
      serviceContext: { service: "opentag-cli", version: "0.0.4" },
    });
    expect(request).toEqual({});
    expect(error).not.toHaveProperty("user");
  });

  it("logs a warning and resolves when the SDK reports a failure or throws", async () => {
    const { logger, resolve } = fakeLogger();
    const failing: ErrorReportingClient = {
      report: vi.fn((_error, _request, callback: (error: Error | null) => void) =>
        callback(new Error("403 permission denied")),
      ),
    };
    const throwing: ErrorReportingClient = {
      report: vi.fn(() => {
        throw new Error("synchronous SDK failure");
      }),
    };

    await expect(
      createErrorReporter({ projectId: "p", logger: resolve, createClient: () => failing }).report(webEvent),
    ).resolves.toBeUndefined();
    await expect(
      createErrorReporter({ projectId: "p", logger: resolve, createClient: () => throwing }).report(webEvent),
    ).resolves.toBeUndefined();
    await expect(
      createErrorReporter({
        projectId: "p",
        logger: resolve,
        createClient: () => {
          throw new Error("no credentials");
        },
      }).report(webEvent),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      module: "error-reporting",
      source: "web",
      errorCode: "unhandled_error",
    });
  });

  it("gives up on a forward that exceeds its deadline and logs it", async () => {
    const { logger, resolve } = fakeLogger();
    const held: ErrorReportingClient = { report: vi.fn() };
    const reporter = createErrorReporter({ projectId: "p", logger: resolve, createClient: () => held, timeoutMs: 20 });

    await expect(reporter.report(webEvent)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warning = logger.warn.mock.calls[0]?.[0] as { err?: Error } | undefined;
    expect(warning?.err?.message).toContain("exceeded 20ms");
  });

  it("forwards a stack longer than a log field without truncating it", async () => {
    const { resolve } = fakeLogger();
    const client: ErrorReportingClient = {
      report: vi.fn((_error, _request, callback: (error: Error | null) => void) => callback(null)),
    };
    const reporter = createErrorReporter({ projectId: "p", logger: resolve, createClient: () => client });
    const frames = Array.from(
      { length: 150 },
      (_value, index) => `    at frame${index} (module-${index}.js:${index}:1)`,
    );
    const stack = ["Error: Render failed", ...frames].join("\n");

    await reporter.report({ ...webEvent, stack });

    const forwarded = vi.mocked(client.report).mock.calls[0]?.[0] as { stack: string };
    expect(forwarded.stack).toHaveLength(stack.length);
    expect(forwarded.stack.endsWith(frames.at(-1) ?? "")).toBe(true);
  });

  it("survives a missing logger", async () => {
    const reporter = createErrorReporter({
      projectId: "p",
      logger: () => undefined,
      createClient: () => ({
        report: () => {
          throw new Error("offline");
        },
      }),
    });
    await expect(reporter.report(webEvent)).resolves.toBeUndefined();
    await expect(createErrorReporter({ logger: () => undefined }).report(webEvent)).resolves.toBeUndefined();
  });
});

describe("reportedMessage", () => {
  it("prefers a stack that already carries the message and prepends it otherwise", () => {
    expect(reportedMessage({ source: "web", message: "boom", occurredAt })).toBe("boom");
    expect(reportedMessage({ source: "web", message: "boom", stack: "Error: boom\n    at a", occurredAt })).toBe(
      "Error: boom\n    at a",
    );
    expect(reportedMessage({ source: "web", message: "boom", stack: "render@app.js:1:1", occurredAt })).toBe(
      "boom\nrender@app.js:1:1",
    );
  });

  it("falls back to the source as a report location when nothing better exists", () => {
    expect(toReportedError({ source: "web", message: "boom", occurredAt })).toEqual({
      message: "boom",
      filePath: "web",
      lineNumber: 0,
      functionName: "unknown",
      serviceContext: { service: "opentag-web" },
    });
  });
});
