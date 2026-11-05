import { randomUUID } from "node:crypto";
import { AgentStatusQuerySchema, FEISHU_REQUIRED_TENANT_SCOPES, RUNTIME_CAPABILITY } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { agents, computers } from "../db/schema/index.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { AgentStatusService } from "../services/agents/agent-status-service.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let db: UnitDatabase;
beforeAll(async () => {
  db = await createUnitDatabase();
}, 60_000);
afterAll(async () => db?.close());
beforeEach(async () => db.reset());

async function fixture() {
  const now = Date.now();
  let elapsed = 0;
  const account = await bootstrapInitialAdmin(db.database, { displayName: "Owner", email: "status@example.test" });
  const installationId = randomUUID(),
    instanceId = randomUUID(),
    connectionId = randomUUID();
  const [computer] = await db.database
    .insert(computers)
    .values({
      ownerAccountId: account.userId,
      displayName: "Computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.1.1",
      currentInstallationId: installationId,
      currentInstanceId: instanceId,
      currentConnectionId: connectionId,
    })
    .returning();
  if (!computer) throw new Error("Missing Computer");
  const registry = new ConnectionRegistry({ monotonicNow: () => elapsed });
  await registry.register(
    {
      computerId: computer.id,
      installationId,
      instanceId,
      connectionId,
      lastHeartbeatAt: now,
      providerReadinessProviders: ["codex"],
      negotiatedCapabilities: { [RUNTIME_CAPABILITY.selfCheckHeartbeat]: 1 },
      socket: { readyState: WebSocket.OPEN, close: vi.fn(), send: vi.fn() } as unknown as WebSocket,
    },
    async () => undefined,
  );
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const agentService = new AgentService(db.database);
  const agent = await agentService.createForAccount(account.userId, {
    name: "first",
    displayName: "First",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const im = new ImBindingService(db.database, cipher, { now: () => new Date(now) });
  const bindingId = await im.activateFeishu({
    agentId: agent.id,
    appId: "cli_status",
    teamId: "tenant",
    botOpenId: "bot",
    appSecret: "secret",
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
  });
  // A live connection lease is maintained by the IM worker, independently of the Local checks.
  const { imBindings } = await import("../db/schema/index.js");
  await db.database
    .update(imBindings)
    .set({
      observedConnectedAt: new Date(now),
      observedAt: new Date(now),
      connectionOwnerInstanceId: randomUUID(),
      connectionLeaseExpiresAt: new Date(now + 600_000),
    })
    .where(eq(imBindings.id, bindingId));
  const epoch = registry.requestSelfCheck(computer.id, instanceId, now);
  if (!epoch) throw new Error("Missing epoch");
  const sample = (sequence = 1) => ({
    type: "runtime:self-check:report" as const,
    requestId: randomUUID(),
    selfCheckId: epoch.requestId,
    sequence,
    checkedAt: new Date(now + elapsed).toISOString(),
    problems: [],
    providerReadiness: [{ provider: "codex" as const, status: "ready" as const }],
    imCliReadiness: [{ provider: "feishu" as const, status: "ready" as const }],
  });
  const credential = (
    status: "ready" | "needs_attention",
    generation = 1,
    details: { reason?: "credential_rejected" | "provider_unreachable" | "rate_limited"; timedOut?: boolean } = {},
    observedAt = now + elapsed,
  ) =>
    registry.setProviderCliCredentialObservation(
      computer.id,
      instanceId,
      {
        agentId: agent.id,
        integrationId: bindingId,
        provider: "feishu",
        credentialGeneration: generation,
        requestId: randomUUID(),
        status,
        ...(status === "needs_attention" ? { reason: "credential_rejected" as const } : {}),
        ...details,
      },
      observedAt,
    );
  registry.setProviderCliArtifactObservation(
    computer.id,
    instanceId,
    {
      agentId: agent.id,
      integrationId: bindingId,
      provider: "feishu",
      credentialGeneration: 1,
      requestId: randomUUID(),
      status: "ready",
    },
    now,
  );
  const service = new AgentStatusService(db.database, registry, cipher, { now: () => new Date(now + elapsed) });
  const read = async () => (await service.read(account.userId, [agent.id])).statuses[0];
  return {
    now,
    account,
    agent,
    agentService,
    computer,
    registry,
    sample,
    credential,
    read,
    service,
    instanceId,
    connectionId,
    advance: (ms: number) => {
      elapsed = ms;
    },
  };
}

describe("Agent status snapshots", () => {
  it("bounds IDs and refuses duplicates before any query", () => {
    for (const ids of [
      "",
      "bad",
      Array(101).fill(randomUUID()).join(","),
      [randomUUID(), randomUUID()].flatMap((id) => [id, id]).join(","),
    ])
      expect(AgentStatusQuerySchema.safeParse({ ids }).success).toBe(false);
  });
  it("permits only the first bounded initialization, keeps a previous result during recheck, and overrides it at 90 seconds offline", async () => {
    const f = await fixture();
    f.registry.recordSelfCheck(f.computer.id, f.instanceId, f.connectionId, f.sample(), f.now);
    expect(await f.read()).toMatchObject({ state: "initializing", reason: "first_validation" });
    f.advance(15_000);
    expect(await f.read()).toMatchObject({ state: "problem", reason: "credential_validation_timeout" });
    f.credential("ready");
    expect(await f.read()).toMatchObject({ state: "ready", reason: null });
    f.registry.requestSelfCheck(f.computer.id, f.instanceId, f.now + 15_000);
    expect(await f.read()).toMatchObject({ state: "ready" });
    f.advance(90_000);
    expect(await f.read()).toMatchObject({ state: "computer_offline", reason: "computer_offline" });
  });
  it.each([
    [{ reason: "provider_unreachable" }, "credential_provider_unreachable"],
    [{ reason: "provider_unreachable", timedOut: true }, "credential_validation_timeout"],
    [{ reason: "rate_limited" }, "credential_rate_limited"],
    [{ reason: "credential_rejected" }, "credential_validation_failed"],
    [{}, "credential_validation_failed"],
  ] as const)("names a credential check answer %j as %s", async (details, reason) => {
    const f = await fixture();
    f.registry.recordSelfCheck(f.computer.id, f.instanceId, f.connectionId, f.sample(), f.now);
    f.credential("needs_attention", 1, details);
    expect(await f.read()).toMatchObject({ state: "problem", reason });
  });
  it("never reports an overdue credential answer as a failed check", async () => {
    const f = await fixture();
    f.registry.recordSelfCheck(f.computer.id, f.instanceId, f.connectionId, f.sample(), f.now);
    const ageSeconds = (seconds: number) => f.credential("ready", 1, {}, f.now - seconds * 1_000);
    // Still inside the room a recheck that started late needs to settle.
    ageSeconds(10 * 60 + 16);
    expect(await f.read()).toMatchObject({ state: "ready", reason: null });
    ageSeconds(10 * 60 + 59);
    expect(await f.read()).toMatchObject({ state: "ready", reason: null });
    // Rechecks have stopped answering: no provider said anything about the credential.
    ageSeconds(10 * 60 + 61);
    expect(await f.read()).toMatchObject({ state: "problem", reason: "credential_validation_timeout" });
  });
  it("never borrows another generation's credential proof and exposes completed timeout reasons", async () => {
    const f = await fixture();
    f.registry.recordSelfCheck(f.computer.id, f.instanceId, f.connectionId, f.sample(), f.now);
    f.credential("ready", 2);
    f.advance(15_000);
    expect(await f.read()).toMatchObject({ state: "problem", reason: "credential_validation_timeout" });
    const sample = {
      ...f.sample(2),
      problems: [{ part: "messaging_cli" as const, reason: "check_timed_out" as const }],
    };
    f.registry.recordSelfCheck(f.computer.id, f.instanceId, f.connectionId, sample, f.now + 15_000);
    expect(await f.read()).toMatchObject({ state: "problem", reason: "messaging_cli_check_timed_out" });
  });
  it("returns no partial data for a mixed authorized/unknown batch and no secrets for an owned batch", async () => {
    const f = await fixture();
    await expect(f.service.read(f.account.userId, [f.agent.id, randomUUID()])).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(f.service.read(randomUUID(), [f.agent.id])).rejects.toMatchObject({ statusCode: 404 });
    const response = await f.service.read(f.account.userId, [f.agent.id]);
    expect(JSON.stringify(response)).not.toMatch(/encryptedCredential|appSecret|credentialGeneration/);
  });
  it("reads 100 Agents with three SELECTs in one snapshot", async () => {
    const f = await fixture();
    const rows = await db.database
      .insert(agents)
      .values(
        Array.from({ length: 99 }, (_, index) => ({
          createdByUserId: f.account.userId,
          name: `batch-${index}`,
          displayName: "Batch",
          runtimeProvider: "codex" as const,
          computerId: f.computer.id,
        })),
      )
      .returning({ id: agents.id });
    const transaction = db.database.transaction.bind(db.database);
    let selects = 0;
    const spy = vi.spyOn(db.database, "transaction").mockImplementation((work, options) =>
      transaction(async (tx) => {
        const select = tx.select.bind(tx);
        vi.spyOn(tx, "select").mockImplementation((...args: Parameters<typeof tx.select>) => {
          selects++;
          return select(...args);
        });
        return work(tx);
      }, options),
    );
    try {
      expect(
        (await f.service.read(f.account.userId, [f.agent.id, ...rows.map((row) => row.id)])).statuses,
      ).toHaveLength(100);
      expect(selects).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});
