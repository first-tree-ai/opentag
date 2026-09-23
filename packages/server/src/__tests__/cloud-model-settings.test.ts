/**
 * Cloud model settings validation against the Router model catalog, exercised against the
 * embedded engine: the catalog (a static double here — the Router-backed transport has its own
 * suite) is the single authority for explicit Cloud model choices on Agent create/update and on
 * internal Session overrides, and every rejected choice must leave zero writes behind.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import type { DatabaseClient } from "../db/client.js";
import { agents, computers, imBindings, sessionMessages, sessions, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import type { CloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";
import { SessionService } from "../services/sessions/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const ROUTER_MODEL = "router-model-a";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => unit.reset());

/** A catalog double that records consultations, so unrelated writes can prove they never read it. */
function trackingCatalog(models: string[] | undefined) {
  const lists = vi.fn(async () =>
    models === undefined
      ? { available: false as const, defaultModel: null, models: [] as string[] }
      : { available: true as const, defaultModel: models[0] ?? null, models },
  );
  const catalog: CloudModelCatalog = {
    capabilitiesOf: async () => undefined,
    defaultModel: async () => (await lists()).defaultModel ?? undefined,
    isModelAllowed: async (model) => (await lists()).models.includes(model),
    list: lists,
  };
  return { catalog, lists };
}

async function account(email = "admin@example.com") {
  return bootstrapTestAccount(unit.database, { displayName: "Admin", email });
}

