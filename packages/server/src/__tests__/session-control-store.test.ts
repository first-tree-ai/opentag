import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControlWriteIntent, FileSessionControlStore } from "../services/session-control-store/index.js";

let root: string;
let store: FileSessionControlStore;
let sessionId: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "opentag-control-"));
  store = new FileSessionControlStore({ root });
  sessionId = randomUUID();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function intent(): ControlWriteIntent {
  return {
    sessionId,
    operationId: randomUUID(),
    executionId: randomUUID(),
    provider: "github",
    resource: "repository:123/refs/heads/topic",
    operation: "git.push",
    requestHash: "a".repeat(64),
    policyRevision: "github:1",
    createdAt: "2026-09-16T00:00:00Z",
  };
}

describe("Server-private Session control storage", () => {
  it("persists an intent before completion and blocks replay after a Server restart", async () => {
    const input = intent();
    const receipt = await store.beginWrite(input);
    const restarted = new FileSessionControlStore({ root });
    expect(await restarted.readWrite(sessionId, input.operationId)).toEqual({ intent: input, ...receipt });
    await expect(restarted.beginWrite(input)).rejects.toMatchObject({ code: "already_started" });
    await expect(restarted.beginWrite(intent())).rejects.toMatchObject({ code: "conflict" });
    expect(await restarted.listUnresolvedWrites(sessionId)).toHaveLength(1);
  });

  it.each(["chat.postMessage", "files.getUploadURLExternal"])(
    "journals the native Slack operation id %s through begin, complete, and read resolution",
    async (operation) => {
      const input = { ...intent(), provider: "slack" as const, resource: "channel:C123", operation };
      const { intentHash } = await store.beginWrite(input);
      expect(await store.readWrite(sessionId, input.operationId)).toEqual({ intent: input, intentHash });
      const outcome = {
        operationId: input.operationId,
        intentHash,
        state: "succeeded" as const,
        resultCode: "ok",
        completedAt: "2026-09-16T00:00:01Z",
      };
      await store.completeWrite(sessionId, outcome);
      expect(await store.readWrite(sessionId, input.operationId)).toMatchObject({
        intent: { operation, provider: "slack" },
        outcome,
        resolution: "succeeded",
      });
      expect(await store.listUnresolvedWrites(sessionId)).toEqual([]);
      // A later write to a different resource with the same native operation id is a fresh intent.
      await expect(
        store.beginWrite({ ...input, operationId: randomUUID(), resource: "channel:C456" }),
      ).resolves.toHaveProperty("intentHash");
    },
  );

  it.each([
    ["uppercase initial letter", "Chat.postMessage"],
    ["whitespace", "chat postMessage"],
    ["path separator", "chat/postMessage"],
    ["query or payload characters", "chat.postMessage?token=x"],
    ["assignment character", "chat.postMessage=1"],
    ["unbounded length", `a${"b".repeat(128)}`],
    ["empty", ""],
  ])("rejects a malformed or unbounded operation id (%s)", async (_case, operation) => {
    await expect(store.beginWrite({ ...intent(), operation } as ControlWriteIntent)).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("publishes one immutable outcome and allows subsequent operations only after a known outcome", async () => {
    const input = intent();
    const { intentHash } = await store.beginWrite(input);
    const outcome = {
      operationId: input.operationId,
      intentHash,
      state: "succeeded" as const,
      resultCode: "remote_sha_confirmed",
      completedAt: "2026-09-16T00:00:01Z",
    };
    await store.completeWrite(sessionId, outcome);
    await store.completeWrite(sessionId, outcome);
    await expect(store.completeWrite(sessionId, { ...outcome, state: "rejected" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await store.listUnresolvedWrites(sessionId)).toEqual([]);
    expect(await store.readWrite(sessionId, input.operationId)).toMatchObject({ outcome });
    await expect(store.beginWrite(intent())).resolves.toHaveProperty("intentHash");
  });

  it("keeps explicit unknown outcomes unresolved and rejects an outcome for another intent", async () => {
    const input = intent();
    const { intentHash } = await store.beginWrite(input);
    const outcome = {
      operationId: input.operationId,
      intentHash,
      state: "unknown" as const,
      resultCode: "connection_lost",
      completedAt: "2026-09-16T00:00:01Z",
    };
    await expect(store.completeWrite(sessionId, { ...outcome, intentHash: "b".repeat(64) })).rejects.toMatchObject({
      code: "conflict",
    });
    await store.completeWrite(sessionId, outcome);
    expect(await store.listUnresolvedWrites(sessionId)).toHaveLength(1);
    await expect(store.beginWrite(intent())).rejects.toMatchObject({ code: "conflict" });
  });

  it("atomically admits one writer for a repeated operation ID across store instances", async () => {
    const input = intent();
    const other = new FileSessionControlStore({ root });
    const outcomes = await Promise.allSettled([store.beginWrite(input), other.beginWrite(input)]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(await store.listUnresolvedWrites(sessionId)).toHaveLength(1);
  });

  it("records source policy before reads, deduplicates it, and enforces a bounded journal", async () => {
    const small = new FileSessionControlStore({ root, maxRecordsPerSession: 1 });
    const source = {
      sessionId,
      provider: "github" as const,
      resource: "repository:123",
      policyRevision: "github:1",
      recordedAt: "2026-09-16T00:00:00Z",
    };
    await small.recordSource(source);
    await small.recordSource({ ...source, recordedAt: "2026-09-16T00:00:01Z" });
    expect(await small.listSources(sessionId)).toEqual([source]);
    await expect(small.recordSource({ ...source, resource: "repository:456" })).rejects.toMatchObject({
      code: "capacity",
    });
  });

  it("rejects world-readable storage and symlink redirection", async () => {
    await chmod(root, 0o755);
    await expect(store.beginWrite(intent())).rejects.toMatchObject({ code: "unsafe_storage" });
    await chmod(root, 0o700);
    const outside = join(root, "outside");
    await writeFile(outside, "preserve", { mode: 0o600 });
    await symlink(outside, join(root, sessionId));
    await expect(store.beginWrite(intent())).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("preserve");
  });

  it("rejects token-bearing payload fields and path traversal without echoing supplied values", async () => {
    await expect(store.beginWrite({ ...intent(), token: "secret-marker" } as ControlWriteIntent)).rejects.toMatchObject(
      { code: "invalid_record" },
    );
    await expect(store.listSources("../secret-marker")).rejects.toMatchObject({ code: "invalid_record" });
  });
});

describe("Session control authoritative reconciliation and retention", () => {
  async function unknownWrite() {
    const input = intent();
    const { intentHash } = await store.beginWrite(input);
    await store.completeWrite(sessionId, {
      operationId: input.operationId,
      intentHash,
      state: "unknown",
      resultCode: "connection_lost",
      completedAt: "2026-09-16T00:00:01Z",
    });
    return { input, intentHash };
  }

  it("resolves an unknown resource through an explicit reconciliation without replaying it", async () => {
    const { input, intentHash } = await unknownWrite();
    expect(await store.listUnresolvedWrites(sessionId)).toHaveLength(1);
    await expect(store.beginWrite({ ...intent(), resource: input.resource })).rejects.toMatchObject({
      code: "conflict",
    });
    const reconciliation = {
      sessionId,
      operationId: input.operationId,
      intentHash,
      disposition: "applied" as const,
      evidence: "remote_sha_confirmed",
      reconciledAt: "2026-09-16T00:01:00Z",
    };
    await store.reconcileWrite(reconciliation);
    const resolved = await store.readWrite(sessionId, input.operationId);
    expect(resolved).toMatchObject({ reconciliation, resolution: "succeeded" });
    expect(await store.listUnresolvedWrites(sessionId)).toEqual([]);
    expect(await store.readReconciliation(sessionId, input.operationId)).toEqual(reconciliation);
    expect(await store.listReconciliations(sessionId)).toEqual([reconciliation]);
    // Identical retry is a no-op; a contradicting verdict conflicts.
    await expect(store.reconcileWrite(reconciliation)).resolves.toBeUndefined();
    await expect(store.reconcileWrite({ ...reconciliation, disposition: "not_applied" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(store.reconcileWrite({ ...reconciliation, evidence: "other_code" })).rejects.toMatchObject({
      code: "conflict",
    });
    // The resource is released for a fresh, separately journaled attempt.
    await expect(store.beginWrite({ ...intent(), resource: input.resource })).resolves.toHaveProperty("intentHash");
  });

  it("never downgrades an authoritative success", async () => {
    const input = intent();
    const { intentHash } = await store.beginWrite(input);
    const succeeded = {
      operationId: input.operationId,
      intentHash,
      state: "succeeded" as const,
      resultCode: "remote_sha_confirmed",
      completedAt: "2026-09-16T00:02:00Z",
    };
    await store.completeWrite(sessionId, succeeded);
    await expect(
      store.reconcileWrite({
        sessionId,
        operationId: input.operationId,
        intentHash,
        disposition: "not_applied",
        evidence: "not_found_remotely",
        reconciledAt: "2026-09-16T00:03:00Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.completeWrite(sessionId, { ...succeeded, state: "rejected" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(store.completeWrite(sessionId, succeeded)).resolves.toBeUndefined();
    expect((await store.readWrite(sessionId, input.operationId))?.resolution).toBe("succeeded");

    // A reconciliation verdict cannot be downgraded by a later non-terminal/contradicting outcome.
    const second = intent();
    const secondReceipt = await store.beginWrite(second);
    await store.reconcileWrite({
      sessionId,
      operationId: second.operationId,
      intentHash: secondReceipt.intentHash,
      disposition: "applied",
      evidence: "remote_sha_confirmed",
      reconciledAt: "2026-09-16T00:04:00Z",
    });
    await expect(
      store.completeWrite(sessionId, {
        operationId: second.operationId,
        intentHash: secondReceipt.intentHash,
        state: "unknown",
        resultCode: "connection_lost",
        completedAt: "2026-09-16T00:05:00Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects reconciliation for another session or a mismatched intent hash", async () => {
    const { input, intentHash } = await unknownWrite();
    const foreign = randomUUID();
    await expect(
      store.reconcileWrite({
        sessionId: foreign,
        operationId: input.operationId,
        intentHash,
        disposition: "applied",
        evidence: "remote_sha_confirmed",
        reconciledAt: "2026-09-16T00:01:00Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.reconcileWrite({
        sessionId,
        operationId: input.operationId,
        intentHash: "b".repeat(64),
        disposition: "applied",
        evidence: "remote_sha_confirmed",
        reconciledAt: "2026-09-16T00:01:00Z",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await store.readReconciliation(foreign, input.operationId)).toBeUndefined();
    expect(await store.readReconciliation(sessionId, randomUUID())).toBeUndefined();
  });

  it("removes only a fully resolved session and keeps other sessions", async () => {
    const otherSession = randomUUID();
    const otherInput = { ...intent(), sessionId: otherSession };
    await store.beginWrite(otherInput);
    const { input } = await unknownWrite();
    await expect(store.removeCompletedSession(sessionId)).rejects.toMatchObject({ code: "conflict" });
    expect(await store.readWrite(sessionId, input.operationId)).toBeDefined();

    await store.reconcileWrite({
      sessionId,
      operationId: input.operationId,
      intentHash: (await store.readWrite(sessionId, input.operationId))?.intentHash ?? "",
      disposition: "not_applied",
      evidence: "not_found_remotely",
      reconciledAt: "2026-09-16T00:01:00Z",
    });
    await expect(store.removeCompletedSession(sessionId)).resolves.toEqual({ removed: true });
    expect(await store.readWrite(sessionId, input.operationId)).toBeUndefined();
    expect(await store.readWrite(otherSession, otherInput.operationId)).toBeDefined();
  });

  it("rejects symlinked reconciliation targets without touching the linked file", async () => {
    const input = intent();
    const { intentHash } = await store.beginWrite(input);
    const outside = join(root, "outside-reconcile");
    await writeFile(outside, "preserve", { mode: 0o600 });
    await symlink(outside, join(root, sessionId, `${input.operationId}.reconcile.json`));
    await expect(
      store.reconcileWrite({
        sessionId,
        operationId: input.operationId,
        intentHash,
        disposition: "applied",
        evidence: "remote_sha_confirmed",
        reconciledAt: "2026-09-16T00:01:00Z",
      }),
    ).rejects.toMatchObject({ code: "unsafe_storage" });
    await expect(store.readReconciliation(sessionId, input.operationId)).rejects.toMatchObject({
      code: "unsafe_storage",
    });
    await expect(store.listReconciliations(sessionId)).rejects.toMatchObject({ code: "unsafe_storage" });
    expect(await readFile(outside, "utf8")).toBe("preserve");
  });
});
