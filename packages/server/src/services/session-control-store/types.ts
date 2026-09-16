import { z } from "zod";

const Id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Resource = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9:._/@-]+$/);
/**
 * Native provider registry operation identifier (for example `chat.postMessage`, `git.push`,
 * or `files.getUploadURLExternal`): one leading lowercase letter followed by a bounded run of
 * letters (uppercase allowed for native camelCase), digits, `_`, `.`, or `-`. It is never a URL,
 * query, whitespace, or payload carrier.
 */
const Operation = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,127}$/);
export const ControlSourceSchema = z
  .object({
    sessionId: Id,
    provider: z.enum(["github", "slack", "feishu"]),
    resource: Resource,
    policyRevision: z.string().min(1).max(256),
    recordedAt: z.string().datetime(),
  })
  .strict();
export const ControlWriteIntentSchema = z
  .object({
    sessionId: Id,
    operationId: Id,
    executionId: Id,
    provider: z.enum(["github", "slack", "feishu"]),
    resource: Resource,
    operation: Operation,
    requestHash: Digest,
    policyRevision: z.string().min(1).max(256),
    createdAt: z.string().datetime(),
  })
  .strict();
export const ControlWriteOutcomeSchema = z
  .object({
    operationId: Id,
    intentHash: Digest,
    state: z.enum(["succeeded", "rejected", "unknown"]),
    resultCode: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
    completedAt: z.string().datetime(),
  })
  .strict();

/**
 * Authoritative offline reconciliation of one unresolved intent, written by the Server owner (or
 * an operator-driven admin path) after inspecting the provider. Disposition is the authoritative
 * verdict; `evidence` is a controlled code, never free text and never provider material. Records
 * are immutable and never trigger a replay.
 */
export const ControlWriteReconciliationSchema = z
  .object({
    sessionId: Id,
    operationId: Id,
    intentHash: Digest,
    disposition: z.enum(["applied", "not_applied"]),
    evidence: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
    reconciledAt: z.string().datetime(),
  })
  .strict();
export type ControlSource = z.infer<typeof ControlSourceSchema>;
export type ControlWriteIntent = z.infer<typeof ControlWriteIntentSchema>;
export type ControlWriteOutcome = z.infer<typeof ControlWriteOutcomeSchema>;
export type ControlWriteReconciliation = z.infer<typeof ControlWriteReconciliationSchema>;

/** Terminal view: the immutable outcome when terminal, else the reconciliation, else unknown. */
export type ControlWriteResolution = "succeeded" | "rejected" | "unknown";

export interface StoredControlWrite {
  intent: ControlWriteIntent;
  intentHash: string;
  outcome?: ControlWriteOutcome;
  reconciliation?: ControlWriteReconciliation;
  /** Absent when the intent has neither a terminal outcome nor a reconciliation. */
  resolution?: ControlWriteResolution;
}

/** Server-private durable metadata. Never put payloads, provider tokens, or signed URLs here. */
export interface SessionControlStore {
  recordSource(source: ControlSource): Promise<void>;
  listSources(sessionId: string): Promise<ControlSource[]>;
  beginWrite(intent: ControlWriteIntent): Promise<{ intentHash: string }>;
  completeWrite(sessionId: string, outcome: ControlWriteOutcome): Promise<void>;
  /** Authoritatively resolves one unresolved write without replaying it. */
  reconcileWrite(reconciliation: ControlWriteReconciliation): Promise<void>;
  readWrite(sessionId: string, operationId: string): Promise<StoredControlWrite | undefined>;
  readReconciliation(sessionId: string, operationId: string): Promise<ControlWriteReconciliation | undefined>;
  listReconciliations(sessionId: string): Promise<ControlWriteReconciliation[]>;
  listUnresolvedWrites(sessionId: string): Promise<StoredControlWrite[]>;
  /**
   * Removes one session's private control records after it is fully resolved. Refuses while any
   * write is unresolved; intended for the Server owner/admin path, never a Sandbox action.
   */
  removeCompletedSession(sessionId: string): Promise<{ removed: boolean }>;
}

export class SessionControlStoreError extends Error {
  constructor(
    readonly code: "invalid_record" | "unsafe_storage" | "capacity" | "already_started" | "conflict" | "unavailable",
  ) {
    super(`Session control storage failed: ${code}`);
    this.name = "SessionControlStoreError";
  }
}

export function controlId(value: string): string {
  const parsed = Id.safeParse(value);
  if (!parsed.success) throw new SessionControlStoreError("invalid_record");
  return parsed.data;
}
