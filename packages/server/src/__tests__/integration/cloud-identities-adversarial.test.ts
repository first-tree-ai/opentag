import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { migrateDatabase } from "../../db/migrate.js";
import { agents, computers, imBindings, sandboxes, sessionPlacements, users } from "../../db/schema/index.js";
import { SandboxService } from "../../services/sandboxes/index.js";
import { SessionService } from "../../services/sessions/index.js";

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof createDatabaseClient>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  await migrateDatabase(container.getConnectionUri(), fileURLToPath(new URL("../../../drizzle", import.meta.url)));
  client = createDatabaseClient(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  await client?.sql.end();
  await container?.stop();
});

async function fixture() {
  const accountId = randomUUID();
  const computerId = randomUUID();
  const localComputerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  await client.database
    .insert(users)
    .values({ id: accountId, email: `${accountId}@opentag.local`, displayName: "E2 adversarial fixture" });
  await client.database.insert(computers).values([
    {
      id: computerId,
      ownerAccountId: accountId,
      kind: "cloud",
      currentInstallationId: randomUUID(),
      displayName: "Cloud",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.5",
    },
    {
      id: localComputerId,
      ownerAccountId: accountId,
      kind: "local",
      currentInstallationId: randomUUID(),
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.5",
    },
  ]);
  await client.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    computerId,
    name: "placement-fixture",
    displayName: "Placement fixture",
    runtimeProvider: "pi",
  });
  // Test-only binding; this service never decrypts or contacts the IM provider.
  await client.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `e2-${bindingId}`,
    externalBotId: "e2-fixture-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "e2-fixture-not-a-provider-credential",
    activatedAt: new Date(),
  });
  const sessionService = new SessionService(client.database);
  const sandboxService = new SandboxService(client.database, sessionService, {
    cloudIdentities: { enabled: true, storageBase: "gs://opentag-e2-fixture/adversarial" },
  });
  const input = {
    imBindingId: bindingId,
    channelId: "fixture-channel",
    conversationKind: "channel" as const,
    kind: "channel" as const,
  };
  return { accountId, computerId, localComputerId, sessionService, sandboxService, input };
}

describe("Cloud identity placement integrity", () => {
  it("refuses to create a Sandbox when persisted Session placement disagrees with the Cloud Agent", async () => {
    const value = await fixture();
    const { session } = await value.sessionService.ensureChatSession(value.input, "channel");
    // Simulate a stale placement left by an earlier writer. Identity ensure must not silently repair it.
    await client.database
      .update(sessionPlacements)
      .set({ computerId: value.localComputerId })
      .where(eq(sessionPlacements.sessionId, session.id));

    await expect(value.sandboxService.ensureForAccount(value.accountId, value.input)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
    expect(await client.database.select().from(sandboxes).where(eq(sandboxes.sessionId, session.id))).toEqual([]);
    const [placement] = await client.database
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, session.id));
    expect(placement?.computerId).toBe(value.localComputerId);
  });

  it("does not present an Agent Computer as the Sandbox placement after a conflicting persisted move", async () => {
    const value = await fixture();
    const created = await value.sandboxService.ensureForAccount(value.accountId, value.input);
    await client.database
      .update(sessionPlacements)
      .set({ computerId: value.localComputerId })
      .where(eq(sessionPlacements.sessionId, created.sessionId));

    await expect(value.sandboxService.getForAccount(value.accountId, created.sandboxId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
    const [stored] = await client.database.select().from(sandboxes).where(eq(sandboxes.id, created.sandboxId));
    expect(stored?.storageUri).toBe(created.storageUri);
  });
});
