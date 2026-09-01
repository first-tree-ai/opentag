import {
  readPrivateJson,
  type UpdaterAttempt,
  type UpdaterStateName,
  type UpdaterStateSnapshot,
  writePrivateJson,
} from "@opentag/client";
import { isSemVer } from "@opentag/shared";
import { resolveDaemonPaths } from "../daemon/paths.js";

const UPDATER_STATE_FILE = "updater.json";

export type UpdaterStateLoad =
  | { status: "ok"; state: UpdaterStateSnapshot }
  | { status: "missing" }
  | { status: "invalid" };

export class UpdaterStateInvalidError extends Error {
  constructor() {
    super("The daemon updater state is invalid; run the CLI upgrade command to repair it manually");
    this.name = "UpdaterStateInvalidError";
  }
}

function updaterStateRelativePath(home: string): string {
  const paths = resolveDaemonPaths(home);
  return `${paths.daemonState.slice(paths.home.length + 1)}/${UPDATER_STATE_FILE}`;
}

/** Read the durable updater state. Missing is normal; malformed is never silently rewritten. */
export async function readUpdaterState(home: string): Promise<UpdaterStateLoad> {
  let parsed: unknown;
  try {
    parsed = await readPrivateJson(home, updaterStateRelativePath(home), (value) => value);
  } catch {
    return { status: "invalid" };
  }
  if (parsed === undefined) return { status: "missing" };
  try {
    return { status: "ok", state: parseUpdaterState(parsed) };
  } catch {
    return { status: "invalid" };
  }
}

export async function writeUpdaterState(home: string, state: UpdaterStateSnapshot): Promise<void> {
  await writePrivateJson(home, updaterStateRelativePath(home), state);
}

/**
 * State store for the daemon UpdateManager. An invalid state file fails closed: the manager refuses
 * to auto-install rather than guess at attempt history and risk a retry storm.
 */
export function createUpdaterStateStore(home: string): {
  loadState(): Promise<UpdaterStateSnapshot | undefined>;
  saveState(state: UpdaterStateSnapshot): Promise<void>;
} {
  return {
    async loadState() {
      const loaded = await readUpdaterState(home);
      if (loaded.status === "missing") return undefined;
      if (loaded.status === "invalid") throw new UpdaterStateInvalidError();
      return loaded.state;
    },
    saveState: (state) => writeUpdaterState(home, state),
  };
}

const STATE_NAMES: readonly UpdaterStateName[] = [
  "idle",
  "awaiting_protected_work",
  "installing",
  "blocked",
  "installed",
];

function stateRecord(value: unknown, label = "state"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`malformed updater ${label}`);
  return value as Record<string, unknown>;
}

function semVerString(value: unknown, label = "state"): string {
  if (typeof value !== "string" || !isSemVer(value)) throw new Error(`malformed updater ${label}`);
  return value;
}

function optionalString(value: unknown, label = "attempt"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`malformed updater ${label}`);
  return value;
}

function parseStateName(value: unknown): UpdaterStateName {
  if (typeof value !== "string" || !STATE_NAMES.includes(value as UpdaterStateName)) {
    throw new Error("malformed updater state");
  }
  return value as UpdaterStateName;
}

function parseAttempts(value: unknown): Record<string, UpdaterAttempt> {
  const record = stateRecord(value, "state");
  const attempts: Record<string, UpdaterAttempt> = {};
  for (const [version, candidate] of Object.entries(record)) {
    semVerString(version);
    const attempt = parseUpdaterAttempt(candidate);
    if (attempt.target !== version) throw new Error("malformed updater state");
    attempts[version] = attempt;
  }
  return attempts;
}

function parseUpdaterState(value: unknown): UpdaterStateSnapshot {
  const record = stateRecord(value);
  if (record.schemaVersion !== 1) throw new Error("malformed updater state");
  const currentVersion = semVerString(record.currentVersion);
  const state = parseStateName(record.state);
  const target = record.target === undefined ? undefined : semVerString(record.target);
  const attempts = parseAttempts(record.attempts);
  const lastAttempt = record.lastAttempt === undefined ? undefined : parseUpdaterAttempt(record.lastAttempt);
  return {
    schemaVersion: 1,
    currentVersion,
    state,
    ...(target ? { target } : {}),
    ...(lastAttempt ? { lastAttempt } : {}),
    attempts,
  };
}

function parseUpdaterAttempt(value: unknown): UpdaterAttempt {
  const record = stateRecord(value, "attempt");
  const target = semVerString(record.target, "attempt");
  if (typeof record.startedAt !== "string" || record.startedAt.length === 0) {
    throw new Error("malformed updater attempt");
  }
  const finishedAt = optionalString(record.finishedAt);
  if (record.result !== undefined && record.result !== "installed" && record.result !== "failed") {
    throw new Error("malformed updater attempt");
  }
  const failureReason = optionalString(record.failureReason);
  return {
    target,
    startedAt: record.startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(record.result !== undefined ? { result: record.result as "installed" | "failed" } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}
