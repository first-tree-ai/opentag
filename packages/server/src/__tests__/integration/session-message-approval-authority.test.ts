import type { RuntimeApprovalRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { loadApprovalAuthority } from "../../runtime/approval-authority.js";
import { AgentService } from "../../services/agents/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(testDatabase.databaseUrl);
  const { database } = client;
  const admin = await bootstrapInitialAdmin(database, { displayName: "Admin", email: "admin@example.com" });
  const instanceId = crypto.randomUUID();
  const [computer] = await database
    .insert(computers)
    .values({
      ownerAccountId: admin.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
      currentInstanceId: instanceId,
      currentConnectionId: "socket-1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture missing");
  const agent = await new AgentService(database).createForAccount(admin.userId, {
    computerId: computer.id,
    displayName: "Code Reviewer",
    name: "code-reviewer",
    runtimeProvider: "claude-code",
    runtimeConfig: { permissions: { approvalPolicy: "on-request", allowCommands: [] } },
  });
  const [binding] = await database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "cli_fixture",
      externalBotId: "ou_bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    })
    .returning();
  if (!binding) throw new Error("Binding fixture missing");
  const session = async (values: Partial<typeof sessions.$inferInsert>) => {
    const [row] = await database
      .insert(sessions)
      .values({ imBindingId: binding.id, channelId: "oc_dm", conversationKind: "dm", kind: "channel", ...values })
      .returning();
    if (!row) throw new Error("Session fixture missing");
    await database.insert(sessionPlacements).values({ sessionId: row.id, computerId: computer.id, generation: 1 });
    return row;
  };
  const humanMessage = async (sessionId: string, externalMessageId: string, author: string, receivedAt: Date) => {
    const [message] = await database
      .insert(imMessages)
      .values({
        imBindingId: binding.id,
        channelId: "oc_dm",
        externalMessageId,
        providerRevisionKey: "v1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: author,
        content: { version: 1, fallbackText: "work", blocks: [{ type: "text", text: "work" }], truncated: false },
        providerContext: { provider: "feishu" },
        occurredAt: receivedAt,
        receivedAt,
      })
      .returning();
    if (!message) throw new Error("Message fixture missing");
    await database.insert(imMessageDeliveries).values({
      messageId: message.id,
      sessionId,
      attention: "direct",
      state: "pending",
      placementGeneration: 1,
      expiresAt: new Date(receivedAt.getTime() + 60_000),
    });
  };
  const sessionMessage = async (sourceSessionId: string, targetSessionId: string, createdAt: Date) => {
    const id = crypto.randomUUID();
    await database.insert(sessionMessages).values({
      id,
      sourceSessionId,
      targetSessionId,
      content: "run a command",
      contentHash: "a".repeat(64),
      lastOutcome: "accepted",
      createdAt,
    });
    return id;
  };
  const context = { computerId: computer.id, instanceId, connectionId: "socket-1" };
  const request = (sessionId: string, messageId: string): RuntimeApprovalRequest => ({
    type: "approval:request",
    requestId: crypto.randomUUID(),
    sessionId,
    deliveryId: messageId,
    placementGeneration: 1,
    turnId: `session-message-${messageId}`,
    title: "Approve Bash",
    description: "ps -ax",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    source: "session-message",
  });
  return { ...client, binding, computer, context, humanMessage, request, session, sessionMessage };
}

describe("Session message approval authority", () => {
  it("routes a grandchild's request to the sender of the top visible Session's last message before it", async () => {
    const f = await fixture();
    try {
      const t0 = new Date(Date.now() - 60_000);
      const visible = await f.session({});
      await f.humanMessage(visible.id, "om_first", "ou_alice", new Date(t0.getTime() - 2_000));
      await f.humanMessage(visible.id, "om_second", "ou_bob", new Date(t0.getTime() - 1_000));
      const child = await f.session({ kind: "internal", createdBySessionId: visible.id });
      const grandchild = await f.session({ kind: "internal", createdBySessionId: child.id });
      const messageId = await f.sessionMessage(child.id, grandchild.id, t0);
      // A message after the Session message does not change who decides.
      await f.humanMessage(visible.id, "om_later", "ou_carol", new Date(t0.getTime() + 1_000));

      const scope = await loadApprovalAuthority(f.database, f.request(grandchild.id, messageId), f.context);
      expect(scope).toMatchObject({
        imBindingId: f.binding.id,
        visibleSessionId: visible.id,
        authority: {
          senderExternalId: "ou_bob",
          provider: "feishu",
          channelId: "oc_dm",
          externalMessageId: "om_second",
          generation: 1,
        },
      });
      expect(scope?.deadlineAt.getTime()).toBe(t0.getTime() + 24 * 60 * 60 * 1000);

      // A visible target is its own conversation.
      const toVisible = await f.sessionMessage(child.id, visible.id, t0);
      expect(
        (await loadApprovalAuthority(f.database, f.request(visible.id, toVisible), f.context))?.authority,
      ).toMatchObject({ senderExternalId: "ou_bob" });
    } finally {
      await f.sql.end();
    }
  });

  it("refuses requests that are not the live Run of an accepted message on this connection", async () => {
    const f = await fixture();
    try {
      const t0 = new Date(Date.now() - 60_000);
      const visible = await f.session({});
      await f.humanMessage(visible.id, "om_first", "ou_alice", new Date(t0.getTime() - 1_000));
      const child = await f.session({ kind: "internal", createdBySessionId: visible.id });
      const messageId = await f.sessionMessage(visible.id, child.id, t0);
      const valid = f.request(child.id, messageId);
      expect(await loadApprovalAuthority(f.database, valid, f.context)).toBeDefined();

      const refused = [
        { ...valid, turnId: "session-message-other" },
        { ...valid, deliveryId: "not-a-uuid", turnId: "session-message-not-a-uuid" },
        { ...valid, sessionId: visible.id },
        { ...valid, placementGeneration: 2 },
      ];
      for (const request of refused)
        expect(await loadApprovalAuthority(f.database, request, f.context)).toBeUndefined();
      expect(
        await loadApprovalAuthority(f.database, valid, { ...f.context, connectionId: "socket-2" }),
      ).toBeUndefined();

      // No human message before the Session message: nobody to ask.
      const early = await f.sessionMessage(visible.id, child.id, new Date(t0.getTime() - 5_000));
      expect(await loadApprovalAuthority(f.database, f.request(child.id, early), f.context)).toBeUndefined();

      // An ended Session on the chain leaves nobody to ask.
      await f.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, visible.id));
      expect(await loadApprovalAuthority(f.database, valid, f.context)).toBeUndefined();
    } finally {
      await f.sql.end();
    }
  });
});
