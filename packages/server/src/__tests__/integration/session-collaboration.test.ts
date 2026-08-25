import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import { computers, imBindings, sessionMessages, sessions, workspaceComputers } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { SessionService } from "../../services/sessions/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

let container: StartedPostgreSqlContainer;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  databaseUrl = container.getConnectionUri();
}, 120_000);

afterAll(async () => container.stop());

beforeEach(async () => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("drop schema if exists drizzle cascade");
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }
});

describe("Session collaboration authority", () => {
  it("creates the internal Session, placement, and initial durable fact atomically and idempotently", async () => {
    const fixture = await createFixture();
    try {
      const creator = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "channel" },
        "channel",
      );
      const messageId = randomUUID();
      const input = {
        creatorSessionId: creator.session.id,
        creatorComputerId: fixture.computerId,
        creatorWorkspaceComputerId: fixture.workspaceComputerId,
        creatorPlacementGeneration: creator.placement.generation,
        messageId,
        initialMessage: "Investigate the deployment failure",
        overrides: { model: "gpt-5.6-codex", reasoningEffort: "high", maxDurationMs: 60_000 },
      };
      const created = await fixture.sessions.createInternalSessionWithMessage(input);
      expect(created).toMatchObject({
        attemptCount: 1,
        deduplicated: false,
        session: {
          kind: "internal",
          createdBySessionId: creator.session.id,
          channelId: "C1",
          runtimeModel: "gpt-5.6-codex",
          runtimeReasoningEffort: "high",
          runtimeMaxDurationMs: 60_000,
        },
        placement: { computerId: fixture.computerId, generation: 1 },
        message: { id: messageId, lastOutcome: "unknown", attemptCount: 1 },
      });
      const recovered = await new SessionService(fixture.database).createInternalSessionWithMessage(input);
      expect(recovered.session.id).toBe(created.session.id);
      expect(recovered.attemptCount).toBe(2);
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 1, outcome: "accepted" })).toBe(
        false,
      );
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 2, outcome: "accepted" })).toBe(
        true,
      );

      const retried = await new SessionService(fixture.database).createInternalSessionWithMessage(input);
      expect(retried.session.id).toBe(created.session.id);
      expect(retried).toMatchObject({ attemptCount: null, deduplicated: true, message: { lastOutcome: "accepted" } });
      expect(await fixture.database.select().from(sessionMessages)).toHaveLength(1);
      expect((await fixture.database.select().from(sessions)).filter(({ kind }) => kind === "internal")).toHaveLength(
        1,
      );

      await expect(
        fixture.sessions.createInternalSessionWithMessage({ ...input, initialMessage: "Conflicting task" }),
      ).rejects.toMatchObject({ code: "SESSION_MESSAGE_CONFLICT" });
      await expect(
        fixture.sessions.createInternalSessionWithMessage({
          ...input,
          overrides: { ...input.overrides, maxDurationMs: 120_000 },
        }),
      ).rejects.toMatchObject({ code: "SESSION_MESSAGE_CONFLICT" });
    } finally {
      await fixture.sql.end();
    }
  });

  it("retries only explicit unknown or unreachable attempts and fences stale outcome writers", async () => {
    const fixture = await createFixture();
    try {
      const creator = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "dm" },
        "channel",
      );
      const child = await fixture.sessions.createInternalSessionWithMessage({
        creatorSessionId: creator.session.id,
        creatorComputerId: fixture.computerId,
        creatorWorkspaceComputerId: fixture.workspaceComputerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "Start",
      });
      const messageId = randomUUID();
      const input = {
        messageId,
        sourceSessionId: child.session.id,
        sourceComputerId: fixture.computerId,
        sourceWorkspaceComputerId: fixture.workspaceComputerId,
        sourcePlacementGeneration: 1,
        targetSessionId: creator.session.id,
        content: "Progress",
      };
      const first = await fixture.sessions.authorizeAndRecordMessage(input);
      expect(first.attemptCount).toBe(1);
      expect(
        await fixture.sessions.recordMessageOutcome({
          messageId,
          attemptCount: 1,
          outcome: "unreachable",
          errorCode: "runtime_unavailable",
        }),
      ).toBe(true);
      const second = await new SessionService(fixture.database).authorizeAndRecordMessage(input);
      expect(second.attemptCount).toBe(2);
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 1, outcome: "accepted" })).toBe(
        false,
      );
      expect(await fixture.sessions.recordMessageOutcome({ messageId, attemptCount: 2, outcome: "accepted" })).toBe(
        true,
      );
      const deduplicated = await fixture.sessions.authorizeAndRecordMessage(input);
      expect(deduplicated).toMatchObject({
        attemptCount: null,
        deduplicated: true,
        message: { lastOutcome: "accepted" },
      });
    } finally {
      await fixture.sql.end();
    }
  });

  it("rejects stale, ended, and cross-scope requests before recording a business message", async () => {
    const fixture = await createFixture();
    try {
      const source = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "channel" },
        "channel",
      );
      const otherScope = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C2", conversationKind: "channel" },
        "channel",
      );
      const staleId = randomUUID();
      await expect(
        fixture.sessions.authorizeAndRecordMessage({
          messageId: staleId,
          sourceSessionId: source.session.id,
          sourceComputerId: fixture.computerId,
          sourceWorkspaceComputerId: fixture.workspaceComputerId,
          sourcePlacementGeneration: 2,
          targetSessionId: source.session.id,
          content: "stale",
        }),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_STALE" });
      const crossScopeId = randomUUID();
      await expect(
        fixture.sessions.authorizeAndRecordMessage({
          messageId: crossScopeId,
          sourceSessionId: source.session.id,
          sourceComputerId: fixture.computerId,
          sourceWorkspaceComputerId: fixture.workspaceComputerId,
          sourcePlacementGeneration: 1,
          targetSessionId: otherScope.session.id,
          content: "cross scope",
        }),
      ).rejects.toMatchObject({ code: "SESSION_SCOPE_MISMATCH" });
      await fixture.sessions.end(otherScope.session.id);
      const endedId = randomUUID();
      await expect(
        fixture.sessions.authorizeAndRecordMessage({
          messageId: endedId,
          sourceSessionId: source.session.id,
          sourceComputerId: fixture.computerId,
          sourceWorkspaceComputerId: fixture.workspaceComputerId,
          sourcePlacementGeneration: 1,
          targetSessionId: otherScope.session.id,
          content: "ended",
        }),
      ).rejects.toMatchObject({ code: "SESSION_TARGET_UNAVAILABLE" });
      for (const messageId of [staleId, crossScopeId, endedId]) {
        expect(await fixture.database.select().from(sessionMessages).where(eq(sessionMessages.id, messageId))).toEqual(
          [],
        );
      }
    } finally {
      await fixture.sql.end();
    }
  });

  it("inherits a Thread scope through nested internal Sessions", async () => {
    const fixture = await createFixture();
    try {
      const thread = await fixture.sessions.ensureChatSession(
        { imBindingId: fixture.imBindingId, channelId: "C1", conversationKind: "channel" },
        "thread",
        "root-1",
      );
      const child = await fixture.sessions.createInternalSessionWithMessage({
        creatorSessionId: thread.session.id,
        creatorComputerId: fixture.computerId,
        creatorWorkspaceComputerId: fixture.workspaceComputerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "Child",
      });
      const grandchild = await fixture.sessions.createInternalSessionWithMessage({
        creatorSessionId: child.session.id,
        creatorComputerId: fixture.computerId,
        creatorWorkspaceComputerId: fixture.workspaceComputerId,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "Grandchild",
      });
      expect(child.session).toMatchObject({ channelId: "C1", conversationKind: "channel", threadKey: "root-1" });
      expect(grandchild.session).toMatchObject({
        createdBySessionId: child.session.id,
        channelId: "C1",
        conversationKind: "channel",
        threadKey: "root-1",
      });
    } finally {
      await fixture.sql.end();
    }
  });
});

async function createFixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    teamDisplayName: "Example",
    teamName: "example",
  });
  const computerId = randomUUID();
  await client.database.insert(computers).values({
    id: computerId,
    ownerUserId: bootstrap.userId,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.1",
  });
  const [workspaceComputer] = await client.database
    .insert(workspaceComputers)
    .values({
      workspaceId: bootstrap.teamId,
      computerId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
      enrolledByUserId: bootstrap.userId,
    })
    .returning({ id: workspaceComputers.id });
  if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
  const agent = await new AgentService(client.database).createForTeam(bootstrap.userId, bootstrap.teamId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId,
  });
  const [binding] = await client.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "slack",
      status: "active",
      externalAppId: "A1",
      externalTeamId: "T1",
      externalBotId: "B1",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "test-only",
      activatedAt: new Date(),
    })
    .returning({ id: imBindings.id });
  if (!binding) throw new Error("Binding fixture was not created");
  return {
    ...client,
    computerId,
    workspaceComputerId: workspaceComputer.id,
    imBindingId: binding.id,
    sessions: new SessionService(client.database),
  };
}
