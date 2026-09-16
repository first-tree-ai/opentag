import { describe, expect, it } from "vitest";
import {
  AccountSandboxRunnerAcceptanceRequestSchema,
  RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES,
  RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES,
  RunnerAcceptanceRunFrameSchema,
  RunnerPiConfigInputSchema,
  serializeRunnerAcceptanceWorkerStdin,
} from "../cloud-runner.js";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** The frame shape the Server dispatches after the HTTP request was accepted. */
function runFrame(piConfig: { authJson: string; modelsJson?: string; settingsJson?: string }) {
  return {
    type: "acceptance:run" as const,
    requestId: "f".repeat(36),
    mode: "real" as const,
    deadlineAtMs: 1_800_000_000_000,
    piConfig,
  };
}

describe("Runner Pi config wire bounds", () => {
  it("bounds each document by UTF-8 bytes even when the character limit would pass", () => {
    const ascii = JSON.stringify({ token: "a".repeat(30_000) });
    expect(utf8Bytes(ascii)).toBeLessThanOrEqual(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    expect(RunnerPiConfigInputSchema.safeParse({ authJson: ascii }).success).toBe(true);

    // 11,012 characters (under the 32K character bound) but 33,012 UTF-8 bytes.
    const nonAscii = JSON.stringify({ token: "密钥".repeat(5_500) });
    expect(nonAscii.length).toBeLessThan(32 * 1024);
    expect(utf8Bytes(nonAscii)).toBeGreaterThan(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    expect(RunnerPiConfigInputSchema.safeParse({ authJson: nonAscii }).success).toBe(false);
  });

  it("bounds the JSON-serialized aggregate including escaping overhead before dispatch", () => {
    // Valid JSON strings: every backslash doubles when the worker stdin document is serialized,
    // so each document passes the per-document bounds while the aggregate does not.
    const escapeHeavy = JSON.stringify("\\".repeat(16_000));
    expect(escapeHeavy.length).toBeLessThanOrEqual(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    expect(JSON.parse(escapeHeavy)).toHaveLength(16_000);
    const piConfig = { authJson: escapeHeavy, modelsJson: escapeHeavy, settingsJson: escapeHeavy };
    expect(RunnerPiConfigInputSchema.safeParse(piConfig).success).toBe(true);
    const serialized = serializeRunnerAcceptanceWorkerStdin({ mode: "real", piConfig });
    expect(utf8Bytes(serialized)).toBeGreaterThan(RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES);
    expect(AccountSandboxRunnerAcceptanceRequestSchema.safeParse({ mode: "real", piConfig }).success).toBe(false);
    expect(RunnerAcceptanceRunFrameSchema.safeParse(runFrame(piConfig)).success).toBe(false);
  });

  it("accepts non-ASCII and escape-heavy documents that fit every bound", () => {
    const valid = {
      authJson: JSON.stringify({ token: "密钥".repeat(5_000), path: "\\tmp\\\\config" }),
      modelsJson: JSON.stringify({ providers: { deepseek: { models: ["deepseek-chat"] } } }),
      settingsJson: JSON.stringify({ defaultProvider: "deepseek" }),
    };
    expect(utf8Bytes(valid.authJson)).toBeLessThanOrEqual(RUNNER_PI_CONFIG_DOCUMENT_MAX_BYTES);
    const serialized = serializeRunnerAcceptanceWorkerStdin({ mode: "real", piConfig: valid });
    expect(utf8Bytes(serialized)).toBeLessThanOrEqual(RUNNER_ACCEPTANCE_WORKER_STDIN_MAX_BYTES);
    expect(AccountSandboxRunnerAcceptanceRequestSchema.safeParse({ mode: "real", piConfig: valid }).success).toBe(true);
    const frame = RunnerAcceptanceRunFrameSchema.safeParse(runFrame(valid));
    expect(frame.success).toBe(true);
    expect(frame.success && frame.data.piConfig?.authJson).toBe(valid.authJson);
  });

  it("serializes exactly the worker stdin document shape", () => {
    const piConfig = { authJson: JSON.stringify({ deepseek: { token: "unit" } }) };
    expect(JSON.parse(serializeRunnerAcceptanceWorkerStdin({ mode: "real", piConfig }))).toEqual({
      kind: "acceptance",
      mode: "real",
      piConfig,
    });
    expect(JSON.parse(serializeRunnerAcceptanceWorkerStdin({ mode: "offline" }))).toEqual({
      kind: "acceptance",
      mode: "offline",
    });
  });
});
