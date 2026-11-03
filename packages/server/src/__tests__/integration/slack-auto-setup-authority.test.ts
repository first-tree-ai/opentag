import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, SLACK_REQUIRED_BOT_SCOPES, type SlackAutoSetupRuntimeResult } from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imBindings, slackInstallations, users } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { SlackAutoSetupOwner } from "../../runtime/slack-auto-setup-owner.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { SlackAutoSetupService } from "../../services/agents/slack-auto-setup-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/im-binding-service.js";
import { SlackConfigurationService } from "../../services/im-bindings/slack/configuration-service.js";
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
  return { client, account, computer, next, agent, agents, auto, entered, release, sent, finish, frames };
}

it.each(["before inspection", "during inspection"])(
  "rejects auto setup after a real rebind %s without storing credentials",
  async (stage) => {
    const f = await fixture(),
      writer = actor();
    const running = f.auto.run(f.account.id, f.agent.id, { action: "connect" }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await f.sent.promise;
      if (stage === "before inspection")
        await new AgentService(writer.database).rebindById(f.account.id, f.agent.id, f.next.id);
      await f.finish({ status: "installed", credentials });
      await f.entered.promise;
      await expect(f.client.sql`select 1 as healthy`).resolves.toHaveLength(1);
      if (stage === "during inspection")
        await new AgentService(writer.database).rebindById(f.account.id, f.agent.id, f.next.id);
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