async function cloudComputer(database: DatabaseClient, ownerAccountId: string) {
  const [computer] = await database
    .insert(computers)
    .values({
      id: randomUUID(),
      ownerAccountId,
      kind: "cloud",
      currentInstallationId: randomUUID(),
      displayName: "Cloud",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Cloud Computer fixture was not created");
  return computer;
}

async function localComputer(database: DatabaseClient, ownerAccountId: string) {
  const [computer] = await database
    .insert(computers)
    .values({
      id: randomUUID(),
      ownerAccountId,
      kind: "local",
      currentInstallationId: randomUUID(),
      currentInstanceId: randomUUID(),
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Local Computer fixture was not created");
  return computer;
}

function agentService(catalog: CloudModelCatalog) {
  return new AgentService(unit.database, { cloudIdentitiesEnabled: true, cloudModelCatalog: catalog });
}

async function agentRow(agentId: string) {
  const [row] = await unit.database.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return row;
}

describe("Agent Cloud model validation", () => {
  it("rejects explicit Cloud model writes when no model path is configured", async () => {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const service = new AgentService(unit.database, { cloudIdentitiesEnabled: true });
    const input = {
      name: "cloud-agent",
      displayName: "Cloud Agent",
      runtimeProvider: "pi" as const,
      computerId: cloud.id,
    };
    await expect(
      service.createForAccount(userId, { ...input, runtimeConfig: { model: ROUTER_MODEL } }),
    ).rejects.toMatchObject({ code: "CLOUD_MODEL_UNAVAILABLE", statusCode: 503 });
    expect(await unit.database.select().from(agents)).toHaveLength(0);
    const created = await service.createForAccount(userId, input);
    await expect(
      service.updateById(userId, created.id, {
        expectedRevision: created.revision,
        runtimeConfig: { model: ROUTER_MODEL },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_MODEL_UNAVAILABLE", statusCode: 503 });
    expect((await service.getConfigById(userId, created.id)).runtimeConfig.model).toBeNull();
  });

  it("rejects an explicit model the Router does not offer before any write", async () => {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const service = agentService(trackingCatalog([ROUTER_MODEL]).catalog);

    await expect(
      service.createForAccount(userId, {
        name: "cloud-agent",
        displayName: "Cloud Agent",
        runtimeProvider: "pi",
        computerId: cloud.id,
        runtimeConfig: { model: "delisted-model" },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_MODEL_NOT_ALLOWED", category: "deterministic", statusCode: 409 });
    // No Agent, no revision writes.
    expect(await unit.database.select().from(agents)).toHaveLength(0);
  });

  it("rejects an explicit model while the Router catalog is unavailable, before any write", async () => {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const service = agentService(trackingCatalog(undefined).catalog);

    await expect(
      service.createForAccount(userId, {
        name: "cloud-agent",
        displayName: "Cloud Agent",
        runtimeProvider: "pi",
        computerId: cloud.id,
        runtimeConfig: { model: ROUTER_MODEL },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_MODEL_UNAVAILABLE", category: "transient", statusCode: 503 });
    expect(await unit.database.select().from(agents)).toHaveLength(0);
  });

  it("accepts the offered model and the explicit platform default (null)", async () => {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const { catalog, lists } = trackingCatalog([ROUTER_MODEL]);
    const service = agentService(catalog);

    const explicit = await service.createForAccount(userId, {
      name: "cloud-agent",
      displayName: "Cloud Agent",
      runtimeProvider: "pi",
      computerId: cloud.id,
      runtimeConfig: { model: ROUTER_MODEL },
    });
    expect(explicit.runtimeConfig.model).toBe(ROUTER_MODEL);

    const defaulted = await service.createForAccount(userId, {
      name: "cloud-agent-default",
      displayName: "Cloud Agent Default",
      runtimeProvider: "pi",
      computerId: cloud.id,
      runtimeConfig: { model: null },
    });
    expect(defaulted.runtimeConfig.model).toBeNull();
    // One catalog read for the explicit choice; null never consults the catalog.
    expect(lists).toHaveBeenCalledTimes(1);
  });

  it("never consults the catalog for Local, unbound, or model-less creates", async () => {
    const { userId } = await account();
    const local = await localComputer(unit.database, userId);
    const { catalog, lists } = trackingCatalog(undefined);
    const service = agentService(catalog);

    const localAgent = await service.createForAccount(userId, {
      name: "local-agent",
      displayName: "Local Agent",
      runtimeProvider: "codex",
      computerId: local.id,
      runtimeConfig: { model: "any-local-model" },
    });
    expect(localAgent.runtimeConfig.model).toBe("any-local-model");

    const unbound = await service.createForAccount(userId, {
      name: "unbound-agent",
      displayName: "Unbound Agent",
      runtimeProvider: "codex",
      runtimeConfig: { model: "deferred-choice" },
    });
    expect(unbound.computerId).toBeNull();

    const cloudless = await service.createForAccount(userId, {
      name: "cloud-no-model",
      displayName: "Cloud Agent",
      runtimeProvider: "pi",
      computerId: (await cloudComputer(unit.database, userId)).id,
    });
    expect(cloudless.runtimeConfig.model).toBeNull();
    expect(lists).not.toHaveBeenCalled();
  });

  it("rejects an update to an unoffered model without touching any revision", async () => {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const { catalog, lists } = trackingCatalog([ROUTER_MODEL]);
    const service = agentService(catalog);
    const created = await service.createForAccount(userId, {
      name: "cloud-agent",
      displayName: "Cloud Agent",
      runtimeProvider: "pi",
      computerId: cloud.id,
    });

    await expect(
      service.updateById(userId, created.id, {
        expectedRevision: created.revision,
        runtimeConfig: { model: "delisted-model" },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_MODEL_NOT_ALLOWED", statusCode: 409 });
    const after = await agentRow(created.id);
    expect(after?.revision).toBe(created.revision);
    const reread = await service.getConfigById(userId, created.id);
    expect(reread.runtimeConfig.revision).toBe(created.runtimeConfig.revision);
    expect(reread.runtimeConfig.model).toBeNull();

    // The offered model applies; null clears it without consulting the catalog.
    const updated = await service.updateById(userId, created.id, {
      expectedRevision: created.revision,
      runtimeConfig: { model: ROUTER_MODEL },
    });
    expect(updated.runtimeConfig.model).toBe(ROUTER_MODEL);
    const cleared = await service.updateById(userId, created.id, {
      expectedRevision: updated.revision,
      runtimeConfig: { model: null },
    });
    expect(cleared.runtimeConfig.model).toBeNull();
    expect(lists.mock.calls.length).toBe(2);
  });

  it("does not block unrelated writes on a historical model or a Router outage", async () => {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const available = trackingCatalog([ROUTER_MODEL]);
    const service = agentService(available.catalog);
    const created = await service.createForAccount(userId, {
      name: "cloud-agent",
      displayName: "Cloud Agent",
      runtimeProvider: "pi",
      computerId: cloud.id,
      runtimeConfig: { model: ROUTER_MODEL },
    });

    // The Router later delists the saved model and then goes down entirely: a rename carries no
    // model choice and must succeed without any catalog read.
    const downed = trackingCatalog(undefined);
    const outageService = agentService(downed.catalog);
    const renamed = await outageService.updateById(userId, created.id, {
      expectedRevision: created.revision,
      displayName: "Renamed Cloud Agent",
    });
    expect(renamed.displayName).toBe("Renamed Cloud Agent");
    expect(renamed.runtimeConfig.model).toBe(ROUTER_MODEL);
    expect(downed.lists).not.toHaveBeenCalled();

    // The same outage rejects a NEW explicit model choice...
    await expect(
      outageService.updateById(userId, created.id, {
        expectedRevision: renamed.revision,
        runtimeConfig: { model: "delisted-model" },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_MODEL_UNAVAILABLE", statusCode: 503 });
    // ...and never wrote a revision for it.
    expect((await agentRow(created.id))?.revision).toBe(renamed.revision);
  });

  it("replays a creation intent without re-validating the model during a Router outage", async () => {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const creationIntentId = randomUUID();
    const input = {
      creationIntentId,
      name: "cloud-agent",
      displayName: "Cloud Agent",
      runtimeProvider: "pi" as const,
      computerId: cloud.id,
      runtimeConfig: { model: ROUTER_MODEL },
    };
    const created = await agentService(trackingCatalog([ROUTER_MODEL]).catalog).createForAccount(userId, input);
    // The retry arrives while the Router is down: the recorded intent answers, not a 503.
    const replayed = await agentService(trackingCatalog(undefined).catalog).createForAccount(userId, input);
    expect(replayed.id).toBe(created.id);
    expect(replayed.runtimeConfig.model).toBe(ROUTER_MODEL);
  });

  it("validates against the caller-owned Computer only, never a foreign one", async () => {
    const owner = await account();
    const cloud = await cloudComputer(unit.database, owner.userId);
    const otherUserId = randomUUID();
    await unit.database.insert(users).values({ id: otherUserId, email: "other@example.com", displayName: "Other" });
    const { catalog, lists } = trackingCatalog(undefined);
    const service = agentService(catalog);
    // A foreign Cloud Computer stays invisible: the ownership failure, never a model answer.
    await expect(
      service.createForAccount(otherUserId, {
        name: "foreign-agent",
        displayName: "Foreign",
        runtimeProvider: "pi",
        computerId: cloud.id,
        runtimeConfig: { model: ROUTER_MODEL },
      }),
    ).rejects.toMatchObject({ code: "COMPUTER_NOT_FOUND", statusCode: 404 });
    expect(lists).not.toHaveBeenCalled();
  });
});

describe("Internal Session Cloud model override validation", () => {
  async function cloudSource(catalog: CloudModelCatalog) {
    const { userId } = await account();
    const cloud = await cloudComputer(unit.database, userId);
    const agent = await agentService(catalog).createForAccount(userId, {
      name: "cloud-agent",
      displayName: "Cloud Agent",
      runtimeProvider: "pi",
      computerId: cloud.id,
    });
    const service = new SessionService(unit.database, {
      cloudModelCatalog: catalog,
      cloudSourceConnection: () => true,
    });
    const bindingId = randomUUID();
    await unit.database.insert(imBindings).values({
      id: bindingId,
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: `app-${randomUUID().slice(0, 8)}`,
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "unit-only-unused",
      activatedAt: new Date(),
    });
    const source = await service.ensureChatSession(
      { imBindingId: bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    return { cloud, service, source };
  }

  function overrideInput(
    source: Awaited<ReturnType<typeof cloudSource>>,
    model: string,
  ): Parameters<SessionService["createInternalSessionWithMessage"]>[0] {
    return {
      creatorSessionId: source.source.session.id,
      creatorInstallationId: source.cloud.currentInstallationId ?? "",
      creatorConnectionInstanceId: "cloud-runner-instance",
      creatorComputerId: source.cloud.id,
      creatorPlacementGeneration: source.source.placement.generation,
      messageId: randomUUID(),
      initialMessage: "Investigate the outage",
      overrides: { model },
    };
  }

  it("rejects an unoffered override before any Session or message insert", async () => {
    const { catalog } = trackingCatalog([ROUTER_MODEL]);
    const source = await cloudSource(catalog);
    await expect(
      source.service.createInternalSessionWithMessage(overrideInput(source, "delisted-model")),
    ).rejects.toMatchObject({ code: "SESSION_MODEL_UNAVAILABLE" });
    // Only the source chat Session exists; nothing was inserted for the rejected override.
    expect(await unit.database.select().from(sessions)).toHaveLength(1);
    expect(await unit.database.select().from(sessionMessages)).toHaveLength(0);
  });

  it("rejects explicit Cloud Session overrides when the model path is disabled", async () => {
    const source = await cloudSource(trackingCatalog([ROUTER_MODEL]).catalog);
    const service = new SessionService(unit.database, { cloudSourceConnection: () => true });
    await expect(service.createInternalSessionWithMessage(overrideInput(source, ROUTER_MODEL))).rejects.toMatchObject({
      code: "SESSION_MODEL_CATALOG_UNAVAILABLE",
    });
    expect(await unit.database.select().from(sessions)).toHaveLength(1);
    expect(await unit.database.select().from(sessionMessages)).toHaveLength(0);
  });

  it("reports an unconfirmable catalog without inserts", async () => {
    const { catalog } = trackingCatalog(undefined);
    const source = await cloudSource(catalog);
    await expect(
      source.service.createInternalSessionWithMessage(overrideInput(source, ROUTER_MODEL)),
    ).rejects.toMatchObject({ code: "SESSION_MODEL_CATALOG_UNAVAILABLE" });
    expect(await unit.database.select().from(sessions)).toHaveLength(1);
    expect(await unit.database.select().from(sessionMessages)).toHaveLength(0);
  });

  it("creates with an offered override and replays it through a later Router outage", async () => {
    const live = trackingCatalog([ROUTER_MODEL]);
    const created = await cloudSource(live.catalog);
    const input = overrideInput(created, ROUTER_MODEL);
    const first = await created.service.createInternalSessionWithMessage(input);
    expect(first).toMatchObject({ deduplicated: false, session: { runtimeModel: ROUTER_MODEL } });

    // The catalog is now down: the idempotent replay returns the recorded Session untouched
    // (a retry of the still-unknown attempt, never a fresh insert or a catalog failure).
    const outage = new SessionService(unit.database, {
      cloudModelCatalog: trackingCatalog(undefined).catalog,
      cloudSourceConnection: () => true,
    });
    const replayed = await outage.createInternalSessionWithMessage(input);
    expect(replayed).toMatchObject({
      deduplicated: false,
      attemptCount: 2,
      session: { id: first.session.id, runtimeModel: ROUTER_MODEL },
    });
    // Exactly the source chat Session and the one internal Session exist.
    expect(await unit.database.select().from(sessions)).toHaveLength(2);
    expect(await unit.database.select().from(sessionMessages)).toHaveLength(1);
  });

  it("never consults the catalog for a Local Session override", async () => {
    const { catalog, lists } = trackingCatalog(undefined);
    const { userId } = await account();
    const local = await localComputer(unit.database, userId);
    const agent = await new AgentService(unit.database).createForAccount(userId, {
      name: "local-agent",
      displayName: "Local Agent",
      runtimeProvider: "codex",
      computerId: local.id,
    });
    const service = new SessionService(unit.database, { cloudModelCatalog: catalog });
    const bindingId = randomUUID();
    await unit.database.insert(imBindings).values({
      id: bindingId,
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: `app-${randomUUID().slice(0, 8)}`,
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "unit-only-unused",
      activatedAt: new Date(),
    });
    const source = await service.ensureChatSession(
      { imBindingId: bindingId, channelId: "C1", conversationKind: "dm" },
      "channel",
    );
    const created = await service.createInternalSessionWithMessage({
      creatorSessionId: source.session.id,
      creatorInstallationId: local.currentInstallationId ?? "",
      creatorConnectionInstanceId: local.currentInstanceId ?? "",
      creatorComputerId: local.id,
      creatorPlacementGeneration: source.placement.generation,
      messageId: randomUUID(),
      initialMessage: "Local override",
      overrides: { model: "any-local-model" },
    });
    expect(created.session.runtimeModel).toBe("any-local-model");
    expect(lists).not.toHaveBeenCalled();
  });
});
