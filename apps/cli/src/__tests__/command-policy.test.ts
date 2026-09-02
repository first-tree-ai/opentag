import { describe, expect, it, vi } from "vitest";
import { buildChildEnvironment } from "../core/command/environment.js";
import {
  CommandError,
  type CommandResult,
  EXIT_CODES,
  presentCommand,
  toCommandError,
} from "../core/command/policy.js";

describe("CLI command result policy", () => {
  it.each([
    ["success", { category: "internal", code: "OK", retryability: "never", phase: "request" } as const, 0],
    [
      "validation",
      { category: "validation", code: "VALIDATION_ERROR", retryability: "never", phase: "validation" } as const,
      2,
    ],
    [
      "authentication",
      { category: "auth", code: "AUTH_INVALID_TOKEN", retryability: "after_auth", phase: "authentication" } as const,
      1,
    ],
    [
      "service unavailable",
      { category: "unavailable", code: "SERVICE_UNAVAILABLE", retryability: "backoff", phase: "transport" } as const,
      3,
    ],
    [
      "interrupted",
      { category: "cancelled", code: "INTERRUPTED", retryability: "never", phase: "shutdown" } as const,
      130,
    ],
  ])("presents %s with stable streams and exit code", (_name, errorFields, expectedExitCode) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result: CommandResult<string> =
      expectedExitCode === 0
        ? { ok: true, value: "ready", exitCode: 0 }
        : {
            ok: false,
            error: new CommandError(errorFields, "operation failed"),
            exitCode: expectedExitCode as 1 | 2 | 3 | 130,
          };

    const exitCode = presentCommand(result, {
      json: false,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      formatValue: (value) => value,
    });

    expect(exitCode).toBe(expectedExitCode);
    if (expectedExitCode === 0) {
      expect(stdout).toEqual(["ready\n"]);
      expect(stderr).toEqual([]);
    } else {
      expect(stdout).toEqual([]);
      expect(stderr.join("")).toContain(errorFields.code);
      expect(stderr.join("")).toContain("operation failed");
    }
  });

  it("keeps JSON output deterministic and redacts secrets", () => {
    const stdout: string[] = [];
    const result: CommandResult<{ token: string }> = { ok: true, value: { token: "access-secret" }, exitCode: 0 };
    presentCommand(result, { json: true, stdout: (value) => stdout.push(value), stderr: vi.fn() });
    expect(stdout).toEqual(['{"ok":true,"result":{"token":"[REDACTED]"}}\n']);
    expect(stdout.join(" ")).not.toContain("access-secret");
  });

  it("keeps safe partial state in the common failure envelope on stderr", () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    presentCommand(
      {
        ok: false,
        error: new CommandError(
          { category: "dependency", code: "SETUP_INCOMPLETE", retryability: "never", phase: "provider" },
          "setup needs attention",
        ),
        exitCode: 1,
        value: { connected: true, nextActions: [{ command: "opentag doctor --json", token: "access-secret" }] },
      },
      { json: true, stdout, stderr },
    );

    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: {
        code: "SETUP_INCOMPLETE",
        category: "dependency",
        retryability: "never",
        phase: "provider",
        message: "setup needs attention",
      },
      result: { connected: true, nextActions: [{ command: "opentag doctor --json", token: "[REDACTED]" }] },
    });
  });

  it("normalizes common thrown errors into the local structured shape", () => {
    expect(toCommandError(new Error("cancelled by signal"))).toMatchObject({
      code: "INTERRUPTED",
      category: "cancelled",
      retryability: "never",
      phase: "shutdown",
    });
  });
});

describe("child environment builder", () => {
  it("does not mutate the caller and passes only explicitly selected keys", () => {
    const caller = { PATH: "/bin", HOME: "/home/test", OPENTAG_HOME: "/tmp/opentag", ACCESS_TOKEN: "secret" };
    const snapshot = { ...caller };
    const child = buildChildEnvironment(caller, {
      keys: ["PATH", "OPENTAG_HOME"],
      overrides: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    });
    expect(caller).toEqual(snapshot);
    expect(child).toEqual({ PATH: "/bin", OPENTAG_HOME: "/tmp/opentag", LANG: "C", LC_ALL: "C", TZ: "UTC" });
    expect(child).not.toHaveProperty("ACCESS_TOKEN");
  });
});

describe("exit code constants", () => {
  it("documents the stable values", () => {
    expect(EXIT_CODES).toEqual({ success: 0, failure: 1, usage: 2, serviceUnavailable: 3, interrupted: 130 });
  });
});
