import { randomUUID } from "node:crypto";
import { HTTP_PATHS, type RuntimeExecutionSource, SESSION_CLI_PROOF_HEADER } from "@opentag/shared";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { registerRuntimeSessionRoutes } from "../api/runtime-sessions.js";
import { computers, imBindings, imMessageDeliveries, imMessages } from "../db/schema/index.js";
import type { RuntimeExecutionRecord } from "../runtime-credentials/types.js";
import { AgentService } from "../services/agents/index.js";
import type { GitHubManagementService } from "../services/github/github-management-service.js";
import { GitHubRuntimePolicy } from "../services/github-proxy/runtime-policy.js";
import { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";
import { SessionService } from "../services/sessions/session-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit.close());

it("carries the Session CLI execution marker through source capture to next-round GitHub admission", async () => {
  const database = unit.database;
  const { userId } = await bootstrapInitialAdmin(database, { displayName: "Owner", email: "owner@example.test" });
  const instanceId = randomUUID();
  const [computer] = await database
    .insert(computers)
    .values({
      ownerAccountId: userId,
      currentInstallationId: randomUUID(),
      currentInstanceId: instanceId,
      displayName: "Fixture",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture missing");
  const agent = await new AgentService(database).createForAccount(userId, {
    name: "worker",
    displayName: "Worker",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const [binding] = await database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "fixture-app",
      externalBotId: "fixture-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "synthetic",
      activatedAt: new Date(),
    })
    .returning();
  if (!binding) throw new Error("Binding fixture missing");
  const sessions = new SessionService(database);
  const { session } = await sessions.ensureChatSession(
    { imBindingId: binding.id, channelId: "fixture", conversationKind: "dm" },
    "channel",
  );
  const [message] = await database
    .insert(imMessages)
    .values({
      imBindingId: binding.id,
      channelId: "fixture",
      externalMessageId: randomUUID(),
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "fixture-user",
      providerContext: { provider: "feishu", chatType: "private" },
      content: { version: 1, fallbackText: "task", blocks: [], truncated: false },
      occurredAt: new Date(),
    })
    .returning();
  if (!message) throw new Error("Message fixture missing");
  const [delivery] = await database
    .insert(imMessageDeliveries)
    .values({
      messageId: message.id,
      sessionId: session.id,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      executionOrigin: "local",
      inputHash: "a".repeat(64),
      turnId: randomUUID(),
      reportOwnerInstanceId: instanceId,
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  if (!delivery?.turnId) throw new Error("Delivery fixture missing");
  const source: RuntimeExecutionSource = { kind: "delivery", deliveryId: delivery.id, turnId: delivery.turnId };
  const execution = {
    executionId: randomUUID(),
    purpose: "execution",
    agentId: agent.id,
    sessionId: session.id,
    computerId: computer.id,
    instanceId,
    placementGeneration: 1,
    source,
  } as RuntimeExecutionRecord;
  let executionLive = true;
  const proofs = new SessionCliProofService(
    database,
    { currentInstanceId: () => instanceId, supportsCapability: () => true },
    new Uint8Array(32).fill(7),
    {
      executions: { get: (id) => (id === execution.executionId ? execution : undefined) },
      executionLive: async () => executionLive,
    },
  );
  const proof = await proofs.mint({
    sessionId: session.id,
    computerId: computer.id,
    placementGeneration: 1,
    connectionInstanceId: instanceId,
  });
  let status = "active";
  const policy = new GitHubRuntimePolicy({
    database,
    management: {
      getOverview: async () => ({
        connection: {
          id: randomUUID(),
          accountId: userId,
          status,
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          authorizationVersion: "1",
          credentialGeneration: "1",
        },
      }),
    } as unknown as GitHubManagementService,
  });
  const app = Fastify();
  registerRuntimeSessionRoutes(app, {
    proofs,
    sessions,
    collaboration: {
      create: async () => {
        throw new Error("Not exercised");
      },
      send: async (input, authenticated) => {
        const attempt = await sessions.authorizeAndRecordMessage({
          messageId: input.messageId,
          sourceSessionId: authenticated.sessionId,
          sourceInstallationId: authenticated.installationId,
          sourceConnectionInstanceId: authenticated.connectionInstanceId,
          sourceComputerId: authenticated.computerId,
          sourcePlacementGeneration: authenticated.placementGeneration,
          userTaskSource: authenticated.userTaskSource,
          targetSessionId: input.targetSessionId,
          content: input.message,
        });
        if (attempt.attemptCount === null) throw new Error("Message attempt missing");
        await sessions.recordMessageOutcome({
          messageId: input.messageId,
          attemptCount: attempt.attemptCount,
          outcome: "accepted",
        });
        return { status: "accepted", messageId: input.messageId, sessionId: input.targetSessionId };
      },
    },
  });
  const nextAdmission = async (executionId?: string) => {
    const messageId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.runtimeSessionMessages,
      headers: {
        [SESSION_CLI_PROOF_HEADER]: proof.token,
        ...(executionId ? { "x-opentag-execution-id": executionId } : {}),
      },
      payload: { messageId, targetSessionId: session.id, message: "continue" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });
    return policy.admit({
      accountId: userId,
      agentId: agent.id,
      sessionId: session.id,
      source: { kind: "session-message", messageId },
    });
  };
  try {
    expect(await nextAdmission(execution.executionId)).toBeDefined();
    expect(await nextAdmission()).toBeUndefined();
    expect(await nextAdmission(randomUUID())).toBeUndefined();
    executionLive = false;
    expect(await nextAdmission(execution.executionId)).toBeUndefined();
    executionLive = true;
    status = "revoked";
    expect(await nextAdmission(execution.executionId)).toBeUndefined();
  } finally {
    await app.close();
  }
});
