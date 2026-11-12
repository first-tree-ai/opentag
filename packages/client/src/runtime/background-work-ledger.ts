import { resolve } from "node:path";
import type { AgentInput, AgentRuntimeEvent } from "../agent-runtime/types.js";
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

/** What the ledger keeps of one result: enough to act on, without growing with the work's output. */
const DETAIL_MAX_CHARS = 2_000;
const MAX_ENTRIES = 32;

/**
 * `completed`, `failed` and `stopped` are facts, observed while the Provider was alive. `unknown` is a
 * `running` entry found by a later Run: its process is gone, and it may have been killed or may still be
 * alive (Claude Code's background tasks survive a SIGKILL), so it is only ever reported as unconfirmed.
 */
export type BackgroundWorkLedgerStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

export interface BackgroundWorkLedgerEntry {
  id: string;
  label: string;
  status: BackgroundWorkLedgerStatus;
  detail?: string;
  outputPath?: string;
}

/** The limit a Run stopped at: the only place a limit's kind appears, so a new kind adds a reason. */
export interface BackgroundWorkRunLimit {
  reason: string;
  at: string;
}

export interface BackgroundWorkLedgerState {
  schemaVersion: 1;
  entries: BackgroundWorkLedgerEntry[];
  runLimit?: BackgroundWorkRunLimit;
  /** A turn the Run started by itself failed after answering its input, so its work may be unfinished. */
  followUpFailure?: string;
  /** When the model quota that failed that turn is available again, if the Provider said. */
  followUpRetryAt?: string;
}

export interface BackgroundWorkLedgerStorage {
  read(): Promise<unknown>;
  write(state: BackgroundWorkLedgerState): Promise<void>;
  remove(): Promise<void>;
}

/**
 * What a Session must be told about its past Runs, kept by the Client because no Provider can be relied on
 * for it: Codex and Pi say nothing on resume, and Claude Code's `stopped` is not always true. It is written
 * from the Run's event stream and read when the next Run starts. An entry leaves only once a model turn
 * started after it ended, so a crash before that tells the next Run again; a repeat is harmless, a miss is not.
 *
 * Storage failures never reach the Run: losing this notice is better than losing the work.
 */
export class BackgroundWorkLedger {
  readonly #storage: BackgroundWorkLedgerStorage;
  readonly #onError: (error: unknown) => void;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(storage: BackgroundWorkLedgerStorage, onError: (error: unknown) => void = () => undefined) {
    this.#storage = storage;
    this.#onError = onError;
  }

  /** Follows one Run's event stream. Safe to call with every event. */
  apply(event: AgentRuntimeEvent): Promise<void> {
    if (event.type === "background_work_changed") {
      return this.#change((state) => {
        const known = new Map(state.entries.map((entry) => [entry.id, entry]));
        const listed = new Set(event.items.map((item) => item.id));
        const ended = state.entries.filter((entry) => entry.status !== "running" || !listed.has(entry.id));
        const live = event.items.map((item) => ({
          ...known.get(item.id),
          id: item.id,
          label: item.label,
          status: "running" as const,
          ...(item.outputPath ? { outputPath: item.outputPath } : {}),
        }));
        // A running entry that leaves the list without a finish frame ended without a result, such as a
        // wakeup that fired: its firing is what the Session hears, so nothing is left to report.
        return {
          ...state,
          entries: [...ended.filter((entry) => entry.status !== "running"), ...live].slice(-MAX_ENTRIES),
        };
      });
    }
    if (event.type === "background_work_finished") {
      return this.#change((state) => ({
        ...state,
        entries: state.entries.map((entry) =>
          entry.id === event.id && entry.status === "running"
            ? {
                ...entry,
                status: event.status,
                ...(event.detail ? { detail: event.detail.slice(-DETAIL_MAX_CHARS) } : {}),
                ...(event.outputPath ? { outputPath: event.outputPath } : {}),
              }
            : entry,
        ),
      }));
    }
    if (event.type === "run_completed" && event.result.followUpFailure) {
      const { code, retryAt } = event.result.followUpFailure;
      return this.#change(({ followUpRetryAt: _earlier, ...state }) => ({
        ...state,
        followUpFailure: code,
        ...(retryAt ? { followUpRetryAt: retryAt } : {}),
      }));
    }
    // Model turns are optional in the event grammar (Codex reports none), so a message counts too.
    if (event.type === "model_turn_started" || event.type === "message_started") {
      return this.#change((state) => {
        const entries = state.entries.filter((entry) => entry.status === "running");
        return { schemaVersion: 1, entries };
      });
    }
    return Promise.resolve();
  }

  /** The Run stopped at its limit. */
  recordRunLimit(limit: BackgroundWorkRunLimit): Promise<void> {
    return this.#change((state) => ({ ...state, runLimit: limit }));
  }

  /**
   * What a starting Run must read first. No Run is live at this point, so a `running` entry belongs to a
   * process that is gone: it becomes `unknown`, and leaves with the rest once a model turn starts.
   */
  async notice(): Promise<string | undefined> {
    const state = await this.#enqueue(async () => {
      const current = await this.#read();
      if (!current?.entries.some((entry) => entry.status === "running")) return current;
      const next: BackgroundWorkLedgerState = {
        ...current,
        entries: current.entries.map((entry) =>
          entry.status === "running" ? { ...entry, status: "unknown" as const } : entry,
        ),
      };
      await this.#storage.write(next);
      return next;
    });
    return state ? renderNotice(state) : undefined;
  }

  /** Puts the notice in front of a Run's input. */
  async prefix(input: AgentInput): Promise<AgentInput> {
    const notice = await this.notice();
    return notice ? { items: [{ type: "text", text: notice }, ...input.items] } : input;
  }

  #change(change: (state: BackgroundWorkLedgerState) => BackgroundWorkLedgerState): Promise<void> {
    return this.#enqueue(async () => {
      const before = (await this.#read()) ?? { schemaVersion: 1 as const, entries: [] };
      const after = change(before);
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      if (after.entries.length === 0 && !after.runLimit && !after.followUpFailure) await this.#storage.remove();
      else await this.#storage.write(after);
    });
  }

  async #read(): Promise<BackgroundWorkLedgerState | undefined> {
    const raw = await this.#storage.read();
    return raw === undefined ? undefined : parseBackgroundWorkLedgerState(raw);
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T | undefined> {
    const run = this.#tail.then(task).catch((error: unknown) => {
      this.#onError(error);
      return undefined;
    });
    this.#tail = run;
    return run;
  }
}

