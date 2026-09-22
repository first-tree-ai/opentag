import { EventEmitter } from "node:events";
import { ErrorReportRequestSchema } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClientErrorReport,
  CLIENT_ERROR_REPORT_TIMEOUT_MS,
  installProcessErrorReporting,
  reportClientError,
} from "../observability/error-reporting.js";
import type { ClientLogger } from "../observability/logger.js";

function recordingLogger() {
  const entries: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const logger: ClientLogger = {
    child: () => logger,
    debug: (fields, message) => entries.push({ level: "debug", fields: { ...fields }, message }),
    error: (fields, message) => entries.push({ level: "error", fields: { ...fields }, message }),
    info: (fields, message) => entries.push({ level: "info", fields: { ...fields }, message }),
    warn: (fields, message) => entries.push({ level: "warn", fields: { ...fields }, message }),
  };
  return { entries, logger };
}

const metadata = { version: "0.0.4", channel: "dev" as const, command: "agent create" };

describe("reportClientError", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts a redacted CLI report to the relay and reports success", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const error = Object.assign(new Error("Request failed: Authorization: Bearer opaque-token"), {
      code: "REQUEST_FAILED",
    });

    const result = await reportClientError({
      serverUrl: "https://opentag.example",
      error,
      fetchImpl,
      ...metadata,
      occurredAt: "2026-09-11T10:00:00.000Z",
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://opentag.example/api/v1/error-reports");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(String(init?.body));
    expect(ErrorReportRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      source: "cli",
      message: "Request failed: Authorization: [REDACTED]",
      code: "REQUEST_FAILED",
      version: "0.0.4",
      channel: "dev",
      command: "agent create",
      occurredAt: "2026-09-11T10:00:00.000Z",
    });
    expect(String(init?.body)).not.toContain("opaque-token");
    expect(body.stack).toContain("Error: Request failed");
  });

  it("reports a rejected relay response, a network failure, and an invalid server URL without throwing", async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"));
    const unused = vi.fn<typeof fetch>();

    await expect(
      reportClientError({
        serverUrl: "https://opentag.example",
        error: new Error("x"),
        fetchImpl: rejected,
        ...metadata,
      }),
    ).resolves.toEqual({ ok: false });
    await expect(
      reportClientError({
        serverUrl: "https://opentag.example",
        error: new Error("x"),
        fetchImpl: offline,
        ...metadata,
      }),
    ).resolves.toEqual({ ok: false });
    await expect(
      reportClientError({ serverUrl: "not a url", error: new Error("x"), fetchImpl: unused, ...metadata }),
    ).resolves.toEqual({ ok: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it("aborts a relay call that exceeds the timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = reportClientError({
      serverUrl: "https://opentag.example",
      error: new Error("slow"),
      fetchImpl,
      ...metadata,
    });
    await vi.advanceTimersByTimeAsync(CLIENT_ERROR_REPORT_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ ok: false });
  });

  it("builds a report that redacts a token-looking value inside the message", () => {
    const report = buildClientErrorReport(new Error("login failed for token=sk-opaque-value"), metadata);

    expect(report.message).toBe("login failed for token=[REDACTED]");
    expect(report.source).toBe("cli");
    expect(report.command).toBe("agent create");
  });
});

describe("installProcessErrorReporting", () => {
  it("logs, reports, prints, and exits with code 1 on an uncaught exception", async () => {
    const target = new EventEmitter();
    const { entries, logger } = recordingLogger();
    const report = vi.fn().mockResolvedValue({ ok: true });
    const exit = vi.fn();
    const print = vi.fn();
    const uninstall = installProcessErrorReporting({ report, logger, target, exit, print, waitMs: 50 });
    const failure = Object.assign(new Error("boom token=opaque"), { code: "E_BOOM" });

    target.emit("uncaughtException", failure);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(report).toHaveBeenCalledExactlyOnceWith(failure, "uncaughtException");
    expect(print).toHaveBeenCalledExactlyOnceWith(failure);
    expect(entries).toEqual([
      {
        level: "error",
        fields: {
          origin: "uncaughtException",
          errorName: "Error",
          errorMessage: "boom token=opaque",
          errorCode: "E_BOOM",
        },
        message: "Process terminated by an unhandled failure",
      },
    ]);
    uninstall();
    expect(target.listenerCount("uncaughtException")).toBe(0);
    expect(target.listenerCount("unhandledRejection")).toBe(0);
  });

  it("does not wait longer than the deadline for a hanging report and ignores a second failure", async () => {
    const target = new EventEmitter();
    const { logger } = recordingLogger();
    const report = vi.fn(() => new Promise(() => undefined));
    const exit = vi.fn();
    const print = vi.fn();
    installProcessErrorReporting({ report, logger, target, exit, print, waitMs: 20 });

    target.emit("unhandledRejection", "plain rejection");
    target.emit("uncaughtException", new Error("second"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(report).toHaveBeenCalledExactlyOnceWith("plain rejection", "unhandledRejection");
    expect(print).toHaveBeenCalledExactlyOnceWith("plain rejection");
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("writes the crash output through stderr and exits only after it drained", async () => {
    const target = new EventEmitter();
    const { logger } = recordingLogger();
    const exit = vi.fn();
    const drained: Array<() => void> = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((_chunk: unknown, callback?: unknown) => {
      if (typeof callback === "function") drained.push(callback as () => void);
      return true;
    }) as typeof process.stderr.write);
    try {
      installProcessErrorReporting({ report: async () => undefined, logger, target, exit, waitMs: 20 });

      target.emit("uncaughtException", new Error("boom"));
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(String(write.mock.calls[0]?.[0])).toContain("Error: boom");
      expect(exit).not.toHaveBeenCalled();

      drained[0]?.();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      write.mockRestore();
    }
  });

  it("still exits when the report or the logger throws", async () => {
    const target = new EventEmitter();
    const logger: ClientLogger = {
      child: () => logger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        throw new Error("logger failed");
      },
    };
    const exit = vi.fn();
    installProcessErrorReporting({
      report: () => {
        throw new Error("report failed");
      },
      logger,
      target,
      exit,
      print: () => undefined,
      waitMs: 20,
    });

    target.emit("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
