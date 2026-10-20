import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentSchedules,
  computers,
  imBindings,
  sessionDescendants,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { disableImBindingInTransaction, ImBindingService } from "../../services/im-bindings/index.js";
import { SessionService } from "../../services/sessions/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const start = "2026-10-19T00:00:00.000Z";
const later = "2026-10-19T01:00:00.000Z";
const newest = "2026-10-19T02:00:00.000Z";

async function fixture() {
  const client = createDatabaseClient(testDatabase.databaseUrl);
  const account = await bootstrapInitialAdmin(client.database, {
    displayName: "Owner",
    email: "sessions@example.test",
  });
  const installationId = crypto.randomUUID();
  const connectionInstanceId = crypto.randomUUID();
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: account.userId,
      currentInstallationId: installationId,
      currentInstanceId: connectionInstanceId,
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.1.2",
    })
    .returning();
  assert(computer);
  const agent = await new AgentService(client.database).createForAccount(account.userId, {
    name: "collaboration",
    displayName: "Collaboration",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const [binding] = await client.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "app-collaboration",
      externalBotId: "bot-collaboration",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "test-only",
      activatedAt: new Date(),
    })
    .returning();
  assert(binding);
  let now = new Date(start);
  const service = new SessionService(client.database, { now: () => new Date(now) });
  const root = await service.ensureChatSession(
    { imBindingId: binding.id, channelId: "C-collaboration", conversationKind: "channel" },
    "channel",
  );
  const createInput = (creatorSessionId: string, initialMessage: string, messageId = crypto.randomUUID()) => ({
    creatorSessionId,
    creatorInstallationId: installationId,
    creatorConnectionInstanceId: connectionInstanceId,
    creatorComputerId: computer.id,
    creatorPlacementGeneration: 1,
    messageId,
    initialMessage,
  });
  const sendInput = (sourceSessionId: string, targetSessionId: string) => ({
    sourceSessionId,
    sourceInstallationId: installationId,
    sourceConnectionInstanceId: connectionInstanceId,
    sourceComputerId: computer.id,
    sourcePlacementGeneration: 1,
    targetSessionId,
    messageId: crypto.randomUUID(),
    content: "Peer message",
  });
  return {
    ...client,
    accountId: account.userId,
    agent,
    computer,
    binding,
    service,
    root,
    createInput,
    sendInput,
    at: (value: string) => {
      now = new Date(value);
    },
    create: (parent: string, text = "Initial task") =>
      service.createInternalSessionWithMessage(createInput(parent, text)),
  };
}

