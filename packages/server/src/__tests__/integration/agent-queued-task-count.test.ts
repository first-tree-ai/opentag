/**
 * `queuedTaskCount` against the Task list, on messages written by the real inbox. Each scenario ingests its
 * messages through `ImMessageInbox` and reads both sides from PostgreSQL. A Turn's acceptance, report and a few
 * states no inbound message produces are written directly, in the shape the custody store leaves them.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { NormalizedInboundImEvent, ProviderInboundContext } from "@opentag/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imBindings, imMessageDeliveries, sessions } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { disableImBindingInTransaction } from "../../services/im-bindings/index.js";
import { TaskService } from "../../services/tasks/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const NOW = new Date("2026-11-03T00:00:00.000Z");
const REPORT_OWNER = "11111111-1111-4111-8111-111111111111";
const GROUP: ProviderInboundContext = { provider: "feishu", chatType: "group" };
const PRIVATE: ProviderInboundContext = { provider: "feishu", chatType: "p2p" };

let pg: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;

beforeAll(async () => {
  pg = await startMigratedTestDatabase();
  client = createDatabaseClient(pg.databaseUrl, { max: 1 });
}, 120_000);
beforeEach(async () => pg.reset());
afterAll(async () => {
  await client?.sql.end();
  await pg?.stop();
});

interface Send {
  id: string;
  thread?: string;
  direct?: boolean;
  kind?: "channel" | "dm";
  context?: ProviderInboundContext;
  revision?: string;
  occurredAt?: Date;
}

async function fixture(receiveMode: "mention_only" | "all_message") {
  const { userId } = await bootstrapInitialAdmin(client.database, { email: "root@example.test", displayName: "Root" });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: userId,
      currentInstallationId: randomUUID(),
      displayName: "Root",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.0.1",
    })
    .returning();
  assert(computer);
  const agents = new AgentService(client.database, { now: () => NOW });
  const created = await agents.createForAccount(userId, {
    name: "root",
    displayName: "Root",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const agent = await agents.updateById(userId, created.id, { expectedRevision: created.revision, receiveMode });
  const [binding] = await client.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "app",
      externalBotId: "bot",
      externalTeamBrand: "feishu",
      externalTeamId: "team",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "unused-fixture",
      activatedAt: NOW,
    })
    .returning();
  assert(binding);
  const bindingId = binding.id;

  let inboxNow = NOW;
  const inbox = new ImMessageInbox(client.database, { now: () => inboxNow });
  const receivedAt = (at: Date) => {
    inboxNow = at;
  };
  let sequence = 0;
  const send = async (message: Send) => {
    sequence += 1;
    const revision = message.revision;
    const event: NormalizedInboundImEvent = {
      providerEventId: `${message.id}-${revision ?? "1"}`,
      externalAppId: "app",
      externalTeamId: "team",
      providerContext: message.context ?? (message.kind === "dm" ? PRIVATE : GROUP),
      conversation: { externalId: "conversation", kind: message.kind ?? "channel" },
      message: {
        externalId: message.id,
        revisionKey: revision ?? "1",
        operation: revision ? "edited" : "created",
        threadKey: message.thread ?? null,
        replyToExternalId: null,
        author: { externalId: "human", kind: "human", displayName: "Human" },
        occurredAt: message.occurredAt ?? new Date(NOW.getTime() - 3_600_000 + sequence * 1_000),
        content: {
          version: 1,
          fallbackText: `${message.id}-${revision ?? "1"}`,
          blocks: [{ type: "text", text: `${message.id}-${revision ?? "1"}` }],
          truncated: false,
        },
        resources: [],
      },
      mentions: message.direct === false ? [] : [{ externalId: "bot", displayName: "Bot" }],
    };
    await inbox.ingest(bindingId, 1, event);
  };

  /** Deliveries of one message, optionally narrowed to one Session kind. */
  const deliveriesOf = (id: string, kind?: "channel" | "thread") => sql`${imMessageDeliveries.id} in (
    select d.id from im_message_deliveries d
    inner join im_messages m on m.id = d.message_id
    inner join sessions s on s.id = d.session_id
    where m.external_message_id = ${id} and m.im_binding_id = ${bindingId}::uuid
      ${kind ? sql`and s.kind = ${sql.raw(`'${kind}'`)}` : sql``}
  )`;
  const accept = async (
    id: string,
    options: { acceptedAt?: Date; expiresAt?: Date; kind?: "channel" | "thread" } = {},
  ) =>
    client.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: `input-${id}`,
        turnId: `turn-${id}`,
        reportOwnerInstanceId: REPORT_OWNER,
        acceptedAt: options.acceptedAt ?? new Date(NOW.getTime() - 60_000),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      })
      .where(deliveriesOf(id, options.kind));
  const reportOn = async (id: string, kind?: "channel" | "thread") =>
    client.database
      .update(imMessageDeliveries)
      .set({
        reportedAt: NOW,
        resultHash: "a".repeat(64),
        turnReport: {
          turnId: `turn-${id}`,
          outcome: "completed",
          finalText: "done",
          usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
        } as never,
      })
      .where(deliveriesOf(id, kind));

  const read = async () => {
    const tasks = await new TaskService(client.database, { now: () => NOW }).list(userId, { limit: 50 });
    const activity = (await agents.getById(userId, agent.id)).activity;
    const listed = (await agents.listForAccount(userId)).agents.find((entry) => entry.id === agent.id)?.activity;
    expect(listed).toEqual(activity);
    return {
      statuses: tasks.tasks.map((task) => task.status).sort(),
      queuedTaskCount: activity.queuedTaskCount ?? 0,
    };
  };
  return { bindingId, send, accept, reportOn, deliveriesOf, read, inbox, receivedAt };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const scenarios: {
  name: string;
  mode?: "mention_only" | "all_message";
  /** The Task list's statuses, sorted. */
  statuses: string[];
  /** Always the number of `queued` statuses. */
  count: number;
  run: (f: Fixture) => Promise<void>;
}[] = [
  {
    name: "01 two direct messages in one channel Session are one Task",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await f.send({ id: "b" });
    },
  },
  {
    name: "02 two Thread Sessions are two Tasks",
    statuses: ["queued", "queued"],
    count: 2,
    run: async (f) => {
      await f.send({ id: "a", thread: "t1" });
      await f.send({ id: "b", thread: "t2" });
    },
  },
  {
    name: "03 a message only overheard in a channel is not a Task",
    mode: "all_message",
    statuses: [],
    count: 0,
    run: async (f) => f.send({ id: "a", direct: false }),
  },
  {
    name: "04 an overheard message in a channel Session somebody addressed",
    mode: "all_message",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await f.accept("a");
      await f.reportOn("a");
      await f.send({ id: "b", direct: false });
    },
  },
  {
    name: "05 an unaddressed follow-up in a finished Thread Task",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a", thread: "t1" });
      await f.accept("a");
      await f.reportOn("a");
      await f.send({ id: "b", thread: "t1", direct: false });
    },
  },
  {
    name: "06 a Thread follow-up under an addressed root, with the channel's observer copy",
    mode: "all_message",
    statuses: ["completed", "queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "root" });
      await f.accept("root");
      await f.reportOn("root");
      await f.send({ id: "b", thread: "root", direct: false, context: { ...GROUP, rootId: "root" } });
    },
  },
  {
    name: "07 a running Session with a direct follow-up reads as running",
    statuses: ["running"],
    count: 0,
    run: async (f) => {
      await f.send({ id: "a" });
      await f.accept("a");
      await f.send({ id: "b" });
    },
  },
  {
    name: "08 a crashed Turn before a later reported Turn does not read as running",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await f.accept("a", { acceptedAt: new Date(NOW.getTime() - 3_000_000) });
      await f.send({ id: "b" });
      await f.accept("b", { acceptedAt: new Date(NOW.getTime() - 1_200_000) });
      await f.reportOn("b");
      await f.send({ id: "c" });
    },
  },
  {
    name: "09 an unreported Turn past its deadline does not read as running",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await f.accept("a", { expiresAt: new Date(NOW.getTime() - 60_000) });
      await f.send({ id: "b" });
    },
  },
  {
    name: "10 a pending message in an ended Session",
    statuses: ["ended"],
    count: 0,
    run: async (f) => {
      await f.send({ id: "a" });
      await client.database.update(sessions).set({ endedAt: NOW }).where(eq(sessions.imBindingId, f.bindingId));
    },
  },
  {
    name: "11 a follow-up after its Thread Session ended waits in the addressed channel Session",
    mode: "all_message",
    statuses: ["ended", "queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "root" });
      await f.accept("root");
      await f.reportOn("root");
      await f.send({ id: "a", thread: "t1" });
      await f.accept("a", { kind: "thread" });
      await f.reportOn("a", "thread");
      await client.database
        .update(sessions)
        .set({ endedAt: NOW })
        .where(and(eq(sessions.imBindingId, f.bindingId), eq(sessions.kind, "thread")));
      await f.send({ id: "b", thread: "t1", direct: false });
    },
  },
  {
    name: "12 a disabled binding",
    statuses: ["ended"],
    count: 0,
    run: async (f) => {
      await f.send({ id: "a" });
      await client.database.transaction((transaction) => disableImBindingInTransaction(transaction, f.bindingId, NOW));
    },
  },
  {
    name: "13 a binding that needs reauthorization",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await client.database
        .update(imBindings)
        .set({ status: "reauthorization_required" })
        .where(eq(imBindings.id, f.bindingId));
    },
  },
  {
    name: "14 a private chat is one Task across its Sessions",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a", kind: "dm" });
      await f.send({ id: "b", kind: "dm", thread: "t1" });
    },
  },
  {
    name: "15 a Turn running in one Session makes the private chat running",
    statuses: ["running"],
    count: 0,
    run: async (f) => {
      await f.send({ id: "a", kind: "dm", thread: "t1" });
      await f.accept("a");
      await f.send({ id: "b", kind: "dm" });
    },
  },
  {
    name: "16 a private chat whose messages carry no chat type",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a", kind: "dm", context: { provider: "feishu" } });
      await f.send({ id: "b", kind: "dm", thread: "t1", context: { provider: "feishu" } });
    },
  },
  {
    name: "17 a pending message already reserved in a batch",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await client.database.update(imMessageDeliveries).set({ reason: "batch_pending" }).where(f.deliveriesOf("a"));
    },
  },
  {
    name: "18 a pending message past its deadline, before the expiry pass",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await client.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(NOW.getTime() - 60_000) })
        .where(f.deliveriesOf("a"));
    },
  },
  {
    name: "19 a Thread nobody addressed",
    mode: "all_message",
    statuses: [],
    count: 0,
    run: async (f) => f.send({ id: "a", thread: "t1", direct: false }),
  },
  {
    name: "20 a superseded revision with its new revision pending",
    statuses: ["queued"],
    count: 1,
    run: async (f) => {
      await f.send({ id: "a" });
      await f.send({ id: "a", revision: "2", occurredAt: NOW });
    },
  },
  {
    name: "21 a Thread whose only direct message was edited into an unaddressed one is not a Task",
    statuses: [],
    count: 0,
    run: async (f) => {
      await f.send({ id: "a", thread: "t1" });
      await f.send({ id: "a", thread: "t1", direct: false, revision: "2", occurredAt: NOW });
    },
  },
];

