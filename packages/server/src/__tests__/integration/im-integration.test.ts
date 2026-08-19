import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { NormalizedInboundImEvent } from "@opentag/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import {
  computers,
  feishuConnectionLeases,
  feishuSetupAttempts,
  imConversations,
  imMessageDeliveries,
  imMessageResources,
  imMessages,
  integrations,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImMessageInbox, ImResourceService, OutboundMessageService } from "../../services/im/index.js";
import {
  type FeishuAdapter,
  FeishuConnectionManager,
  type FeishuRegistration,
  type FeishuRegistrationGateway,
  FeishuSetupService,
} from "../../services/integrations/feishu/index.js";
import { IntegrationService } from "../../services/integrations/index.js";
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

async function fixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    teamDisplayName: "Example",
    teamName: "example",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      id: crypto.randomUUID(),
      ownerUserId: bootstrap.userId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(client.database).createForTeam(bootstrap.userId, bootstrap.teamId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const integrationService = new IntegrationService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => new Date("2026-08-19T00:00:00.000Z"),
  });
  const integrationId = await integrationService.activateSlack({
    agentId: agent.id,
    appId: "A1",
    teamId: "T1",
    botUserId: "U_BOT",
    grantedBotScopes: [
      "chat:write",
      "app_mentions:read",
      "im:history",
      "channels:history",
      "groups:history",
      "mpim:history",
    ],
    botAccessToken: "xoxb-secret",
    signingSecret: "signing-secret",
    installedAt: new Date("2026-08-19T00:00:00.000Z"),
  });
  return { ...client, agent, bootstrap, computer, integrationId, integrationService };
}

