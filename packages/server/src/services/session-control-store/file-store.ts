import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { controlRecords, createControlFile, ensureControlDirectory, readControlFile } from "./private-files.js";
import {
  type ControlSource,
  ControlSourceSchema,
  type ControlWriteIntent,
  ControlWriteIntentSchema,
  type ControlWriteOutcome,
  ControlWriteOutcomeSchema,
  type ControlWriteReconciliation,
  ControlWriteReconciliationSchema,
  type ControlWriteResolution,
  controlId,
  type SessionControlStore,
  SessionControlStoreError,
  type StoredControlWrite,
} from "./types.js";

const INTENT_SUFFIX = ".intent.json";
const OUTCOME_SUFFIX = ".outcome.json";
const RECONCILE_SUFFIX = ".reconcile.json";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SessionControlStoreError("invalid_record");
  return result.data;
}
function decode<T>(schema: z.ZodType<T>, value: string): T {
  let object: unknown;
  try {
    object = JSON.parse(value);
  } catch {
    throw new SessionControlStoreError("invalid_record");
  }
  return parsed(schema, object);
}

/** Terminal view across the immutable outcome and an authoritative reconciliation record. */
function resolutionOf(
  write: Pick<StoredControlWrite, "outcome" | "reconciliation">,
): ControlWriteResolution | undefined {
  if (write.outcome?.state === "succeeded" || write.outcome?.state === "rejected") return write.outcome.state;
  if (write.reconciliation) return write.reconciliation.disposition === "applied" ? "succeeded" : "rejected";
  if (write.outcome?.state === "unknown") return "unknown";
  return undefined;
}

function outcomeMatchesReconciliation(
  outcome: ControlWriteOutcome,
  reconciliation: ControlWriteReconciliation,
): boolean {
  return reconciliation.disposition === (outcome.state === "succeeded" ? "applied" : "not_applied");
}

/**
 * Durable implementation for a private Server volume. One authoritative Server owner routes each
 * Session; atomic immutable files preserve no-replay records across restart and competing writers.
 * An `unknown` write should reconcile its resource forever through an explicit authoritative
 * `reconcileWrite` record, never by replaying the provider call. Retention/removal of a fully
 * resolved Session is an operator action on that volume, never a Sandbox action.
 */
export class FileSessionControlStore implements SessionControlStore {
  readonly #root: string;
  readonly #limit: number;
  readonly #pending = new Map<string, Promise<unknown>>();

