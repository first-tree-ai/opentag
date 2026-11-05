import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type RuntimeImSteerRequest,
  RuntimeImSteerRequestSchema,
} from "@opentag/shared";
import {
  ensurePrivateDirectory,
  RuntimeStorageError,
  readDurableJson,
  removeDurableFile,
  validatePrivateDirectory,
  writeDurableJson,
} from "../storage/durable-file.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { deriveRuntimeKey } from "./runtime-paths.js";

/**
 * The recoverable interruption classes. Everything else is a non-recoverable failure and is
 * reported as before, without an automatic retry.
 *
 * - `daemon_crash`: the daemon process died mid-Run (crash, kill, power loss); found on restart.
 * - `client_shutdown`: an orderly daemon stop (restart, upgrade) cancelled the Run.
 * - `turn_timeout`: the Run reached its maximum duration.
 * - `provider_rate_limited`: the model API answered HTTP 429.
 */
export type InterruptionReason = "daemon_crash" | "client_shutdown" | "turn_timeout" | "provider_rate_limited";

const REASONS = new Set<InterruptionReason>([
  "daemon_crash",
  "client_shutdown",
  "turn_timeout",
  "provider_rate_limited",
]);

/** At most one automatic retry per accepted message. */
export const MAX_AUTOMATIC_RETRIES = 1;
/** A rate-limited Run waits this long before its automatic retry. */
export const RATE_LIMIT_RETRY_DELAY_MS = 30_000;

export interface Interruption {
  reason: InterruptionReason;
  /** ISO time the interruption was observed; for a crash, the time it was detected on restart. */
  at: string;
}

/** Maps a Run failure reason to a recoverable class, or undefined when it must not be retried. */
export function recoverableFailure(reason: string | undefined): InterruptionReason | undefined {
  return reason !== undefined && REASONS.has(reason as InterruptionReason) ? (reason as InterruptionReason) : undefined;
}

function describeInterruption(reason: InterruptionReason): string {
  switch (reason) {
    case "daemon_crash":
      return "the OpenTag daemon stopped unexpectedly (process crash or power loss)";
    case "client_shutdown":
      return "the OpenTag daemon was restarted or upgraded";
    case "turn_timeout":
      return "the turn reached its maximum run duration";
    case "provider_rate_limited":
      return "the model API rate-limited the request (HTTP 429)";
  }
}

/**
 * The continuation notice placed before the original input of an automatic retry. The Provider
 * may or may not have persisted the interrupted turn, so the original input always follows and
 * may duplicate history.
 */
export function buildContinuationNotice(interruption: Interruption, attempt = 1): string {
  const when = interruption.reason === "daemon_crash" ? `at or before ${interruption.at}` : `at ${interruption.at}`;
  return [
    `[OpenTag] Your previous turn was interrupted ${when} because ${describeInterruption(interruption.reason)} (automatic retry ${attempt}/${MAX_AUTOMATIC_RETRIES}).`,
    "Before continuing, check your history and the work already done in this conversation, including replies already sent, then continue the original request.",
    "The original request follows; it may duplicate a message already in your history. Do not repeat replies or side effects that already happened.",
  ].join(" ");
}

/** Durable input of one accepted IM Turn, kept until the Turn is recorded so it can be retried. */
export interface TurnRetryRecord {
  schemaVersion: 1;
  agentId: string;
  sessionId: string;
  deliveryId: string;
  turnId: string;
  request: DirectImMessageDeliveryRequest;
  /** Messages steered into this Turn, re-included on retry. */
  steers: RuntimeImSteerRequest[];
  /** Automatic retries already started for this Turn. */
  retries: number;
  /** Set when a recoverable interruption was recorded but the retry has not started yet. */
  interruption?: Interruption;
}

/** Bound on steered messages kept per Turn; further messages are not steered but queued by the Server. */
export const MAX_RECORDED_STEERS = 16;

/**
 * One small private file per Session (a Session has at most one unresolved Turn). Written when a
 * Turn is accepted, removed when its result is recorded, and listed on startup to find Turns that a
 * restart interrupted.
 */