async function unboundFixture() {
  await migrateDatabase(databaseUrl, migrationsFolder);
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    teamDisplayName: "Example",
    teamName: "example",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      id: crypto.randomUUID(),
      ownerUserId: bootstrap.userId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(client.database).createForTeam(bootstrap.userId, bootstrap.teamId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const integrationService = new IntegrationService(client.database, cipher);
  return { ...client, agent, bootstrap, computer, cipher, integrationService };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function inbound(
  providerEventId: string,
  operation: "created" | "edited" | "deleted" = "created",
): NormalizedInboundImEvent {
  return {
    providerEventId,
    externalAppId: "A1",
    externalTenantId: "T1",
    conversation: { externalId: "C1", kind: "channel" as const },
    message: {
      externalId: "1000.1",
      revisionKey: `${operation}:${providerEventId}`,
      operation,
      threadKey: null,
      replyToExternalId: null,
      author: { externalId: "U_HUMAN", kind: "human" as const, displayName: "Human" },
      occurredAt: new Date("2026-08-19T00:00:01.000Z"),
      content: {
        version: 1 as const,
        fallbackText: "hello",
        blocks: [{ type: "text" as const, text: "hello" }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [{ externalId: "U_BOT", displayName: "Assistant" }],
  };
}

describe("IM Integration persistence", () => {
  it("migrates the authority tables with partial Session uniqueness and self-scope provenance", async () => {
    const value = await fixture();
    try {
      const indexes = await value.sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where indexname in ('sessions_active_channel_unique', 'sessions_active_thread_unique')
        order by indexname
      `;
      expect(indexes).toHaveLength(2);
      expect(indexes.every((index) => index.indexdef.includes("ended_at IS NULL"))).toBe(true);
      const [creatorForeignKey] = await value.sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'sessions_created_by_session_id_sessions_id_fk'
      `;
      expect(creatorForeignKey?.definition).toContain("REFERENCES sessions(id)");
    } finally {
      await value.sql.end();
    }
  });

  it("atomically deduplicates provider events and converges duplicate Slack message event types", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database, { now: () => new Date("2026-08-19T00:00:02.000Z") });
      const first = await inbox.ingest(value.integrationId, 1, inbound("Ev1"));
      const retry = await inbox.ingest(value.integrationId, 1, inbound("Ev1"));
      const companion = await inbox.ingest(value.integrationId, 1, inbound("Ev2"));
      expect(first.deliveryIds).toHaveLength(1);
      expect(retry).toEqual({ duplicate: true, deliveryIds: [] });
      expect(companion).toMatchObject({ duplicate: true, messageId: first.messageId, revision: 1, deliveryIds: [] });
      expect(await value.database.select().from(imMessages)).toHaveLength(1);
      expect(await value.database.select().from(imMessageDeliveries)).toHaveLength(1);
      expect(await value.database.select().from(sessions)).toHaveLength(1);
      expect(await value.database.select().from(sessionPlacements)).toMatchObject([
        { computerId: value.computer.id, generation: 1 },
      ]);

      const edit = await inbox.ingest(value.integrationId, 1, inbound("Ev3", "edited"));
      expect(edit).toMatchObject({ duplicate: false, revision: 2 });
      expect(await value.database.select().from(imMessageDeliveries)).toHaveLength(2);
    } finally {
      await value.sql.end();
    }
  });

  it("keeps pending delivery durable across a failed worker and accepts it after restart", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-worker"));
      const registry = { currentInstanceId: () => instanceId };
      const failedDomain = {
        requestReconcile: vi.fn().mockRejectedValue(new Error("runtime unavailable")),
        requestDelivery: vi.fn(),
      };
      await new ImDeliveryWorker({
        database: value.database,
        registry: registry as never,
        domain: failedDomain as never,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]?.state).toBe("pending");

      await value.database.update(imMessageDeliveries).set({ nextAttemptAt: new Date(0) });
      const recoveredDomain = {
        requestReconcile: vi.fn().mockResolvedValue({ status: "ready" }),
        requestDelivery: vi.fn().mockResolvedValue({ status: "accepted", turnId: crypto.randomUUID() }),
      };
      await new ImDeliveryWorker({
        database: value.database,
        registry: registry as never,
        domain: recoveredDomain as never,
      }).runOnce();
      expect((await value.database.select().from(imMessageDeliveries))[0]).toMatchObject({ state: "accepted" });
      expect(recoveredDomain.requestDelivery).toHaveBeenCalledWith(
        value.computer.id,
        instanceId,
        expect.objectContaining({
          imMessageRevision: 1,
          attention: "direct",
          runtime: expect.objectContaining({
            allowedTools: ["opentag_message_send", "opentag_message_reply", "opentag_message_react"],
          }),
        }),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("fences stale placement generations and ends chat Sessions only on explicit replacement", async () => {
    const value = await fixture();
    try {
      const inbox = new ImMessageInbox(value.database);
      await inbox.ingest(value.integrationId, 1, inbound("Ev1"));
      const [session] = await value.database.select().from(sessions);
      if (!session) throw new Error("Session fixture was not created");
      const sessionService = new SessionService(value.database);
      await expect(sessionService.assertPlacement(session.id, value.computer.id, 1)).resolves.toBeUndefined();
      await sessionService.movePlacement(session.id, value.computer.id);
      await expect(sessionService.assertPlacement(session.id, value.computer.id, 1)).rejects.toMatchObject({
        code: "SESSION_PLACEMENT_STALE",
      });

      await value.integrationService.activateSlack({
        agentId: value.agent.id,
        appId: "A2",
        teamId: "T1",
        botUserId: "U_BOT_2",
        grantedBotScopes: [
          "chat:write",
          "app_mentions:read",
          "im:history",
          "channels:history",
          "groups:history",
          "mpim:history",
        ],
        botAccessToken: "xoxb-replacement",
        signingSecret: "replacement-secret",
        installedAt: new Date(),
      });
      expect(
        (await value.database.select().from(sessions).where(eq(sessions.id, session.id)))[0]?.endedAt,
      ).not.toBeNull();
      expect(await value.database.select().from(imMessages)).toHaveLength(1);
      expect((await value.database.select().from(integrations))[0]?.disabledAt).toBeNull();
      const rebound = inbound("Ev2");
      rebound.externalAppId = "A2";
      rebound.message.externalId = "1000.2";
      rebound.mentions = [{ externalId: "U_BOT_2", displayName: "Assistant" }];
      await inbox.ingest(value.integrationId, 2, rebound);
      const sessionRows = await value.database.select().from(sessions);
      expect(sessionRows).toHaveLength(2);
      expect(sessionRows.find((row) => row.id !== session.id)?.endedAt).toBeNull();
      expect((await value.database.select().from(imConversations))[0]?.detachedAt).toBeNull();
    } finally {
      await value.sql.end();
    }
  });

  it("authorizes lazy resources by Session placement and preserves oversized messages", async () => {
    const value = await fixture();
    try {
      const instanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: instanceId })
        .where(eq(computers.id, value.computer.id));
      const event = inbound("Ev-resource");
      event.message.resources = [
        {
          providerResourceKey: "F1",
          kind: "file",
          filename: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
        },
        {
          providerResourceKey: "F2",
          kind: "file",
          filename: "oversized.bin",
          mediaType: "application/octet-stream",
          sizeBytes: 25 * 1024 * 1024 + 1,
        },
      ];
      await new ImMessageInbox(value.database).ingest(value.integrationId, 1, event);
      const resourceRows = await value.database.select().from(imMessageResources).orderBy(imMessageResources.ordinal);
      const [session] = await value.database.select().from(sessions);
      if (!session || !resourceRows[0] || !resourceRows[1]) throw new Error("Resource fixture was not created");
      expect(resourceRows.map((resource) => resource.availability)).toEqual(["available", "too_large"]);

      const resources = new ImResourceService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTenantId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({
          stream: Readable.from(Buffer.from("hello world!")),
          filename: "report.txt",
          mediaType: "text/plain",
          sizeBytes: 12,
        }),
      }));
      const runtimeScope = {
        sessionId: session.id,
        computerId: value.computer.id,
        instanceId,
        placementGeneration: 1,
      };
      const opened = await resources.open(value.bootstrap.userId, runtimeScope, resourceRows[0].id);
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("hello world!");
      await expect(resources.open(crypto.randomUUID(), runtimeScope, resourceRows[0].id)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        resources.open(value.bootstrap.userId, { ...runtimeScope, placementGeneration: 2 }, resourceRows[0].id),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(resources.open(value.bootstrap.userId, runtimeScope, resourceRows[1].id)).rejects.toMatchObject({
        statusCode: 413,
      });
    } finally {
      await value.sql.end();
    }
  });

  it("guards outbound writes by immutable request, latest input, and placement authority", async () => {
    const value = await fixture();
    try {
      const computerInstanceId = crypto.randomUUID();
      await value.database
        .update(computers)
        .set({ currentInstanceId: computerInstanceId })
        .where(eq(computers.id, value.computer.id));
      const admitted = await new ImMessageInbox(value.database).ingest(value.integrationId, 1, inbound("Ev-outbound"));
      const [session] = await value.database.select().from(sessions);
      if (!session || !admitted.messageId) throw new Error("Outbound fixture was not created");
      let sends = 0;
      let rateLimited = false;
      const providerRelease = deferred<void>();
      const outbound = new OutboundMessageService(value.database, async () => ({
        provider: "slack" as const,
        validateBinding: async () => ({ externalAppId: "A1", externalTenantId: "T1", externalBotId: "U_BOT" }),
        normalizeInbound: () => [],
        send: async () => {
          sends += 1;
          await providerRelease.promise;
          if (rateLimited) {
            return {
              ok: false as const,
              category: "rate_limited" as const,
              code: "ratelimited",
              retryAfterSeconds: 17,
            };
          }
          return { ok: true as const, externalMessageId: "1000.2", occurredAt: new Date() };
        },
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }));
      const requestId = crypto.randomUUID();
      const request = {
        requestId,
        sessionId: session.id,
        agentId: value.agent.id,
        computerId: value.computer.id,
        computerInstanceId,
        placementGeneration: 1,
        expectedLatestImMessageId: admitted.messageId,
        operation: "send" as const,
        content: {
          version: 1 as const,
          fallbackText: "answer",
          blocks: [{ type: "text" as const, text: "answer" }],
          truncated: false,
        },
      };
      const firstWrite = outbound.execute(request);
      const concurrentWrite = outbound.execute(request);
      await expect.poll(() => sends).toBe(1);
      providerRelease.resolve();
      await expect(firstWrite).resolves.toMatchObject({ state: "succeeded" });
      await expect(concurrentWrite).resolves.toMatchObject({ state: "succeeded" });
      expect(sends).toBe(1);
      rateLimited = true;
      const rateLimitedRequest = { ...request, requestId: crypto.randomUUID() };
      await expect(outbound.execute(rateLimitedRequest)).resolves.toEqual({
        state: "transient_failed",
        code: "ratelimited",
        retryAfterSeconds: 17,
      });
      await expect(outbound.execute(rateLimitedRequest)).resolves.toEqual({
        state: "transient_failed",
        code: "ratelimited",
        retryAfterSeconds: 17,
      });
      expect(sends).toBe(2);
      await expect(
        outbound.execute({ ...request, content: { ...request.content, fallbackText: "different" } }),
      ).rejects.toThrow("OUTBOUND_REQUEST_CONFLICT");
      await expect(
        outbound.execute({
          ...request,
          requestId: crypto.randomUUID(),
          expectedLatestImMessageId: crypto.randomUUID(),
        }),
      ).rejects.toThrow("OUTBOUND_LATEST_MESSAGE_STALE");

      const internal = await new SessionService(value.database).createInternalSession(session.id);
      await expect(
        outbound.execute({ ...request, requestId: crypto.randomUUID(), sessionId: internal.session.id }),
      ).rejects.toThrow("OUTBOUND_SESSION_UNAUTHORIZED");
    } finally {
      await value.sql.end();
    }
  });

  it("reuses one Feishu QR attempt and activates only after candidate validation", async () => {
    const value = await unboundFixture();
    try {
      const completion = deferred<{
        appId: string;
        appSecret: string;
        tenantBrand: "feishu";
        requestedScopes: string[];
      }>();
      let aborted = false;
      const registration: FeishuRegistration = {
        qrReady: Promise.resolve({
          url: "https://open.feishu.cn/qr/example",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        result: completion.promise,
        abort: () => {
          aborted = true;
        },
      };
      const gateway: FeishuRegistrationGateway = { start: () => registration };
      let validations = 0;
      const instanceId = crypto.randomUUID();
      const manager = new FeishuConnectionManager({
        database: value.database,
        inbox: new ImMessageInbox(value.database),
        instanceId,
        integrations: value.integrationService,
        createAdapter: (input) =>
          ({
            channel: {
              on: () => () => undefined,
              disconnect: async () => undefined,
            },
            validateBinding: async () => {
              validations += 1;
              return {
                externalAppId: input.appId,
                externalTenantId: input.appId,
                externalBotId: "ou_bot",
              };
            },
            listGrantedTenantScopes: async () => [
              "im:message:send_as_bot",
              "im:message.p2p_msg:readonly",
              "im:message.group_at_msg:readonly",
              "im:message.group_msg",
            ],
          }) as unknown as FeishuAdapter,
        maintenanceMs: 1_000_000,
      });
      const setup = new FeishuSetupService({
        database: value.database,
        cipher: value.cipher,
        instanceId,
        integrations: value.integrationService,
        registrations: gateway,
        activation: manager,
      });
      const first = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      const second = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      expect(second.id).toBe(first.id);
      expect(first).toMatchObject({ state: "awaiting_user", qrUrl: "https://open.feishu.cn/qr/example" });
      expect(aborted).toBe(false);

      completion.resolve({
        appId: "cli_1",
        appSecret: "secret",
        tenantBrand: "feishu",
        requestedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      await expect.poll(async () => (await setup.get(value.bootstrap.userId, first.id)).state).toBe("succeeded");
      expect(validations).toBe(1);
      expect(await value.integrationService.getForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
        identity: { provider: "feishu", appId: "cli_1", botOpenId: "ou_bot", tenantKey: null },
      });
      const [stored] = await value.database.select().from(feishuSetupAttempts);
      expect(stored?.encryptedQrContext).not.toContain("open.feishu.cn");
      await manager.stop();
    } finally {
      await value.sql.end();
    }
  });

  it("does not persist a Feishu binding when the tenant grant omits a requested scope", async () => {
    const value = await unboundFixture();
    const manager = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId: crypto.randomUUID(),
      integrations: value.integrationService,
      createAdapter: () =>
        ({
          channel: { disconnect: async () => undefined },
          validateBinding: async () => ({
            externalAppId: "cli_missing_scope",
            externalTenantId: "tenant",
            externalBotId: "ou_bot",
          }),
          listGrantedTenantScopes: async () => ["im:message:send_as_bot"],
        }) as unknown as FeishuAdapter,
      maintenanceMs: 1_000_000,
    });
    try {
      await expect(
        manager.activate({
          agentId: value.agent.id,
          appId: "cli_missing_scope",
          appSecret: "secret",
          tenantBrand: "feishu",
          requestedScopes: ["im:message:send_as_bot", "im:message.group_msg"],
        }),
      ).rejects.toThrow("FEISHU_SCOPE_REAUTH_REQUIRED");
      await expect(
        value.integrationService.getForAgent(value.bootstrap.userId, value.agent.id),
      ).resolves.toBeUndefined();
    } finally {
      await manager.stop();
      await value.sql.end();
    }
  });

  it("fails reauthorization without an existing binding and lets cancel win before activation", async () => {
    const value = await unboundFixture();
    const completion = deferred<{
      appId: string;
      appSecret: string;
      tenantBrand: "feishu";
      requestedScopes: string[];
    }>();
    const start = vi.fn(() => ({
      qrReady: Promise.resolve({ url: "https://open.feishu.cn/qr/cancel", expiresAt: new Date(Date.now() + 60_000) }),
      result: completion.promise,
      abort: vi.fn(),
    }));
    const activateAtomicAttempt = vi.fn();
    const setup = new FeishuSetupService({
      database: value.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      integrations: value.integrationService,
      registrations: { start },
      activation: { activateAtomicAttempt },
    });
    try {
      await expect(setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize")).rejects.toThrow(
        "FEISHU_REAUTHORIZATION_REQUIRES_BINDING",
      );
      expect(start).not.toHaveBeenCalled();
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      await expect(setup.cancel(value.bootstrap.userId, attempt.id)).resolves.toMatchObject({ state: "canceled" });
      completion.resolve({
        appId: "cli_canceled",
        appSecret: "secret",
        tenantBrand: "feishu",
        requestedScopes: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(activateAtomicAttempt).not.toHaveBeenCalled();
      await expect(
        value.integrationService.getForAgent(value.bootstrap.userId, value.agent.id),
      ).resolves.toBeUndefined();
    } finally {
      await value.sql.end();
    }
  });

  it("fences the previous Feishu Channel owner when reauthorization moves an active lease", async () => {
    const value = await unboundFixture();
    const firstInstanceId = crypto.randomUUID();
    const secondInstanceId = crypto.randomUUID();
    const disconnects: string[] = [];
    const createAdapter = (input: { appId: string; appSecret: string; tenantKey: string | null }) =>
      ({
        provider: "feishu" as const,
        channel: {
          on: () => () => undefined,
          disconnect: async () => {
            disconnects.push(input.appId);
          },
        },
        validateBinding: async () => ({
          externalAppId: input.appId,
          externalTenantId: input.tenantKey ?? input.appId,
          externalBotId: "ou_bot",
        }),
        listGrantedTenantScopes: async () => [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
        normalizeInbound: () => [],
        send: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        react: async () => ({ ok: false as const, category: "unknown" as const, code: "unused" }),
        fetchResource: async () => ({ stream: Readable.from(Buffer.alloc(0)) }),
      }) as unknown as FeishuAdapter;
    const first = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId: firstInstanceId,
      integrations: value.integrationService,
      createAdapter,
      maintenanceMs: 1_000_000,
    });
    const second = new FeishuConnectionManager({
      database: value.database,
      inbox: new ImMessageInbox(value.database),
      instanceId: secondInstanceId,
      integrations: value.integrationService,
      createAdapter,
      maintenanceMs: 1_000_000,
    });
    try {
      first.start();
      await first.activate({
        agentId: value.agent.id,
        appId: "cli_lease",
        appSecret: "secret",
        tenantBrand: "feishu",
        requestedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      const [initial] = await value.database.select().from(feishuConnectionLeases);
      expect(initial).toMatchObject({ holderInstanceId: firstInstanceId, fencingEpoch: 1 });
      if (!initial) throw new Error("Lease fixture was not created");
      second.start();
      await second.activate({
        agentId: value.agent.id,
        appId: "cli_lease",
        appSecret: "secret-rotated",
        tenantBrand: "feishu",
        requestedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      const [claimed] = await value.database.select().from(feishuConnectionLeases);
      expect(claimed).toMatchObject({ holderInstanceId: secondInstanceId, fencingEpoch: 2 });
      await first.maintain();
      expect(disconnects).toContain("cli_lease");
    } finally {
      await first.stop();
      await second.stop();
      await value.sql.end();
    }
  });

  it("checks the Feishu lease holder and epoch inside the admission transaction", async () => {
    const value = await unboundFixture();
    try {
      const integrationId = await value.integrationService.activateFeishu({
        agentId: value.agent.id,
        appId: "cli_fence",
        appSecret: "secret",
        tenantKey: null,
        botOpenId: "ou_bot",
        tenantBrand: "feishu",
        grantedScopes: [
          "im:message:send_as_bot",
          "im:message.p2p_msg:readonly",
          "im:message.group_at_msg:readonly",
          "im:message.group_msg",
        ],
      });
      const staleHolder = crypto.randomUUID();
      const currentHolder = crypto.randomUUID();
      await value.database.insert(feishuConnectionLeases).values({
        integrationId,
        holderInstanceId: currentHolder,
        fencingEpoch: 2,
        expiresAt: new Date(Date.now() + 60_000),
        observedConnectedAt: new Date(),
        observedAt: new Date(),
      });
      const fenceAcquired = deferred<void>();
      const releaseAdmission = deferred<void>();
      const inbox = new ImMessageInbox(value.database, {
        afterAdmissionFence: async () => {
          fenceAcquired.resolve();
          await releaseAdmission.promise;
        },
      });
      await expect(
        inbox.ingest(
          integrationId,
          1,
          { ...inbound("Ev-stale-fence"), externalAppId: "cli_fence" },
          {
            provider: "feishu",
            holderInstanceId: staleHolder,
            fencingEpoch: 1,
          },
        ),
      ).rejects.toThrow("FEISHU_CONNECTION_LEASE_STALE");

      const admission = inbox.ingest(
        integrationId,
        1,
        { ...inbound("Ev-current-fence"), externalAppId: "cli_fence" },
        {
          provider: "feishu",
          holderInstanceId: currentHolder,
          fencingEpoch: 2,
        },
      );
      await fenceAcquired.promise;
      const takeoverHolder = crypto.randomUUID();
      let takeoverSettled = false;
      const takeover = value.database
        .update(feishuConnectionLeases)
        .set({ holderInstanceId: takeoverHolder, fencingEpoch: 3, expiresAt: new Date(Date.now() + 60_000) })
        .where(eq(feishuConnectionLeases.integrationId, integrationId))
        .then(() => {
          takeoverSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(takeoverSettled).toBe(false);
      releaseAdmission.resolve();
      await expect(admission).resolves.toMatchObject({ duplicate: false });
      await takeover;
      await expect(
        new ImMessageInbox(value.database).ingest(
          integrationId,
          1,
          { ...inbound("Ev-after-takeover"), externalAppId: "cli_fence" },
          {
            provider: "feishu",
            holderInstanceId: currentHolder,
            fencingEpoch: 2,
          },
        ),
      ).rejects.toThrow("FEISHU_CONNECTION_LEASE_STALE");
    } finally {
      await value.sql.end();
    }
  });
});
