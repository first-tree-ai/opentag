import { describe, expect, it, vi } from "vitest";
import { installProcessFatalHandlers } from "../index.js";

describe("installProcessFatalHandlers", () => {
  it("logs fatal record and exits on uncaughtException", () => {
    const fatal = vi.fn();
    const exit = vi.fn();
    const uninstall = installProcessFatalHandlers(() => ({ fatal }), exit);

    try {
      const error = new Error("simulated fatal crash");
      error.stack = "Error: simulated fatal crash\n    at test.ts:10:15";

      process.emit("uncaughtException", error);

      expect(fatal).toHaveBeenCalledTimes(1);
      const [payload, message] = fatal.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload).toMatchObject({
        origin: "uncaughtException",
        module: "process",
        operation: "server.fatal",
        outcome: "failed",
        code: "SERVER_PROCESS_FATAL",
        errorCode: "SERVER_PROCESS_FATAL",
        err: {
          type: "Error",
          message: "simulated fatal crash",
          stack: "Error: simulated fatal crash\n    at test.ts:10:15",
        },
      });
      expect(message).toBe("Server process fatal crash");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      uninstall();
    }
  });

  it("logs fatal record and exits on unhandledRejection", () => {
    const fatal = vi.fn();
    const exit = vi.fn();
    const uninstall = installProcessFatalHandlers(() => ({ fatal }), exit);

    try {
      const error = new Error("simulated unhandled rejection");

      process.emit("unhandledRejection", error, Promise.resolve());

      expect(fatal).toHaveBeenCalledTimes(1);
      const [payload, message] = fatal.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload).toMatchObject({
        origin: "unhandledRejection",
        module: "process",
        operation: "server.fatal",
        outcome: "failed",
        code: "SERVER_PROCESS_FATAL",
        errorCode: "SERVER_PROCESS_FATAL",
        err: {
          type: "Error",
          message: "simulated unhandled rejection",
        },
      });
      expect(message).toBe("Server process fatal crash");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      uninstall();
    }
  });

  it("redacts and bounds credentials in logger-present fatal handling", () => {
    const fatal = vi.fn();
    const exit = vi.fn();
    const uninstall = installProcessFatalHandlers(() => ({ fatal }), exit);

    try {
      const error = new Error("fatal crash token=SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL Bearer sk-ant-secret");
      error.stack = "Error: fatal crash token=SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL\n    at boot.ts:1:1";

      process.emit("uncaughtException", error);

      expect(fatal).toHaveBeenCalledTimes(1);
      const [payload] = fatal.mock.calls[0] as [Record<string, unknown>, string];
      const err = payload.err as Record<string, unknown>;
      expect(err.message).toBe("fatal crash token=[REDACTED] Bearer [REDACTED]");
      expect(err.message).not.toContain("SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL");
      expect(err.message).not.toContain("sk-ant-secret");
      expect(err.stack).not.toContain("SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL");
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      uninstall();
    }
  });

  it("redacts credentials and bounds length in stderr fallback when logger is unavailable", () => {
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const exit = vi.fn();
    const uninstall = installProcessFatalHandlers(() => undefined, exit);

    try {
      const error = new Error("stderr fatal token=SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL");
      error.stack = `Error: stderr fatal token=SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL\n${"x".repeat(10_000)}`;
      process.emit("uncaughtException", error);

      expect(stderrSpy).toHaveBeenCalled();
      expect(stderrChunks).toHaveLength(1);
      const firstStderr = stderrChunks[0] ?? "";
      const parsed = JSON.parse(firstStderr);
      expect(parsed).toMatchObject({
        level: 60,
        origin: "uncaughtException",
        module: "process",
        operation: "server.fatal",
        outcome: "failed",
        code: "SERVER_PROCESS_FATAL",
        errorCode: "SERVER_PROCESS_FATAL",
        err: {
          type: "Error",
          message: "stderr fatal token=[REDACTED]",
        },
      });
      expect(parsed.err.message).not.toContain("SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL");
      expect(parsed.err.stack).not.toContain("SYNTHETIC_BOOT_SECRET_NOT_A_CREDENTIAL");
      expect(parsed.err.stack.length).toBeLessThanOrEqual(8_192);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      stderrSpy.mockRestore();
      uninstall();
    }
  });
});
