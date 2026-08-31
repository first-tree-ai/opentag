import { OpenTagApiError } from "@opentag/client";
import { CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";
import { resolveCommandContext } from "../core/command/context.js";
import {
  CommandError,
  commandExitCode,
  EXIT_CODES,
  executeCommand,
  presentCommand,
  redactSecrets,
  toCommandError,
} from "../core/command/policy.js";
import * as cliExports from "../index.js";

describe("command policy branches", () => {
  it("loads the public CLI barrel", () => {
    expect(cliExports).toHaveProperty("createProgram");
    expect(cliExports).toHaveProperty("EXIT_CODES");
  });
  it("normalizes API, validation, authentication, transport, and generic errors", () => {
    expect(
      toCommandError(
        new CommandError({ code: "KNOWN", category: "internal", retryability: "never", phase: "request" }, "known"),
      ),
    ).toBeInstanceOf(CommandError);
    expect(
      toCommandError(
        Object.assign(new Error("bad input"), {
          name: "ZodError",
          issues: [
            { path: [], message: "required" },
            { path: ["name", 0], message: "invalid" },
          ],
        }),
      ),
    ).toMatchObject({
      code: "VALIDATION_ERROR",
      category: "validation",
      phase: "validation",
    });

    const apiCases = [
      ["credential", "AUTH_INVALID_TOKEN", "auth", "authentication", "after_auth"],
      ["validation", "VALIDATION_ERROR", "validation", "validation", "never"],
      ["rate_limit", "RATE_LIMITED", "rate_limit", "request", "backoff"],
      ["transient", "SERVICE_UNAVAILABLE", "unavailable", "transport", "backoff"],
      ["deterministic", "INTERNAL_ERROR", "internal", "request", "never"],
    ] as const;
    for (const [category, code, mappedCategory, phase, retryability] of apiCases) {
      expect(toCommandError(new OpenTagApiError(code, category, "request failed", 500))).toMatchObject({
        code,
        category: mappedCategory,
        phase,
        retryability,
      });
    }

    expect(toCommandError(new Error("aborted by signal"))).toMatchObject({
      code: "INTERRUPTED",
      category: "cancelled",
    });
    expect(toCommandError(Object.assign(new Error("cancelled"), { name: "AbortError" }))).toMatchObject({
      code: "INTERRUPTED",
    });
    expect(toCommandError({ category: "validation", code: "BAD_INPUT", message: "bad" }, "request")).toMatchObject({
      category: "validation",
      phase: "validation",
    });
    expect(toCommandError({ code: "AUTH_EXPIRED", message: "token expired", requestId: "req-auth" })).toMatchObject({
      category: "auth",
      requestId: "req-auth",
    });
    expect(
      toCommandError({ category: "authentication", code: "LOGIN_REQUIRED", message: "authentication required" }),
    ).toMatchObject({ category: "auth" });
    expect(
      toCommandError({ category: "unavailable", code: "UPSTREAM_DOWN", message: "down", requestId: "req-up" }),
    ).toMatchObject({ category: "unavailable", requestId: "req-up" });
    expect(toCommandError({ category: "service-unavailable", code: "DOWN", message: "down" })).toMatchObject({
      category: "unavailable",
    });
    expect(toCommandError({ category: "transient", code: "RETRY", message: "retry" })).toMatchObject({
      category: "unavailable",
    });
    expect(toCommandError({ code: "FOO_UNAVAILABLE", message: "try later" })).toMatchObject({
      category: "unavailable",
    });
    expect(toCommandError({ code: "OTHER", message: "connection refused" })).toMatchObject({ category: "unavailable" });
    expect(toCommandError({ code: "OTHER", message: "timed out" })).toMatchObject({ category: "unavailable" });
    expect(
      toCommandError({ code: "CUSTOM", message: "internal", requestId: "req-internal" }, "provider"),
    ).toMatchObject({ category: "internal", phase: "provider", requestId: "req-internal" });
    expect(toCommandError(null)).toMatchObject({ code: "INTERNAL_ERROR", message: "null" });
    expect(toCommandError(undefined)).toMatchObject({ code: "INTERNAL_ERROR", message: "undefined" });
  });

  it("maps every documented error category to its process exit", () => {
    for (const category of [
      "validation",
      "unavailable",
      "timeout",
      "dependency",
      "cancelled",
      "auth",
      "internal",
      "authorization",
      "conflict",
      "not_found",
      "rate_limit",
      "protocol",
      "configuration",
    ] as const) {
      const error = new CommandError({ code: category, category, retryability: "never", phase: "request" }, category);
      expect(commandExitCode(error)).toBe(
        category === "validation"
          ? EXIT_CODES.usage
          : category === "unavailable" || category === "timeout" || category === "dependency"
            ? EXIT_CODES.serviceUnavailable
            : category === "cancelled"
              ? EXIT_CODES.interrupted
              : EXIT_CODES.failure,
      );
    }
  });

  it("presents formatted values and structured redacted failures", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const error = new CommandError(
      {
        code: "AUTH_INVALID_TOKEN",
        category: "auth",
        retryability: "after_auth",
        phase: "authentication",
        requestId: "req-1",
      },
      "Bearer access-secret",
    );
    expect(
      presentCommand(
        { ok: false, error, exitCode: EXIT_CODES.failure },
        { json: true, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      ),
    ).toBe(1);
    expect(JSON.parse(stderr[0] ?? "")).toEqual({
      ok: false,
      error: {
        code: "AUTH_INVALID_TOKEN",
        category: "auth",
        retryability: "after_auth",
        phase: "authentication",
        requestId: "req-1",
        message: "Bearer [REDACTED]",
      },
    });
    const formatted: string[] = [];
    expect(
      presentCommand(
        { ok: true, value: { answer: 42 }, exitCode: 0 },
        { stdout: (value) => formatted.push(value), stderr: () => undefined, formatValue: () => "answer" },
      ),
    ).toBe(0);
    expect(formatted).toEqual(["answer\n"]);
    expect(
      presentCommand(
        { ok: true, value: "text", exitCode: 0 },
        { stdout: (value) => formatted.push(value), stderr: () => undefined },
      ),
    ).toBe(0);
    expect(
      presentCommand(
        { ok: true, value: { plain: "object" }, exitCode: 0 },
        { stdout: (value) => formatted.push(value), stderr: () => undefined },
      ),
    ).toBe(0);
  });

  it("redacts nested values, bounded collections, circular values, and connection strings", () => {
    const redacted = redactSecrets("Bearer abc authorization: secret");
    expect(redacted).toBe("Bearer [REDACTED] authorization: [REDACTED]");
    expect(redactSecrets("?access_token=abc")).toBe("?access_token=[REDACTED]");
    // Assembled at runtime so secret scanners do not flag the fixture as a credential URL.
    const connectionFixture = ["postgres:/", "user:pass@db"].join("/");
    expect(redactSecrets(connectionFixture)).toBe("postgres://[REDACTED]@db");
    const circular: Record<string, unknown> = { token: "secret", nested: { password: "secret" } };
    circular.self = circular;
    const output: string[] = [];
    presentCommand(
      { ok: true, value: circular, exitCode: 0 },
      { json: true, stdout: (value) => output.push(value), stderr: () => undefined },
    );
    expect(output[0]).toContain("[CIRCULAR]");
    expect(output[0]).not.toContain("secret");
    expect(
      presentCommand(
        { ok: true, value: new Date("2020-01-01"), exitCode: 0 },
        { json: true, stdout: (value) => output.push(value), stderr: () => undefined },
      ),
    ).toBe(0);
  });

  it("executes operations through one success and failure presentation path", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(
      executeCommand(async () => "ready", {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      }),
    ).resolves.toBe(0);
    await expect(
      executeCommand(
        async () => {
          throw { code: "SERVICE_UNAVAILABLE", message: "unavailable" };
        },
        { json: true, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      ),
    ).resolves.toBe(3);
    expect(stdout.join("\n")).toContain("ready");
    expect(stderr.join("\n")).toContain("SERVICE_UNAVAILABLE");
  });

  it("resolves detached command contexts for anonymous, server, and authenticated paths", async () => {
    const anonymous = await resolveCommandContext({ environment: { OPENTAG_HOME: "/tmp/opentag-context" } });
    expect(anonymous.home).toBe("/tmp/opentag-context");
    expect(anonymous.api).toBeUndefined();
    const server = await resolveCommandContext({ serverUrl: "https://opentag.example", environment: {} });
    expect(server.api).toBeDefined();
    await expect(resolveCommandContext({ api: {} as never, environment: {} })).rejects.toThrow(
      "both api and accessToken",
    );
    await expect(
      resolveCommandContext({ requireAuth: true, home: "/tmp/no-such-opentag-home", environment: {} }),
    ).rejects.toThrow("not logged in");
  });
});

describe("CLI process entrypoint", () => {
  it("handles successful parsing and generic errors without leaking raw details", async () => {
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      vi.resetModules();
      vi.doMock("../cli/program.js", () => ({ createProgram: () => ({ parseAsync: async () => undefined }) }));
      process.argv = ["node", "opentag"];
      await import("../cli/index.js");
      expect(process.exitCode).toBe(previousExitCode);

      vi.resetModules();
      vi.doMock("../cli/program.js", () => ({
        createProgram: () => ({
          parseAsync: async () => {
            throw new Error("Bearer private-secret");
          },
        }),
      }));
      process.argv = ["node", "opentag", "--json"];
      await import("../cli/index.js");
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[REDACTED]"));
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("private-secret"));
    } finally {
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
      vi.resetModules();
    }
  });

  it("maps Commander usage failures to exit code two", async () => {
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      process.exitCode = typeof code === "number" ? code : undefined;
      return undefined as never;
    });
    try {
      vi.resetModules();
      vi.doMock("../cli/program.js", () => ({
        createProgram: () => ({
          parseAsync: async () => {
            throw new CommanderError(1, "commander.unknownOption", "unknown");
          },
        }),
      }));
      process.argv = ["node", "opentag"];
      await import("../cli/index.js");
      expect(exit).toHaveBeenCalledWith(2);
    } finally {
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
      exit.mockRestore();
      vi.resetModules();
    }
  });
});
