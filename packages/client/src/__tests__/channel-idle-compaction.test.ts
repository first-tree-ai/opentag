import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginChannelTurn,
  CHANNEL_IDLE_COMPACTION_MS,
  ChannelActivityStore,
  channelIdleExceeded,
  endChannelTurn,
  isChannelOutbox,
} from "../runtime/channel-idle-compaction.js";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();

describe("channelIdleExceeded", () => {
  it("is 8 hours", () => {
    expect(CHANNEL_IDLE_COMPACTION_MS).toBe(8 * 60 * 60 * 1000);
  });

  it.each([
    ["just under the threshold", CHANNEL_IDLE_COMPACTION_MS - 1, false],
    ["exactly at the threshold", CHANNEL_IDLE_COMPACTION_MS, false],
    ["just over the threshold", CHANNEL_IDLE_COMPACTION_MS + 1, true],
    ["long past the threshold", CHANNEL_IDLE_COMPACTION_MS * 10, true],
    ["a future activity", -1000, false],
  ])("%s", (_name, idleMs, expected) => {
    expect(channelIdleExceeded(at(NOW - idleMs), NOW)).toBe(expected);
  });

  it("never compacts from an unknown or unreadable activity time", () => {
    expect(channelIdleExceeded(undefined, NOW)).toBe(false);
    expect(channelIdleExceeded("not a date", NOW)).toBe(false);
  });
});

describe("isChannelOutbox", () => {
  it("reads the Session's kind from its outbox", () => {
    expect(isChannelOutbox({ provider: "feishu", sessionKind: "channel", chatId: "oc" })).toBe(true);
    expect(isChannelOutbox({ provider: "slack", sessionKind: "channel", channelId: "C" })).toBe(true);
    expect(isChannelOutbox({ provider: "feishu", sessionKind: "thread", chatId: "oc", threadId: "omt" })).toBe(false);
    expect(isChannelOutbox(undefined)).toBe(false);
  });
});

describe("beginChannelTurn", () => {
  const activity = (idle: boolean) => ({
    beginTurn: vi.fn(async () => idle),
    recordActivity: vi.fn(async () => undefined),
  });

  it("compacts the first Turn after the idle time", async () => {
    await expect(beginChannelTurn(activity(true), { sessionId: "session", channel: true }, NOW)).resolves.toEqual({
      compactContext: true,
    });
  });

  it("does not compact a retry, but still records its activity", async () => {
    const store = activity(true);
    await expect(beginChannelTurn(store, { sessionId: "session", channel: true, retry: true }, NOW)).resolves.toEqual(
      {},
    );
    expect(store.beginTurn).toHaveBeenCalledWith("session", NOW);
  });

  it("does not track other Sessions", async () => {
    const store = activity(true);
    await expect(beginChannelTurn(store, { sessionId: "session", channel: false }, NOW)).resolves.toEqual({});
    await endChannelTurn(store, { sessionId: "session", channel: false }, NOW);
    expect(store.beginTurn).not.toHaveBeenCalled();
    expect(store.recordActivity).not.toHaveBeenCalled();
    await expect(beginChannelTurn(undefined, { sessionId: "session", channel: true }, NOW)).resolves.toEqual({});
    await expect(endChannelTurn(undefined, { sessionId: "session", channel: true }, NOW)).resolves.toBeUndefined();
  });
});

describe("ChannelActivityStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "channel-activity-"));
  });

  afterEach(async () => {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  });

  it("does not compact a Session it has never seen, and remembers it", async () => {
    const store = new ChannelActivityStore(root);
    await expect(store.beginTurn("session", NOW)).resolves.toBe(false);
    await expect(store.beginTurn("session", NOW + CHANNEL_IDLE_COMPACTION_MS + 1)).resolves.toBe(true);
  });

  it("measures idle time from the latest activity across store instances", async () => {
    const first = new ChannelActivityStore(root);
    await first.beginTurn("session", NOW);
    await first.recordActivity("session", NOW + 1000);
    const restarted = new ChannelActivityStore(root);
    await expect(restarted.beginTurn("session", NOW + 1000 + CHANNEL_IDLE_COMPACTION_MS)).resolves.toBe(false);
  });

  it("fences a second Turn right after a compacting one", async () => {
    const store = new ChannelActivityStore(root);
    await store.recordActivity("session", NOW);
    const later = NOW + CHANNEL_IDLE_COMPACTION_MS + 1;
    await expect(store.beginTurn("session", later)).resolves.toBe(true);
    await expect(store.beginTurn("session", later + 1)).resolves.toBe(false);
  });

  it("keeps Sessions apart", async () => {
    const store = new ChannelActivityStore(root);
    await store.recordActivity("one", NOW);
    await expect(store.beginTurn("two", NOW + CHANNEL_IDLE_COMPACTION_MS + 1)).resolves.toBe(false);
  });

  it("runs the Turn without compaction when storage fails", async () => {
    await chmod(root, 0o500);
    const store = new ChannelActivityStore(root);
    await expect(store.beginTurn("session", NOW)).resolves.toBe(false);
    await expect(store.recordActivity("session", NOW)).resolves.toBeUndefined();
  });
});
