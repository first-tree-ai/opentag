import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeImCredentialGrantRequestSchema, type RuntimeImCredentialGrantResult } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImCredentialEnvironmentManager,
  type ImCredentialEnvironmentManagerOptions,
} from "../runtime/im-credential-environment-manager.js";
import type { RuntimeBusinessFrame } from "../runtime/runtime-connection.js";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";
import { writeDurableFile } from "../storage/durable-file.js";

const cleanups: Array<() => Promise<void>> = [];
const gates: Array<() => void> = [];

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("real legacy credential lifecycle", () => {
  it.each([
    { provider: "slack", outcome: "success" },
    { provider: "slack", outcome: "failure" },
    { provider: "feishu", outcome: "success" },
    { provider: "feishu", outcome: "failure" },
  ] as const)(
    "preserves successor artifacts and context after a late $provider write ($outcome)",
    async ({ provider, outcome }) => {
      const blocked = deferred<void>();
      const release = deferred<void>();
      gates.push(() => release.resolve(undefined));
      let held = false;
      const s = await system({
        provider,
        writeEnvironmentFile: async (path, content, mode) => {
          if (!held && content.includes("fixture-1")) {
            held = true;
            blocked.resolve(undefined);
            await release.promise;
            if (outcome === "failure") throw new Error("old write failed");
          }
          await writeDurableFile(path, content, mode);
        },
      });
      const first = s.manager.prepare(s.subject).catch((error: unknown) => error);
      await blocked.promise;
      const replacement = s.manager.prepare({ ...s.subject, placementGeneration: 2 });
      await Promise.race([replacement, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect(s.requests).toHaveLength(1);
      expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
      release.resolve(undefined);
      expect(await first).toMatchObject({
        code: outcome === "failure" ? "credential_materialization_failed" : "preparation_superseded",
      });
      const current = await replacement;
      expect(await readFile(current.path, "utf8")).toContain("fixture-2");
      if (!current.environmentManifest) throw new Error("Expected the legacy environment manifest");
      expect(JSON.parse(await readFile(current.environmentManifest, "utf8")).executionId).toBe(current.executionId);
      expect(s.manager.outboxContextForSession(s.subject.sessionId)).toMatchObject({
        ...(provider === "slack" ? { channelId: "C2" } : { chatId: "oc_2" }),
      });
    },
  );

  it.each(["slack", "feishu"] as const)("ignores stale %s execution cleanup after replacement", async (provider) => {
    const s = await system({ provider });
    const first = await s.manager.prepare(s.subject);
    const second = await s.manager.prepare({ ...s.subject, placementGeneration: 2 });
    if (!first.executionId || !second.executionId || !second.environmentManifest)
      throw new Error("Expected exact legacy execution identities and manifest");
    expect(first.executionId).not.toBe(second.executionId);
    await s.manager.cleanup(s.subject.sessionId, first.executionId);
    expect(await readFile(second.path, "utf8")).toContain("fixture-2");
    expect(JSON.parse(await readFile(second.environmentManifest, "utf8")).executionId).toBe(second.executionId);
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toEqual(second.outboxContext);
    await s.manager.cleanup(s.subject.sessionId, second.executionId);
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
    await expect(stat(second.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(second.environmentManifest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["abort", "cleanup", "close"] as const)("removes late materialization artifacts after %s", async (action) => {
    const blocked = deferred<void>();
    const release = deferred<void>();
    gates.push(() => release.resolve(undefined));
    const s = await system({
      writeEnvironmentFile: async (path, content, mode) => {
        if (path.endsWith(".json")) {
          blocked.resolve(undefined);
          await release.promise;
        }
        await writeDurableFile(path, content, mode);
      },
    });
    const abort = new AbortController();
    const preparation = s.manager.prepare(s.subject, abort.signal).catch((error: unknown) => error);
    await blocked.promise;
    let cleanup: Promise<void> | undefined;
    if (action === "abort") abort.abort();
    else if (action === "cleanup") cleanup = s.manager.cleanup(s.subject.sessionId);
    else cleanup = s.manager.close();
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
    release.resolve(undefined);
    expect(await preparation).toMatchObject({
      code: action === "abort" ? "aborted" : action === "cleanup" ? "preparation_superseded" : "client_shutdown",
    });
    await cleanup;
    await expect(stat(s.manager.pathForSession(s.subject.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
    if (action === "close")
      await expect(s.manager.prepare(s.subject)).rejects.toMatchObject({ code: "client_shutdown" });
  });

  it("withdraws live context on abort and before failed artifact cleanup, then retries removal at shutdown", async () => {
    let failRemoval = false;
    const s = await system({
      removePath: async (path, options) => {
        if (failRemoval && path.endsWith(".sh")) {
          failRemoval = false;
          throw new Error("disk unavailable");
        }
        await rm(path, options);
      },
    });
    const abort = new AbortController();
    const current = await s.manager.prepare(s.subject, abort.signal);
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toEqual(current.outboxContext);
    abort.abort();
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
    failRemoval = true;
    const cleanup = s.manager.cleanup(s.subject.sessionId, current.executionId);
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
    await expect(cleanup).rejects.toMatchObject({ code: "cleanup_failed" });
    await s.manager.close();
    await expect(stat(current.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares other Sessions while one Session's materialization is blocked", async () => {
    const blocked = deferred<void>();
    const release = deferred<void>();
    gates.push(() => release.resolve(undefined));
    const s = await system({
      writeEnvironmentFile: async (path, content, mode) => {
        if (content.includes("fixture-1")) {
          blocked.resolve(undefined);
          await release.promise;
        }
        await writeDurableFile(path, content, mode);
      },
    });
    const first = s.manager.prepare(s.subject);
    await blocked.promise;
    const otherSubject = { ...s.subject, sessionId: randomUUID(), placementGeneration: 2 };
    const other = await s.manager.prepare(otherSubject);
    expect(await readFile(other.path, "utf8")).toContain("fixture-2");
    release.resolve(undefined);
    const current = await first;
    await s.manager.cleanup(s.subject.sessionId, current.executionId);
    expect(await readFile(other.path, "utf8")).toContain("fixture-2");
    expect(s.manager.outboxContextForSession(otherSubject.sessionId)).toEqual(other.outboxContext);
  });

  it("finishes in-flight cleanup before publishing a replacement", async () => {
    const blocked = deferred<void>();
    const release = deferred<void>();
    gates.push(() => release.resolve(undefined));
    let holdRemoval = false;
    const s = await system({
      removePath: async (path, options) => {
        if (holdRemoval && path.endsWith(".sh")) {
          holdRemoval = false;
          blocked.resolve(undefined);
          await release.promise;
        }
        await rm(path, options);
      },
    });
    const first = await s.manager.prepare(s.subject);
    holdRemoval = true;
    const cleanup = s.manager.cleanup(s.subject.sessionId, first.executionId);
    await blocked.promise;
    const replacement = s.manager.prepare({ ...s.subject, placementGeneration: 2 });
    await Promise.race([replacement, new Promise((resolve) => setTimeout(resolve, 100))]);
    expect(s.requests).toHaveLength(1);
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
    release.resolve(undefined);
    await cleanup;
    const current = await replacement;
    expect(await readFile(current.path, "utf8")).toContain("fixture-2");
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toEqual(current.outboxContext);
  });

  it("refuses replacement publication while the previous credential artifacts cannot be removed", async () => {
    let failRemoval = false;
    const s = await system({
      removePath: async (path, options) => {
        if (failRemoval && path.endsWith(".sh")) throw new Error("disk unavailable");
        await rm(path, options);
      },
    });
    const first = await s.manager.prepare(s.subject);
    failRemoval = true;
    await expect(s.manager.prepare({ ...s.subject, placementGeneration: 2 })).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(s.requests).toHaveLength(1);
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toBeUndefined();
    failRemoval = false;
    const current = await s.manager.prepare({ ...s.subject, placementGeneration: 2 });
    await s.manager.cleanup(s.subject.sessionId, first.executionId);
    expect(await readFile(current.path, "utf8")).toContain("fixture-2");
    expect(s.manager.outboxContextForSession(s.subject.sessionId)).toEqual(current.outboxContext);
  });
});

async function system(
  options: {
    provider?: "slack" | "feishu";
    writeEnvironmentFile?: ImCredentialEnvironmentManagerOptions["writeEnvironmentFile"];
    removePath?: ImCredentialEnvironmentManagerOptions["removePath"];
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "opentag-legacy-lifecycle-"));
  const subject = { sessionId: randomUUID(), agentId: randomUUID(), placementGeneration: 1 };
  const provider = options.provider ?? "slack";
  const requests: unknown[] = [];
  let listener: ((frame: RuntimeBusinessFrame) => void) | undefined;
  const manager = new RuntimeCredentialEnvironmentManager({
    home,
    legacy: (legacyOptions) =>
      new ImCredentialEnvironmentManager({
        ...legacyOptions,
        exchangeFeishuToken: async (grant) => grant.appId,
        ...(options.writeEnvironmentFile ? { writeEnvironmentFile: options.writeEnvironmentFile } : {}),
        ...(options.removePath ? { removePath: options.removePath } : {}),
      }),
    connection: {
      capabilityVersion: () => 2,
      send: async (frame) => {
        const request = RuntimeImCredentialGrantRequestSchema.parse(frame);
        requests.push(request);
        const generation = request.placementGeneration;
        const result: RuntimeImCredentialGrantResult = {
          type: "im:credential:result",
          requestId: request.requestId,
          status: "succeeded",
          credentialGeneration: generation,
          grant:
            provider === "slack"
              ? { provider, botAccessToken: `fixture-${generation}` }
              : { provider, appId: `fixture-${generation}`, appSecret: "fixture-secret", teamBrand: "feishu" },
          outboxContext:
            provider === "slack"
              ? { provider, sessionKind: "thread", channelId: `C${generation}`, threadTs: "1.2" }
              : { provider, sessionKind: "thread", chatId: `oc_${generation}`, threadId: "omt_thread" },
        };
        queueMicrotask(() => listener?.(result));
      },
      subscribeBusinessFrames: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      subscribeState: () => () => undefined,
    },
  });
  cleanups.push(async () => {
    await manager.close();
    await rm(home, { recursive: true, force: true });
  });
  return { manager, subject, requests };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
