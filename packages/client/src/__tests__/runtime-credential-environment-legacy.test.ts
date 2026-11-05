import type { RuntimeImOutboxContext } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { PreparedImCredentialEnvironment } from "../runtime/im-credential-environment-manager.js";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";

const subject = { sessionId: "session", agentId: "agent", placementGeneration: 1 };
const outbox: RuntimeImOutboxContext = {
  provider: "slack",
  sessionKind: "thread",
  channelId: "C1",
  threadTs: "1.2",
};
const prepared: PreparedImCredentialEnvironment = {
  path: "/unused/environment.sh",
  environmentManifest: "/unused/environment.json",
  provider: "slack",
  outboxContext: outbox,
};

describe("legacy execution outbox lifecycle", () => {
  it("exposes context only after materialization and withdraws it when the Turn is aborted", async () => {
    const s = system();
    const pending = deferred<PreparedImCredentialEnvironment>();
    s.legacy.prepare.mockReturnValueOnce(pending.promise);
    const abort = new AbortController();
    const preparation = s.manager.prepare(subject, abort.signal);
    expect(s.manager.outboxContextForSession(subject.sessionId)).toBeUndefined();
    pending.resolve(prepared);
    await preparation;
    expect(s.manager.outboxContextForSession(subject.sessionId)).toEqual(outbox);
    abort.abort();
    expect(s.manager.outboxContextForSession(subject.sessionId)).toBeUndefined();
    await s.manager.close();
  });

  it.each(["abort", "cleanup", "close"] as const)(
    "does not restore context after a late preparation finishes (%s)",
    async (action) => {
      const s = system();
      const pending = deferred<PreparedImCredentialEnvironment>();
      s.legacy.prepare.mockReturnValueOnce(pending.promise);
      const abort = new AbortController();
      const preparation = s.manager.prepare(subject, abort.signal);
      if (action === "abort") abort.abort();
      else if (action === "cleanup") await s.manager.cleanup(subject.sessionId);
      else await s.manager.close();
      pending.resolve(prepared);
      await preparation;
      expect(s.manager.outboxContextForSession(subject.sessionId)).toBeUndefined();
      await s.manager.close();
      await expect(s.manager.prepare(subject)).rejects.toMatchObject({ code: "client_shutdown" });
    },
  );

  it("withdraws context before cleanup I/O and keeps it withdrawn when removal fails", async () => {
    const s = system();
    await s.manager.prepare(subject);
    const pending = deferred<void>();
    s.legacy.cleanup.mockReturnValueOnce(pending.promise);
    const cleanup = s.manager.cleanup(subject.sessionId);
    expect(s.manager.outboxContextForSession(subject.sessionId)).toBeUndefined();
    pending.reject(new Error("disk unavailable"));
    await expect(cleanup).rejects.toThrow("disk unavailable");
    expect(s.manager.outboxContextForSession(subject.sessionId)).toBeUndefined();
    await s.manager.close();
  });

  it.each(["success", "failure"] as const)(
    "ignores an older preparation completing after its replacement (%s)",
    async (outcome) => {
      const s = system();
      const old = deferred<PreparedImCredentialEnvironment>();
      s.legacy.prepare.mockReturnValueOnce(old.promise);
      const first = s.manager.prepare(subject);
      const replacement = { ...prepared, outboxContext: { ...outbox, channelId: "C2" } };
      s.legacy.prepare.mockResolvedValueOnce(replacement);
      await s.manager.prepare({ ...subject, placementGeneration: 2 });
      if (outcome === "success") {
        old.resolve(prepared);
        await first;
      } else {
        old.reject(new Error("old grant failed"));
        await expect(first).rejects.toThrow("old grant failed");
      }
      expect(s.manager.outboxContextForSession(subject.sessionId)).toEqual(replacement.outboxContext);
      await s.manager.close();
    },
  );

  it("drops prior context when the next materialization fails or supplies no context, without touching another Session", async () => {
    const s = system();
    await s.manager.prepare(subject);
    await s.manager.prepare({ ...subject, sessionId: "other-session" });
    s.legacy.prepare.mockRejectedValueOnce(new Error("disk full"));
    await expect(s.manager.prepare(subject)).rejects.toThrow("disk full");
    expect(s.manager.outboxContextForSession(subject.sessionId)).toBeUndefined();
    expect(s.manager.outboxContextForSession("other-session")).toEqual(outbox);
    await s.manager.prepare(subject);
    s.legacy.prepare.mockResolvedValueOnce({ ...prepared, outboxContext: undefined });
    await s.manager.prepare(subject);
    expect(s.manager.outboxContextForSession(subject.sessionId)).toBeUndefined();
    expect(s.manager.outboxContextForSession("other-session")).toEqual(outbox);
    await s.manager.close();
    expect(s.manager.outboxContextForSession("other-session")).toBeUndefined();
  });
});

function system() {
  const legacy = {
    prepare: vi.fn(async (): Promise<PreparedImCredentialEnvironment> => prepared),
    cleanup: vi.fn(async (): Promise<void> => undefined),
    close: vi.fn(async () => undefined),
  };
  const manager = new RuntimeCredentialEnvironmentManager({
    home: "/unused/opentag-home",
    legacy: () => legacy as never,
    connection: {
      capabilityVersion: () => undefined,
      send: async () => undefined,
      subscribeBusinessFrames: () => () => undefined,
      subscribeState: () => () => undefined,
    },
  });
  return { legacy, manager };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
