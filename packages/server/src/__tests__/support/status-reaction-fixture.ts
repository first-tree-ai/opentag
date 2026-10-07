import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type DirectImMessageDeliveryRequest, type TurnReportRequest } from "@opentag/shared";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";

export async function createStatusReactionFixture(database: DatabaseClient) {
  const now = new Date("2026-10-07T12:00:00Z");
  const accountId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const instanceId = randomUUID();
  await database.insert(users).values({ id: accountId, email: `${accountId}@example.com`, displayName: "User" });
  await database.insert(computers).values({
    id: computerId,
    ownerAccountId: accountId,
    currentInstallationId: randomUUID(),
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
  });
  await database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: "codex",
  });
  await database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `app-${bindingId}`,
    externalBotId: "bot",
    encryptedCredential: "encrypted-test-value",
    credentialGeneration: 1,
    credentialSchemaVersion: 1,
    activatedAt: now,
  });
  await database
    .insert(sessions)
    .values({ id: sessionId, imBindingId: bindingId, channelId: "chat", conversationKind: "dm", kind: "channel" });
  await database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  await database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: "chat",
    externalMessageId: "om_message",
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "human",
    content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
    providerContext: { provider: "feishu" },
    occurredAt: now,
  });
  await database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    placementGeneration: 1,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const request: DirectImMessageDeliveryRequest = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: messageId,
    sessionId,
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "feishu",
        teamBrand: "feishu",
        appId: `app-${bindingId}`,
        botOpenId: "bot",
        chatId: "chat",
        messageId: "om_message",
      },
    },
    runtime: {
      contextTrees: [],
      revision: { agent: { sequence: 1, id: agentId }, session: { sequence: 1, id: sessionId } },
      agentId,
      provider: "codex",
      instructions: { platform: "", agent: "", session: "" },
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
    },
  };
  const context: RuntimeBusinessContext = {
    computerId,
    instanceId,
    installationId: randomUUID(),
    signal: new AbortController().signal,
  };
  return { now, bindingId, messageId, deliveryId, request, context };
}

export function statusReactionReport(
  fixture: Awaited<ReturnType<typeof createStatusReactionFixture>>,
  outcome: TurnReportRequest["outcome"] = "completed",
): TurnReportRequest {
  const body = {
    deliveryId: fixture.deliveryId,
    turnId: "turn-status",
    sessionId: fixture.request.sessionId,
    agentId: fixture.request.agentId,
    placementGeneration: 1,
    outcome,
    executionEffects: "not_started" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
