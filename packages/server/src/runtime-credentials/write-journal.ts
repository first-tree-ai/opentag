import type { RuntimeCredentialProvider } from "@opentag/shared";

/**
 * Durable write intent/outcome port. Structurally compatible with the parent's
 * `SessionControlStore` (`beginWrite` / `completeWrite`): the composition wires the persistent
 * store per execution. Contains metadata only — never payloads, tokens, or signed URLs.
 */
export interface RuntimeWriteIntent {
  sessionId: string;
  operationId: string;
  executionId: string;
  provider: RuntimeCredentialProvider;
  resource: string;
  operation: string;
  requestHash: string;
  policyRevision: string;
  createdAt: string;
}

export interface RuntimeWriteOutcome {
  operationId: string;
  intentHash: string;
  state: "succeeded" | "rejected" | "unknown";
  resultCode: string;
  completedAt: string;
}

export interface RuntimeWriteJournal {
  beginWrite(intent: RuntimeWriteIntent): Promise<{ intentHash: string }>;
  completeWrite(sessionId: string, outcome: RuntimeWriteOutcome): Promise<void>;
}

export class RuntimeWriteJournalUnavailableError extends Error {
  readonly code = "write_journal_unavailable" as const;

  constructor() {
    super("Durable write journaling is unavailable");
    this.name = "RuntimeWriteJournalUnavailableError";
  }
}

/**
 * Fail-closed default: without a Server-exclusive durable store, write operations are rejected
 * before forwarding. Durable writes are never faked with in-memory bookkeeping.
 */
export class UnavailableRuntimeWriteJournal implements RuntimeWriteJournal {
  beginWrite(): Promise<{ intentHash: string }> {
    return Promise.reject(new RuntimeWriteJournalUnavailableError());
  }

  completeWrite(): Promise<void> {
    return Promise.reject(new RuntimeWriteJournalUnavailableError());
  }
}
