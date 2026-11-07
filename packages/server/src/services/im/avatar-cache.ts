export const AVATAR_CACHE_TTL_MS = 30 * 60 * 1_000;
export const AVATAR_CACHE_MAX_ENTRIES = 128;
export const AVATAR_CACHE_MAX_BYTES = 16 * 1024 * 1024;

type AvatarBytes = { body: Buffer; mediaType: string };
type Entry = AvatarBytes & { expiresAt: number };

export class AvatarCache {
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;

  get(key: string): AvatarBytes | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.#entries.set(key, entry);
    this.#bytes += entry.body.byteLength;
    return { body: Buffer.from(entry.body), mediaType: entry.mediaType };
  }

  set(key: string, avatar: AvatarBytes): void {
    this.#delete(key);
    if (avatar.body.byteLength > AVATAR_CACHE_MAX_BYTES) return;
    const now = Date.now();
    for (const [entryKey, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#delete(entryKey);
    }
    while (
      this.#entries.size >= AVATAR_CACHE_MAX_ENTRIES ||
      this.#bytes + avatar.body.byteLength > AVATAR_CACHE_MAX_BYTES
    ) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.#delete(oldestKey);
    }
    this.#entries.set(key, {
      body: Buffer.from(avatar.body),
      mediaType: avatar.mediaType,
      expiresAt: now + AVATAR_CACHE_TTL_MS,
    });
    this.#bytes += avatar.body.byteLength;
  }

  #delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#bytes -= entry.body.byteLength;
    this.#entries.delete(key);
  }
}
