import { createHash } from "node:crypto";
import {
  type WorkspaceObject,
  type WorkspaceObjectScope,
  type WorkspaceObjectStore,
  WorkspaceObjectStoreError,
  type WorkspaceObjectWriteInput,
} from "../../services/sandboxes/workspace-object-store.js";

/**
 * Deterministic in-memory double of the GCS workspace object store with the contract semantics
 * the integration relies on: one latest object per storage URI, generation+metageneration
 * compare-and-swap on every mutation, first-generation-only seeding, owner fencing, terminal
 * seal, exact byte/checksum enforcement, and typed `WorkspaceObjectStoreError` failures so the
 * route/service error mapping is exercised for real. Instrumented for call counts and gates.
 */

const EMPTY_SHA256 = createHash("sha256").update(new Uint8Array(0)).digest("hex");
const EMPTY_MD5 = createHash("md5").update(new Uint8Array(0)).digest("base64");

interface StoredWorkspace {
  generation: number;
  metageneration: number;
  ownerGeneration: number;
  saved: boolean;
  sealed: boolean;
  content: Buffer;
  sha256: string;
  md5: string;
}

function snapshotOf(stored: StoredWorkspace): WorkspaceObject {
  return {
    generation: String(stored.generation),
    metageneration: String(stored.metageneration),
    ownerGeneration: stored.ownerGeneration,
    saved: stored.saved,
    sealed: stored.sealed,
    bytes: stored.content.byteLength,
    sha256: stored.sha256,
    md5: stored.md5,
  };
}

export class FakeWorkspaceObjectStore implements WorkspaceObjectStore {
  readonly #objects = new Map<string, StoredWorkspace>();
  claims = 0;
  heads = 0;
  reads = 0;
  writes: { bytes: number; sha256: string; md5: string; sealed: boolean }[] = [];
  /** When set, the next write waits on the gate before landing (concurrency simulation). */
  writeGate?: { promise: Promise<void>; open: () => void };
  failNextWriteWith?: WorkspaceObjectStoreError;
  failNextClaimWith?: WorkspaceObjectStoreError;

  /** Seed or overwrite a stored object directly (fixture setup for save/release proofs). */
  plant(
    scope: WorkspaceObjectScope,
    overrides: Partial<Omit<StoredWorkspace, "content" | "sha256" | "md5">> & { content?: Buffer } = {},
  ): WorkspaceObject {
    const content = overrides.content ?? Buffer.from("unit archive bytes");
    const stored: StoredWorkspace = {
      generation: overrides.generation ?? 7,
      metageneration: overrides.metageneration ?? 1,
      ownerGeneration: overrides.ownerGeneration ?? scope.environmentGeneration,
      saved: overrides.saved ?? true,
      sealed: overrides.sealed ?? false,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      md5: createHash("md5").update(content).digest("base64"),
    };
    this.#objects.set(scope.storageUri, stored);
    return snapshotOf(stored);
  }

  /** The raw stored record for assertions; undefined when nothing exists. */
  stored(storageUri: string): WorkspaceObject | undefined {
    const stored = this.#objects.get(storageUri);
    return stored ? snapshotOf(stored) : undefined;
  }

  /** The exact archived bytes, for download assertions. */
  storedBytes(storageUri: string): Buffer | undefined {
    return this.#objects.get(storageUri)?.content;
  }

  async claim(scope: WorkspaceObjectScope): Promise<WorkspaceObject> {
    this.claims += 1;
    if (this.failNextClaimWith) {
      const error = this.failNextClaimWith;
      this.failNextClaimWith = undefined;
      throw error;
    }
    const current = this.#objects.get(scope.storageUri);
    if (!current) {
      if (scope.environmentGeneration !== 1) {
        throw new WorkspaceObjectStoreError(
          "missing",
          "Workspace archive is absent for a non-first environment generation",
        );
      }
      const seed: StoredWorkspace = {
        generation: 1,
        metageneration: 1,
        ownerGeneration: 1,
        saved: false,
        sealed: false,
        content: Buffer.alloc(0),
        sha256: EMPTY_SHA256,
        md5: EMPTY_MD5,
      };
      this.#objects.set(scope.storageUri, seed);
      return snapshotOf(seed);
    }
    if (current.ownerGeneration > scope.environmentGeneration) {
      throw new WorkspaceObjectStoreError("stale", "Workspace is owned by a newer environment generation");
    }
    if (current.ownerGeneration === scope.environmentGeneration) return snapshotOf(current);
    current.ownerGeneration = scope.environmentGeneration;
    current.sealed = false;
    current.metageneration += 1;
    return snapshotOf(current);
  }