async function listAll(service: SessionService, sourceSessionId: string, recursive: boolean) {
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await service.listInternalSessions(sourceSessionId, { recursive, limit: 1, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

describe("Internal Session creator activity", () => {
  it("includes the creator's new message in direct and recursive since filters", async () => {
    const value = await fixture();
    try {
      const parent = await value.create(value.root.session.id, "Parent task");
      value.at(later);
      const child = await value.create(parent.session.id, "Child task");
      const query = { since: "2026-10-19T00:30:00.000Z", limit: 20 };
      const direct = await value.service.listInternalSessions(value.root.session.id, { ...query, recursive: false });
      expect(direct.items).toEqual([
        expect.objectContaining({ sessionId: parent.session.id, lastMessageAt: later, taskPreview: "Parent task" }),
      ]);
      const recursive = await value.service.listInternalSessions(value.root.session.id, { ...query, recursive: true });
      expect(new Set(recursive.items.map((item) => item.sessionId))).toEqual(
        new Set([parent.session.id, child.session.id]),
      );
      expect(recursive.items.every((item) => item.lastMessageAt === later)).toBe(true);
    } finally {
      await value.sql.end();
    }
  });

  it("does not treat a descendant's later message as activity of an uninvolved ancestor", async () => {
    const value = await fixture();
    try {
      const parent = await value.create(value.root.session.id);
      value.at(later);
      const child = await value.create(parent.session.id);
      value.at(newest);
      const grandchild = await value.create(child.session.id);
      const direct = await value.service.listInternalSessions(value.root.session.id, { recursive: false, limit: 20 });
      expect(direct.items).toEqual([expect.objectContaining({ sessionId: parent.session.id, lastMessageAt: later })]);
      const since = "2026-10-19T01:30:00.000Z";
      expect(
        await value.service.listInternalSessions(value.root.session.id, { recursive: false, limit: 20, since }),
      ).toEqual({
        items: [],
      });
      const recursive = await value.service.listInternalSessions(value.root.session.id, {
        recursive: true,
        limit: 20,
        since,
      });
      expect(new Set(recursive.items.map((item) => item.sessionId))).toEqual(
        new Set([child.session.id, grandchild.session.id]),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("paginates direct and recursive results by original message time, message ID, then Session ID", async () => {
    const value = await fixture();
    try {
      const first = await value.create(value.root.session.id, "First task");
      const second = await value.create(value.root.session.id, "Second task");
      value.at(later);
      const lower = await value.service.createInternalSessionWithMessage(
        value.createInput(first.session.id, "Lower ID", "00000000-0000-4000-8000-000000000010"),
      );
      const higher = await value.service.createInternalSessionWithMessage(
        value.createInput(second.session.id, "Higher ID", "00000000-0000-4000-8000-000000000020"),
      );
      expect((await listAll(value.service, value.root.session.id, false)).map((item) => item.sessionId)).toEqual([
        second.session.id,
        first.session.id,
      ]);
      const expected = [
        ...[second.session.id, higher.session.id].sort().reverse(),
        ...[first.session.id, lower.session.id].sort().reverse(),
      ];
      const recursive = await listAll(value.service, value.root.session.id, true);
      expect(recursive.map((item) => item.sessionId)).toEqual(expected);
      expect(recursive.every((item) => item.lastMessageAt === later)).toBe(true);
    } finally {
      await value.sql.end();
    }
  });

  it("keeps newer activity and initial previews when an older creation is explicitly retried or receives an outcome", async () => {
    const value = await fixture();
    try {
      const parent = await value.create(value.root.session.id, "Parent preview");
      value.at(later);
      const input = value.createInput(parent.session.id, "Child preview");
      const child = await value.service.createInternalSessionWithMessage(input);
      value.at(newest);
      const message = await value.service.authorizeAndRecordMessage(
        value.sendInput(child.session.id, parent.session.id),
      );
      value.at("2026-10-19T03:00:00.000Z");
      const retry = await value.service.createInternalSessionWithMessage(input);
      expect(retry).toMatchObject({
        session: { id: child.session.id },
        attemptCount: 2,
        message: { createdAt: new Date(later) },
      });
      expect(
        await value.service.recordMessageOutcome({ messageId: input.messageId, attemptCount: 1, outcome: "accepted" }),
      ).toBe(false);
      expect(
        await value.service.recordMessageOutcome({ messageId: input.messageId, attemptCount: 2, outcome: "accepted" }),
      ).toBe(true);
      expect(
        await value.service.recordMessageOutcome({
          messageId: message.message.id,
          attemptCount: 1,
          outcome: "rejected",
        }),
      ).toBe(true);
      const deduplicated = await value.service.createInternalSessionWithMessage(input);
      expect(deduplicated).toMatchObject({ deduplicated: true, attemptCount: null });
      const items = await listAll(value.service, value.root.session.id, true);
      expect(items).toHaveLength(2);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: parent.session.id,
            lastMessageAt: newest,
            lastDeliveryOutcome: "rejected",
            taskPreview: "Parent preview",
          }),
          expect.objectContaining({
            sessionId: child.session.id,
            lastMessageAt: newest,
            lastDeliveryOutcome: "rejected",
            taskPreview: "Child preview",
          }),
        ]),
      );
    } finally {
      await value.sql.end();
    }
  });

  it("repairs a missing creator projection only through an explicit retry, using the original message time", async () => {
    const value = await fixture();
    try {
      const parent = await value.create(value.root.session.id);
      value.at(later);
      const input = value.createInput(parent.session.id, "Child task");
      const child = await value.service.createInternalSessionWithMessage(input);
      await value.database
        .update(sessionDescendants)
        .set({ lastMessageCreatedAt: new Date(start), lastMessageId: parent.message.id })
        .where(eq(sessionDescendants.descendantSessionId, parent.session.id));
      value.at(newest);
      await value.service.createInternalSessionWithMessage(input);
      const items = await listAll(value.service, value.root.session.id, true);
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.lastMessageAt === later)).toBe(true);
      expect(items.map((item) => item.sessionId)).toEqual([parent.session.id, child.session.id].sort().reverse());
    } finally {
      await value.sql.end();
    }
  });
});

async function waitForLock(observer: ReturnType<typeof createDatabaseClient>, pid: number) {
  await expect
    .poll(
      async () => {
        const [row] = await observer.sql<
          { waiting: boolean }[]
        >`select exists(select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock') as waiting`;
        return row?.waiting ?? false;
      },
      { timeout: 5_000, interval: 10 },
    )
    .toBe(true);
}

