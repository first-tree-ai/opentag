import { randomUUID } from "node:crypto";
import type { RuntimeApprovalRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalStore, PendingApproval } from "../runtime/approval-store.js";
import { type ApprovalAction, RuntimeApprovalOwner } from "../runtime/runtime-approval-owner.js";

function setup(provider: "slack" | "feishu" = "slack") {
  let now = Date.now();
  const rows = new Map<string, PendingApproval>();
  const store: ApprovalStore = {
    insert: async (row) => {
      if (rows.has(row.id)) return false;
      rows.set(row.id, {
        ...structuredClone(row),
        authority: Object.fromEntries(Object.entries(row.authority).sort()) as PendingApproval["authority"],
      });
      return true;
    },
    find: async (id) => rows.get(id),
    update: async (id, expected, change) => {
      const row = rows.get(id);
      if (!row || row.status !== expected) return false;
      rows.set(id, { ...row, ...change });
      return true;
    },
    list: async (id) =>
      [...rows.values()].filter(
        (row) =>
          row.serverInstanceId === id &&
          (["pending", "accept", "decline"].includes(row.status) ||
            (["approved", "denied", "stale"].includes(row.status) && row.cardUpdatedAt === null)),
      ),
    purge: async () => undefined,
  };
  const context = {
    computerId: randomUUID(),
    instanceId: randomUUID(),
    installationId: randomUUID(),
    connectionId: randomUUID(),
    signal: new AbortController().signal,
  };
  const authority = {
    senderExternalId: "sender",
    provider,
    generation: 3,
    ...(provider === "slack" ? { installationId: "installation" } : {}),
    channelId: "channel",
    threadKey: "thread",
    externalMessageId: "message",
    configRevision: 2,
  };
  const scope = { imBindingId: randomUUID(), authority, deadlineAt: new Date(now + 60_000) };
  const load = vi.fn(async () => scope);
  const registry = {
    isCurrentConnection: vi.fn(() => true),
    send: vi.fn(async (_computerId: string, _instanceId: string, _frame: unknown) => undefined),
  };
  const messenger = {
    post: vi.fn(async () => ({ messageId: "approval-message", channelId: "sender-dm" })),
    finish: vi.fn(async () => undefined),
  };
  const options = {
    store,
    registry,
    authority: load,
    messenger,
    serverInstanceId: randomUUID(),
    now: () => now,
    onError: vi.fn(),
  };
  const owner = new RuntimeApprovalOwner(options);
  const request: RuntimeApprovalRequest = {
    type: "approval:request",
    requestId: randomUUID(),
    sessionId: randomUUID(),
    deliveryId: randomUUID(),
    placementGeneration: 1,
    turnId: "turn",
    title: "Approve command",
    description: "git push",
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const row = () => [...rows.values()][0] as PendingApproval;
  const action = (): ApprovalAction => ({
    approvalId: row().id,
    decision: "accept",
    userId: "sender",
    provider,
    generation: 3,
    channelId: "sender-dm",
    messageId: "approval-message",
    installationId: "installation",
    imBindingId: scope.imBindingId,
  });
  return {
    owner,
    options,
    context,
    request,
    rows,
    row,
    action,
    registry,
    messenger,
    load,
    advance: () => {
      now += 60_001;
    },
  };
}

describe("Runtime approvals", () => {
  it.each(["slack", "feishu"] as const)(
    "delivers a %s decision once to the same turn and waits for acknowledgement",
    async (provider) => {
      const s = setup(provider);
      await s.owner.request(s.request, s.context);
      await s.owner.request(s.request, s.context);
      expect(s.messenger.post).toHaveBeenCalledTimes(1);
      expect(await s.owner.decide(s.action())).toBe("recorded");
      expect(await s.owner.decide(s.action())).toBe("unavailable");
      await s.owner.poll();
      await s.owner.poll();
      expect(s.registry.send).toHaveBeenCalledTimes(1);
      expect(s.registry.send).toHaveBeenCalledWith(
        s.context.computerId,
        s.context.instanceId,
        expect.objectContaining({
          type: "approval:decision",
          turnId: "turn",
          requestId: s.request.requestId,
          decision: "accept",
        }),
      );
      expect(s.messenger.finish).not.toHaveBeenCalled();
      const { title: _title, description: _description, expiresAt: _expiresAt, ...identity } = s.request;
      await s.owner.businessOptions().handle({ ...identity, type: "approval:result", status: "applied" }, s.context);
      expect(s.row().status).toBe("approved");
      await s.owner.poll();
      expect(s.messenger.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
      expect(s.row().cardUpdatedAt).toBeInstanceOf(Date);
      s.owner.close();
    },
  );

  it("accepts the callback at a different server replica", async () => {
    const s = setup();
    await s.owner.request(s.request, s.context);
    const other = new RuntimeApprovalOwner({
      ...s.options,
      serverInstanceId: randomUUID(),
      registry: { ...s.registry, isCurrentConnection: () => false },
    });
    expect(await other.decide(s.action())).toBe("recorded");
    await other.poll();
    expect(s.registry.send).not.toHaveBeenCalled();
    await s.owner.poll();
    expect(s.registry.send).toHaveBeenCalledTimes(1);
  });

  it("does not recheck an unchanged pending card on every poll", async () => {
    const s = setup();
    await s.owner.request(s.request, s.context);
    await s.owner.poll();
    await s.owner.poll();
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(await s.owner.decide(s.action())).toBe("recorded");
    expect(s.load).toHaveBeenCalledTimes(2);
  });

  it("marks a declined approval as denied after the running turn acknowledges it", async () => {
    const s = setup();
    await s.owner.request(s.request, s.context);
    expect(await s.owner.decide({ ...s.action(), decision: "decline" })).toBe("recorded");
    await s.owner.poll();
    const { title: _title, description: _description, expiresAt: _expiresAt, ...identity } = s.request;
    await s.owner.businessOptions().handle({ ...identity, type: "approval:result", status: "applied" }, s.context);
    await s.owner.poll();
    expect(s.row().status).toBe("denied");
    expect(s.messenger.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "denied" }));
  });

  it("retries a failed card update after recording a decision", async () => {
    const s = setup();
    await s.owner.request(s.request, s.context);
    await s.owner.decide(s.action());
    await s.owner.poll();
    const { title: _title, description: _description, expiresAt: _expiresAt, ...identity } = s.request;
    await s.owner.businessOptions().handle({ ...identity, type: "approval:result", status: "applied" }, s.context);
    s.messenger.finish.mockRejectedValueOnce(new Error("temporary API failure"));
    await s.owner.poll();
    expect(s.row().status).toBe("approved");
    expect(s.row().cardUpdatedAt).toBeNull();
    await s.owner.poll();
    expect(s.messenger.finish).toHaveBeenCalledTimes(2);
    expect(s.row().cardUpdatedAt).toBeInstanceOf(Date);
  });

  it.each([
    { userId: "stranger" },
    { generation: 4 },
    { messageId: "other" },
    { channelId: "other" },
    { installationId: "other" },
  ])("rejects mismatched callback authority %j", async (change) => {
    const s = setup();
    await s.owner.request(s.request, s.context);
    expect(await s.owner.decide({ ...s.action(), ...change })).toBe("unavailable");
    expect(s.row().status).toBe("pending");
  });

  it("denies a request when its authority is unavailable", async () => {
    const s = setup();
    s.load.mockResolvedValue(undefined as never);
    expect(await s.owner.request(s.request, s.context)).toMatchObject({
      type: "approval:decision",
      decision: "decline",
    });
    expect(s.messenger.post).not.toHaveBeenCalled();
  });

  it("expires a pending request without applying a late approval", async () => {
    const s = setup();
    await s.owner.request(s.request, s.context);
    s.advance();
    expect(await s.owner.decide(s.action())).toBe("unavailable");
    await s.owner.poll();
    expect(s.row().status).toBe("stale");
    expect(s.registry.send).toHaveBeenCalledWith(
      s.context.computerId,
      s.context.instanceId,
      expect.objectContaining({ decision: "decline" }),
    );
  });

  it("invalidates a decision after reconnection and never replays an uncertain send", async () => {
    const s = setup();
    await s.owner.request(s.request, s.context);
    await s.owner.decide(s.action());
    s.registry.isCurrentConnection.mockReturnValue(false);
    await s.owner.poll();
    expect(s.row().status).toBe("stale");
    expect(s.registry.send).not.toHaveBeenCalled();
  });

  it("denies and reports a failed approval message", async () => {
    const s = setup();
    s.messenger.post.mockRejectedValue(new Error("unavailable"));
    expect(await s.owner.request(s.request, s.context)).toMatchObject({ decision: "decline" });
    expect(s.row().status).toBe("stale");
    expect(s.options.onError).toHaveBeenCalled();
  });
});
