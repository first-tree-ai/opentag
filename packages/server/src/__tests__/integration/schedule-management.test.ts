/**
 * ScheduleService against real PostgreSQL: fixed-target resolution (P02), ownership and 404
 * concealment across Agents and Accounts (P04/P05), CAS revision behavior including a real
 * two-connection race (M05), pause/resume idempotency and exhaustion edges (M06/M07), and stable
 * scoped pagination (M08). Time comes from an injected deterministic clock; the production clock
 * adapter is proven once against the real database time.
 */

import { randomUUID } from "node:crypto";
import {
  AGENT_SCHEDULE_LIST_LIMIT_MAX,
  type AgentSchedule,
  agentSchedulePath,
  agentSchedulesPath,
  RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH,
  RUNTIME_AGENT_SCHEDULES_PATH,
  runtimeAgentSchedulePath,
  runtimeAgentSchedulePausePath,
  SCHEDULE_ERROR_CODES,
  SESSION_CLI_PROOF_HEADER,
} from "@opentag/shared";
import { eq, sql as sqlTag } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import { agentSchedules, sessions } from "../../db/schema/index.js";
import { DatabaseAgentOwnerResolver } from "../../services/agents/index.js";
import type { UserAuthService } from "../../services/auth/index.js";
import { ScheduleService } from "../../services/schedules/index.js";
import { SessionCliProofError } from "../../services/sessions/index.js";
import type { SessionCliSourceContext } from "../../services/sessions/session-cli-proof-service.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const T0 = new Date("2026-09-28T01:00:00.000Z");
const PUBLIC_URL = "https://opentag.example.com";

let testDatabase: MigratedTestDatabase;
let client: { database: DatabaseClient; sql: { end(): Promise<void> } };
let currentTime: Date;
let proofs: Map<string, SessionCliSourceContext>;
let service: ScheduleService;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDatabase.stop();
});

beforeEach(async () => {
  await testDatabase.reset();
  client = createDatabaseClient(testDatabase.databaseUrl);
  currentTime = T0;
  proofs = new Map();
  service = new ScheduleService({
    database: client.database,
    owners: new DatabaseAgentOwnerResolver(client.database),
    proofs: {
      authenticate: async (token) => {
        const source = proofs.get(token);
        if (!source) throw new SessionCliProofError("invalid_proof", "unknown proof");
        return source;
      },
    },
    publicUrl: PUBLIC_URL,
    clock: { now: async () => currentTime },
  });
});

async function closeClient(): Promise<void> {
  await client.sql.end();
}

interface ConversationSeed {
  accountId: string;
  agentId: string;
  bindingId: string;
  channelSessionId: string;
  threadSessionId: string;
  internalChannelSessionId: string;
  internalThreadSessionId: string;
}

/** One Account's Agent with a binding and channel/thread/internal Sessions on one conversation. */
async function seedConversation(email: string, agentName: string): Promise<ConversationSeed> {
  const ids = {
    accountId: randomUUID(),
    agentId: randomUUID(),
    bindingId: randomUUID(),
    channelSessionId: randomUUID(),
    threadSessionId: randomUUID(),
    internalChannelSessionId: randomUUID(),
    internalThreadSessionId: randomUUID(),
  };
  const db = client.database;
  await db.execute(
    sqlRaw(`insert into users (id, email, display_name) values ('${ids.accountId}', '${email}', 'Owner')`),
  );
  await db.execute(
    sqlRaw(
      `insert into agents (id, created_by_user_id, name, display_name, runtime_provider)
     values ('${ids.agentId}', '${ids.accountId}', '${agentName}', '${agentName}', 'codex')`,
    ),
  );
  await db.execute(
    sqlRaw(
      `insert into im_bindings (
       id, agent_id, provider, status, external_app_id, external_bot_id,
       credential_schema_version, credential_generation, encrypted_credential, activated_at
     ) values (
       '${ids.bindingId}', '${ids.agentId}', 'feishu', 'active', 'app_${ids.bindingId}', 'ou_fixture', 1, 1, 'test-only', now()
     )`,
    ),
  );
  await db.execute(
    sqlRaw(
      `insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind)
     values ('${ids.channelSessionId}', '${ids.bindingId}', 'oc_channel', 'dm', 'channel')`,
    ),
  );
  await db.execute(
    sqlRaw(
      `insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, thread_key)
     values ('${ids.threadSessionId}', '${ids.bindingId}', 'oc_channel', 'dm', 'thread', 'omt_thread')`,
    ),
  );
  await db.execute(
    sqlRaw(
      `insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_by_session_id)
     values ('${ids.internalChannelSessionId}', '${ids.bindingId}', 'oc_channel', 'dm', 'internal', '${ids.channelSessionId}')`,
    ),
  );
  await db.execute(
    sqlRaw(
      `insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, thread_key, created_by_session_id)
     values ('${ids.internalThreadSessionId}', '${ids.bindingId}', 'oc_channel', 'dm', 'internal', 'omt_thread', '${ids.threadSessionId}')`,
    ),
  );
  return ids;
}