  constructor(options: { root: string; maxRecordsPerSession?: number }) {
    this.#root = resolve(options.root);
    this.#limit = options.maxRecordsPerSession ?? 10_000;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 100_000) {
      throw new SessionControlStoreError("capacity");
    }
  }

  async #directory(sessionId: string): Promise<string> {
    await ensureControlDirectory(this.#root);
    const directory = join(this.#root, controlId(sessionId));
    await ensureControlDirectory(directory);
    return directory;
  }

  async recordSource(input: ControlSource): Promise<void> {
    const source = parsed(ControlSourceSchema, input);
    const directory = await this.#directory(source.sessionId);
    const content = JSON.stringify(source);
    const key = digest(
      JSON.stringify({ provider: source.provider, resource: source.resource, policyRevision: source.policyRevision }),
    );
    await this.#serial(source.sessionId, async () => {
      const path = join(directory, `${key}.source.json`);
      if (await readControlFile(path)) return;
      if ((await controlRecords(directory, ".source.json", this.#limit)).length >= this.#limit) {
        throw new SessionControlStoreError("capacity");
      }
      await createControlFile(path, content);
    });
  }

  async listSources(sessionId: string): Promise<ControlSource[]> {
    const directory = await this.#directory(sessionId);
    const expected = controlId(sessionId);
    const result: ControlSource[] = [];
    for (const name of await controlRecords(directory, ".source.json", this.#limit)) {
      const content = await readControlFile(join(directory, name));
      if (!content) throw new SessionControlStoreError("invalid_record");
      const source = decode(ControlSourceSchema, content);
      if (source.sessionId !== expected) throw new SessionControlStoreError("conflict");
      result.push(source);
    }
    return result;
  }

  async beginWrite(input: ControlWriteIntent): Promise<{ intentHash: string }> {
    const intent = parsed(ControlWriteIntentSchema, input);
    const directory = await this.#directory(intent.sessionId);
    const content = JSON.stringify(intent);
    return this.#serial(intent.sessionId, async () => {
      const path = join(directory, `${intent.operationId}${INTENT_SUFFIX}`);
      if (await readControlFile(path)) throw new SessionControlStoreError("already_started");
      if ((await controlRecords(directory, INTENT_SUFFIX, this.#limit)).length >= this.#limit) {
        throw new SessionControlStoreError("capacity");
      }
      // Unresolved writes to the same resource require authoritative reconciliation, never replay.
      for (const unresolved of await this.listUnresolvedWrites(intent.sessionId)) {
        if (unresolved.intent.provider === intent.provider && unresolved.intent.resource === intent.resource) {
          throw new SessionControlStoreError("conflict");
        }
      }
      if (!(await createControlFile(path, content))) throw new SessionControlStoreError("already_started");
      return { intentHash: digest(content) };
    });
  }

  async completeWrite(sessionId: string, input: ControlWriteOutcome): Promise<void> {
    const outcome = parsed(ControlWriteOutcomeSchema, input);
    const directory = await this.#directory(sessionId);
    const id = controlId(outcome.operationId);
    await this.#serial(controlId(sessionId), async () => {
      const write = await this.#readWrite(directory, sessionId, id);
      if (!write || write.intentHash !== outcome.intentHash) throw new SessionControlStoreError("conflict");
      if (write.reconciliation && !outcomeMatchesReconciliation(outcome, write.reconciliation)) {
        // An authoritative reconciliation is never downgraded by a contradicting outcome.
        throw new SessionControlStoreError("conflict");
      }
      const content = JSON.stringify(outcome);
      const path = join(directory, `${id}${OUTCOME_SUFFIX}`);
      // Outcomes are append-only: an identical retry is a no-op, a different record is a conflict.
      if (!(await createControlFile(path, content)) && (await readControlFile(path)) !== content) {
        throw new SessionControlStoreError("conflict");
      }
    });
  }

  /**
   * Records an authoritative offline reconciliation for one unresolved intent. The record must
   * belong to this Session's own intent (cross-session or hash-mismatched resolution is a
   * conflict), is immutable, and never replays the provider call. A terminal outcome cannot be
   * contradicted, and a success is never downgraded.
   */
  async reconcileWrite(input: ControlWriteReconciliation): Promise<void> {
    const reconciliation = parsed(ControlWriteReconciliationSchema, input);
    const directory = await this.#directory(reconciliation.sessionId);
    const id = controlId(reconciliation.operationId);
    await this.#serial(controlId(reconciliation.sessionId), async () => {
      const write = await this.#readWrite(directory, reconciliation.sessionId, id);
      if (!write || write.intentHash !== reconciliation.intentHash) {
        throw new SessionControlStoreError("conflict");
      }
      if (
        write.outcome &&
        write.outcome.state !== "unknown" &&
        !outcomeMatchesReconciliation(write.outcome, reconciliation)
      ) {
        throw new SessionControlStoreError("conflict");
      }
      const content = JSON.stringify(reconciliation);
      const path = join(directory, `${id}${RECONCILE_SUFFIX}`);
      if (!(await createControlFile(path, content)) && (await readControlFile(path)) !== content) {
        throw new SessionControlStoreError("conflict");
      }
    });
  }

  async readWrite(sessionId: string, operationId: string): Promise<StoredControlWrite | undefined> {
    const directory = await this.#directory(sessionId);
    return this.#readWrite(directory, sessionId, controlId(operationId));
  }

  async readReconciliation(sessionId: string, operationId: string): Promise<ControlWriteReconciliation | undefined> {
    const directory = await this.#directory(sessionId);
    const expected = controlId(sessionId);
    const id = controlId(operationId);
    const content = await readControlFile(join(directory, `${id}${RECONCILE_SUFFIX}`));
    if (!content) return undefined;
    const reconciliation = decode(ControlWriteReconciliationSchema, content);
    if (reconciliation.sessionId !== expected || reconciliation.operationId !== id) {
      throw new SessionControlStoreError("conflict");
    }
    return reconciliation;
  }

  async listReconciliations(sessionId: string): Promise<ControlWriteReconciliation[]> {
    const directory = await this.#directory(sessionId);
    const expected = controlId(sessionId);
    const result: ControlWriteReconciliation[] = [];
    for (const name of await controlRecords(directory, RECONCILE_SUFFIX, this.#limit)) {
      const content = await readControlFile(join(directory, name));
      if (!content) throw new SessionControlStoreError("invalid_record");
      const reconciliation = decode(ControlWriteReconciliationSchema, content);
      if (reconciliation.sessionId !== expected) throw new SessionControlStoreError("conflict");
      result.push(reconciliation);
    }
    return result;
  }

  async listUnresolvedWrites(sessionId: string): Promise<StoredControlWrite[]> {
    const directory = await this.#directory(sessionId);
    const result: StoredControlWrite[] = [];
    for (const name of await controlRecords(directory, INTENT_SUFFIX, this.#limit)) {
      const write = await this.#readWrite(directory, sessionId, name.slice(0, -INTENT_SUFFIX.length));
      if (write && (!write.resolution || write.resolution === "unknown")) result.push(write);
    }
    return result;
  }

  async removeCompletedSession(sessionId: string): Promise<{ removed: boolean }> {
    const directory = await this.#directory(sessionId);
    return this.#serial(controlId(sessionId), async () => {
      const unresolved = await this.listUnresolvedWrites(sessionId);
      if (unresolved.length > 0) throw new SessionControlStoreError("conflict");
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new SessionControlStoreError("unsafe_storage");
      await rm(directory, { recursive: true, force: true });
      return { removed: true };
    });
  }

  async #readWrite(directory: string, sessionId: string, id: string): Promise<StoredControlWrite | undefined> {
    const intentContent = await readControlFile(join(directory, `${id}${INTENT_SUFFIX}`));
    if (!intentContent) return undefined;
    const intent = decode(ControlWriteIntentSchema, intentContent);
    if (intent.sessionId !== controlId(sessionId) || intent.operationId !== id) {
      throw new SessionControlStoreError("conflict");
    }
    const intentHash = digest(intentContent);
    const outcomeContent = await readControlFile(join(directory, `${id}${OUTCOME_SUFFIX}`));
    const outcome = outcomeContent ? decode(ControlWriteOutcomeSchema, outcomeContent) : undefined;
    if (outcome && (outcome.operationId !== id || outcome.intentHash !== intentHash)) {
      throw new SessionControlStoreError("conflict");
    }
    const reconciliationContent = await readControlFile(join(directory, `${id}${RECONCILE_SUFFIX}`));
    const reconciliation = reconciliationContent
      ? decode(ControlWriteReconciliationSchema, reconciliationContent)
      : undefined;
    if (
      reconciliation &&
      (reconciliation.sessionId !== intent.sessionId ||
        reconciliation.operationId !== id ||
        reconciliation.intentHash !== intentHash)
    ) {
      throw new SessionControlStoreError("conflict");
    }
    const write: StoredControlWrite = { intent, intentHash };
    if (outcome) write.outcome = outcome;
    if (reconciliation) write.reconciliation = reconciliation;
    const resolution = resolutionOf(write);
    if (resolution) write.resolution = resolution;
    return write;
  }

  async #serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#pending.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#pending.get(key) === current) this.#pending.delete(key);
    }
  }
}
