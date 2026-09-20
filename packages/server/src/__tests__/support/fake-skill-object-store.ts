import { type SkillObjectStore, SkillObjectStoreError } from "../../services/skills/skill-object-store.js";

/**
 * Deterministic in-memory double of `SkillObjectStore` with the contract semantics the tests rely
 * on: content-addressed keys, exact-byte reads, and typed `SkillObjectStoreError` failures so the
 * service's error mapping and best-effort cleanup paths are exercised for real. Instrumented with
 * call counters and injectable failures.
 */
export class FakeSkillObjectStore implements SkillObjectStore {
  readonly #objects = new Map<string, Uint8Array>();
  puts = 0;
  gets = 0;
  heads = 0;
  deletes = 0;
  failNextPutWith?: SkillObjectStoreError;
  failNextGetWith?: SkillObjectStoreError;
  failNextHeadWith?: SkillObjectStoreError;
  failNextDeleteWith?: SkillObjectStoreError;
  /**
   * One-shot gate awaited at the start of the next `delete`, before the object is removed. Lets a
   * test pause a writer between its row update and its old-object cleanup. `onPause` fires when the
   * gate is reached, `onDone` after the object is actually removed.
   */
  beforeDelete?: { promise: Promise<void>; open: () => void; onPause?: () => void; onDone?: () => void };
  /** One-shot hook awaited at the start of the next `head`, before the result is computed. */
  onHead?: () => Promise<void>;

  /** Seeds a stored object directly, bypassing the counters (fixture setup). */
  plant(key: string, body: Uint8Array): void {
    this.#objects.set(key, body.slice());
  }

  /** The raw stored bytes for assertions; undefined when nothing exists. */
  stored(key: string): Uint8Array | undefined {
    const body = this.#objects.get(key);
    return body ? body.slice() : undefined;
  }

  keys(): string[] {
    return [...this.#objects.keys()].sort();
  }

  async put(key: string, body: Uint8Array, _meta: { sha256: string }): Promise<void> {
    this.puts += 1;
    if (this.failNextPutWith) {
      const error = this.failNextPutWith;
      this.failNextPutWith = undefined;
      throw error;
    }
    this.#objects.set(key, body.slice());
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    this.gets += 1;
    if (this.failNextGetWith) {
      const error = this.failNextGetWith;
      this.failNextGetWith = undefined;
      throw error;
    }
    const body = this.#objects.get(key);
    if (!body) throw new SkillObjectStoreError("not_found", "The Skill bundle is absent");
    const bytes = body.slice();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    this.heads += 1;
    const hook = this.onHead;
    if (hook) {
      this.onHead = undefined;
      await hook();
    }
    if (this.failNextHeadWith) {
      const error = this.failNextHeadWith;
      this.failNextHeadWith = undefined;
      throw error;
    }
    const body = this.#objects.get(key);
    return body ? { bytes: body.byteLength } : null;
  }

  async delete(key: string): Promise<void> {
    this.deletes += 1;
    const gate = this.beforeDelete;
    if (gate) {
      this.beforeDelete = undefined;
      gate.onPause?.();
      await gate.promise;
    }
    if (this.failNextDeleteWith) {
      const error = this.failNextDeleteWith;
      this.failNextDeleteWith = undefined;
      throw error;
    }
    if (!this.#objects.delete(key)) {
      throw new SkillObjectStoreError("not_found", "The Skill bundle is absent");
    }
    gate?.onDone?.();
  }
}
