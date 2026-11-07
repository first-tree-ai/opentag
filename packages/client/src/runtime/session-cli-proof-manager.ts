import { formatSessionRunInput, type SessionRunInput } from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import {
  ensurePrivateDirectory,
  readDurableJson,
  removeDurableFile,
  writeDurableJson,
} from "../storage/durable-file.js";
import { sessionCliProofPath, sessionCliProofRoot } from "./runtime-paths.js";

export interface StoredSessionCliProof {
  proofId: string;
  token: string;
}

/** Written beside a Session's proof, so the CLI finds it from the proof path it already has. */
export function sessionRunInputsPath(proofPath: string): string {
  return `${proofPath}.run-inputs`;
}

/**
 * The header value naming what this Session's current Run is working on, or undefined outside a tracked Run.
 * The file holds no authority: the Server only accepts inputs actually addressed to this Session, and a
 * missing or unreadable file leaves the message with an unknown initiator.
 */
export async function readSessionRunInputsHeader(proofPath: string): Promise<string | undefined> {
  const stored = await readDurableJson(sessionRunInputsPath(proofPath), parseStoredRunInputs).catch(() => undefined);
  return stored?.inputs.length ? stored.inputs.join(",") : undefined;
}

/** Tells the Session's CLI what its current Run is working on. */
export type SessionRunInputTracker = Pick<SessionCliProofManager, "addRunInput" | "beginRun" | "endRun">;

export class SessionCliProofManager {
  readonly #home: string;
  readonly #logger: Pick<ClientLogger, "warn">;
  readonly #runs = new Map<string, { runId: string; inputs: Set<string> }>();
  readonly #writes = new Map<string, Promise<void>>();

  constructor(home: string, logger: Pick<ClientLogger, "warn"> = createLogger("session-run-inputs")) {
    this.#home = home;
    this.#logger = logger;
  }

  /** Starts tracking a Run. Its retry keeps the same Run ID, so what it was already given stays on the list. */
  beginRun(sessionId: string, runId: string, inputs: readonly SessionRunInput[]): Promise<void> {
    const current = this.#runs.get(sessionId);
    const run = current?.runId === runId ? current : { runId, inputs: new Set<string>() };
    for (const input of inputs) run.inputs.add(formatSessionRunInput(input));
    this.#runs.set(sessionId, run);
    return this.#publish(sessionId);
  }

  /**
   * An input about to be steered into the running Run, kept for the rest of the Run even if the steer then
   * fails: a failure does not prove the provider never took it. A send afterwards can only lose its initiator.
   * No-op when no Run is tracked; such a send stays unprovable.
   */
  addRunInput(sessionId: string, input: SessionRunInput): Promise<void> {
    const run = this.#runs.get(sessionId);
    if (!run) return Promise.resolve();
    run.inputs.add(formatSessionRunInput(input));
    return this.#publish(sessionId);
  }

  /** Rejects like the others only so a caller can tell; nothing more runs on this list once its Run has ended. */
  endRun(sessionId: string, runId: string): Promise<void> {
    if (this.#runs.get(sessionId)?.runId !== runId) return Promise.resolve();
    this.#runs.delete(sessionId);
    return this.#publish(sessionId).catch(() => undefined);
  }

  /**
   * Writes in call order. A write that fails removes the file: no list means an unknown initiator, which is safe.
   * If the old list cannot be removed either it would read as complete, so this rejects, and the caller must
   * not start the Run or the steer.
   */
  #publish(sessionId: string): Promise<void> {
    const write = (this.#writes.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const path = sessionRunInputsPath(this.pathForSession(sessionId));
        const run = this.#runs.get(sessionId);
        try {
          if (run) {
            await ensurePrivateDirectory(this.#home, sessionCliProofRoot(this.#home));
            await writeDurableJson(path, { inputs: [...run.inputs] });
            return;
          }
        } catch (error) {
          this.#logger.warn(
            { code: "SESSION_RUN_INPUTS_WRITE_FAILED", err: error, sessionId },
            "Session Run inputs could not be written; this Run's messages will have no known initiator",
          );
        }
        await removeIfPresent(path);
      });
    this.#writes.set(sessionId, write);
    const release = () => {
      if (this.#writes.get(sessionId) === write) this.#writes.delete(sessionId);
    };
    void write.then(release, release);
    return write;
  }

  pathForSession(sessionId: string): string {
    return sessionCliProofPath(this.#home, sessionId);
  }

  async materialize(sessionId: string, proof: StoredSessionCliProof): Promise<string> {
    const parsed = parseStoredSessionCliProof(proof);
    await ensurePrivateDirectory(this.#home, sessionCliProofRoot(this.#home));
    const path = this.pathForSession(sessionId);
    const current = await readDurableJson(path, parseStoredSessionCliProof);
    if (current?.proofId !== parsed.proofId || current.token !== parsed.token) await writeDurableJson(path, parsed);
    return path;
  }

  async cleanup(sessionId: string): Promise<void> {
    this.#runs.delete(sessionId);
    await this.#publish(sessionId).catch(() => undefined);
    await removeIfPresent(this.pathForSession(sessionId));
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await removeDurableFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseStoredRunInputs(value: unknown): { inputs: string[] } {
  const inputs = (value as { inputs?: unknown } | null)?.inputs;
  if (!Array.isArray(inputs) || !inputs.every((input) => typeof input === "string")) {
    throw new Error("Invalid Session Run inputs file");
  }
  return { inputs };
}

export async function readSessionCliProofFile(path: string): Promise<StoredSessionCliProof> {
  const proof = await readDurableJson(path, parseStoredSessionCliProof);
  if (!proof) throw new Error("The OpenTag-managed Session proof file is missing");
  return proof;
}

function parseStoredSessionCliProof(value: unknown): StoredSessionCliProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Session CLI proof file");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.proofId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.proofId) ||
    typeof record.token !== "string" ||
    record.token.length < 32 ||
    record.token.length > 4096
  ) {
    throw new Error("Invalid Session CLI proof file");
  }
  return { proofId: record.proofId, token: record.token };
}
