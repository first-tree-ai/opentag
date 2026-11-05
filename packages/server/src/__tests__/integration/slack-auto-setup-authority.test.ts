import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, SLACK_REQUIRED_BOT_SCOPES, type SlackAutoSetupRuntimeResult } from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { agents as agentRows, computers, imBindings, slackInstallations, users } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { SlackAutoSetupOwner } from "../../runtime/slack-auto-setup-owner.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { AgentSetupService } from "../../services/agents/agent-setup-service.js";
import { SlackAutoSetupService } from "../../services/agents/slack-auto-setup-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { FeishuSetupService } from "../../services/im-bindings/feishu/index.js";
import { ImBindingService } from "../../services/im-bindings/im-binding-service.js";
import { SlackConfigurationService } from "../../services/im-bindings/slack/configuration-service.js";
import { moveLegacyAgentFixture, transferLegacyAgentFixture } from "../support/legacy-agent-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
const owners: SlackAutoSetupOwner[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => {
  await pg.reset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) owner.close();
  await Promise.all(clients.splice(0).map((client) => client.sql.end()));
});
afterAll(async () => {
  await pg?.stop();
});
function actor() {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(client);
  return client;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const credentials = {
  appId: "A_SETUP",
  teamId: "T_SETUP",
  botUserId: "U_SETUP",
  botAccessToken: "xoxb-fixture-only",
  signingSecret: "fixture-secret-only",
};
async function fixture() {
  const client = actor();
  const [account] = await client.database
    .insert(users)
    .values({ email: "setup@example.test", displayName: "Setup" })
    .returning();
  assert(account);
  const targets = await client.database
    .insert(computers)
    .values(
      ["A", "B"].map((name) => ({
        ownerAccountId: account.id,
        currentInstallationId: randomUUID(),
        displayName: name,
        platform: "linux" as const,
        arch: "x64",
        clientVersion: "0.1.2",
      })),
    )
    .returning();
  const computer = targets[0],
    next = targets[1];
  assert(computer?.currentInstallationId && next);
  const agents = new AgentService(client.database);
  const agent = await agents.createForAccount(account.id, {
    name: "setup",
    displayName: "Setup",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 13));
  const bindings = new ImBindingService(client.database, cipher);
  const entered = deferred(),
    release = deferred();
  const slack = new SlackConfigurationService({
    database: client.database,
    cipher,
    imBindings: bindings,
    api: {
      authTest: async () => {
        throw new Error("Unexpected authTest");
      },
      oauthAccess: async () => {
        throw new Error("Unexpected oauthAccess");
      },
      fetchResource: async () => {
        throw new Error("Unexpected fetchResource");
      },
      inspectInstallation: async () => {
        entered.resolve();
        await release.promise;
        return {
          ...credentials,
          enterpriseId: null,
          botId: "B_SETUP",
          grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        };
      },
      botInfo: async () => ({ id: "B_SETUP", userId: credentials.botUserId, appId: credentials.appId, deleted: false }),
      botProfile: async () => ({ displayName: "Setup", avatarUrl: null }),
    },
  });
  const registry = new ConnectionRegistry();
  const instanceId = randomUUID(),
    frames: { requestId: string }[] = [],
    sent = deferred();
  await registry.register(
    {
      computerId: computer.id,
      installationId: computer.currentInstallationId,
      instanceId,
      lastHeartbeatAt: Date.now(),
      negotiatedCapabilities: { [RUNTIME_CAPABILITY.slackAutoSetup]: 1 },
      socket: {
        readyState: WebSocket.OPEN,
        send: (body: string, done: () => void) => {
          frames.push(JSON.parse(body));
          sent.resolve();
          done();
        },
      } as unknown as WebSocket,
    },
    async () => undefined,
  );
  const owner = new SlackAutoSetupOwner(registry, 2000);
  owners.push(owner);
  const auto = new SlackAutoSetupService({ agents, slack, owner, publicOrigin: "https://example.test" });
  const finish = (result: SlackAutoSetupRuntimeResult["result"]) => {
    const frame = frames.at(-1);
    assert(frame);
    return owner.businessOptions().handle(
      { type: "slack:auto-setup:result", requestId: frame.requestId, result },
      {
        computerId: computer.id,
        installationId: computer.currentInstallationId as string,
        instanceId,
        signal: new AbortController().signal,
      },
    );
  };
  return {
    client,
    account,
    computer,
    next,
    agent,
    agents,
    auto,
    slack,
    bindings,
    cipher,
    entered,
    release,
    sent,
    finish,
    frames,
  };
}

it.each(["before inspection", "during inspection"])(
  "rejects auto setup after a historical placement change %s without storing credentials",
  async (stage) => {
    const f = await fixture(),
      writer = actor();
    const running = f.auto.run(f.account.id, f.agent.id, { action: "connect" }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await f.sent.promise;
      if (stage === "before inspection") await moveLegacyAgentFixture(writer.database, f.agent.id, f.next.id);
      await f.finish({ status: "installed", credentials });
      await f.entered.promise;
      await expect(f.client.sql`select 1 as healthy`).resolves.toHaveLength(1);
      if (stage === "during inspection") await moveLegacyAgentFixture(writer.database, f.agent.id, f.next.id);
    } finally {
      f.release.resolve();
    }
    expect(await running).toMatchObject({ error: { code: "SLACK_CONFIGURATION_CONFLICT", statusCode: 409 } });
    expect(
      await f.client.database
        .select()
        .from(imBindings)
        .where(and(eq(imBindings.agentId, f.agent.id), ne(imBindings.status, "disabled"))),
    ).toHaveLength(0);
    expect(await f.client.database.select().from(slackInstallations)).toHaveLength(0);
    expect(f.frames).toHaveLength(1);
    expect((await f.agents.getConfigById(f.account.id, f.agent.id)).computerId).toBe(f.next.id);
  },
);

async function boundFixture() {
  const f = await fixture();
  f.release.resolve();
  await f.slack.configureToken(
    f.account.id,
    f.agent.id,
    {
      intent: "create",
      expectedMessaging: { kind: "unbound" },
      botAccessToken: credentials.botAccessToken,
      signingSecret: credentials.signingSecret,
    },
    credentials,
    f.computer.id,
  );
  return f;
}
const changes = ["unbind", "generation", "transfer", "computer", "suspended"] as const;
type Change = (typeof changes)[number];
async function changeTarget(f: Awaited<ReturnType<typeof boundFixture>>, change: Change) {
  const view = await f.slack.view(f.account.id, f.agent.id, "https://example.test");
  assert(view.binding);
  if (change === "unbind") {
    await f.bindings.unbindForAgent(f.account.id, f.agent.id, { provider: "slack", bindingId: view.binding.id });
  } else if (change === "generation") {
    await f.slack.configureToken(f.account.id, f.agent.id, {
      intent: "reauthorize",
      expectedMessaging: {
        kind: "bound",
        provider: "slack",
        bindingId: view.binding.id,
        credentialGeneration: view.binding.credentialGeneration,
      },
      signingSecret: "replacement-secret",
    });
  } else if (change === "computer") await moveLegacyAgentFixture(f.client.database, f.agent.id, f.next.id);
  else if (change === "suspended") await f.agents.suspendById(f.account.id, f.agent.id);
  else {
    const [other] = await f.client.database
      .insert(users)
      .values({ email: "new-owner@example.test", displayName: "Next" })
      .returning();
    assert(other);
    await f.agents.suspendById(f.account.id, f.agent.id);
    await transferLegacyAgentFixture(f.client.database, {
      agentId: f.agent.id,
      slack: "keep",
      targetAccountId: other.id,
    });
    await f.agents.reactivateById(other.id, f.agent.id);
  }
}
async function targetState(f: Awaited<ReturnType<typeof fixture>>) {
  const [agent] = await f.client.database.select().from(agentRows).where(eq(agentRows.id, f.agent.id));
  const bindings = await f.client.database
    .select()
    .from(imBindings)
    .where(eq(imBindings.agentId, f.agent.id))
    .orderBy(imBindings.id);
  return { agent, bindings };
}

it.each(changes)("refuses callback admission after %s without sending CLI work", async (change) => {
  const f = await boundFixture(),
    read = f.slack.view.bind(f.slack);
  let changed: Awaited<ReturnType<typeof targetState>> | undefined;
  vi.spyOn(f.slack, "view").mockImplementationOnce(async (...args) => {
    const selected = await read(...args);
    // Change after the authoritative view returned, before the final admission query.
    await changeTarget(f, change);
    changed = await targetState(f);
    return selected;
  });
  await expect(f.auto.run(f.account.id, f.agent.id, { action: "connect" })).rejects.toMatchObject({
    code: "SLACK_CONFIGURATION_CONFLICT",
  });
  expect(f.frames).toHaveLength(0);
  expect(await targetState(f)).toEqual(changed);
});

it.each(changes)("refuses late callback success after %s without rebinding or undoing the change", async (change) => {
  const f = await boundFixture();
  const running = f.auto.run(f.account.id, f.agent.id, { action: "connect" }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await f.sent.promise;
  await expect(f.client.sql`select 1 as healthy`).resolves.toHaveLength(1);
  await changeTarget(f, change);
  const changed = await targetState(f);
  await f.finish({ status: "connected" });
  expect(await running).toMatchObject({ error: { code: "SLACK_CONFIGURATION_CONFLICT" } });
  expect(await targetState(f)).toEqual(changed);
  expect(f.frames).toHaveLength(1);
});

it("keeps a current callback success", async () => {
  const f = await boundFixture(),
    running = f.auto.run(f.account.id, f.agent.id, { action: "connect" });
  await f.sent.promise;
  await f.finish({ status: "connected" });
  expect(await running).toEqual({ status: "connected" });
  expect(f.frames).toHaveLength(1);
});

it("reads setup and preparation without discarded activity queries", async () => {
  const f = await fixture(),
    now = new Date("2026-11-03T00:00:00Z");
  const messaging = new FeishuSetupService({
    database: f.client.database,
    cipher: f.cipher,
    instanceId: randomUUID(),
    imBindings: f.bindings,
    registrations: {
      start: () => {
        throw new Error("Unexpected provider request");
      },
    },
    activation: {} as never,
    now: () => now,
  });
  const prepareComputer = vi.fn(async () => undefined);
  const setup = new AgentSetupService(f.client.database, f.agents, messaging, { now: () => now, prepareComputer });
  const { activity: _activity, ...summary } = await f.agents.getById(f.account.id, f.agent.id);
  const queries: string[] = [];
  const debug = f.client.sql.options.debug;
  f.client.sql.options.debug = (_id, query) => {
    queries.push(query);
  };
  try {
    expect((await setup.getSetupById(f.account.id, f.agent.id)).agent).toEqual(summary);
    expect(queries.some((query) => query.includes('from "im_message_deliveries"'))).toBe(false);
    expect(queries.filter((query) => query.trimStart().toLowerCase().startsWith("select"))).toHaveLength(5);
    // Messaging retains its own Repeatable Read BEGIN/SET/COMMIT.
    expect(queries).toHaveLength(8);
    queries.length = 0;
    await setup.refreshPreparationById(f.account.id, f.agent.id);
    expect(queries.some((query) => query.includes('from "im_message_deliveries"'))).toBe(false);
    expect(queries).toHaveLength(2);
    expect(prepareComputer).toHaveBeenCalledTimes(1);
  } finally {
    f.client.sql.options.debug = debug;
    await messaging.stop();
  }
});

it("joins a disconnected HTTP setup through confirmed inspection and final SQL", async () => {
  const f = await fixture();
  const app = createApp();
  let result: unknown;
  app.post("/setup", async () => {
    result = await f.auto.run(f.account.id, f.agent.id, { action: "connect" });
    return result;
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const request = fetch(`${address}/setup`, { method: "POST", signal: abort.signal }).then(
    () => undefined,
    (error: unknown) => error,
  );
  let drained = false;
  let closing: Promise<void> | undefined;
  try {
    await f.sent.promise;
    await f.finish({ status: "installed", credentials });
    await f.entered.promise;
    abort.abort();
    expect(await request).toMatchObject({ name: "AbortError" });
    closing = app.close().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(drained).toBe(false);
    f.release.resolve();
    await expect.poll(() => f.frames.length).toBe(2);
    await f.finish({ status: "connected" });
    await closing;
    expect(result).toEqual({ status: "connected" });
    const [binding] = await f.client.database.select().from(imBindings).where(eq(imBindings.agentId, f.agent.id));
    expect(binding?.status).toBe("active");
    expect(binding?.provider).toBe("slack");
    expect((await f.client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
  } finally {
    f.release.resolve();
    abort.abort();
    await request;
    await (closing ?? app.close());
  }
});