/** Raw SQL fragment for fixture inserts; every interpolated value is a test-minted UUID. */
function sqlRaw(text: string) {
  return sqlTag.raw(text);
}

/** Register a proof token resolving to one of the seeded Sessions. */
function registerProof(
  token: string,
  seed: ConversationSeed,
  sessionId: string,
  sessionKind: "channel" | "thread" | "internal",
) {
  proofs.set(token, {
    agentId: seed.agentId,
    computerId: randomUUID(),
    connectionInstanceId: randomUUID(),
    installationId: randomUUID(),
    placementGeneration: 1,
    sessionId,
    sessionKind,
  });
}

async function authenticate(token: string) {
  return service.authenticate(token);
}

const CREATE_EVERY = {
  name: "Daily check",
  prompt: "Check the build.",
  schedule: { kind: "every", intervalSeconds: 300 },
  timezone: "Asia/Shanghai",
} as const;

async function createViaChannelProof(input: Partial<typeof CREATE_EVERY> = {}) {
  const scope = await authenticate("proof-channel");
  return service.createForAgent(scope, { ...CREATE_EVERY, ...input });
}

describe("ScheduleService fixed-target resolution (P02)", () => {
  it("pins channel and thread Sessions to themselves", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    registerProof("proof-thread", seed, seed.threadSessionId, "thread");
    try {
      const fromChannel = await createViaChannelProof();
      expect(fromChannel.target).toEqual({
        sessionId: seed.channelSessionId,
        provider: "feishu",
        sessionKind: "channel",
        channelId: "oc_channel",
        threadKey: null,
      });
      const fromThread = await service.createForAgent(await authenticate("proof-thread"), CREATE_EVERY);
      expect(fromThread.target).toMatchObject({
        sessionId: seed.threadSessionId,
        sessionKind: "thread",
        threadKey: "omt_thread",
      });
    } finally {
      await closeClient();
    }
  });

  it("maps an internal Session to the one existing visible Session of the same scope", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-internal-channel", seed, seed.internalChannelSessionId, "internal");
    registerProof("proof-internal-thread", seed, seed.internalThreadSessionId, "internal");
    try {
      const channelScope = await service.createForAgent(await authenticate("proof-internal-channel"), CREATE_EVERY);
      expect(channelScope.target.sessionId).toBe(seed.channelSessionId);
      const threadScope = await service.createForAgent(await authenticate("proof-internal-thread"), CREATE_EVERY);
      expect(threadScope.target.sessionId).toBe(seed.threadSessionId);
    } finally {
      await closeClient();
    }
  });

  it("refuses creation when no visible Session exists in the exact scope, without fallback", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    const db = client.database;
    // An internal Session on another Agent's binding that has no visible Session at all...
    const lonely = await seedConversation("lonely@example.com", "agent-lonely");
    await db.execute(
      sqlRaw(
        `update sessions set created_by_session_id = '${seed.channelSessionId}'
       where im_binding_id = '${lonely.bindingId}' and kind = 'internal'`,
      ),
    );
    await db.execute(sqlRaw(`delete from sessions where im_binding_id = '${lonely.bindingId}' and kind <> 'internal'`));
    await db.execute(
      sqlRaw(
        `update sessions set channel_id = 'oc_nowhere'
       where id = '${lonely.internalChannelSessionId}'`,
      ),
    );
    // ...and an internal Session scoped to a thread that does not exist while its channel does.
    const orphanThreadInternalId = randomUUID();
    await db.execute(
      sqlRaw(
        `insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, thread_key, created_by_session_id)
       values ('${orphanThreadInternalId}', '${seed.bindingId}', 'oc_channel', 'dm', 'internal', 'omt_missing', '${seed.channelSessionId}')`,
      ),
    );
    registerProof("proof-lonely", lonely, lonely.internalChannelSessionId, "internal");
    registerProof("proof-orphan-thread", seed, orphanThreadInternalId, "internal");
    try {
      for (const token of ["proof-lonely", "proof-orphan-thread"]) {
        await expect(service.createForAgent(await authenticate(token), CREATE_EVERY)).rejects.toMatchObject({
          code: SCHEDULE_ERROR_CODES.TARGET_REQUIRED,
          statusCode: 409,
        });
      }
      // Neither attempt created a schedule or resurrected a Session.
      expect(await client.database.select().from(agentSchedules)).toHaveLength(0);
      const visible = (await client.database.select().from(sessions)).filter((row) => row.kind !== "internal");
      expect(visible.map((row) => row.id).sort()).toEqual([seed.channelSessionId, seed.threadSessionId].sort());
    } finally {
      await closeClient();
    }
  });
});

