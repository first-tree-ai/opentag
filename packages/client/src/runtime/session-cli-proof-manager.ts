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

export class SessionCliProofManager {
  readonly #home: string;

  constructor(home: string) {
    this.#home = home;
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
    try {
      await removeDurableFile(this.pathForSession(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
