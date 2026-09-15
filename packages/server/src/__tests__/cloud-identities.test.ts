/** Database decisions run on the embedded PostgreSQL engine; transport/concurrency acceptance stays in E2. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, computers, imBindings, sandboxes, sessionPlacements, sessions, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ComputerService, MachineAuthService } from "../services/computers/index.js";
import { SandboxService } from "../services/sandboxes/index.js";
import { SessionService } from "../services/sessions/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
const cloudIdentities = { enabled: true, runnerVersion: "0.0.5", storageBase: "gs://unit-cloud/sandboxes" };
const unusedAccountResolver = {
  getActiveUserById: async () => {
    throw new Error("unused Account projection");
  },
};

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

async function account() {
  const id = randomUUID();
  await unit.database.insert(users).values({ id, email: `${id}@example.test`, displayName: "Cloud fixture" });
  return id;
}
function computerService(config = cloudIdentities) {
  return new ComputerService(unit.database, unusedAccountResolver, { cloudIdentities: config });
}
function sandboxService(enabled = true) {
  return new SandboxService(unit.database, new SessionService(unit.database), {
    cloudIdentities: { ...cloudIdentities, enabled },
  });
}
async function binding() {
  const accountId = await account();
  const cloud = await computerService().ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: "cloud-pi",
    displayName: "Cloud Pi",
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  const bindingId = randomUUID();
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId: agent.id,
    provider: "feishu",
    status: "active",
    externalAppId: "unit-app",
    externalBotId: "unit-bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: new Date(),
  });
  return {
    accountId,
    cloud,
    agent,
    request: {
      imBindingId: bindingId,
      channelId: "unit-channel",
      conversationKind: "channel" as const,
      kind: "channel" as const,
    },
  };
}

describe("Cloud identity database decisions", () => {
  it("keeps Account identity and installation metadata stable without inventing Local credentials", async () => {
    const owner = await account();
    const service = computerService();
    const cloud = await service.ensureCloudComputerForAccount(owner);
    const [before] = await unit.database.select().from(computers).where(eq(computers.id, cloud.computerId));
    expect(
      await computerService({ ...cloudIdentities, runnerVersion: "0.0.6" }).ensureCloudComputerForAccount(owner),
    ).toEqual(cloud);
    expect(await unit.database.select().from(computers)).toEqual([before]);
    const other = await service.ensureCloudComputerForAccount(await account());
    expect(other.computerId).not.toBe(cloud.computerId);
    expect(before).toMatchObject({
      kind: "cloud",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.5",
      currentInstanceId: null,
      connectedAt: null,
      lastSeenAt: null,
    });
    expect(before?.currentInstallationId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await service.listAccountComputers(owner)).computers).toEqual([]);

    const machine = new MachineAuthService(unit.database);
    const code = await machine.issueForAccount(owner, {});
    const local = await machine.exchangeConnectCode({
      code: code.code,
      installationId: randomUUID(),
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.5",
    });
    const legacy = await service.listAccountComputers(owner);
    expect(legacy.computers).toEqual([
      expect.objectContaining({ computerId: local.computerId, connectionStatus: "offline" }),
    ]);
    expect(legacy.computers[0]).not.toHaveProperty("kind");
    const capable = await service.listAccountComputers(owner, true, true);
    const row = capable.computers.find((entry) => entry.computerId === cloud.computerId);
    expect(row).toMatchObject({ kind: "cloud", connectionStatus: "online", connectedAt: null, lastSeenAt: null });
    expect(row?.providerReadiness).toContainEqual({ provider: "pi", status: "unavailable", observedAt: null });
    expect(row?.imCliReadiness?.every((entry) => entry.status === "unavailable" && entry.observedAt === null)).toBe(
      true,
    );
  });

  it("refuses Cloud creation when disabled or when the Account is suspended", async () => {
    const owner = await account();
    await expect(
      computerService({ ...cloudIdentities, enabled: false }).ensureCloudComputerForAccount(owner),
    ).rejects.toMatchObject({ statusCode: 404 });
    await unit.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, owner));
    await expect(computerService().ensureCloudComputerForAccount(owner)).rejects.toMatchObject({
      code: "AUTH_USER_SUSPENDED",
    });
    expect(await unit.database.select().from(computers)).toEqual([]);
  });

  it("ensures one durable environment per actual Session and preserves reads with creation disabled", async () => {
    const seeded = await binding();
    const service = sandboxService();
    const created = await service.ensureForAccount(seeded.accountId, seeded.request);
    expect(created).toMatchObject({
      computerId: seeded.cloud.computerId,
      lifecycle: "unallocated",
      environmentGeneration: 0,
      currentResourceName: null,
      currentResourceUid: null,
      currentOperationName: null,
    });
    expect(created.storageUri).toBe(`${cloudIdentities.storageBase}/${created.sandboxId}`);
    expect(await service.ensureForAccount(seeded.accountId, seeded.request)).toEqual(created);
    expect(await sandboxService(false).getForAccount(seeded.accountId, created.sandboxId)).toEqual(created);
    await expect(sandboxService(false).ensureForAccount(seeded.accountId, seeded.request)).rejects.toMatchObject({
      statusCode: 404,
    });
    const thread = await service.ensureForAccount(seeded.accountId, {
      ...seeded.request,
      kind: "thread",
      threadKey: "unit-thread",
    });
    expect(thread.sessionId).not.toBe(created.sessionId);
    expect(thread.storageUri).not.toBe(created.storageUri);
    expect(await unit.database.select().from(sandboxes)).toHaveLength(2);
  });

  it("refuses foreign or missing bindings and Sandboxes without creating a Session", async () => {
    const seeded = await binding();
    const other = await account();
    const service = sandboxService();
    for (const [owner, request] of [
      [other, seeded.request],
      [seeded.accountId, { ...seeded.request, imBindingId: randomUUID() }],
    ] as const) {
      await expect(service.ensureForAccount(owner, request)).rejects.toMatchObject({
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
      });
    }
    expect(await unit.database.select().from(sessions)).toEqual([]);
    const created = await service.ensureForAccount(seeded.accountId, seeded.request);
    await expect(service.getForAccount(other, created.sandboxId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getForAccount(seeded.accountId, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.ensureForAccount(seeded.accountId, { ...seeded.request, conversationKind: "dm" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rolls Session and placement creation back if environment creation fails", async () => {
    const seeded = await binding();
    const failing = new SandboxService(unit.database, new SessionService(unit.database), {
      cloudIdentities,
      afterSessionEnsured: async () => {
        throw new Error("environment store unavailable");
      },
    });
    await expect(failing.ensureForAccount(seeded.accountId, seeded.request)).rejects.toThrow(
      "environment store unavailable",
    );
    expect(await unit.database.select().from(sessions)).toEqual([]);
    expect(await unit.database.select().from(sessionPlacements)).toEqual([]);
    expect(await unit.database.select().from(sandboxes)).toEqual([]);
  });

  it("rejects placement disagreement without reporting or overwriting another Computer", async () => {
    const seeded = await binding();
    const created = await sandboxService().ensureForAccount(seeded.accountId, seeded.request);
    const otherCloud = await computerService().ensureCloudComputerForAccount(await account());
    await unit.database
      .update(sessionPlacements)
      .set({ computerId: otherCloud.computerId })
      .where(eq(sessionPlacements.sessionId, created.sessionId));
    await expect(sandboxService().getForAccount(seeded.accountId, created.sandboxId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(sandboxService().ensureForAccount(seeded.accountId, seeded.request)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect((await unit.database.select().from(sandboxes))[0]?.storageUri).toBe(created.storageUri);
    expect((await unit.database.select().from(sessionPlacements))[0]?.computerId).toBe(otherCloud.computerId);
  });

  it("requires an active Pi binding and an owned Cloud Computer before allocating any identity", async () => {
    const seeded = await binding();
    const service = sandboxService();
    await unit.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, seeded.request.imBindingId));
    await expect(service.ensureForAccount(seeded.accountId, seeded.request)).rejects.toMatchObject({ statusCode: 404 });
    await unit.database
      .update(imBindings)
      .set({ status: "active" })
      .where(eq(imBindings.id, seeded.request.imBindingId));
    await unit.database.update(agents).set({ computerId: null }).where(eq(agents.id, seeded.agent.id));
    await expect(service.ensureForAccount(seeded.accountId, seeded.request)).rejects.toMatchObject({ statusCode: 404 });
    await unit.database
      .update(agents)
      .set({ computerId: seeded.cloud.computerId })
      .where(eq(agents.id, seeded.agent.id));
    await unit.database.update(computers).set({ kind: "local" }).where(eq(computers.id, seeded.cloud.computerId));
    await expect(service.ensureForAccount(seeded.accountId, seeded.request)).rejects.toMatchObject({ statusCode: 404 });
    expect(await unit.database.select().from(sessions)).toEqual([]);
  });
});