describe("ScheduleService creation validation and DTO", () => {
  it("validates rules and timezone through the single calculator, anchored at database time", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      // `at` must be strictly future against the database clock.
      for (const at of [T0.toISOString(), new Date(T0.getTime() - 1).toISOString()]) {
        await expect(
          service.createForAgent(scope, { ...CREATE_EVERY, schedule: { kind: "at", at } }),
        ).rejects.toMatchObject({ code: SCHEDULE_ERROR_CODES.NO_FUTURE_OCCURRENCE, statusCode: 409 });
      }
      await expect(service.createForAgent(scope, { ...CREATE_EVERY, timezone: "Mars/Olympus" })).rejects.toMatchObject({
        code: SCHEDULE_ERROR_CODES.INVALID_TIMEZONE,
        statusCode: 400,
      });
      await expect(service.createForAgent(scope, { ...CREATE_EVERY, timezone: "+08:00" })).rejects.toMatchObject({
        code: SCHEDULE_ERROR_CODES.INVALID_TIMEZONE,
      });
      await expect(
        service.createForAgent(scope, { ...CREATE_EVERY, schedule: { kind: "cron", expression: "61 * * * *" } }),
      ).rejects.toMatchObject({ code: SCHEDULE_ERROR_CODES.INVALID_RULE, statusCode: 400 });
      await expect(
        service.createForAgent(scope, { ...CREATE_EVERY, schedule: { kind: "cron", expression: "0 9 * *" } }),
      ).rejects.toMatchObject({ code: SCHEDULE_ERROR_CODES.INVALID_RULE });
      expect(await client.database.select().from(agentSchedules)).toHaveLength(0);

      const created = await service.createForAgent(scope, CREATE_EVERY);
      expect(created).toMatchObject({
        agentId: seed.agentId,
        name: "Daily check",
        enabled: true,
        revision: 1,
        lastDispatch: null,
        timezone: "Asia/Shanghai",
        // The Server writes the anchor at the creation transaction's database time.
        schedule: { kind: "every", intervalSeconds: 300, anchorAt: T0.toISOString() },
        // First fire is exactly one interval after the anchor; nothing fires at creation.
        nextTriggerAt: new Date(T0.getTime() + 300_000).toISOString(),
        detailUrl: `${PUBLIC_URL}/agents/${seed.agentId}?schedule=${created.id}`,
      });
      expect(created.prompt).toBe("Check the build.");

      const cron = await service.createForAgent(scope, {
        ...CREATE_EVERY,
        name: "Weekday 9am",
        schedule: { kind: "cron", expression: "0 9 * * MON-FRI" },
      });
      // T0 is Monday 09:00 in Shanghai; the strictly-next weekday 09:00 is Tuesday (01:00Z).
      expect(cron.nextTriggerAt).toBe("2026-09-29T01:00:00.000Z");
    } finally {
      await closeClient();
    }
  });

  it("anchors a production-clock creation at real database time", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    const realClockService = new ScheduleService({
      database: client.database,
      owners: new DatabaseAgentOwnerResolver(client.database),
      proofs: serviceAuthenticate(),
      publicUrl: PUBLIC_URL,
    });
    try {
      const before = new Date();
      const created = await realClockService.createForAgent(await authenticate("proof-channel"), CREATE_EVERY);
      const after = new Date();
      expect(created.schedule.kind).toBe("every");
      if (created.schedule.kind === "every") {
        const anchor = Date.parse(created.schedule.anchorAt);
        expect(anchor).toBeGreaterThanOrEqual(before.getTime() - 1_000);
        expect(anchor).toBeLessThanOrEqual(after.getTime() + 1_000);
      }
      expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before.getTime() - 1_000);
    } finally {
      await closeClient();
    }
  });

  function serviceAuthenticate() {
    return {
      authenticate: async (token: string) => {
        const source = proofs.get(token);
        if (!source) throw new SessionCliProofError("invalid_proof", "unknown proof");
        return source;
      },
    };
  }
});

