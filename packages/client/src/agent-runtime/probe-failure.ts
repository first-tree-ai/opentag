import type { AgentRuntimeProbeIssue } from "./types.js";

/**
 * Spawn errnos that mean "the machine could not run the check right now", not
 * "the binary is broken or absent". These map to `temporarily_unavailable` and
 * must not advance same-Provider candidate fallback.
 */
const TRANSIENT_SPAWN_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "EAGAIN", "ENOMEM"]);

/**
 * Kill signals that mean the binary crashed deterministically — a broken or
 * incompatible native install that will fault the same way on every retry.
 * These stay binary-shaped so a later same-Provider candidate may be tried.
 * Deterministic crash signals take precedence over a generic `killed` flag.
 */
const DETERMINISTIC_CRASH_SIGNALS: ReadonlySet<string> = new Set(["SIGSEGV", "SIGABRT", "SIGILL", "SIGBUS", "SIGFPE"]);

export type ProbeFailureEvidence = {
  readonly errno?: string;
  readonly exitCode?: number | null;
  readonly signal?: string;
  readonly killed?: boolean;
};

export function readProbeFailureEvidence(error: unknown): ProbeFailureEvidence {
  if (!error || typeof error !== "object") return {};
  const err = error as NodeJS.ErrnoException & {
    errno?: unknown;
    exitCode?: unknown;
    signal?: unknown;
    killed?: unknown;
  };
  const errno =
    typeof err.errno === "string"
      ? err.errno
      : typeof err.code === "string" && err.code.startsWith("E")
        ? err.code
        : undefined;
  const exitCode =
    typeof err.exitCode === "number"
      ? err.exitCode
      : err.exitCode === null
        ? null
        : typeof err.code === "number"
          ? err.code
          : undefined;
  const signal = typeof err.signal === "string" ? err.signal : undefined;
  return {
    ...(errno ? { errno } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal ? { signal } : {}),
    ...(err.killed === true ? { killed: true } : {}),
  };
}

export function isDeterministicCrashSignal(signal: string | undefined): boolean {
  return signal !== undefined && DETERMINISTIC_CRASH_SIGNALS.has(signal);
}

export function isTransientProviderProbeFailure(error: unknown): boolean {
  const evidence = readProbeFailureEvidence(error);
  if (isDeterministicCrashSignal(evidence.signal)) return false;
  if (evidence.errno && TRANSIENT_SPAWN_CODES.has(evidence.errno)) return true;
  if (evidence.killed) return true;
  if (evidence.signal) return true;
  return false;
}

export function isBinaryShapedProviderProbeFailure(error: unknown): boolean {
  const evidence = readProbeFailureEvidence(error);
  if (isDeterministicCrashSignal(evidence.signal)) return true;
  if (isTransientProviderProbeFailure(error)) return false;
  if (typeof evidence.exitCode === "number" && evidence.exitCode !== 0) return true;
  if (typeof evidence.errno === "string") return true;
  return false;
}

export function artifactOrTransientProbeIssue(error: unknown, artifactMessage: string): AgentRuntimeProbeIssue {
  if (isTransientProviderProbeFailure(error)) {
    return { code: "temporarily_unavailable", message: artifactMessage };
  }
  return { code: "artifact_missing", message: artifactMessage };
}
