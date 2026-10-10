import { randomUUID } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  SLACK_REQUIRED_BOT_SCOPES,
  type TurnActivityRequest,
} from "@opentag/shared";
import { vi } from "vitest";
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
import type { ApplicationCipher } from "../../services/crypto.js";
import { SlackWorkingStore } from "../../services/im/slack-working-store.js";
import { SlackWorkingWorker, slackWorkingCredentialResolver } from "../../services/im/slack-working-worker.js";
import { ImBindingService } from "../../services/im-bindings/index.js";

export async function createSlackWorkingFixture(database: DatabaseClient, cipher: ApplicationCipher, now: () => Date) {
  const userId = randomUUID(),
    computerId = randomUUID(),
    agentId = randomUUID(),
    sessionId = randomUUID(),
    instanceId = randomUUID();
  await database.insert(users).values({ id: userId, email: `${userId}@example.test`, displayName: "Working" });
  await database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: randomUUID(),
    displayName: "Working",
    platform: "darwin",
    arch: "arm64",
    clientVersion: "test",
  });
  await database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: "working",
    displayName: "Working",
    runtimeProvider: "codex",
  });
  await new ImBindingService(database, cipher).activateSlack(
    {
      intent: "create",
      agentId,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "unit-secret",
      signingSecret: "unit-signing",
      installedAt: now(),
    },
    "B1",
  );
  const [binding] = await database.select().from(imBindings);
  if (!binding) throw new Error("missing binding");
  const bindingId = binding.id;
  await database
    .insert(sessions)
    .values({ id: sessionId, imBindingId: bindingId, channelId: "C1", conversationKind: "channel", kind: "channel" });
  await database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  const context: RuntimeBusinessContext = {
    computerId,
    installationId: randomUUID(),
    instanceId,
    signal: new AbortController().signal,
  };
  const store = new SlackWorkingStore(database, now);
  const calls: string[] = [];
  const api = {
    setThreadStatus: vi.fn(async (input: { status: string; token: string }) => {
      calls.push(input.status);
    }),
  };
  const worker = new SlackWorkingWorker({ store, api, token: slackWorkingCredentialResolver(database, cipher) });
  async function delivery(threadTs = "1.1", replyRole?: "observer") {
    const messageId = randomUUID(),
      deliveryId = randomUUID(),
      turnId = randomUUID(),
      requestId = randomUUID();
    const request: DirectImMessageDeliveryRequest = {
      type: "im:deliver",
      requestId,
      deliveryId,
      imMessageId: messageId,
      sessionId,
      agentId,
      placementGeneration: 1,
      attention: "direct",
      ...(replyRole ? { replyRole } : {}),
      content: {
        kind: "text",
        text: "work",
        providerRef: {
          provider: "slack",
          appId: "A1",
          teamId: "T1",
          botUserId: "U1",
          channelId: "C1",
          messageTs: "2.2",
          threadTs,
        },
      },
      runtime: {
        agentId,
        contextTrees: [],
        instructions: { agent: "A", platform: "P" },
        provider: "codex",
        revision: { agent: { id: randomUUID(), sequence: 1 }, session: { id: randomUUID(), sequence: 1 } },
        execution: { approvalPolicy: "never", networkAccess: true },
        workspace: { workspaceId: randomUUID(), mode: "empty_on_create", sharing: "agent" },
        budget: { maxDurationMs: 600_000 },
      },
    };
    await database.insert(imMessages).values({
      id: messageId,
      imBindingId: bindingId,
      channelId: "C1",
      externalMessageId: messageId,
      providerRevisionKey: "1",
      direction: "inbound",
      operation: "created",
      authorKind: "human",
      authorExternalId: "U2",
      content: { version: 1, fallbackText: "work", blocks: [], truncated: false },
      providerContext: { provider: "slack" },
      occurredAt: now(),
    });
    await database.insert(imMessageDeliveries).values({
      id: deliveryId,
      messageId,
      sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      dispatchRequestId: requestId,
      dispatchInputHash: "a".repeat(64),
      dispatchPayload: request,
      inputHash: "a".repeat(64),
      turnId,
      reportOwnerInstanceId: instanceId,
      acceptedAt: now(),
      expiresAt: new Date(now().getTime() + 600_000),
    });
    const frame: TurnActivityRequest = {
      type: "turn:activity",
      requestId: randomUUID(),
      deliveryId,
      sessionId,
      agentId,
      placementGeneration: 1,
      turnId,
      sequence: 1,
      phase: "running",
    };
    return { request, frame };
  }
  return { store, worker, calls, api, delivery, binding, context, sessionId };
}