describe("ScheduleService updates and revision CAS", () => {
  it("keeps the next trigger on name/prompt edits and re-anchors on interval change", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const created = await createViaChannelProof();

      const renamed = await service.updateForAgent(scope, created.id, {
        expectedRevision: 1,
        name: "Renamed",
        prompt: "New body.",
      });
      expect(renamed).toMatchObject({ revision: 2, name: "Renamed", prompt: "New body." });
      expect(renamed.nextTriggerAt).toBe(created.nextTriggerAt);
      expect(renamed.schedule).toEqual(created.schedule);

      // Resubmitting the same rule is not an actual edit: neither revision nor next moves.
      currentTime = new Date(T0.getTime() + 60_000);
      const resubmitted = await service.updateForAgent(scope, created.id, {
        expectedRevision: 2,
        schedule: { kind: "every", intervalSeconds: 300 },
      });
      expect(resubmitted.schedule).toEqual(created.schedule);
      expect(resubmitted.revision).toBe(2);
      expect(resubmitted.nextTriggerAt).toBe(renamed.nextTriggerAt);
      expect(resubmitted.updatedAt).toBe(renamed.updatedAt);

      const sameName = await service.updateForAgent(scope, created.id, { expectedRevision: 2, name: "Renamed" });
      expect(sameName.revision).toBe(2);
      expect(sameName.updatedAt).toBe(renamed.updatedAt);

      // Changing the interval re-anchors at the database time of this edit.
      currentTime = new Date(T0.getTime() + 120_000);
      const changed = await service.updateForAgent(scope, created.id, {
        expectedRevision: 2,
        schedule: { kind: "every", intervalSeconds: 600 },
      });
      expect(changed.revision).toBe(3);
      expect(changed.schedule).toEqual({
        kind: "every",
        intervalSeconds: 600,
        anchorAt: currentTime.toISOString(),
      });
      expect(changed.nextTriggerAt).toBe(new Date(currentTime.getTime() + 600_000).toISOString());

      await expect(
        service.updateForAgent(scope, created.id, { expectedRevision: 2, name: "stale" }),
      ).rejects.toMatchObject({ code: SCHEDULE_ERROR_CODES.REVISION_CONFLICT, statusCode: 409 });
    } finally {
      await closeClient();
    }
  });

  it("recomputes cron occurrences when the timezone changes and keeps `at` absolute", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const cron = await service.createForAgent(scope, {
        ...CREATE_EVERY,
        schedule: { kind: "cron", expression: "0 9 * * *" },
      });
      expect(cron.nextTriggerAt).toBe("2026-09-29T01:00:00.000Z"); // Shanghai 09:00
      const moved = await service.updateForAgent(scope, cron.id, { expectedRevision: 1, timezone: "UTC" });
      expect(moved.nextTriggerAt).toBe("2026-09-28T09:00:00.000Z"); // UTC 09:00

      const at = await service.createForAgent(scope, {
        ...CREATE_EVERY,
        schedule: { kind: "at", at: "2026-09-29T09:00:00+08:00" },
      });
      expect(at.schedule).toEqual({ kind: "at", at: "2026-09-29T01:00:00.000Z" });
      const retimed = await service.updateForAgent(scope, at.id, { expectedRevision: 1, timezone: "UTC" });
      expect(retimed.schedule).toEqual({ kind: "at", at: "2026-09-29T01:00:00.000Z" });
      expect(retimed.nextTriggerAt).toBe("2026-09-29T01:00:00.000Z");
    } finally {
      await closeClient();
    }
  });

  it("keeps paused schedules paused through edits and validates rule edits even then", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const created = await createViaChannelProof();
      const paused = await service.pauseForAgent(scope, created.id, 1);
      expect(paused).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });

      currentTime = new Date(T0.getTime() + 30_000);
      const edited = await service.updateForAgent(scope, created.id, {
        expectedRevision: 2,
        schedule: { kind: "cron", expression: "0 9 * * MON-FRI" },
      });
      expect(edited).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 3 });
      expect(edited.schedule).toEqual({ kind: "cron", expression: "0 9 * * MON-FRI" });

      // A rule with no future occurrence is rejected even while paused; nothing is stored.
      await expect(
        service.updateForAgent(scope, created.id, {
          expectedRevision: 3,
          schedule: { kind: "at", at: new Date(currentTime.getTime() - 1_000).toISOString() },
        }),
      ).rejects.toMatchObject({ code: SCHEDULE_ERROR_CODES.NO_FUTURE_OCCURRENCE });
      const after = await service.getForAgent(scope, created.id);
      expect(after.revision).toBe(3);
      expect(after.schedule).toEqual({ kind: "cron", expression: "0 9 * * MON-FRI" });
    } finally {
      await closeClient();
    }
  });

  it("lets exactly one of two concurrent same-revision updates win (M05)", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const created = await createViaChannelProof();
      const results = await Promise.allSettled([
        service.updateForAgent(scope, created.id, { expectedRevision: 1, name: "Writer one" }),
        service.updateForAgent(scope, created.id, { expectedRevision: 1, name: "Writer two" }),
      ]);
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: SCHEDULE_ERROR_CODES.REVISION_CONFLICT,
        statusCode: 409,
      });
      const final = await service.getForAgent(scope, created.id);
      expect(final.revision).toBe(2);
      expect(["Writer one", "Writer two"]).toContain(final.name);
    } finally {
      await closeClient();
    }
  });
});

