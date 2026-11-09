import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agents, imBindings, users } from "../../db/schema/index.js";
import type { ExternalCallPolicy } from "../../services/im/external-call-policy.js";
import { type AuthorizedAgentAvatar, ImResourceService } from "../../services/im/im-resource-service.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);
beforeEach(async () => testDatabase.reset());
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

async function fixture() {
  const [owner, other] = await client.database
    .insert(users)
    .values([
      { email: "avatar-owner@example.com", displayName: "Owner" },
      { email: "avatar-other@example.com", displayName: "Other" },
    ])
    .returning();
  if (!owner || !other) throw new Error("Missing Accounts");
  const [agent] = await client.database
    .insert(agents)
    .values({
      createdByUserId: owner.id,
      name: "avatar",
      displayName: "Avatar",
      runtimeProvider: "codex",
    })
    .returning();
  if (!agent) throw new Error("Missing Agent");
  const [binding] = await client.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "error",
      botAvatarUrl: "https://cdn.example.test/avatar.png",
    })
    .returning();
  if (!binding) throw new Error("Missing binding");
  const fetch = vi.fn(async () => new Response("image", { headers: { "content-type": "image/png" } }));
  const service = new ImResourceService(client.database, vi.fn(), { fetch } as unknown as ExternalCallPolicy);
  const open = (accountId = owner.id) => service.openAvatar(accountId, agent.id);
  const warm = async () => expect(await text(await open())).toBe("image");
  return { owner, other, agent, binding, fetch, open, warm };
}

async function text(avatar: AuthorizedAgentAvatar): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of avatar.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe("avatar cache database authority", () => {
  it("rejects another Account after warming and fetches fresh bytes after an ownership transfer", async () => {
    const value = await fixture();
    await value.warm();
    await value.warm();
    await expect(value.open(value.other.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(value.fetch).toHaveBeenCalledOnce();
    await client.database.update(agents).set({ createdByUserId: value.other.id }).where(eq(agents.id, value.agent.id));
    await expect(value.open()).rejects.toMatchObject({ statusCode: 404 });
    value.fetch.mockResolvedValueOnce(new Response("new owner", { headers: { "content-type": "image/png" } }));
    expect(await text(await value.open(value.other.id))).toBe("new owner");
    expect(value.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "deleted", "cleared"] as const)("rejects a warm entry when %s", async (state) => {
    const value = await fixture();
    await value.warm();
    if (state === "disabled") {
      await client.database
        .update(imBindings)
        .set({ status: "disabled", disabledAt: new Date() })
        .where(eq(imBindings.id, value.binding.id));
    } else if (state === "deleted") {
      await client.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, value.agent.id));
    } else {
      await client.database.update(imBindings).set({ botAvatarUrl: null }).where(eq(imBindings.id, value.binding.id));
    }
    await expect(value.open()).rejects.toMatchObject({ statusCode: 404 });
    expect(value.fetch).toHaveBeenCalledOnce();
  });

  it("retains the existing display permission for a suspended Agent", async () => {
    const value = await fixture();
    await value.warm();
    await client.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
    await value.warm();
    expect(value.fetch).toHaveBeenCalledOnce();
  });

  it("does not reuse bytes for a new URL, credential generation, or replacement binding", async () => {
    const value = await fixture();
    await value.warm();
    await client.database
      .update(imBindings)
      .set({ botAvatarUrl: "https://cdn.example.test/new.png" })
      .where(eq(imBindings.id, value.binding.id));
    await value.warm();
    await client.database
      .update(imBindings)
      .set({ credentialGeneration: 1 })
      .where(eq(imBindings.id, value.binding.id));
    await value.warm();
    await client.database
      .update(imBindings)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(imBindings.id, value.binding.id));
    await client.database.insert(imBindings).values({
      agentId: value.agent.id,
      provider: "feishu",
      status: "error",
      credentialGeneration: 1,
      botAvatarUrl: "https://cdn.example.test/new.png",
    });
    await value.warm();
    expect(value.fetch).toHaveBeenCalledTimes(4);
  });
});
