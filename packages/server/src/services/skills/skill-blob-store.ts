import { Readable } from "node:stream";

/**
 * Where canonical skill archives live. Keys are relative to whatever prefix the implementation owns; the service
 * builds them as `<owner>/<skillId>/<digest>.zip`, so an object is content-addressed and never rewritten in place.
 */
export interface SkillBlobObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface SkillBlobHead {
  size: number;
  lastModified: Date;
}

export interface OpenedSkillBlob {
  stream: Readable;
  contentLength: number;
}

export interface SkillBlobStore {
  put(key: string, bytes: Uint8Array, sha256: string): Promise<void>;
  /** Resolve `undefined` when the object does not exist. */
  open(key: string): Promise<OpenedSkillBlob | undefined>;
  /** Idempotent: deleting a missing object resolves. */
  delete(key: string): Promise<void>;
  head(key: string): Promise<SkillBlobHead | undefined>;
  list(prefix: string): Promise<SkillBlobObject[]>;
}

/** In-memory store for unit tests. `objects` is exposed so tests can assert on what was written or deleted. */
export class MemorySkillBlobStore implements SkillBlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array; sha256: string; lastModified: Date }>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async put(key: string, bytes: Uint8Array, sha256: string): Promise<void> {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), sha256, lastModified: this.#now() });
  }

  async open(key: string): Promise<OpenedSkillBlob | undefined> {
    const object = this.objects.get(key);
    if (!object) return undefined;
    return { stream: Readable.from([Buffer.from(object.bytes)]), contentLength: object.bytes.byteLength };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async head(key: string): Promise<SkillBlobHead | undefined> {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength, lastModified: object.lastModified } : undefined;
  }

  async list(prefix: string): Promise<SkillBlobObject[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, size: object.bytes.byteLength, lastModified: object.lastModified }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}