function outcome(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return "committed";
  let error = result.reason;
  while (error?.cause) error = error.cause;
  return error?.code ?? String(error);
}

describe("Session write authority lock order", () => {
  it.each(["send", "self-send", "create", "create retry", "send retry"] as const)(
    "commits a peer send concurrent with %s across independent connections",
    async (path) => {
      const isCreate = path.startsWith("create");
      const value = await fixture();
      const first = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const second = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const locked = deferred();
      const release = deferred();
      const pending: Promise<unknown>[] = [];
      let holding: Promise<unknown> | undefined;
      try {
        const a = await value.create(value.root.session.id);
        const b = await value.create(value.root.session.id);
        const inputA = value.sendInput(a.session.id, b.session.id);
        const inputB = value.sendInput(b.session.id, path === "self-send" ? b.session.id : a.session.id);
        const createInput = value.createInput(b.session.id, "Concurrent child");
        if (path === "create retry") await value.service.createInternalSessionWithMessage(createInput);
        if (path === "send retry") await value.service.authorizeAndRecordMessage(inputB);
        const [firstBackend] = await first.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const [secondBackend] = await second.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        assert(firstBackend && secondBackend);
        holding = gate.sql.begin(async (transaction) => {
          await transaction`select id from agents where id = ${value.agent.id} for update`;
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const sentA = Promise.allSettled([new SessionService(first.database).authorizeAndRecordMessage(inputA)]);
        pending.push(sentA);
        await waitForLock(value, firstBackend.pid);
        const serviceB = new SessionService(second.database);
        const sentB = Promise.allSettled([
          isCreate
            ? serviceB.createInternalSessionWithMessage(createInput)
            : serviceB.authorizeAndRecordMessage(inputB),
        ]);
        pending.push(sentB);
        await waitForLock(value, secondBackend.pid);
        release.resolve();
        await holding;
        const results = [...(await sentA), ...(await sentB)];
        expect(results.map(outcome)).toEqual(["committed", "committed"]);
        const recorded = await value.database.select().from(sessionMessages);
        const messageIds = new Set<string>([inputA.messageId, isCreate ? createInput.messageId : inputB.messageId]);
        expect(recorded.filter((message) => messageIds.has(message.id))).toHaveLength(2);
        expect(results[1]).toMatchObject({
          status: "fulfilled",
          value: { attemptCount: path.endsWith("retry") ? 2 : 1 },
        });
      } finally {
        release.resolve();
        await holding;
        await Promise.allSettled(pending);
        await Promise.all([first.sql.end(), second.sql.end(), gate.sql.end(), value.sql.end()]);
      }
    },
  );

  it.each(["rebind", "repair issuance", "repair exchange", "binding disable"] as const)(
    "finishes a send before a waiting %s without reversing the lock order",
    async (action) => {
      const value = await fixture();
      try {
        const child = await value.create(value.root.session.id);
        const repairInput = {
          mode: "repair" as const,
          targetComputerId: value.computer.id,
          targetAgentId: value.agent.id,
        };
        const code =
          action === "repair exchange"
            ? await new MachineAuthService(value.database).issueForAccount(value.accountId, repairInput)
            : undefined;
        const results = await raceAtRow(
          value,
          { computerId: value.computer.id },
          (client) =>
            new SessionService(client.database).authorizeAndRecordMessage(
              value.sendInput(child.session.id, value.root.session.id),
            ),
          (client) => {
            if (action === "rebind") {
              return new AgentService(client.database).rebindById(value.accountId, value.agent.id, value.computer.id);
            }
            if (action === "repair issuance") {
              return new MachineAuthService(client.database).issueForAccount(value.accountId, repairInput);
            }
            if (action === "binding disable") {
              return new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7))).disable(
                value.accountId,
                value.binding.id,
              );
            }
            assert(code);
            return new MachineAuthService(client.database).exchangeConnectCode({
              code: code.code,
              installationId: crypto.randomUUID(),
              displayName: "Repaired",
              platform: "linux",
              arch: "x64",
              clientVersion: "0.1.2",
            });
          },
        );
        expect(results.map(outcome)).toEqual(["committed", "committed"]);
        expect(results[0]).toMatchObject({ status: "fulfilled", value: { attemptCount: 1 } });
        if (action === "binding disable") {
          await expect(
            value.service.authorizeAndRecordMessage(value.sendInput(child.session.id, value.root.session.id)),
          ).rejects.toMatchObject({ code: "SESSION_SOURCE_UNAVAILABLE" });
        }
      } finally {
        await value.sql.end();
      }
    },
  );

  it("does not hold Sessions while a binding-first disable waits ahead of the send", async () => {
    const value = await fixture();
    try {
      const child = await value.create(value.root.session.id);
      const results = await raceAtRow(
        value,
        { bindingId: value.binding.id },
        (client) =>
          client.database.transaction((transaction) =>
            disableImBindingInTransaction(transaction, value.binding.id, new Date()),
          ),
        (client) =>
          new SessionService(client.database).authorizeAndRecordMessage(
            value.sendInput(child.session.id, value.root.session.id),
          ),
      );
      expect(results.map(outcome)).toEqual(["committed", "SESSION_SOURCE_UNAVAILABLE"]);
    } finally {
      await value.sql.end();
    }
  });

  it.each(["source", "target"] as const)("rechecks a concurrently moved %s placement", async (side) => {
    const value = await fixture();
    try {
      const child = await value.create(value.root.session.id);
      const [destination] = await value.database
        .insert(computers)
        .values({
          ownerAccountId: value.accountId,
          currentInstallationId: crypto.randomUUID(),
          currentInstanceId: crypto.randomUUID(),
          displayName: "Destination",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.1.2",
        })
        .returning();
      assert(destination);
      const results = await raceAtRow(
        value,
        { computerId: destination.id },
        (client) =>
          new SessionService(client.database).movePlacement(
            side === "source" ? child.session.id : value.root.session.id,
            destination.id,
          ),
        (client) =>
          new SessionService(client.database).authorizeAndRecordMessage(
            value.sendInput(child.session.id, value.root.session.id),
          ),
      );
      expect(results.map(outcome)).toEqual(["committed", side === "source" ? "SESSION_PLACEMENT_STALE" : "committed"]);
      if (side === "target") {
        expect(results[1]).toMatchObject({
          status: "fulfilled",
          value: {
            route: {
              targetComputerId: destination.id,
              targetInstallationId: destination.currentInstallationId,
              targetPlacementGeneration: 2,
            },
          },
        });
      }
    } finally {
      await value.sql.end();
    }
  });

  it.each(["ordinary", "scheduled"] as const)("commits %s admission ahead of a waiting send", async (kind) => {
    const value = await fixture();
    try {
      const child = await value.create(value.root.session.id);
      const [schedule] = await value.database
        .insert(agentSchedules)
        .values({
          agentId: value.agent.id,
          targetSessionId: child.session.id,
          name: "Concurrent admission",
          prompt: "Run the task",
          schedule: { kind: "every", intervalSeconds: 60, anchorAt: start },
          timezone: "UTC",
          enabled: true,
          nextTriggerAt: new Date(later),
        })
        .returning();
      assert(schedule);
      const resolved = await value.service.resolveScheduledMessageRoute(child.session.id, value.agent.id);
      assert(resolved.kind === "route");
      const results = await raceAtRow(
        value,
        { computerId: value.computer.id },
        (client) => {
          const service = new SessionService(client.database);
          const dispatch = async (onDispatched: () => void) => {
            onDispatched();
            return "sent";
          };
          return kind === "ordinary"
            ? service.withCollaborationDispatchAdmission(child.route, dispatch)
            : service.withScheduledDispatchAdmission(
                resolved.route,
                { scheduleId: schedule.id, revision: 1 },
                dispatch,
              );
        },
        (client) =>
          new SessionService(client.database).authorizeAndRecordMessage(
            value.sendInput(child.session.id, value.root.session.id),
          ),
      );
      expect(results.map(outcome)).toEqual(["committed", "committed"]);
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { admitted: true } });
    } finally {
      await value.sql.end();
    }
  });

  it.each(["binding", "channel", "conversation kind", "thread"] as const)(
    "rejects a foreign %s scope while the target Session and placement are locked elsewhere",
    async (difference) => {
      const value = await fixture();
      const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const request = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
      const locked = deferred();
      const release = deferred();
      let holding: Promise<unknown> | undefined;
      try {
        let bindingId = value.binding.id;
        if (difference === "binding") {
          const otherAgent = await new AgentService(value.database).createForAccount(value.accountId, {
            name: "other-agent",
            displayName: "Other",
            runtimeProvider: "codex",
            computerId: value.computer.id,
          });
          const [binding] = await value.database
            .insert(imBindings)
            .values({
              agentId: otherAgent.id,
              provider: "feishu",
              status: "active",
              externalAppId: "other-app",
              externalBotId: "other-bot",
              credentialSchemaVersion: 1,
              credentialGeneration: 1,
              encryptedCredential: "test-only",
              activatedAt: new Date(),
            })
            .returning();
          assert(binding);
          bindingId = binding.id;
        }
        const [target] = await value.database
          .insert(sessions)
          .values({
            imBindingId: bindingId,
            channelId: difference === "channel" ? "foreign-channel" : value.root.session.channelId,
            conversationKind: difference === "conversation kind" ? "dm" : "channel",
            kind: "internal",
            createdBySessionId: value.root.session.id,
            threadKey: difference === "thread" ? "foreign-thread" : null,
          })
          .returning();
        assert(target);
        await value.database
          .insert(sessionPlacements)
          .values({ sessionId: target.id, computerId: value.computer.id, generation: 1 });
        holding = gate.sql.begin(async (transaction) => {
          await transaction`select id from sessions where id = ${target.id} for update`;
          await transaction`select session_id from session_placements where session_id = ${target.id} for update`;
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        await request.sql`set statement_timeout = '2s'`;
        await expect(
          new SessionService(request.database).authorizeAndRecordMessage(
            value.sendInput(value.root.session.id, target.id),
          ),
        ).rejects.toMatchObject({ code: "SESSION_SCOPE_MISMATCH" });
      } finally {
        release.resolve();
        await holding;
        await Promise.all([request.sql.end(), gate.sql.end(), value.sql.end()]);
      }
    },
  );

  it("keeps source, target and message-conflict error precedence for send and create retry", async () => {
    const value = await fixture();
    try {
      const input = value.createInput(value.root.session.id, "Original task");
      const child = await value.service.createInternalSessionWithMessage(input);
      await value.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, child.session.id));
      await expect(
        value.service.createInternalSessionWithMessage({ ...input, initialMessage: "Conflict" }),
      ).rejects.toMatchObject({ code: "SESSION_MESSAGE_CONFLICT" });
      await expect(value.service.createInternalSessionWithMessage(input)).rejects.toMatchObject({
        code: "SESSION_TARGET_UNAVAILABLE",
      });
      const send = {
        ...value.sendInput(value.root.session.id, child.session.id),
        messageId: input.messageId,
        content: "Conflict",
      };
      await expect(value.service.authorizeAndRecordMessage(send)).rejects.toMatchObject({
        code: "SESSION_TARGET_UNAVAILABLE",
      });
      await expect(
        value.service.authorizeAndRecordMessage({ ...send, sourcePlacementGeneration: 99 }),
      ).rejects.toMatchObject({ code: "SESSION_PLACEMENT_STALE" });
      const [message] = await value.database
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.id, input.messageId));
      expect(message).toMatchObject({ content: "Original task", attemptCount: 1 });
    } finally {
      await value.sql.end();
    }
  });
});