describe("ScheduleService pause/resume semantics (M06, M07)", () => {
  it("repeats pause and resume without moving anything, even when due (M06)", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const created = await createViaChannelProof();

      const paused = await service.pauseForAgent(scope, created.id, 1);
      expect(paused).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 2 });
      // Repeated pause validates the revision and changes nothing.
      const pausedAgain = await service.pauseForAgent(scope, created.id, 2);
      expect(pausedAgain).toEqual(paused);
      await expect(service.pauseForAgent(scope, created.id, 1)).rejects.toMatchObject({
        code: SCHEDULE_ERROR_CODES.REVISION_CONFLICT,
      });

      // Resume recomputes from the resume transaction's database time.
      currentTime = new Date(T0.getTime() + 400_000); // one occurrence (T0+300s) already in the past
      const resumed = await service.resumeForAgent(scope, created.id, 2);
      expect(resumed.enabled).toBe(true);
      expect(resumed.nextTriggerAt).toBe(new Date(T0.getTime() + 600_000).toISOString());
      expect(resumed.revision).toBe(3);

      // Repeated resume revalidates but does not move an already-due next trigger.
      currentTime = new Date(T0.getTime() + 700_000); // next (T0+600s) is now due
      const resumedAgain = await service.resumeForAgent(scope, created.id, 3);
      expect(resumedAgain.nextTriggerAt).toBe(new Date(T0.getTime() + 600_000).toISOString());
      expect(resumedAgain.revision).toBe(3);
    } finally {
      await closeClient();
    }
  });

  it("refuses to resume an exhausted one-time schedule until it is retimed (M07)", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const created = await service.createForAgent(scope, {
        ...CREATE_EVERY,
        schedule: { kind: "at", at: new Date(T0.getTime() + 60_000).toISOString() },
      });
      // The scanner's exhaustion shape: still enabled, no next occurrence.
      await client.database
        .update(agentSchedules)
        .set({ nextTriggerAt: null })
        .where(eq(agentSchedules.id, created.id));

      currentTime = new Date(T0.getTime() + 120_000); // the one-time instant is now past
      await expect(service.resumeForAgent(scope, created.id, 1)).rejects.toMatchObject({
        code: SCHEDULE_ERROR_CODES.NO_FUTURE_OCCURRENCE,
        statusCode: 409,
      });
      const preview = await service.previewForAgent(scope, { scheduleId: created.id });
      expect(preview.items).toEqual([]);
      expect(preview.schedule).toEqual({ kind: "at", at: new Date(T0.getTime() + 60_000).toISOString() });

      // Retiming to the future makes it schedulable again; resume then succeeds.
      const retimed = await service.updateForAgent(scope, created.id, {
        expectedRevision: 1,
        schedule: { kind: "at", at: new Date(T0.getTime() + 600_000).toISOString() },
      });
      expect(retimed.nextTriggerAt).toBe(new Date(T0.getTime() + 600_000).toISOString());
      const resumed = await service.resumeForAgent(scope, created.id, 2);
      expect(resumed.enabled).toBe(true);
    } finally {
      await closeClient();
    }
  });

  it("refuses to resume when the fixed target permanently died, never retargeting (M07)", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const created = await createViaChannelProof();
      await service.pauseForAgent(scope, created.id, 1);
      await client.database
        .update(sessions)
        .set({ endedAt: new Date(T0.getTime() + 10_000) })
        .where(eq(sessions.id, seed.channelSessionId));
      await expect(service.resumeForAgent(scope, created.id, 2)).rejects.toMatchObject({
        code: SCHEDULE_ERROR_CODES.TARGET_INVALID,
        statusCode: 409,
      });
      // The schedule stays paused with its original pinned target; nothing was recreated.
      const after = await service.getForAgent(scope, created.id);
      expect(after.enabled).toBe(false);
      expect(after.target.sessionId).toBe(seed.channelSessionId);
    } finally {
      await closeClient();
    }
  });
});

