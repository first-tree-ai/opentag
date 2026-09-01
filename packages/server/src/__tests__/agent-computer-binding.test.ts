/**
 * An Agent that exists before its Computer, exercised against the embedded engine.
 *
 * These are database decisions — a nullable pair of columns, a projection that distinguishes "no
 * Computer" from "Computer unreadable", a rebind that starts from nothing, and the refusals that
 * keep an unplaceable Agent from being connected to messaging. They are unit tests because the
 * behaviour is the SQL: a stubbed query builder would test the stub.
 */

import { FEISHU_REQUIRED_TENANT_SCOPES, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import type { DatabaseClient } from "../db/client.js";
import { agents, computerCredentials, computers, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { FeishuSetupService } from "../services/im-bindings/feishu/index.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { SlackConfigurationService } from "../services/im-bindings/slack/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => unitDatabase?.close());

beforeEach(async () => unitDatabase.reset());

async function account(email = "admin@example.com") {
  return bootstrapTestAccount(unitDatabase.database, {
    displayName: "Admin",
    email,
  });
}

const computerProfile = {
  displayName: "workstation",
  platform: "linux" as const,
  arch: "x64",
  clientVersion: "0.0.2",
};

async function connectComputer(database: DatabaseClient, ownerAccountId: string) {
  const installationId = crypto.randomUUID();
  const [computer] = await database
    .insert(computers)
    .values({
      id: crypto.randomUUID(),
      ownerAccountId,
      currentInstallationId: installationId,
      ...computerProfile,
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  await database.insert(computerCredentials).values({
    computerId: computer.id,
    secretHash: `agent-binding-${computer.id}`,
    issuedByUserId: ownerAccountId,
  });
  return { id: computer.id, installationId };
}

function unboundInput(name = "assistant") {
  return { name, displayName: "Assistant", runtimeProvider: "codex" as const };
}

const cipher = () => new ApplicationCipher(Buffer.alloc(32, 7));

describe("An Agent created before its Computer", () => {
  it("records no Computer, stays readable, and reports the absence rather than omitting it", async () => {
    const bootstrap = await account();
    const service = new AgentService(unitDatabase.database);

    const created = await service.createForAccount(bootstrap.userId, unboundInput());
    expect(created).toMatchObject({ computerId: null, revision: 1, status: "active" });

    const [stored] = await unitDatabase.database.select().from(agents).where(eq(agents.id, created.id));
    expect(stored?.computerId).toBeNull();

    // `computer` is stated as null rather than dropped, so a reader can tell it from an unread one.
    const listed = await service.listForAccount(bootstrap.userId);
    expect(listed.agents).toEqual([expect.objectContaining({ id: created.id, computer: null })]);
    await expect(service.getById(bootstrap.userId, created.id)).resolves.toMatchObject({
      id: created.id,
      computer: null,
    });
    await expect(service.getConfigById(bootstrap.userId, created.id)).resolves.toEqual(created);
  });

  it("refuses a row that names a Computer that does not exist", async () => {
    const bootstrap = await account();

    await expect(
      unitDatabase.engine.query(
        `insert into agents (created_by_user_id, computer_id, name, display_name, runtime_provider)
         values ($1, $2, 'missing', 'Missing', 'codex')`,
        [bootstrap.userId, crypto.randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("takes a Computer afterwards through the operation that moves one", async () => {
    const bootstrap = await account();
    const service = new AgentService(unitDatabase.database);
    const created = await service.createForAccount(bootstrap.userId, unboundInput());
    const connected = await connectComputer(unitDatabase.database, bootstrap.userId);

    const bound = await service.rebindById(bootstrap.userId, created.id, connected.id);
    expect(bound).toMatchObject({ computerId: connected.id, revision: 2 });
    await expect(service.getById(bootstrap.userId, created.id)).resolves.toMatchObject({
      computer: expect.objectContaining({ computerId: connected.id }),
    });
  });

  it("refuses a Computer the caller does not own", async () => {
    const bootstrap = await account();
    const service = new AgentService(unitDatabase.database);
    const created = await service.createForAccount(bootstrap.userId, unboundInput());
    const [other] = await unitDatabase.database
      .insert(users)
      .values({ displayName: "Other", email: "other@example.com" })
      .returning();
    if (!other) throw new Error("Other Account fixture was not created");
    const foreign = await connectComputer(unitDatabase.database, other.id);

    await expect(service.rebindById(bootstrap.userId, created.id, foreign.id)).rejects.toMatchObject({
      code: "COMPUTER_NOT_FOUND",
    });
  });
});

describe("Messaging for an Agent that has no Computer", () => {
  it("refuses a Feishu setup before it registers an App, and refuses the activation too", async () => {
    const bootstrap = await account();
    const imBindings = new ImBindingService(unitDatabase.database, cipher());
    const created = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, unboundInput());
    const start = vi.fn();
    const setup = new FeishuSetupService({
      database: unitDatabase.database,
      cipher: cipher(),
      instanceId: crypto.randomUUID(),
      imBindings,
      registrations: { start },
      activation: { activateAtomicAttempt: vi.fn() },
    });

    await expect(setup.createOrReuse(bootstrap.userId, created.id, "create")).rejects.toMatchObject({
      code: "AGENT_COMPUTER_NOT_BOUND",
      statusCode: 409,
    });
    // Nothing external was asked for: a registration creates a real Feishu App the Agent could not use.
    expect(start).not.toHaveBeenCalled();

    await expect(
      imBindings.activateFeishu({
        agentId: created.id,
        appId: "cli_unbound",
        appSecret: "secret",
        teamId: "T_UNBOUND",
        botOpenId: "ou_bot",
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      }),
    ).rejects.toMatchObject({ code: "AGENT_COMPUTER_NOT_BOUND", statusCode: 409 });
  });

  it("refuses Slack at the read both configuration paths make", async () => {
    const bootstrap = await account();
    const imBindings = new ImBindingService(unitDatabase.database, cipher());
    const created = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, unboundInput());
    const inspectInstallation = vi.fn().mockResolvedValue({
      appId: "A_OPENTAG",
      teamId: "T_TEAM",
      enterpriseId: null,
      botUserId: "U_BOT",
      botId: "B_BOT",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    });
    const slack = new SlackConfigurationService({
      api: { inspectInstallation } as never,
      database: unitDatabase.database,
      imBindings,
    });

    // The start path reads this, so nothing is installed for an Agent that has nowhere to run.
    await expect(slack.currentBinding(bootstrap.userId, created.id)).rejects.toMatchObject({
      code: "AGENT_COMPUTER_NOT_BOUND",
      statusCode: 409,
    });
    // Nothing was asked of Slack to reach that answer.
    expect(inspectInstallation).not.toHaveBeenCalled();
    // And the commit reads it again, which is what covers an Agent unbound after the install began.
    await expect(
      slack.configure(bootstrap.userId, created.id, {
        intent: "create",
        expectedBinding: null,
        appId: "A_OPENTAG",
        botAccessToken: "xoxb-unbound",
        signingSecret: "signing-secret",
      }),
    ).rejects.toMatchObject({ code: "AGENT_COMPUTER_NOT_BOUND", statusCode: 409 });
  });

  it("connects messaging once a Computer is bound", async () => {
    const bootstrap = await account();
    const imBindings = new ImBindingService(unitDatabase.database, cipher());
    const service = new AgentService(unitDatabase.database);
    const created = await service.createForAccount(bootstrap.userId, unboundInput());
    const connected = await connectComputer(unitDatabase.database, bootstrap.userId);
    await service.rebindById(bootstrap.userId, created.id, connected.id);

    const activated = await imBindings.activateSlack(
      {
        intent: "create",
        agentId: created.id,
        appId: "A1",
        teamId: "T1",
        botUserId: "U_BOT",
        grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        botAccessToken: "xoxb-secret",
        signingSecret: "signing-secret",
        installedAt: new Date("2026-08-19T00:00:00.000Z"),
      },
      "B_BOT",
    );
    expect(activated.imBindingId).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
