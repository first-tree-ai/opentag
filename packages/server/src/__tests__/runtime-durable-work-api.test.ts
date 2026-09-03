import { randomUUID } from "node:crypto";
import { HTTP_PATHS, type RuntimeDurableWorkRecord } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { RuntimeDurableWorkConflictError } from "../runtime/runtime-durable-work-store.js";

const computerId = randomUUID();
const agentId = randomUUID();
const targetSessionId = randomUUID();
const record: RuntimeDurableWorkRecord = {
  acceptedAt: 1,
  attempts: 0,
  key: "session:message",
  kind: "session-message",
  payload: {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId,
    agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "hello" },
    runtime: {
      revision: { agent: { sequence: 1, id: "agent" }, session: { sequence: 1, id: "session" } },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId: "workspace", mode: "empty_on_create", sharing: "agent" },
    },
  },
  status: "accepted",
  updatedAt: 1,
};

describe("Runtime durable work HTTP API", () => {
  it("authenticates the Computer and scopes list/write to its identity", async () => {
    const store = { list: vi.fn().mockResolvedValue([record]), write: vi.fn().mockResolvedValue(undefined) };
    const verifyMachineToken = vi.fn().mockResolvedValue({ computerId });
    const app = createApp({
      runtimeDurableWork: { machineAuth: { verifyMachineToken }, store },
    });
    const list = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.runtimeDurableWork}?kind=session-message`,
      headers: { authorization: "Bearer machine" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [record] });
    expect(store.list).toHaveBeenCalledWith(computerId, "session-message");

    const write = await app.inject({
      method: "PUT",
      url: `${HTTP_PATHS.runtimeDurableWork}/session-message/${encodeURIComponent(record.key)}`,
      headers: { authorization: "Bearer machine", "content-type": "application/json" },
      payload: record,
    });
    expect(write.statusCode).toBe(204);
    expect(store.write).toHaveBeenCalledWith(computerId, record);
    await app.close();
  });

  it("rejects path identity conflicts and persisted payload conflicts", async () => {
    const store = { list: vi.fn(), write: vi.fn().mockRejectedValue(new RuntimeDurableWorkConflictError()) };
    const app = createApp({
      runtimeDurableWork: {
        machineAuth: { verifyMachineToken: vi.fn().mockResolvedValue({ computerId }) },
        store,
      },
    });
    const mismatch = await app.inject({
      method: "PUT",
      url: `${HTTP_PATHS.runtimeDurableWork}/turn-report/other`,
      headers: { authorization: "Bearer machine", "content-type": "application/json" },
      payload: record,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(store.write).not.toHaveBeenCalled();

    const conflict = await app.inject({
      method: "PUT",
      url: `${HTTP_PATHS.runtimeDurableWork}/session-message/${encodeURIComponent(record.key)}`,
      headers: { authorization: "Bearer machine", "content-type": "application/json" },
      payload: record,
    });
    expect(conflict.statusCode).toBe(409);
    await app.close();
  });
});