describe("ScheduleService listing (M08)", () => {
  const IDS = [
    "00000000-0000-4000-8000-0000000000e5",
    "00000000-0000-4000-8000-0000000000e4",
    "00000000-0000-4000-8000-0000000000e3",
    "00000000-0000-4000-8000-0000000000e2",
    "00000000-0000-4000-8000-0000000000e1",
  ];

  async function seedRows(agentId: string, targetSessionId: string) {
    const db = client.database;
    const base = {
      agentId,
      targetSessionId,
      prompt: "Check the build.",
      schedule: { kind: "cron", expression: "0 9 * * MON-FRI" } as const,
      timezone: "Asia/Shanghai",
      enabled: true,
      nextTriggerAt: new Date("2026-09-29T01:00:00.000Z"),
      revision: 1,
    };
    // e5/e4 share an identical created_at to exercise the id tiebreak; duplicate names are legal.
    const rows = [
      { id: IDS[0], name: "dup", createdAt: new Date("2026-09-28T03:00:00.000Z") },
      { id: IDS[1], name: "dup", createdAt: new Date("2026-09-28T03:00:00.000Z") },
      { id: IDS[2], name: "middle", createdAt: new Date("2026-09-28T02:00:00.000Z") },
      { id: IDS[3], name: "older", createdAt: new Date("2026-09-28T01:00:00.000Z") },
      { id: IDS[4], name: "oldest", createdAt: new Date("2026-09-28T00:00:00.000Z") },
    ];
    for (const row of rows) {
      await db.insert(agentSchedules).values({ ...base, ...row, updatedAt: row.createdAt });
    }
  }

  it("pages in stable createdAt DESC, id DESC order with a scoped cursor and no prompt", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    const other = await seedConversation("b@example.com", "agent-b");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    registerProof("proof-other", other, other.channelSessionId, "channel");
    await seedRows(seed.agentId, seed.channelSessionId);
    try {
      const scope = await authenticate("proof-channel");
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result: Awaited<ReturnType<ScheduleService["listForAgent"]>> = await service.listForAgent(scope, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        expect(result.items.length).toBeLessThanOrEqual(2);
        for (const item of result.items) {
          expect(item).not.toHaveProperty("prompt");
          expect(item).not.toHaveProperty("detailUrl");
          seen.push(item.id);
        }
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(seen).toEqual([...IDS]);

      // A cursor minted for another Agent's collection never applies here.
      const otherScope = await authenticate("proof-other");
      const foreignPage = await service.listForAgent(otherScope, { limit: 1 });
      expect(foreignPage.items).toHaveLength(0);
      const foreignCursor = (await service.listForAgent(scope, { limit: 1 })).nextCursor;
      expect(foreignCursor).toBeTruthy();
      await expect(
        service.listForAgent(otherScope, { limit: 1, cursor: foreignCursor as string }),
      ).rejects.toMatchObject({
        code: SCHEDULE_ERROR_CODES.INVALID_REQUEST,
        statusCode: 400,
      });
      await expect(service.listForAgent(scope, { limit: 1, cursor: "not-a-cursor" })).rejects.toMatchObject({
        code: SCHEDULE_ERROR_CODES.INVALID_REQUEST,
      });
    } finally {
      await closeClient();
    }
  });

  it("caps a page at the documented maximum", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    await seedRows(seed.agentId, seed.channelSessionId);
    try {
      const scope = await authenticate("proof-channel");
      const page = await service.listForAgent(scope, { limit: AGENT_SCHEDULE_LIST_LIMIT_MAX });
      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).toBeNull();
    } finally {
      await closeClient();
    }
  });
});