export class TurnRetryStore {
  readonly #root: string;
  readonly #directory: string;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(home: string) {
    this.#root = resolveOpenTagHomeLayout(home).runtime;
    this.#directory = resolve(this.#root, "turn-retries");
  }

  async list(): Promise<TurnRetryRecord[]> {
    if (!(await validatePrivateDirectory(this.#root, this.#directory))) return [];
    const records: TurnRetryRecord[] = [];
    for (const name of await readdir(this.#directory)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const record = await readDurableJson(resolve(this.#directory, name), parseTurnRetryRecord).catch(() => undefined);
      if (record) records.push(record);
    }
    return records;
  }

  read(sessionId: string): Promise<TurnRetryRecord | undefined> {
    return this.#withLock(sessionId, () => this.#read(sessionId));
  }

  write(record: TurnRetryRecord): Promise<void> {
    return this.#withLock(record.sessionId, async () => {
      await ensurePrivateDirectory(this.#root, this.#directory);
      await writeDurableJson(this.#path(record.sessionId), record);
    });
  }

  /** Applies `change` to the Session's record for this Turn; no-op when it does not exist. */
  update(
    sessionId: string,
    turnId: string,
    change: (record: TurnRetryRecord) => TurnRetryRecord,
  ): Promise<TurnRetryRecord | undefined> {
    return this.#withLock(sessionId, async () => {
      const current = await this.#read(sessionId);
      if (!current || current.turnId !== turnId) return undefined;
      const next = change(current);
      await writeDurableJson(this.#path(sessionId), next);
      return next;
    });
  }

  /**
   * Add a steered message to its Turn's retry input before the steer is acknowledged. `full` and
   * `missing` mean it was not captured, so the caller must not acknowledge the steer; storage errors
   * reject. A message that was already captured counts as appended.
   */
  async appendSteer(request: RuntimeImSteerRequest): Promise<"appended" | "full" | "missing"> {
    let outcome: "appended" | "full" = "appended";
    const record = await this.update(request.sessionId, request.expectedTurnId, (current) => {
      if (current.steers.some((steer) => steer.deliveryId === request.deliveryId)) return current;
      if (current.steers.length >= MAX_RECORDED_STEERS) {
        outcome = "full";
        return current;
      }
      return { ...current, steers: [...current.steers, request] };
    });
    return record ? outcome : "missing";
  }

  /** Drop a captured steer that was not acknowledged (best effort; receipts filter it anyway). */
  async removeSteer(request: RuntimeImSteerRequest): Promise<void> {
    await this.update(request.sessionId, request.expectedTurnId, (current) => ({
      ...current,
      steers: current.steers.filter((steer) => steer.deliveryId !== request.deliveryId),
    }));
  }

  remove(sessionId: string, turnId?: string): Promise<void> {
    return this.#withLock(sessionId, async () => {
      const current = await this.#read(sessionId).catch(() => undefined);
      if (turnId !== undefined && current && current.turnId !== turnId) return;
      try {
        await removeDurableFile(this.#path(sessionId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }

  async #read(sessionId: string): Promise<TurnRetryRecord | undefined> {
    if (!(await validatePrivateDirectory(this.#root, this.#directory))) return undefined;
    return readDurableJson(this.#path(sessionId), parseTurnRetryRecord);
  }

  #path(sessionId: string): string {
    return resolve(this.#directory, `${deriveRuntimeKey("session", sessionId)}.json`);
  }

  async #withLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((done) => {
      release = done;
    });
    this.#tails.set(sessionId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
    }
  }
}

export function parseTurnRetryRecord(value: unknown): TurnRetryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeStorageError("invalid", "Turn retry record is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const request = DirectImMessageDeliveryRequestSchema.parse(candidate.request);
  if (!Array.isArray(candidate.steers) || candidate.steers.length > MAX_RECORDED_STEERS) {
    throw new RuntimeStorageError("invalid", "Turn retry steers are invalid");
  }
  // Strict: a record that lost part of its input is unreadable, so the Turn is reported, not retried.
  const steers = candidate.steers.map((steer) => RuntimeImSteerRequestSchema.parse(steer));
  const interruption = candidate.interruption as Record<string, unknown> | undefined;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.agentId !== request.agentId ||
    candidate.sessionId !== request.sessionId ||
    candidate.deliveryId !== request.deliveryId ||
    typeof candidate.turnId !== "string" ||
    candidate.turnId.length === 0 ||
    !Number.isSafeInteger(candidate.retries) ||
    (candidate.retries as number) < 0 ||
    (interruption !== undefined &&
      (!REASONS.has(interruption.reason as InterruptionReason) || typeof interruption.at !== "string"))
  ) {
    throw new RuntimeStorageError("invalid", "Turn retry record is invalid");
  }
  return {
    schemaVersion: 1,
    agentId: request.agentId,
    sessionId: request.sessionId,
    deliveryId: request.deliveryId,
    turnId: candidate.turnId,
    request,
    steers,
    retries: candidate.retries as number,
    ...(interruption
      ? { interruption: { reason: interruption.reason as InterruptionReason, at: interruption.at as string } }
      : {}),
  };
}

/**
 * The captured steers that the Server settled with the root Turn: only those with a durable steer
 * receipt in the Session binding. A captured steer whose provider steer or receipt failed was answered
 * `deferred`, so the Server still owns it and the retry must not replay it. The caller must hold the
 * binding: an unreadable or missing binding says nothing about the receipts and must stop the retry.
 */
export function acknowledgedSteers(
  steers: readonly RuntimeImSteerRequest[],
  binding: { recentRecordedInputs: ReadonlyArray<{ kind: string; deliveryId: string; turnId: string }> },
): RuntimeImSteerRequest[] {
  const receipts = new Set(
    binding.recentRecordedInputs
      .filter((entry) => entry.kind === "steer")
      .map((entry) => `${entry.deliveryId}:${entry.turnId}`),
  );
  return steers.filter((steer) => receipts.has(`${steer.deliveryId}:${steer.expectedTurnId}`));
}

export function turnRetryRecord(request: DirectImMessageDeliveryRequest, turnId: string): TurnRetryRecord {
  return {
    schemaVersion: 1,
    agentId: request.agentId,
    sessionId: request.sessionId,
    deliveryId: request.deliveryId,
    turnId,
    request,
    steers: [],
    retries: 0,
  };
}
