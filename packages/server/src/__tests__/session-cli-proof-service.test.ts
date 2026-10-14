import { randomUUID } from "node:crypto";
import type { SessionReconcileRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";

describe("SessionCliProofService", () => {
  it("keeps a visible IM ready reconcile proof-free when the Client did not negotiate collaboration", async () => {
    const request = {
      type: "session:reconcile",
      requestId: randomUUID(),
      installationId: randomUUID(),
      sessionId: randomUUID(),
      agentId: randomUUID(),
      placementGeneration: 1,
      desired: "ready",
      runtime: {},
    } as SessionReconcileRequest;
    const database = { transaction: vi.fn(), delete: vi.fn() };
    const service = new SessionCliProofService(
      database as never,
      { currentInstanceId: vi.fn(), supportsCapability: vi.fn().mockReturnValue(false) },
      new Uint8Array(32).fill(7),
    );

    await expect(service.prepareReconcile(randomUUID(), randomUUID(), request)).resolves.toEqual({ request });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.delete).not.toHaveBeenCalled();
  });
});

it("captures provenance only from the exact live execution behind the authenticated Session proof", async () => {
  const sessionId = randomUUID(),
    agentId = randomUUID(),
    computerId = randomUUID(),
    instanceId = randomUUID();
  const row = {
    sessionId,
    agentId,
    computerId,
    proofComputerId: computerId,
    agentStatus: "active",
    bindingStatus: "active",
    computerKind: "local",
    placementGeneration: 1,
    placementGenerationCurrent: 1,
    connectionInstanceId: instanceId,
    currentInstanceId: instanceId,
    installationId: randomUUID(),
    creatorSessionId: null,
    sessionKind: "channel",
    proofId: randomUUID(),
  };
  const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: async () => [row] };
  const source = { kind: "delivery" as const, deliveryId: randomUUID(), turnId: randomUUID() };
  const executionId = randomUUID();
  const record = {
    executionId,
    sessionId,
    agentId,
    computerId,
    instanceId,
    placementGeneration: 1,
    source,
    purpose: "execution",
  };
  const get = vi.fn((id: string) => (id === executionId ? record : undefined));
  const executionLive = vi.fn(async () => true);
  const service = new SessionCliProofService(
    { select: () => chain } as never,
    { currentInstanceId: () => instanceId, supportsCapability: () => true },
    new Uint8Array(32).fill(7),
    { executions: { get } as never, executionLive },
  );
  expect(await service.authenticate("proof", executionId)).toHaveProperty("userTaskSource", { sessionId, source });
  expect(await service.authenticate("proof")).not.toHaveProperty("userTaskSource");
  expect(await service.authenticate("proof", randomUUID())).not.toHaveProperty("userTaskSource");
  record.sessionId = randomUUID();
  expect(await service.authenticate("proof", executionId)).not.toHaveProperty("userTaskSource");
  record.sessionId = sessionId;
  executionLive.mockResolvedValue(false);
  expect(await service.authenticate("proof", executionId)).not.toHaveProperty("userTaskSource");
});