describe("Schedule ownership and concealment (P04, P05)", () => {
  it("conceals another Agent's schedules and another Account's Agents as 404", async () => {
    const seedA = await seedConversation("a@example.com", "agent-a");
    const seedB = await seedConversation("b@example.com", "agent-b");
    registerProof("proof-a", seedA, seedA.channelSessionId, "channel");
    registerProof("proof-b", seedB, seedB.channelSessionId, "channel");
    try {
      const scopeA = await authenticate("proof-a");
      const scopeB = await authenticate("proof-b");
      const created = await service.createForAgent(scopeA, CREATE_EVERY);

      // The other Agent's proof finds nothing, in any operation.
      await expect(service.getForAgent(scopeB, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        statusCode: 404,
      });
      await expect(
        service.updateForAgent(scopeB, created.id, { expectedRevision: 1, name: "hijack" }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await expect(service.pauseForAgent(scopeB, created.id, 1)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await expect(service.resumeForAgent(scopeB, created.id, 1)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      await expect(service.deleteForAgent(scopeB, created.id, 1)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
      expect((await service.listForAgent(scopeB, { limit: 50 })).items).toHaveLength(0);

      // The other Account finds nothing either, including the Agent path itself.
      await expect(service.listForAccount(seedB.accountId, seedA.agentId, { limit: 50 })).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(service.getForAccount(seedB.accountId, seedA.agentId, created.id)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(service.pauseForAccount(seedB.accountId, seedA.agentId, created.id, 1)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });
      await expect(service.deleteForAccount(seedB.accountId, seedA.agentId, created.id, 1)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
      });

      // The owning Account manages it: pause, resume, delete.
      const paused = await service.pauseForAccount(seedA.accountId, seedA.agentId, created.id, 1);
      expect(paused.enabled).toBe(false);
      const resumed = await service.resumeForAccount(seedA.accountId, seedA.agentId, created.id, 2);
      expect(resumed.enabled).toBe(true);
      await service.deleteForAccount(seedA.accountId, seedA.agentId, created.id, 3);
      await expect(service.getForAgent(scopeA, created.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

      // The original row stayed intact through every rejected attempt (name never hijacked).
      expect((await client.database.select().from(agentSchedules)).length).toBe(0);
    } finally {
      await closeClient();
    }
  });

  it("lets the Agent manage its schedules from any of its own Sessions (P05)", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    registerProof("proof-thread", seed, seed.threadSessionId, "thread");
    try {
      const created = await createViaChannelProof();
      const threadScope = await authenticate("proof-thread");
      const shown = await service.getForAgent(threadScope, created.id);
      expect(shown.target.sessionId).toBe(seed.channelSessionId);
      const paused = await service.pauseForAgent(threadScope, created.id, 1);
      expect(paused.enabled).toBe(false);
      const resumed = await service.resumeForAgent(threadScope, created.id, 2);
      // The target never moved to the managing Session.
      expect(resumed.target.sessionId).toBe(seed.channelSessionId);
    } finally {
      await closeClient();
    }
  });
});

describe("Schedule preview", () => {
  it("keeps the stored every anchor for persisted schedules and assumes now for ad-hoc rules", async () => {
    const seed = await seedConversation("a@example.com", "agent-a");
    registerProof("proof-channel", seed, seed.channelSessionId, "channel");
    try {
      const scope = await authenticate("proof-channel");
      const created = await service.createForAgent(scope, {
        ...CREATE_EVERY,
        schedule: { kind: "every", intervalSeconds: 3600 },
      });
      currentTime = new Date(T0.getTime() + 100_000);

      const stored = await service.previewForAgent(scope, { scheduleId: created.id });
      expect(stored.calculatedAt).toBe(currentTime.toISOString());
      expect(stored.schedule).toEqual({ kind: "every", intervalSeconds: 3600, anchorAt: T0.toISOString() });
      expect(stored.items[0]?.at).toBe(new Date(T0.getTime() + 3_600_000).toISOString());
      expect(stored.items).toHaveLength(5);
      expect(stored.items[0]?.local).toContain("+08:00");

      const adhoc = await service.previewForAgent(scope, {
        schedule: { kind: "every", intervalSeconds: 3600 },
        timezone: "Asia/Shanghai",
      });
      expect(adhoc.schedule).toEqual({ kind: "every", intervalSeconds: 3600, anchorAt: currentTime.toISOString() });
      expect(adhoc.items[0]?.at).toBe(new Date(currentTime.getTime() + 3_600_000).toISOString());

      // An ad-hoc past `at` previews empty rather than erroring; invalid input still 400s.
      const exhausted = await service.previewForAgent(scope, {
        schedule: { kind: "at", at: new Date(T0.getTime() - 1_000).toISOString() },
        timezone: "Asia/Shanghai",
      });
      expect(exhausted.items).toEqual([]);
      await expect(
        service.previewForAgent(scope, { schedule: { kind: "cron", expression: "@daily" }, timezone: "Asia/Shanghai" }),
      ).rejects.toMatchObject({ code: SCHEDULE_ERROR_CODES.INVALID_RULE, statusCode: 400 });
      await expect(
        service.previewForAgent(scope, { schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "nope" }),
      ).rejects.toMatchObject({ code: SCHEDULE_ERROR_CODES.INVALID_TIMEZONE, statusCode: 400 });
    } finally {
      await closeClient();
    }
  });
});

describe("Schedule HTTP surfaces end to end (M01)", () => {
  function authServiceStub(accounts: Record<string, string>): UserAuthService {
    return {
      getAuthenticatedUser: vi.fn(async (token: string) => {
        const accountId = accounts[token];
        if (!accountId) throw new Error("unauthenticated");
        return {
          tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
          me: { user: { id: accountId, email: "owner@example.com", displayName: "Owner" }, setupCompletedAt: null },
        };
      }),
    } as unknown as UserAuthService;
  }

  it("drives the proof and Account surfaces against the real service and database", async () => {
    const seedA = await seedConversation("a@example.com", "agent-a");
    const seedB = await seedConversation("b@example.com", "agent-b");
    registerProof("proof-a", seedA, seedA.channelSessionId, "channel");
    const app = createApp({
      authService: authServiceStub({ "bearer-a": seedA.accountId, "bearer-b": seedB.accountId }),
      runtimeAgentSchedules: { service },
      agentSchedules: { service },
    });
    try {
      // Create through the Session proof surface.
      const created = await app.inject({
        method: "POST",
        url: RUNTIME_AGENT_SCHEDULES_PATH,
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
        payload: CREATE_EVERY,
      });
      expect(created.statusCode).toBe(201);
      const schedule = created.json() as AgentSchedule;
      expect(schedule.target.sessionId).toBe(seedA.channelSessionId);
      expect(schedule.detailUrl).toBe(`${PUBLIC_URL}/agents/${seedA.agentId}?schedule=${schedule.id}`);

      // List omits the prompt; show returns it.
      const listed = await app.inject({
        method: "GET",
        url: RUNTIME_AGENT_SCHEDULES_PATH,
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toHaveLength(1);
      expect(listed.json().items[0]).not.toHaveProperty("prompt");
      const shown = await app.inject({
        method: "GET",
        url: runtimeAgentSchedulePath(schedule.id),
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
      });
      expect(shown.json().prompt).toBe("Check the build.");

      // Update, pause, resume with the revision from each response.
      const updated = await app.inject({
        method: "PATCH",
        url: runtimeAgentSchedulePath(schedule.id),
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
        payload: { expectedRevision: 1, name: "Renamed check" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().revision).toBe(2);
      const stale = await app.inject({
        method: "PATCH",
        url: runtimeAgentSchedulePath(schedule.id),
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
        payload: { expectedRevision: 1, name: "lost race" },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: "SCHEDULE_REVISION_CONFLICT" } });

      const paused = await app.inject({
        method: "POST",
        url: runtimeAgentSchedulePausePath(schedule.id),
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
        payload: { expectedRevision: 2 },
      });
      expect(paused.json()).toMatchObject({ enabled: false, nextTriggerAt: null, revision: 3 });

      // The owning Account sees and resumes the same schedule; the foreign Account gets 404.
      const accountList = await app.inject({
        method: "GET",
        url: agentSchedulesPath(seedA.agentId),
        headers: { authorization: "Bearer bearer-a" },
      });
      expect(accountList.statusCode).toBe(200);
      expect(accountList.json().items[0].id).toBe(schedule.id);
      const foreign = await app.inject({
        method: "GET",
        url: agentSchedulePath(seedA.agentId, schedule.id),
        headers: { authorization: "Bearer bearer-b" },
      });
      expect(foreign.statusCode).toBe(404);
      const accountResume = await app.inject({
        method: "POST",
        url: `${agentSchedulePath(seedA.agentId, schedule.id)}/resume`,
        headers: { authorization: "Bearer bearer-a" },
        payload: { expectedRevision: 3 },
      });
      expect(accountResume.statusCode).toBe(200);
      expect(accountResume.json().enabled).toBe(true);

      // Preview both forms, then delete; the row is concealed afterwards.
      const previewed = await app.inject({
        method: "POST",
        url: RUNTIME_AGENT_SCHEDULE_PREVIEW_PATH,
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
        payload: { scheduleId: schedule.id },
      });
      expect(previewed.statusCode).toBe(200);
      expect(previewed.json().items.length).toBeGreaterThan(0);
      const removed = await app.inject({
        method: "DELETE",
        url: `${runtimeAgentSchedulePath(schedule.id)}?expectedRevision=4`,
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
      });
      expect(removed.statusCode).toBe(204);
      const gone = await app.inject({
        method: "GET",
        url: runtimeAgentSchedulePath(schedule.id),
        headers: { [SESSION_CLI_PROOF_HEADER]: "proof-a" },
      });
      expect(gone.statusCode).toBe(404);
    } finally {
      await app.close();
      await closeClient();
    }
  });
});
