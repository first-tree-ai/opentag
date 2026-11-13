import { performance } from "node:perf_hooks";
import { createPiDiagnosticStderrWriter } from "../observability/pi-diagnostics.js";

export type RunnerPerformanceOperation =
  | "runner.native_sandbox.start"
  | "runner.native_sandbox.probe"
  | "runner.native_sandbox.reset"
  | "runner.boot.ready"
  | "runner.connection.auth"
  | "runner.connection.rebind"
  | "runner.workspace.claim"
  | "runner.workspace.restore"
  | "runner.workspace.save"
  | "runner.workspace.seal";

export interface RunnerPerformanceMetrics {
  readonly sandboxName?: string;
  readonly requestId?: string;
  readonly connectionOutcome?:
    | "welcomed"
    | "closed"
    | "auth_failed"
    | "auth_timeout"
    | "renewed"
    | "bound"
    | "unchanged"
    | "refused";
  readonly sandboxId?: string;
  readonly sessionId?: string;
  readonly environmentGeneration?: number;
  readonly runnerVersion?: string;
  readonly launchDurationMs?: number;
  readonly probeDurationMs?: number;
  readonly wsOpenDurationMs?: number;
  readonly authRoundTripMs?: number;
  readonly reason?: "initial_restore_fence" | "initial_empty_workspace";
  readonly archiveBytes?: number;
  readonly downloadMs?: number;
  readonly extractMs?: number;
  readonly fingerprintMs?: number;
  readonly packMs?: number;
  readonly uploadMs?: number;
  readonly commitVerificationMs?: number;
  readonly workspaceBytes?: number;
  readonly entryCount?: number;
  readonly workspaceGeneration?: string;
  readonly saved?: boolean;
  readonly sealed?: boolean;
  readonly errorCode?: string;
}

export interface RunnerPerformanceLogRecord extends RunnerPerformanceMetrics {
  readonly timestamp: string;
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly message: string;
  readonly component: "runner";
  readonly module: "cloud-runner";
  readonly operation: RunnerPerformanceOperation;
  readonly runnerVersion: string;
  readonly durationMs: number;
  readonly thresholdMs: number;
  readonly slow: boolean;
  readonly outcome: "success" | "error";
}

export type RunnerPerformanceSink = (record: RunnerPerformanceLogRecord) => void;

const THRESHOLDS_MS: Readonly<Record<RunnerPerformanceOperation, number>> = {
  "runner.native_sandbox.start": 2_000,
  "runner.native_sandbox.probe": 2_000,
  "runner.native_sandbox.reset": 3_000,
  "runner.boot.ready": 5_000,
  "runner.connection.auth": 5_000,
  "runner.connection.rebind": 5_000,
  "runner.workspace.claim": 5_000,
  "runner.workspace.restore": 5_000,
  "runner.workspace.save": 5_000,
  "runner.workspace.seal": 5_000,
};

const SAFE_ERROR_CODE = /^[a-zA-Z0-9_-]{1,64}$/;

export function safeRunnerErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createRunnerPerformanceStderrSink(
  stderr: { write(line: string, callback?: (error?: Error | null) => void): unknown } | undefined,
  defaultMetrics?: () => RunnerPerformanceMetrics,
): RunnerPerformanceSink {
  const write = createPiDiagnosticStderrWriter(stderr ?? process.stderr);
  return (record) => {
    try {
      const defaults = defaultMetrics?.() ?? {};
      const merged: RunnerPerformanceLogRecord = {
        ...defaults,
        ...record,
        runnerVersion: record.runnerVersion || defaults.runnerVersion || "unknown",
      };
      write(`${JSON.stringify(merged)}\n`);
    } catch {
      // Performance logging must never alter Runner execution or state transitions.
    }
  };
}

export function emitRunnerPerformance(
  sink: RunnerPerformanceSink | undefined,
  input: {
    readonly operation: RunnerPerformanceOperation;
    readonly durationMs: number;
    readonly outcome: "success" | "error";
    readonly metrics?: RunnerPerformanceMetrics;
  },
): void {
  if (!sink) return;
  try {
    const durationMs = Math.max(0, Math.round(input.durationMs));
    const thresholdMs = THRESHOLDS_MS[input.operation];
    const slow = durationMs >= thresholdMs;
    const severity = input.outcome === "error" ? "ERROR" : slow ? "WARNING" : "INFO";
    sink({
      timestamp: new Date().toISOString(),
      severity,
      message: input.operation,
      component: "runner",
      module: "cloud-runner",
      operation: input.operation,
      runnerVersion: input.metrics?.runnerVersion ?? "unknown",
      ...input.metrics,
      durationMs,
      thresholdMs,
      slow,
      outcome: input.outcome,
    });
  } catch {
    // Performance logging must never alter Runner execution or state transitions.
  }
}

export async function traceRunnerOperation<T>(
  sink: RunnerPerformanceSink | undefined,
  operation: RunnerPerformanceOperation,
  fn: (addMetrics: (metrics: RunnerPerformanceMetrics) => void) => Promise<T>,
  initialMetrics?: RunnerPerformanceMetrics,
  nowMs: () => number = () => performance.now(),
): Promise<T> {
  if (!sink) {
    return fn(() => undefined);
  }
  let startedAt = 0;
  try {
    startedAt = nowMs();
  } catch {
    startedAt = 0;
  }
  let extraMetrics: RunnerPerformanceMetrics = initialMetrics ? { ...initialMetrics } : {};
  const addMetrics = (metrics: RunnerPerformanceMetrics) => {
    try {
      extraMetrics = { ...extraMetrics, ...metrics };
    } catch {
      // Performance logging must never alter Runner execution or state transitions.
    }
  };
  try {
    const result = await fn(addMetrics);
    try {
      emitRunnerPerformance(sink, {
        operation,
        durationMs: nowMs() - startedAt,
        outcome: "success",
        metrics: extraMetrics,
      });
    } catch {
      // Performance logging must never alter Runner execution or state transitions.
    }
    return result;
  } catch (error) {
    try {
      const errorCode = safeRunnerErrorCode(error);
      emitRunnerPerformance(sink, {
        operation,
        durationMs: nowMs() - startedAt,
        outcome: "error",
        metrics: {
          ...extraMetrics,
          ...(errorCode ? { errorCode } : {}),
        },
      });
    } catch {
      // Performance logging must never replace the original operation error.
    }
    throw error;
  }
}
