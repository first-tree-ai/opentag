import { describe, expect, it } from "vitest";
import { AccountSandboxEnsureRequestSchema, AccountSandboxResponseSchema, SandboxLifecycleSchema } from "../sandbox.js";

const unallocated = {
  sandboxId: "2b63a21e-f6c7-4474-91ea-4dabf0566a24",
  sessionId: "3c63a21e-f6c7-4474-91ea-4dabf0566a24",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  storageUri: "gs://opentag-sandbox/2b63a21e-f6c7-4474-91ea-4dabf0566a24",
  lifecycle: "unallocated" as const,
  environmentGeneration: 0,
  currentResourceName: null,
  currentResourceUid: null,
  currentOperationName: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

describe("Sandbox contracts", () => {
  it("accepts channel and thread ensure input from an owned IM binding", () => {
    const channel = {
      imBindingId: "4d63a21e-f6c7-4474-91ea-4dabf0566a24",
      channelId: "oc_channel",
      conversationKind: "channel" as const,
      kind: "channel" as const,
    };
    expect(AccountSandboxEnsureRequestSchema.parse(channel)).toEqual(channel);
    const thread = {
      ...channel,
      kind: "thread" as const,
      threadKey: "om_root",
    };
    expect(AccountSandboxEnsureRequestSchema.parse(thread)).toEqual(thread);
  });

  it("rejects internal Sessions and invalid threadKey pairing", () => {
    const base = {
      imBindingId: "4d63a21e-f6c7-4474-91ea-4dabf0566a24",
      channelId: "oc_channel",
      conversationKind: "dm" as const,
    };
    expect(() => AccountSandboxEnsureRequestSchema.parse({ ...base, kind: "internal" })).toThrow();
    expect(() => AccountSandboxEnsureRequestSchema.parse({ ...base, kind: "thread" })).toThrow();
    expect(() => AccountSandboxEnsureRequestSchema.parse({ ...base, kind: "channel", threadKey: "om_root" })).toThrow();
    expect(() => AccountSandboxEnsureRequestSchema.parse({ ...base, kind: "thread", threadKey: "" })).toThrow();
    expect(() =>
      AccountSandboxEnsureRequestSchema.parse({ ...base, kind: "channel", accountId: crypto.randomUUID() }),
    ).toThrow();
  });

  it("carries durable identity, relationships, state, storage, and allocation absence", () => {
    expect(SandboxLifecycleSchema.options).toEqual(["unallocated", "preparing", "ready", "releasing"]);
    expect(AccountSandboxResponseSchema.parse(unallocated)).toEqual(unallocated);
    expect(unallocated.lifecycle).toBe("unallocated");
    expect(unallocated.currentResourceName).toBeNull();
    expect(unallocated.currentResourceUid).toBeNull();
    expect(unallocated.currentOperationName).toBeNull();
    expect(() => AccountSandboxResponseSchema.parse({ ...unallocated, allocated: false })).toThrow();
    expect(() => AccountSandboxResponseSchema.parse({ ...unallocated, lastSeenAt: unallocated.createdAt })).toThrow();
    expect(() => AccountSandboxResponseSchema.parse({ ...unallocated, environmentGeneration: -1 })).toThrow();
  });
});
