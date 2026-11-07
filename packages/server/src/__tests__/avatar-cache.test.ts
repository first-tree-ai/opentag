import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_CACHE_MAX_BYTES,
  AVATAR_CACHE_MAX_ENTRIES,
  AVATAR_CACHE_TTL_MS,
  AvatarCache,
} from "../services/im/avatar-cache.js";

afterEach(() => vi.useRealTimers());

function avatar(size = 1) {
  return { body: Buffer.alloc(size, 7), mediaType: "image/png" };
}

describe("bounded avatar bytes", () => {
  it("expires from insertion time even when repeatedly read", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = new AvatarCache();
    cache.set("one", avatar());
    vi.setSystemTime(Date.now() + AVATAR_CACHE_TTL_MS - 1);
    expect(cache.get("one")).toBeDefined();
    vi.setSystemTime(Date.now() + 1);
    expect(cache.get("one")).toBeUndefined();
  });

  it("evicts the least recently read entry at the entry limit, including empty bodies", () => {
    const cache = new AvatarCache();
    for (let index = 0; index < AVATAR_CACHE_MAX_ENTRIES; index += 1) cache.set(String(index), avatar(0));
    expect(cache.get("0")).toBeDefined();
    cache.set("new", avatar(0));
    expect(cache.get("1")).toBeUndefined();
    expect(cache.get("0")).toBeDefined();
    expect(cache.get("new")).toBeDefined();
  });

  it("enforces the total byte limit and accounts for replacements and reads", () => {
    const cache = new AvatarCache();
    const quarter = AVATAR_CACHE_MAX_BYTES / 4;
    for (let index = 0; index < 4; index += 1) cache.set(String(index), avatar(quarter));
    expect(cache.get("0")).toBeDefined();
    cache.set("3", avatar(1));
    cache.set("new", avatar(quarter - 1));
    expect(cache.get("1")).toBeDefined();
    cache.set("overflow", avatar(quarter));
    expect(cache.get("2")).toBeUndefined();
    expect(cache.get("0")).toBeDefined();
    expect(cache.get("3")).toBeDefined();
    expect(cache.get("new")).toBeDefined();
    expect(cache.get("overflow")).toBeDefined();
  });

  it("removes expired bytes before evicting live entries", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cache = new AvatarCache();
    cache.set("old", avatar(AVATAR_CACHE_MAX_BYTES / 2));
    vi.setSystemTime(Date.now() + 1);
    cache.set("live", avatar(AVATAR_CACHE_MAX_BYTES / 2));
    cache.get("old");
    vi.setSystemTime(Date.now() + AVATAR_CACHE_TTL_MS - 1);
    cache.set("new", avatar(AVATAR_CACHE_MAX_BYTES / 2));
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("live")).toBeDefined();
    expect(cache.get("new")).toBeDefined();
  });

  it("does not retain an entry over the total byte budget", () => {
    const cache = new AvatarCache();
    cache.set("large", avatar(AVATAR_CACHE_MAX_BYTES + 1));
    expect(cache.get("large")).toBeUndefined();
    cache.set("small", avatar());
    expect(cache.get("small")).toBeDefined();
  });

  it("owns its bytes and returns independent copies", () => {
    const cache = new AvatarCache();
    const input = avatar();
    cache.set("one", input);
    input.body.fill(8);
    const first = cache.get("one");
    expect(first?.body).toEqual(Buffer.from([7]));
    first?.body.fill(9);
    expect(cache.get("one")?.body).toEqual(Buffer.from([7]));
  });
});
