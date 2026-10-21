import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentProviderError, AgentRuntimeError, type AgentRuntimeErrorCode } from "../agent-runtime/errors.js";
import {
  createPiDiagnosticReader,
  createPiDiagnosticStderrWriter,
  createPiDiagnosticWriter,
  PI_DIAGNOSTIC_LINE_BYTES,
  PI_DIAGNOSTIC_PREFIX,
  type PiDiagnosticEvent,
  PiRunDiagnostics,
  piDiagnosticError,
} from "../observability/pi-diagnostics.js";
import { PiRpcError } from "../providers/pi/rpc-wire.js";

const context = {
  turnId: "turn-1",
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  resourceName: "instance-1",
  environmentGeneration: 1,
};
const start: PiDiagnosticEvent = { phase: "get_state", event: "start", durationMs: 0, timeoutMs: 60_000 };

describe("Cloud Pi diagnostics", () => {
  it.each(["worker", "parent"])("survives asynchronous closed-stderr errors in the %s output", async (role) => {
    for (const closed of [false, true]) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("./fixtures/pi-diagnostic-pipe.mts", import.meta.url)),
          role,
        ],
        { stdio: "pipe" },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.once("data", () => {
        if (closed) child.stderr.destroy();
        child.stdin.end("continue");
      });
      try {
        const result = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        expect(result).toEqual({ code: 0, signal: null });
        expect(stdout).toBe("survived\n");
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  });

  it("shares one asynchronous error listener across repeated diagnostic writers", () => {
    const stderr = new PassThrough();
    for (let i = 0; i < 20; i++) createPiDiagnosticStderrWriter(stderr);
    expect(stderr.listenerCount("error")).toBe(1);
    stderr.emit("error", new Error("closed"));
    const diagnostics = createPiDiagnosticWriter(createPiDiagnosticStderrWriter(stderr));
    expect(() => diagnostics.emit(start)).not.toThrow();
    stderr.destroy();
  });

  it("keeps the first failure and its duration separate from cleanup, using monotonic clocks", () => {
    let time = 10;
    const records: Readonly<Record<string, unknown>>[] = [];
    const reader = createPiDiagnosticReader(
      context,
      (record) => records.push(record),
      () => time,
    );
    const writer = createPiDiagnosticWriter(
      (line) => reader.consume(Buffer.from(line)),
      () => time,
    );
    const observer = new PiRunDiagnostics(writer.emit, () => time);
    observer.start("get_state", 60_000);
    time += 60_000;
    observer.failure(new PiRpcError("timeout", "Pi RPC request timed out: get_state"));
    observer.start("cleanup");
    time += 30;
    observer.failure(new PiRpcError("aborted", "Pi RPC is closing"), { code: null, signal: "SIGTERM" });
    writer.finish();
    reader.finish({ severity: "ERROR", stopType: "worker_exit" });
    expect(records.filter((record) => record.event === "failure")).toMatchObject([
      {
        phase: "get_state",
        durationMs: 60_000,
        primaryFailure: true,
        error: { name: "PiRpcError", errorCode: "timeout", message: "Pi RPC request timed out: get_state" },
      },
      { phase: "cleanup", durationMs: 30, primaryFailure: false, exitSignal: "SIGTERM" },
    ]);
    expect(records.at(-1)).toMatchObject({
      failurePhase: "get_state",
      originalErrorReceived: true,
      diagnosticIncomplete: false,
    });
  });

  it("distinguishes compaction wall time from the current acceptance window", () => {
    let time = 0;
    const events: PiDiagnosticEvent[] = [];
    const observer = new PiRunDiagnostics(
      (event) => events.push(event),
      () => time,
    );
    observer.start("prompt_acceptance", 60_000);
    observer.acceptanceArm();
    time = 20;
    observer.compactionStart();
    observer.acceptancePause();
    time = 100_020;
    observer.failure(new PiRpcError("aborted", "Pi RPC request was aborted"), undefined, true);
    expect(events.at(-1)).toMatchObject({
      durationMs: 100_020,
      compactionDurationMs: 100_000,
      compactionCount: 1,
      acceptanceTimerPaused: true,
      acceptanceWindowElapsedMs: 20,
      abortSource: "run_signal",
    });
    observer.compactionEnd();
    observer.acceptanceArm();
    time += 60_000;
    observer.end(undefined, "completed");
    expect(events.at(-1)).toMatchObject({
      durationMs: 160_020,
      compactionDurationMs: 100_000,
      acceptanceWindowSeq: 2,
      acceptanceWindowElapsedMs: 60_000,
      acceptanceTimerPaused: false,
      outcome: "completed",
    });
  });

  it("redacts free text and absolute paths while keeping bounded cause and code locations", () => {
    const root = Object.assign(new Error("token=secret /Users/private/input"), { code: "ENOENT" });
    root.stack = "Error: secret\n at launch (/Users/private/pi/rpc-wire.ts:12:4)\n at /Users/private/worker.mjs:21:8";
    const error = new PiRpcError("spawn", "token=secret", { cause: new Error("secret", { cause: root }) });
    const captured = piDiagnosticError(error);
    expect(captured).toMatchObject({
      name: "PiRpcError",
      errorCode: "spawn",
      messageOrigin: "omitted",
      redacted: true,
    });
    expect(captured.cause[1]).toMatchObject({
      errorCode: "ENOENT",
      stack: ["launch@rpc-wire.ts:12:4", "<frame>@worker.mjs:21:8"],
    });
    expect(JSON.stringify(captured)).not.toMatch(/secret|Users|private/);
    expect(piDiagnosticError("secret").messageOrigin).toBe("omitted");
  });

  it("preserves every runtime error code and provider startup failures without copying free text", () => {
    const codes: Record<AgentRuntimeErrorCode, true> = {
      binding_incompatible: true,
      busy: true,
      closed: true,
      configuration_invalid: true,
      close_failed: true,
      create_failed: true,
      duplicate_run_id: true,
      interaction_not_found: true,
      invalid_request: true,
      provider_unavailable: true,
      resume_failed: true,
      run_mismatch: true,
      unsupported_capability: true,
    };
    const errors = [
      ...Object.keys(codes).map(
        (code) => new AgentRuntimeError(code as AgentRuntimeErrorCode, "private runtime input"),
      ),
      new AgentProviderError("provider_start_failed", "private provider input"),
    ];
    const records: Readonly<Record<string, unknown>>[] = [];
    const reader = createPiDiagnosticReader(context, (record) => records.push(record));
    const writer = createPiDiagnosticWriter((line) => reader.consume(Buffer.from(line)));
    for (const error of errors) {
      const captured = piDiagnosticError(error);
      expect(captured).toMatchObject({ name: error.name, errorCode: error.code, messageOrigin: "omitted" });
      writer.emit({ phase: "worker_preparation", event: "failure", durationMs: 1, error: captured });
    }
    expect(records.filter((record) => record.event === "failure")).toHaveLength(errors.length);
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it("still emits the original error when stacks and cause chains exceed their bounds", () => {
    const error = new PiRpcError("timeout", "Pi RPC request timed out: get_state");
    error.stack = `PiRpcError: message\n at ${"f".repeat(500)} (/private/${"x".repeat(500)}.ts:1:2)\n${"x".repeat(100_000)}`;
    error.cause = new Error("private", { cause: new Error("private", { cause: new Error("private") }) });
    const lines: string[] = [];
    const writer = createPiDiagnosticWriter((line) => lines.push(line));
    writer.emit(start);
    writer.failure(error);
    const record = JSON.parse(lines[1]?.trim().slice(PI_DIAGNOSTIC_PREFIX.length) ?? "{}");
    expect(record).toMatchObject({
      event: "failure",
      phase: "get_state",
      error: { errorCode: "timeout", truncated: true },
    });
    expect(record.error.cause).toHaveLength(2);
    expect(Buffer.byteLength(lines[1] ?? "")).toBeLessThan(PI_DIAGNOSTIC_LINE_BYTES);
    expect(
      Buffer.byteLength(JSON.stringify({ stack: record.error.stack, cause: record.error.cause })),
    ).toBeLessThanOrEqual(2048);
  });

  it("streams split records immediately, rejects forged fields, and reports truncation", () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const reader = createPiDiagnosticReader(context, (record) => records.push(record));
    const lines: string[] = [];
    const writer = createPiDiagnosticWriter((line) => lines.push(line));
    writer.emit(start);
    const wire = lines.join("");
    reader.consume(Buffer.from(`noise containing token=secret\n${wire.slice(0, 30)}`));
    expect(records).toHaveLength(1);
    reader.consume(Buffer.from(wire.slice(30)));
    expect(records.at(-1)).toMatchObject({ phase: "get_state", turnId: context.turnId });
    const record = JSON.parse(wire.trim().slice(PI_DIAGNOSTIC_PREFIX.length));
    reader.consume(Buffer.from(`${PI_DIAGNOSTIC_PREFIX}${JSON.stringify({ ...record, seq: 2, turnId: "forged" })}\n`));
    reader.consume(
      Buffer.from(
        `${PI_DIAGNOSTIC_PREFIX}${JSON.stringify({ ...record, seq: 2, error: { ...piDiagnosticError(new Error()), message: "secret" } })}\n`,
      ),
    );
    reader.consume(Buffer.from("x".repeat(PI_DIAGNOSTIC_LINE_BYTES + 100)));
    reader.consume(Buffer.from("\n"));
    reader.consume(Buffer.from(`${PI_DIAGNOSTIC_PREFIX}{"partial":`));
    reader.finish({ severity: "ERROR", stopType: "exec_rejected" });
    expect(records.at(-1)).toMatchObject({
      phase: "get_state",
      phaseComplete: false,
      originalErrorReceived: false,
      diagnosticIncomplete: true,
    });
    expect(JSON.stringify(records)).not.toMatch(/secret|forged/);
  });

  it("reserves bounded capacity for a failure, cleanup and the parent summary", () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    let bytes = 0;
    const reader = createPiDiagnosticReader(context, (record) => records.push(record));
    const writer = createPiDiagnosticWriter((line) => {
      bytes += Buffer.byteLength(line);
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(PI_DIAGNOSTIC_LINE_BYTES);
      reader.consume(Buffer.from(line));
    });
    for (let i = 0; i < 100; i++) writer.emit(start);
    writer.failure(new PiRpcError("timeout", "Pi RPC request timed out: get_state"));
    writer.emit({ phase: "cleanup", event: "start", durationMs: 0 });
    writer.emit({ phase: "cleanup", event: "end", durationMs: 2 });
    writer.finish();
    reader.finish({ severity: "ERROR" });
    expect(records).toHaveLength(32);
    expect(bytes).toBeLessThan(64 * 1024);
    expect(records.at(-1)).toMatchObject({ originalErrorReceived: true, diagnosticIncomplete: true });
    expect(records).toContainEqual(expect.objectContaining({ phase: "get_state", event: "failure" }));
  });

  it("cannot make the caller fail when an observer or pipe throws", () => {
    const observer = new PiRunDiagnostics(() => {
      throw new Error("closed");
    });
    expect(() => observer.start("get_state")).not.toThrow();
    const writer = createPiDiagnosticWriter(() => {
      throw new Error("EPIPE");
    });
    expect(() => writer.emit(start)).not.toThrow();
    const reader = createPiDiagnosticReader(context, () => {
      throw new Error("closed");
    });
    expect(() => reader.finish({ severity: "ERROR" })).not.toThrow();
  });
});
