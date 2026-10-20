import assert from "node:assert/strict";
import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import type { SlackApiClient } from "../../services/im-bindings/slack/adapter.js";
import { SlackConfigurationService } from "../../services/im-bindings/slack/configuration-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
const eventKinds = ["observation", "identity closure", "token revocation", "uninstall"] as const;
type EventKind = (typeof eventKinds)[number];
type Connection = ReturnType<typeof createDatabaseClient>;

async function fixture() {
  const observer = createDatabaseClient(testDatabase.databaseUrl);
  const account = await bootstrapInitialAdmin(observer.database, {
    displayName: "Owner",
    email: "slack-locks@example.test",
  });
  const [computer] = await observer.database
    .insert(computers)
    .values({
      ownerAccountId: account.userId,
      currentInstallationId: crypto.randomUUID(),
      currentInstanceId: crypto.randomUUID(),
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.1.2",
    })
    .returning();
  assert(computer);
  const agent = await new AgentService(observer.database).createForAccount(account.userId, {
    name: "slack-locks",
    displayName: "Slack locks",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  let now = new Date("2026-10-20T00:00:00.000Z");
  const serviceFor = (client: Connection) =>
    new ImBindingService(client.database, cipher, { now: () => new Date(now) });
  const service = serviceFor(observer);
  const activation = {
    intent: "create" as const,
    agentId: agent.id,
    appId: "A_LOCKS",
    teamId: "T_LOCKS",
    botUserId: "U_LOCKS",
    grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    botAccessToken: "xoxb-test-only",
    signingSecret: "test-only-signing-secret",
    installedAt: new Date(now),
  };
  const binding = await service.activateSlack(activation, "B_LOCKS");
  const [installation] = await observer.database.select().from(slackInstallations);
  assert(installation);
  const sessionService = new SessionService(observer.database);
  const root = await sessionService.ensureChatSession(
    {
      imBindingId: binding.imBindingId,
      channelId: "C_LOCKS",
      conversationKind: "channel",
    },
    "channel",
  );
  return {
    observer,
    accountId: account.userId,
    agent,
    computer,
    binding,
    installation,
    activation,
    service,
    serviceFor,
    root,
    at: (value: string) => {
      now = new Date(value);
    },
    close: () => observer.sql.end(),
  };
}

function event(service: ImBindingService, kind: EventKind, installationId: string, generation: number) {
  switch (kind) {
    case "observation":
      return service.recordSlackInstallationObservation(installationId, generation);
    case "identity closure":
      return service.recordSlackInstallationIdentityClosure(installationId, generation);
    case "token revocation":
      return service.requireSlackInstallationReauthorization(installationId, generation, "SLACK_TOKEN_REVOKED");
    case "uninstall":
      return service.disableSlackInstallationFromProvider(installationId, generation);
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function configuration(value: Fixture, client: Connection, inspect?: SlackApiClient["inspectInstallation"]) {
  const api: SlackApiClient = {
    authTest: async () => ({ appId: "A_LOCKS", teamId: "T_LOCKS", botUserId: "U_LOCKS", botId: "B_LOCKS" }),
    inspectInstallation:
      inspect ??
      (async () => ({
        appId: "A_LOCKS",
        teamId: "T_LOCKS",
        enterpriseId: null,
        botUserId: "U_LOCKS",
        botId: "B_LOCKS",
        grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      })),
    oauthAccess: async () => {
      throw new Error("Unexpected OAuth exchange");
    },
    fetchResource: async () => {
      throw new Error("Unexpected resource request");
    },
  };
  return new SlackConfigurationService({ database: client.database, imBindings: value.serviceFor(client), api });
}

function reauthorize(value: Fixture, client: Connection) {
  return configuration(value, client).configure(value.accountId, value.agent.id, {
    intent: "reauthorize",
    expectedBinding: { id: value.binding.imBindingId, credentialGeneration: 1 },
    appId: "A_LOCKS",
    botAccessToken: "xoxb-renewed-test-only",
    signingSecret: "renewed-test-only-signing-secret",
  });
}

async function snapshot(value: Fixture) {
  const [binding] = await value.observer.database
    .select()
    .from(imBindings)
    .where(eq(imBindings.id, value.binding.imBindingId));
  const [installation] = await value.observer.database
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.id, value.installation.id));
  const [session] = await value.observer.database.select().from(sessions).where(eq(sessions.id, value.root.session.id));
  assert(binding && installation && session);
  return { binding, installation, session };
}

function unbind(value: Fixture, client: Connection) {
  return value.serviceFor(client).unbindForAgent(value.accountId, value.agent.id, {
    provider: "slack",
    bindingId: value.binding.imBindingId,
  });
}

async function waitForLock(observer: Connection, pid: number) {
  await expect
    .poll(
      async () => {
        const [row] = await observer.sql<{ waiting: boolean }[]>`
      select exists(select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock') as waiting`;
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

async function raceAtBinding(
  value: Fixture,
  firstAction: (client: Connection) => Promise<unknown>,
  secondAction: (client: Connection) => Promise<unknown>,
) {
  const first = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const second = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const locked = deferred();
  const release = deferred();
  let holding: Promise<unknown> | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    await first.sql`set statement_timeout = '10s'`;
    await second.sql`set statement_timeout = '10s'`;
    const [firstBackend] = await first.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const [secondBackend] = await second.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    assert(firstBackend && secondBackend);
    holding = gate.sql.begin(async (transaction) => {
      await transaction`select id from im_bindings where id = ${value.binding.imBindingId} for update`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const firstResult = Promise.allSettled([firstAction(first)]);
    pending.push(firstResult);
    await waitForLock(value.observer, firstBackend.pid);
    const secondResult = Promise.allSettled([secondAction(second)]);
    pending.push(secondResult);
    await waitForLock(value.observer, secondBackend.pid);
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

describe("Slack installation management and event lock order", () => {
  it.each(eventKinds)(
    "commits unbind ahead of a waiting %s without a deadlock",
    async (kind) => {
      const value = await fixture();
      try {
        const results = await raceAtBinding(
          value,
          (client) => unbind(value, client),
          (client) => event(value.serviceFor(client), kind, value.installation.id, 1),
        );
        expect(results.map(outcome)).toEqual(["committed", "committed"]);
        expect(results[1]).toMatchObject({ status: "fulfilled", value: false });
        const [binding] = await value.observer.database
          .select()
          .from(imBindings)
          .where(eq(imBindings.id, value.binding.imBindingId));
        const [installation] = await value.observer.database
          .select()
          .from(slackInstallations)
          .where(eq(slackInstallations.id, value.installation.id));
        const [session] = await value.observer.database
          .select()
          .from(sessions)
          .where(eq(sessions.id, value.root.session.id));
        expect(binding).toMatchObject({ status: "disabled", credentialGeneration: 2, encryptedCredential: null });
        expect(installation).toMatchObject({ status: "disabled", credentialGeneration: 2, encryptedCredential: null });
        expect(session?.endedAt).toBeInstanceOf(Date);
      } finally {
        await value.close();
      }
    },
    20_000,
  );

  it.each(eventKinds)("preserves unbind results after a waiting %s commits first", async (kind) => {
    const value = await fixture();
    try {
      const results = await raceAtBinding(
        value,
        (client) => event(value.serviceFor(client), kind, value.installation.id, 1),
        (client) => unbind(value, client),
      );
      expect(results[0]).toMatchObject({ status: "fulfilled", value: true });
      if (kind === "uninstall") {
        expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "IM_BINDING_CONFIGURATION_CONFLICT" } });
      } else {
        expect(results.map(outcome)).toEqual(["committed", "committed"]);
      }
      const stored = await snapshot(value);
      const generation = kind === "token revocation" ? 3 : 2;
      expect(stored.binding).toMatchObject({ status: "disabled", credentialGeneration: generation });
      expect(stored.installation).toMatchObject({ status: "disabled", credentialGeneration: generation });
      expect(stored.session.endedAt).toBeInstanceOf(Date);
    } finally {
      await value.close();
    }
  });

  it.each(eventKinds)("fences an old %s behind a same-identity reauthorization", async (kind) => {
    const value = await fixture();
    try {
      const results = await raceAtBinding(
        value,
        (client) => reauthorize(value, client),
        (client) => event(value.serviceFor(client), kind, value.installation.id, 1),
      );
      expect(results.map(outcome)).toEqual(["committed", "committed"]);
      expect(results[1]).toMatchObject({ status: "fulfilled", value: false });
      const stored = await snapshot(value);
      expect(stored.binding).toMatchObject({ status: "active", credentialGeneration: 2, observedConnectedAt: null });
      expect(stored.installation).toMatchObject({
        status: "active",
        credentialGeneration: 2,
        observedConnectedAt: null,
      });
      expect(stored.session.endedAt).toBeNull();
    } finally {
      await value.close();
    }
  });

  it.each(eventKinds)("preserves configuration conflicts after a waiting %s commits first", async (kind) => {
    const value = await fixture();
    try {
      const results = await raceAtBinding(
        value,
        (client) => event(value.serviceFor(client), kind, value.installation.id, 1),
        (client) => reauthorize(value, client),
      );
      expect(results[0]).toMatchObject({ status: "fulfilled", value: true });
      if (kind === "token revocation" || kind === "uninstall") {
        expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "SLACK_CONFIGURATION_CONFLICT" } });
      } else {
        expect(results.map(outcome)).toEqual(["committed", "committed"]);
      }
      const stored = await snapshot(value);
      expect(stored.binding.credentialGeneration).toBe(2);
      expect(stored.installation.credentialGeneration).toBe(2);
      expect(stored.binding.observedConnectedAt).toBeNull();
      expect(stored.installation.observedConnectedAt).toBeNull();
    } finally {
      await value.close();
    }
  });

  it.each(eventKinds)("processes %s for a suspended Agent without waiting for its row lock", async (kind) => {
    const value = await fixture();
    const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const caller = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const locked = deferred();
    const release = deferred();
    let holding: Promise<unknown> | undefined;
    try {
      await new AgentService(value.observer.database).suspendById(value.accountId, value.agent.id);
      holding = gate.sql.begin(async (transaction) => {
        await transaction`select id from agents where id = ${value.agent.id} for update`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      await caller.sql`set statement_timeout = '2s'`;
      await expect(event(value.serviceFor(caller), kind, value.installation.id, 1)).resolves.toBe(true);
      const stored = await snapshot(value);
      expect(stored.binding.status).toBe(
        kind === "uninstall" ? "disabled" : kind === "token revocation" ? "reauthorization_required" : "active",
      );
      expect(stored.installation.status).toBe(stored.binding.status);
    } finally {
      release.resolve();
      await holding;
      await Promise.all([gate.sql.end(), caller.sql.end(), value.close()]);
    }
  });

  it.each(eventKinds)("commits Agent deletion ahead of a waiting %s", async (kind) => {
    const value = await fixture();
    try {
      await new AgentService(value.observer.database).suspendById(value.accountId, value.agent.id);
      const results = await raceAtBinding(
        value,
        (client) => new AgentService(client.database).deleteById(value.accountId, value.agent.id),
        (client) => event(value.serviceFor(client), kind, value.installation.id, 1),
      );
      expect(results.map(outcome)).toEqual(["committed", "committed"]);
      expect(results[1]).toMatchObject({ status: "fulfilled", value: false });
      const stored = await snapshot(value);
      expect(stored.binding.status).toBe("disabled");
      expect(stored.installation.status).toBe("disabled");
      expect(stored.session.endedAt).toBeInstanceOf(Date);
      const [agent] = await value.observer.database.select().from(agents).where(eq(agents.id, value.agent.id));
      expect(agent?.status).toBe("deleted");
    } finally {
      await value.close();
    }
  });

  describe.each(["keep", "disable"] as const)("operator transfer with Slack %s", (slack) => {
    it.each(eventKinds)("commits before a waiting %s with the original lifecycle result", async (kind) => {
      const value = await fixture();
      try {
        const [target] = await value.observer.database
          .insert(users)
          .values({ email: "target@example.test", displayName: "Target" })
          .returning();
        assert(target);
        await new AgentService(value.observer.database).suspendById(value.accountId, value.agent.id);
        const results = await raceAtBinding(
          value,
          (client) =>
            new AgentService(client.database).transferToAccount({
              agentId: value.agent.id,
              targetAccountId: target.id,
              slack,
            }),
          (client) => event(value.serviceFor(client), kind, value.installation.id, 1),
        );
        expect(results.map(outcome)).toEqual(["committed", "committed"]);
        expect(results[0]).toMatchObject({
          status: "fulfilled",
          value: { imBinding: slack === "keep" ? "kept" : "disabled" },
        });
        expect(results[1]).toMatchObject({ status: "fulfilled", value: slack === "keep" });
        const stored = await snapshot(value);
        const status =
          slack === "disable" || kind === "uninstall"
            ? "disabled"
            : kind === "token revocation"
              ? "reauthorization_required"
              : "active";
        expect(stored.binding.status).toBe(status);
        expect(stored.installation.status).toBe(status);
        expect(stored.session.endedAt).toBeInstanceOf(Date);
        const [agent] = await value.observer.database.select().from(agents).where(eq(agents.id, value.agent.id));
        expect(agent).toMatchObject({ createdByUserId: target.id, computerId: null, status: "suspended" });
      } finally {
        await value.close();
      }
    });
  });

  describe.each(["create", "send", "ordinary admission", "scheduled admission"] as const)("Session %s", (operation) => {
    it.each(eventKinds)("commits ahead of a waiting %s", async (kind) => {
      const value = await fixture();
      try {
        assert(value.computer.currentInstallationId && value.computer.currentInstanceId);
        const createInput = {
          creatorSessionId: value.root.session.id,
          creatorInstallationId: value.computer.currentInstallationId,
          creatorConnectionInstanceId: value.computer.currentInstanceId,
          creatorComputerId: value.computer.id,
          creatorPlacementGeneration: 1,
          messageId: crypto.randomUUID(),
          initialMessage: "Internal task",
        };
        const service = new SessionService(value.observer.database);
        const child = await service.createInternalSessionWithMessage(createInput);
        const [schedule] = await value.observer.database
          .insert(agentSchedules)
          .values({
            agentId: value.agent.id,
            targetSessionId: child.session.id,
            name: "Slack event concurrency",
            prompt: "Run the task",
            schedule: { kind: "every", intervalSeconds: 60, anchorAt: "2026-10-20T00:00:00.000Z" },
            timezone: "UTC",
            enabled: true,
            nextTriggerAt: new Date("2026-10-20T01:00:00.000Z"),
          })
          .returning();
        assert(schedule);
        const resolved = await service.resolveScheduledMessageRoute(child.session.id, value.agent.id);
        assert(resolved.kind === "route");
        const results = await raceAtBinding(
          value,
          (client) => {
            const caller = new SessionService(client.database);
            if (operation === "create") {
              return caller.createInternalSessionWithMessage({ ...createInput, messageId: crypto.randomUUID() });
            }
            if (operation === "send") {
              return caller.authorizeAndRecordMessage({
                sourceSessionId: value.root.session.id,
                sourceInstallationId: createInput.creatorInstallationId,
                sourceConnectionInstanceId: createInput.creatorConnectionInstanceId,
                sourceComputerId: value.computer.id,
                sourcePlacementGeneration: 1,
                targetSessionId: child.session.id,
                messageId: crypto.randomUUID(),
                content: "Internal message",
              });
            }
            const dispatch = async (onDispatched: () => void) => {
              onDispatched();
              return "sent";
            };
            return operation === "ordinary admission"
              ? caller.withCollaborationDispatchAdmission(child.route, dispatch)
              : caller.withScheduledDispatchAdmission(
                  resolved.route,
                  { scheduleId: schedule.id, revision: 1 },
                  dispatch,
                );
          },
          (client) => event(value.serviceFor(client), kind, value.installation.id, 1),
        );
        expect(results.map(outcome)).toEqual(["committed", "committed"]);
        expect(results[1]).toMatchObject({ status: "fulfilled", value: true });
        if (operation.endsWith("admission")) {
          expect(results[0]).toMatchObject({ status: "fulfilled", value: { admitted: true } });
        }
      } finally {
        await value.close();
      }
    });
  });

  it("allows a Session foreign-key check while an observation waits for the installation", async () => {
    const value = await fixture();
    const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const caller = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const admission = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const locked = deferred();
    const release = deferred();
    let holding: Promise<unknown> | undefined;
    let pending: Promise<PromiseSettledResult<boolean>[]> | undefined;
    try {
      const [backend] = await caller.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      assert(backend);
      holding = gate.sql.begin(async (transaction) => {
        await transaction`select id from slack_installations where id = ${value.installation.id} for update`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      pending = Promise.allSettled([event(value.serviceFor(caller), "observation", value.installation.id, 1)]);
      await waitForLock(value.observer, backend.pid);
      await admission.sql`set statement_timeout = '2s'`;
      const admitted = await new SessionService(admission.database).ensureChatSession(
        { imBindingId: value.binding.imBindingId, channelId: "C_FK_CHECK", conversationKind: "channel" },
        "channel",
      );
      expect(admitted.session.imBindingId).toBe(value.binding.imBindingId);
      release.resolve();
      await holding;
      expect(await pending).toEqual([{ status: "fulfilled", value: true }]);
    } finally {
      release.resolve();
      await holding;
      await pending;
      await Promise.all([gate.sql.end(), caller.sql.end(), admission.sql.end(), value.close()]);
    }
  });

  it("preserves the first identity closure and leaves stale or missing events without writes", async () => {
    const value = await fixture();
    try {
      await event(value.service, "identity closure", value.installation.id, 1);
      const first = await snapshot(value);
      value.at("2026-10-20T01:00:00.000Z");
      await event(value.service, "identity closure", value.installation.id, 1);
      const later = await snapshot(value);
      expect(later.installation.observedConnectedAt).toEqual(first.installation.observedConnectedAt);
      expect(later.binding.observedConnectedAt).toEqual(first.binding.observedConnectedAt);
      expect(later.installation.observedAt).toEqual(new Date("2026-10-20T01:00:00.000Z"));
      for (const kind of eventKinds) {
        expect(await event(value.service, kind, value.installation.id, 0)).toBe(false);
        expect(await event(value.service, kind, crypto.randomUUID(), 1)).toBe(false);
      }
      expect(await snapshot(value)).toEqual(later);
    } finally {
      await value.close();
    }
  });

  it("keeps runtime grants fenced by identity closure, revocation, and uninstall", async () => {
    const value = await fixture();
    const request = {
      type: "im:credential" as const,
      requestId: crypto.randomUUID(),
      sessionId: value.root.session.id,
      agentId: value.agent.id,
      placementGeneration: 1,
    };
    const grant = () => value.service.issueRuntimeCredentialGrant(request, { computerId: value.computer.id });
    try {
      await expect(grant()).resolves.toMatchObject({ status: "rejected", code: "binding_inactive" });
      await event(value.service, "identity closure", value.installation.id, 1);
      await expect(grant()).resolves.toMatchObject({ status: "succeeded", credentialGeneration: 1 });
      await event(value.service, "token revocation", value.installation.id, 1);
      await expect(grant()).resolves.toMatchObject({ status: "rejected", code: "binding_inactive" });
      await value.service.activateSlack({ ...value.activation, intent: "reauthorize" }, "B_LOCKS");
      await expect(grant()).resolves.toMatchObject({ status: "rejected", code: "binding_inactive" });
      await event(value.service, "identity closure", value.installation.id, 3);
      await expect(grant()).resolves.toMatchObject({ status: "succeeded", credentialGeneration: 3 });
      await event(value.service, "uninstall", value.installation.id, 3);
      await expect(grant()).resolves.toMatchObject({ status: "rejected", code: "placement_stale" });
      const stored = await snapshot(value);
      for (const kind of eventKinds) expect(await event(value.service, kind, value.installation.id, 3)).toBe(false);
      expect(await snapshot(value)).toEqual(stored);
    } finally {
      await value.close();
    }
  });

  it("allows unbind during slow external token inspection and rejects its stale configuration", async () => {
    const value = await fixture();
    const caller = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const entered = deferred();
    const release = deferred();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const service = configuration(value, value.observer, async () => {
        entered.resolve();
        await release.promise;
        return {
          appId: "A_LOCKS",
          teamId: "T_LOCKS",
          enterpriseId: null,
          botUserId: "U_LOCKS",
          botId: "B_LOCKS",
          grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        };
      });
      pending = Promise.allSettled([
        service.configure(value.accountId, value.agent.id, {
          intent: "reauthorize",
          expectedBinding: { id: value.binding.imBindingId, credentialGeneration: 1 },
          appId: "A_LOCKS",
          botAccessToken: "xoxb-renewed-test-only",
          signingSecret: "test-only-signing-secret",
        }),
      ]);
      await entered.promise;
      await caller.sql`set statement_timeout = '2s'`;
      await unbind(value, caller);
      release.resolve();
      expect((await pending)[0]).toMatchObject({
        status: "rejected",
        reason: { code: "SLACK_CONFIGURATION_CONFLICT" },
      });
      expect((await snapshot(value)).installation.status).toBe("disabled");
    } finally {
      release.resolve();
      await pending;
      await Promise.all([caller.sql.end(), value.close()]);
    }
  });
});
