import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { computeDirectInputHash, computeTurnResultHash, type DirectImMessageDeliveryRequest } from "@opentag/shared";
import { expect, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
export async function createInboundFixture(databaseUrl: string) {
  const client = createDatabaseClient(databaseUrl);
  const clock = { now: new Date() };
  const account = await bootstrapInitialAdmin(client.database, {
    email: "inbound@example.test",
    displayName: "Inbound",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: account.userId,
      currentInstallationId: randomUUID(),
      currentInstanceId: randomUUID(),
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "test",
    })
    .returning();
  assert(computer);
  const agent = await new AgentService(client.database).createForAccount(account.userId, {
    name: "inbound",
    displayName: "Inbound",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const service = new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => clock.now,
  });
  return { client, clock, account, computer, agent, service, close: () => client.sql.end() };
}

export async function recordInboundInputs(
  f: Pick<Awaited<ReturnType<typeof createInboundFixture>>, "client" | "clock" | "computer" | "agent">,
  count: number,
) {
  const custody = new PostgresRuntimeCustodyStore(f.client.database, { now: () => f.clock.now });
  assert(f.computer.currentInstallationId && f.computer.currentInstanceId);
  const context = {
    computerId: f.computer.id,
    installationId: f.computer.currentInstallationId,
    instanceId: f.computer.currentInstanceId,
    signal: new AbortController().signal,
  };
  const requestDelivery = vi.fn(
    async (
      _computerId: string,
      _instanceId: string,
      request: DirectImMessageDeliveryRequest,
      onDispatched?: () => void,
    ) => {
      const hash = computeDirectInputHash(request);
      expect(await custody.beginDeliveryDispatch(request, hash, context)).toBe("dispatched");
      onDispatched?.();
      const turnId = randomUUID();
      expect(await custody.acceptDelivery(request, hash, turnId, context)).toBe("accepted");
      const body = {
        deliveryId: request.deliveryId,
        turnId,
        sessionId: request.sessionId,
        agentId: request.agentId,
        placementGeneration: request.placementGeneration,
        outcome: "completed" as const,
        executionEffects: "completed" as const,
        traceSummary: { lastSequence: 0, droppedEvents: 0 },
      };
      expect(
        await custody.recordTurn(
          { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) },
          context,
        ),
      ).toBe("recorded");
      return {
        type: "im:deliver:result" as const,
        requestId: request.requestId,
        deliveryId: request.deliveryId,
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        status: "accepted" as const,
        turnId,
      };
    },
  );
  const worker = new ImDeliveryWorker({
    database: f.client.database,
    domain: {
      requestReconcile: vi.fn((_computerId, _instanceId, _request, onDispatched) => {
        onDispatched?.();
        return Promise.resolve({ status: "ready" });
      }),
      requestDelivery,
    } as never,
    registry: {
      canReceiveSnapshot: () => true,
      currentInstanceId: () => f.computer.currentInstanceId,
      supportsCapability: () => false,
      capabilityVersion: () => 2,
    } as never,
    assembler: {
      assembleForSession: vi.fn(async (sessionId: string) => ({
        agentId: f.agent.id,
        provider: "codex",
        contextTrees: [],
        instructions: { platform: "", agent: "" },
        revision: { agent: { id: f.agent.id, sequence: 1 }, session: { id: sessionId, sequence: 1 } },
        execution: { approvalPolicy: "never", networkAccess: false },
        workspace: { workspaceId: f.agent.id, mode: "empty_on_create", sharing: "agent" },
      })),
    } as never,
    now: () => f.clock.now,
    intervalMs: 60000,
  });
  try {
    for (let i = 0; i <= count; i += 1) await worker.runOnce();
  } finally {
    worker.stop();
  }
  expect(requestDelivery).toHaveBeenCalledTimes(count);
  return requestDelivery.mock.calls.map((call) => call[2]);
}
