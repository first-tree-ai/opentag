import type { RuntimeCredentialProvider } from "@opentag/shared";

/**
 * Durable record of one protected provider read output (metadata only — never payloads, native
 * URLs, or tokens). Structurally compatible with the parent's `SessionControlStore.recordSource`
 * (`{sessionId, provider, resource, policyRevision, recordedAt}`), so the composition wires the
 * persistent control store directly.
 */
export interface RuntimeSourceRecord {
  sessionId: string;
  provider: RuntimeCredentialProvider;
  resource: string;
  policyRevision: string;
  recordedAt: string;
}

export interface RuntimeSourceRecorder {
  recordSource(record: RuntimeSourceRecord): Promise<void>;
}

export class RuntimeSourceRecorderUnavailableError extends Error {
  readonly code = "source_recorder_unavailable" as const;

  constructor() {
    super("Durable source recording is unavailable");
    this.name = "RuntimeSourceRecorderUnavailableError";
  }
}

/**
 * Fail-closed default for protected read outputs: without a Server-exclusive durable recorder,
 * the adapter refuses to hand out handle/stream read results rather than serving them unrecorded.
 */
export class UnavailableRuntimeSourceRecorder implements RuntimeSourceRecorder {
  recordSource(): Promise<void> {
    return Promise.reject(new RuntimeSourceRecorderUnavailableError());
  }
}