it.each(scenarios)(
  "$name",
  async ({ mode, run, statuses, count }) => {
    const f = await fixture(mode ?? "mention_only");
    try {
      await run(f);
      expect(await f.read()).toEqual({ statuses, queuedTaskCount: count });
    } finally {
      await f.inbox.close();
    }
  },
  30_000,
);

const HOUR_MS = 60 * 60 * 1_000;

// Work waiting behind an offline Computer is what this count exists to show, so no pending Task may drop out because
// of how old it or its provider time is.
it.each([
  { name: "for 13 hours", receivedAgoHours: 13, occurredAgoHours: 13, expiresInHours: 155 },
  { name: "for almost the whole direct window", receivedAgoHours: 167, occurredAgoHours: 167, expiresInHours: 1 },
  {
    name: "past its deadline, before the expiry pass",
    receivedAgoHours: 216,
    occurredAgoHours: 216,
    expiresInHours: -48,
  },
  { name: "with a provider time nine days old", receivedAgoHours: 0, occurredAgoHours: 216, expiresInHours: 168 },
])(
  "still counts a direct message waiting $name",
  async ({ receivedAgoHours, occurredAgoHours, expiresInHours }) => {
    const f = await fixture("mention_only");
    try {
      f.receivedAt(new Date(NOW.getTime() - receivedAgoHours * HOUR_MS));
      await f.send({ id: "a", occurredAt: new Date(NOW.getTime() - occurredAgoHours * HOUR_MS) });
      await client.database
        .update(imMessageDeliveries)
        .set({ expiresAt: new Date(NOW.getTime() + expiresInHours * HOUR_MS) })
        .where(f.deliveriesOf("a"));
      expect(await f.read()).toEqual({ statuses: ["queued"], queuedTaskCount: 1 });
    } finally {
      await f.inbox.close();
    }
  },
  30_000,
);