async function raceAtRow(
  value: Awaited<ReturnType<typeof fixture>>,
  row: { computerId: string } | { bindingId: string },
  firstAction: (client: ReturnType<typeof createDatabaseClient>) => Promise<unknown>,
  secondAction: (client: ReturnType<typeof createDatabaseClient>) => Promise<unknown>,
) {
  const first = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const second = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const locked = deferred();
  const release = deferred();
  const pending: Promise<unknown>[] = [];
  let holding: Promise<unknown> | undefined;
  try {
    await first.sql`set statement_timeout = '10s'`;
    await second.sql`set statement_timeout = '10s'`;
    const [firstBackend] = await first.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const [secondBackend] = await second.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    assert(firstBackend && secondBackend);
    holding = gate.sql.begin(async (transaction) => {
      if ("computerId" in row) await transaction`select id from computers where id = ${row.computerId} for update`;
      else await transaction`select id from im_bindings where id = ${row.bindingId} for update`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const firstResult = Promise.allSettled([firstAction(first)]);
    pending.push(firstResult);
    await waitForLock(value, firstBackend.pid);
    const secondResult = Promise.allSettled([secondAction(second)]);
    pending.push(secondResult);
    await waitForLock(value, secondBackend.pid);
    release.resolve();
    await holding;
    return [...(await firstResult), ...(await secondResult)];
  } finally {
    release.resolve();
    await holding;
    await Promise.allSettled(pending);
    await Promise.all([first.sql.end(), second.sql.end(), gate.sql.end()]);
  }
}