function renderNotice(state: BackgroundWorkLedgerState): string | undefined {
  if (state.entries.length === 0 && !state.runLimit && !state.followUpFailure) return undefined;
  const lines: string[] = [];
  if (state.followUpFailure) {
    lines.push(
      `[openTag notice] Your previous Run answered its request, but the turn that should have continued its background work failed (${state.followUpFailure}), so that work may be unfinished.${state.followUpRetryAt ? ` The model is available again at ${state.followUpRetryAt}.` : ""}`,
    );
  } else if (state.runLimit) {
    lines.push(
      `[openTag notice] Your previous Run reached ${describeLimit(state.runLimit.reason)} at ${state.runLimit.at} and was stopped. Whoever was waiting for it has been told.`,
    );
  } else {
    lines.push("[openTag notice] A previous Run left background work behind.");
  }
  if (state.entries.length > 0) {
    lines.push("Background work from that Run:", ...state.entries.map(renderEntry));
    lines.push("Do not rely on this work without checking it, and start it again if you still need it.");
  }
  return lines.join("\n");
}

function describeLimit(reason: string): string {
  return reason === "turn_timeout" ? "its duration limit" : `its limit (${reason})`;
}

function renderEntry(entry: BackgroundWorkLedgerEntry): string {
  const facts = [
    describeStatus(entry.status),
    ...(entry.detail ? [entry.detail] : []),
    ...(entry.outputPath ? [`output: ${entry.outputPath}`] : []),
  ];
  return `- ${entry.label} (${facts.join("; ")})`;
}

function describeStatus(status: BackgroundWorkLedgerStatus): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped, no result";
    case "running":
    case "unknown":
      return "status unknown: its process ended, so it may have stopped or may still be running; check with ps or its output";
  }
}

export function parseBackgroundWorkLedgerState(value: unknown): BackgroundWorkLedgerState {
  const candidate = (value ?? {}) as Partial<BackgroundWorkLedgerState>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.entries)) {
    throw new RuntimeStorageError("invalid", "Background work ledger is invalid");
  }
  return candidate as BackgroundWorkLedgerState;
}

/** The Client's ledgers: one small private file per Session, kept beside its other runtime state. */
export class BackgroundWorkLedgers {
  readonly #root: string;
  readonly #directory: string;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #ledgers = new Map<string, BackgroundWorkLedger>();

  constructor(home: string, onError?: (error: unknown) => void) {
    this.#root = resolveOpenTagHomeLayout(home).runtime;
    this.#directory = resolve(this.#root, "background-work");
    this.#onError = onError;
  }

  forSession(sessionId: string): BackgroundWorkLedger {
    const known = this.#ledgers.get(sessionId);
    if (known) return known;
    const ledger = new BackgroundWorkLedger(this.#storage(sessionId), this.#onError);
    this.#ledgers.set(sessionId, ledger);
    return ledger;
  }

  #storage(sessionId: string): BackgroundWorkLedgerStorage {
    const path = resolve(this.#directory, `${deriveRuntimeKey("session", sessionId)}.json`);
    return {
      read: async () => {
        if (!(await validatePrivateDirectory(this.#root, this.#directory))) return undefined;
        return readDurableJson(path, (value) => value);
      },
      write: async (state) => {
        await ensurePrivateDirectory(this.#root, this.#directory);
        await writeDurableJson(path, state);
      },
      remove: async () => {
        try {
          await removeDurableFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }
}
