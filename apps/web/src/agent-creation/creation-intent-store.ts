import type { AgentAdminConfig, CreateAgentRequest } from "@opentag/shared/browser";
import { browserApi } from "../api.js";

const CREATE_INTENT_VERSION = 4;
const CREATION_INTENT_KEY_PREFIX = "opentag.agent-creation.intent:";

export type CreationIntentRequest = Omit<CreateAgentRequest, "creationIntentId">;

export interface CreationIntentRecord {
  readonly version: typeof CREATE_INTENT_VERSION;
  readonly accountId: string;
  readonly creationIntentId: string;
  readonly request: CreationIntentRequest;
}

interface CreationIntentStore {
  readonly version: typeof CREATE_INTENT_VERSION;
  readonly accountId: string;
  readonly records: readonly CreationIntentRecord[];
}

/**
 * The read-only half of recovery: which exact active Agent, if any, the saved idempotency identity
 * produced. A namesake is irrelevant; only the Server's Account-scoped creation-intent record can
 * satisfy this check.
 */
export type CreationIntentCheck =
  | { readonly kind: "ambiguous" }
  | { readonly kind: "found"; readonly agentId: string }
  | { readonly kind: "not-found" };

const memoryIntentRecords = new Map<string, readonly CreationIntentRecord[]>();
const memoryIntentFallbackAccounts = new Set<string>();
const fallbackCreationLocks = new Map<string, Promise<void>>();
const creationRequests = new Map<string, Promise<AgentAdminConfig>>();

export function createAgentOnce(record: CreationIntentRecord): Promise<AgentAdminConfig> {
  const existing = creationRequests.get(record.creationIntentId);
  if (existing) return existing;
  const request = browserApi.createAgent({
    ...record.request,
    creationIntentId: record.creationIntentId,
  });
  creationRequests.set(record.creationIntentId, request);
  void request.catch(() => creationRequests.delete(record.creationIntentId));
  return request;
}

/**
 * Reconciles a saved attempt against the Server without mutating anything there. The answer names
 * the exact Agent produced by this creation identity, or says no active result exists yet.
 */
export async function checkCreationIntentResult(record: CreationIntentRecord): Promise<CreationIntentCheck> {
  return browserApi.agentCreationIntent(record.creationIntentId);
}

async function withCreationLock<T>(accountId: string, task: () => Promise<T> | T): Promise<T> {
  const lockName = `opentag:create-agent:${accountId}`;
  if (navigator.locks) return navigator.locks.request(lockName, task);
  const prior = fallbackCreationLocks.get(lockName) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  fallbackCreationLocks.set(lockName, queued);
  await prior;
  try {
    return await task();
  } finally {
    release();
    if (fallbackCreationLocks.get(lockName) === queued) fallbackCreationLocks.delete(lockName);
  }
}

export async function getOrCreateCreationIntent(
  accountId: string,
  request: CreationIntentRequest,
): Promise<CreationIntentRecord> {
  return withCreationLock(accountId, () => {
    const records = readCreationIntents(accountId);
    const fingerprint = JSON.stringify(request);
    const existing = records.find((record) => JSON.stringify(record.request) === fingerprint);
    if (existing) return existing;
    const next: CreationIntentRecord = {
      version: CREATE_INTENT_VERSION,
      accountId,
      creationIntentId: crypto.randomUUID(),
      request,
    };
    writeCreationIntents(accountId, [...records, next]);
    return next;
  });
}

export function readCreationIntent(accountId: string): CreationIntentRecord | undefined {
  return readCreationIntents(accountId).at(-1);
}

function readCreationIntents(accountId: string): readonly CreationIntentRecord[] {
  try {
    const raw = window.localStorage.getItem(creationIntentKey(accountId));
    if (!raw) {
      if (memoryIntentFallbackAccounts.has(accountId)) return memoryIntentRecords.get(accountId) ?? [];
      memoryIntentRecords.delete(accountId);
      return [];
    }
    const value = JSON.parse(raw) as Partial<CreationIntentStore>;
    if (
      value.version !== CREATE_INTENT_VERSION ||
      value.accountId !== accountId ||
      !Array.isArray(value.records) ||
      !value.records.every((record) => validCreationIntentRecord(record, accountId))
    ) {
      return [];
    }
    const records = value.records as readonly CreationIntentRecord[];
    memoryIntentRecords.set(accountId, records);
    return records;
  } catch {
    return memoryIntentRecords.get(accountId) ?? [];
  }
}

function writeCreationIntents(accountId: string, records: readonly CreationIntentRecord[]): void {
  memoryIntentRecords.set(accountId, records);
  try {
    window.localStorage.setItem(
      creationIntentKey(accountId),
      JSON.stringify({ version: CREATE_INTENT_VERSION, accountId, records } satisfies CreationIntentStore),
    );
    memoryIntentFallbackAccounts.delete(accountId);
  } catch {
    memoryIntentFallbackAccounts.add(accountId);
  }
}

export async function clearCreationIntent(accountId: string, creationIntentId: string): Promise<void> {
  await withCreationLock(accountId, () => {
    const records = readCreationIntents(accountId).filter((record) => record.creationIntentId !== creationIntentId);
    if (records.length > 0) {
      writeCreationIntents(accountId, records);
      return;
    }
    memoryIntentRecords.delete(accountId);
    memoryIntentFallbackAccounts.delete(accountId);
    try {
      window.localStorage.removeItem(creationIntentKey(accountId));
    } catch {
      // No durable record is available to clear.
    }
  });
}

function validCreationIntentRecord(value: unknown, accountId: string): value is CreationIntentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CreationIntentRecord>;
  return (
    record.version === CREATE_INTENT_VERSION &&
    record.accountId === accountId &&
    typeof record.creationIntentId === "string" &&
    record.request !== undefined &&
    typeof record.request.name === "string" &&
    typeof record.request.displayName === "string" &&
    (record.request.computerId === undefined || typeof record.request.computerId === "string") &&
    (record.request.runtimeProvider === "codex" || record.request.runtimeProvider === "claude-code")
  );
}

function creationIntentKey(accountId: string): string {
  return `${CREATION_INTENT_KEY_PREFIX}${accountId}`;
}

/**
 * Drops creation intents written in a superseded format. Their keys are never read by the current
 * Account-scoped format; removing them by stored version leaves other Accounts' current records on a
 * shared browser untouched.
 */
export function pruneSupersededCreationIntents(): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(CREATION_INTENT_KEY_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (raw === null) continue;
      let version: unknown;
      try {
        version = (JSON.parse(raw) as Partial<CreationIntentStore>).version;
      } catch {
        version = undefined;
      }
      if (version !== CREATE_INTENT_VERSION) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // Storage is unavailable; the superseded records are unreadable either way.
  }
}
