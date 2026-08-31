import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapTestAccount } from "../../../__tests__/test-account.js";
import {
  accountComputers,
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  sessions,
  workspaceComputers,
} from "../../../db/schema/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "../index.js";

let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unitDatabase?.close();
});

beforeEach(async () => {
  await unitDatabase.reset();
});

async function fixture(withConfig = true) {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Runtime User",
    email: "runtime@example.com",
    workspaceDisplayName: "Runtime",
    workspaceName: "runtime",
  });
  const installationId = crypto.randomUUID();
  await unitDatabase.database.insert(computers).values({ id: installationId });
  const [enrollment] = await unitDatabase.database
    .insert(workspaceComputers)
    .values({
      workspaceId: bootstrap.workspaceId,
      computerId: installationId,
      displayName: "Runtime Computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
      enrolledByUserId: bootstrap.userId,
    })
    .returning();
  if (!enrollment) throw new Error("Runtime computer fixture was not created");
  await unitDatabase.database.insert(accountComputers).values({
    id: enrollment.id,
    ownerAccountId: bootstrap.userId,
    currentInstallationId: installationId,
    displayName: "Runtime Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const [agent] = await unitDatabase.database
    .insert(agents)
    .values({
      workspaceId: bootstrap.workspaceId,
      createdByUserId: bootstrap.userId,
      workspaceComputerId: enrollment.id,
      computerId: enrollment.id,
      name: "runtime-agent",
      displayName: "Runtime Agent",
      runtimeProvider: "codex",
    })
    .returning();
  if (!agent) throw new Error("Runtime Agent fixture was not created");
  const [binding] = await unitDatabase.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "runtime-app",
      externalBotId: "runtime-bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "runtime-credential",
      activatedAt: new Date(),
    })
    .returning();
  if (!binding) throw new Error("Runtime binding fixture was not created");
  const [session] = await unitDatabase.database
    .insert(sessions)
    .values({
      imBindingId: binding.id,
      channelId: "runtime-channel",
      conversationKind: "channel",
      kind: "channel",
    })
    .returning();
  if (!session) throw new Error("Runtime Session fixture was not created");
  if (withConfig) {
    await unitDatabase.database.insert(agentRuntimeConfigs).values({
      agentId: agent.id,
      revision: 4,
      model: "gpt-5",
      reasoningEffort: "high",
      instructions: "Read the repository instructions.",
      maxDurationMs: 30_000,
    });
  }
  return { agent, session };
}

describe("EffectiveRuntimeSnapshotAssembler database authority", () => {
  it("loads and projects a real Session authority row", async () => {
    const { agent, session } = await fixture();
    const snapshot = await new EffectiveRuntimeSnapshotAssembler(unitDatabase.database).assembleForSession(session.id);
    expect(snapshot).toMatchObject({
      agentId: agent.id,
      provider: "codex",
      model: "gpt-5",
      reasoningEffort: "high",
      instructions: { agent: "Read the repository instructions." },
      budget: { maxDurationMs: 30_000 },
      revision: { agent: { sequence: 4 }, session: { sequence: 4 } },
    });
  });

  it("distinguishes a missing Session and a missing runtime config from database loading", async () => {
    await expect(
      new EffectiveRuntimeSnapshotAssembler(unitDatabase.database).assembleForSession(crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    const { session } = await fixture(false);
    await expect(
      new EffectiveRuntimeSnapshotAssembler(unitDatabase.database).assembleForSession(session.id),
    ).rejects.toMatchObject({ code: "RUNTIME_CONFIG_MISSING" });
  });
});