  async head(scope: WorkspaceObjectScope): Promise<WorkspaceObject | undefined> {
    this.heads += 1;
    const current = this.#objects.get(scope.storageUri);
    return current ? snapshotOf(current) : undefined;
  }

  async read(scope: WorkspaceObjectScope, object: WorkspaceObject): Promise<ReadableStream<Uint8Array>> {
    this.reads += 1;
    if (object.ownerGeneration !== scope.environmentGeneration) {
      throw new WorkspaceObjectStoreError("stale", "Workspace object belongs to another environment generation");
    }
    const current = this.#objects.get(scope.storageUri);
    if (!current) throw new WorkspaceObjectStoreError("missing", "Workspace archive object is absent");
    if (String(current.generation) !== object.generation || String(current.metageneration) !== object.metageneration) {
      throw new WorkspaceObjectStoreError("changed", "Workspace object changed since the claimed snapshot");
    }
    const bytes = new Uint8Array(current.content);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async write(
    scope: WorkspaceObjectScope,
    previous: WorkspaceObject,
    input: WorkspaceObjectWriteInput,
  ): Promise<WorkspaceObject> {
    if (this.writeGate) {
      const gate = this.writeGate;
      this.writeGate = undefined;
      await gate.promise;
    }
    if (this.failNextWriteWith) {
      const error = this.failNextWriteWith;
      this.failNextWriteWith = undefined;
      throw error;
    }
    if (previous.sealed) throw new WorkspaceObjectStoreError("sealed", "Workspace archive is sealed");
    if (previous.ownerGeneration !== scope.environmentGeneration) {
      throw new WorkspaceObjectStoreError("stale", "Workspace object belongs to another environment generation");
    }
    const current = this.#objects.get(scope.storageUri);
    if (!current) throw new WorkspaceObjectStoreError("missing", "Workspace archive object is absent");
    if (current.ownerGeneration !== scope.environmentGeneration) {
      throw new WorkspaceObjectStoreError("stale", "Workspace snapshot owner changed");
    }
    if (
      String(current.generation) !== previous.generation ||
      String(current.metageneration) !== previous.metageneration
    ) {
      throw new WorkspaceObjectStoreError("conflict", "Workspace object changed since the claimed snapshot");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input.body) {
      bytes += chunk.byteLength;
      if (bytes > input.bytes) {
        throw new WorkspaceObjectStoreError("invalid_input", "Workspace archive source exceeded its declared length");
      }
      chunks.push(Buffer.from(chunk));
    }
    if (bytes !== input.bytes) {
      throw new WorkspaceObjectStoreError("invalid_input", "Workspace archive source is shorter than declared");
    }
    const content = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const md5 = createHash("md5").update(content).digest("base64");
    if (sha256 !== input.sha256 || md5 !== input.md5) {
      throw new WorkspaceObjectStoreError("invalid_input", "Workspace archive checksums do not match its content");
    }
    this.writes.push({ bytes: input.bytes, sha256: input.sha256, md5: input.md5, sealed: input.sealed });
    const next: StoredWorkspace = {
      generation: current.generation + 1,
      metageneration: 1,
      ownerGeneration: scope.environmentGeneration,
      saved: true,
      sealed: input.sealed,
      content,
      sha256,
      md5,
    };
    this.#objects.set(scope.storageUri, next);
    return snapshotOf(next);
  }
}

/** Hash helpers so tests send truthful digests over the wire. */
export function workspaceDigests(content: Buffer): { bytes: number; sha256: string; md5: string } {
  return {
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    md5: createHash("md5").update(content).digest("base64"),
  };
}
