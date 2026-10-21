import assert from "node:assert/strict";
import type { NormalizedInboundImEvent } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { agentSchedules, imBindings, sessionPlacements, sessions } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { ImMessageInbox } from "../../services/im/index.js";
import { SessionService } from "../../services/sessions/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

function exchangeInput(code: string) {
  return {
    code,
    installationId: crypto.randomUUID(),
    displayName: "Local",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.1.2",
  };
}
async function fixture() {
  const observer = createDatabaseClient(testDatabase.databaseUrl);
  const management = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const admission = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const account = await bootstrapInitialAdmin(observer.database, {
    displayName: "Owner",
    email: "admission@example.test",
  });
  const machineAuth = new MachineAuthService(observer.database);
  const initialCode = await machineAuth.issueForAccount(account.userId, {});
  const computer = await machineAuth.exchangeConnectCode(exchangeInput(initialCode.code));
  const agent = await new AgentService(observer.database).createForAccount(account.userId, {
    computerId: computer.computerId,
    runtimeProvider: "codex",
    name: "admission",
    displayName: "Admission",
  });
  const [binding] = await observer.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "app-admission",
      externalBotId: "bot-admission",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    })
    .returning();
  assert(binding);
  const [session] = await observer.database
    .insert(sessions)
    .values({ imBindingId: binding.id, channelId: "C-admission", conversationKind: "dm", kind: "channel" })
    .returning();
  assert(session);
  await observer.database
    .insert(sessionPlacements)
    .values({ sessionId: session.id, computerId: computer.computerId, generation: 1 });
  const now = new Date();
  const [schedule] = await observer.database
    .insert(agentSchedules)
    .values({
      agentId: agent.id,
      targetSessionId: session.id,
      name: "Admission",
      prompt: "Check",
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: now.toISOString() },
      timezone: "UTC",
      enabled: true,
      nextTriggerAt: now,
    })
    .returning();
  assert(schedule);
  const [managementBackend] = await management.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [admissionBackend] = await admission.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  assert(managementBackend && admissionBackend);
  return {
    observer,
    management,
    admission,
    gate,
    accountId: account.userId,
    machineAuth,
    computer,
    agent,
    binding,
    session,
    schedule,
    managementPid: managementBackend.pid,
    admissionPid: admissionBackend.pid,
    close: () => Promise.all([observer.sql.end(), management.sql.end(), admission.sql.end(), gate.sql.end()]),
  };
}
async function waitForLock(value: Awaited<ReturnType<typeof fixture>>, pid: number) {
  await expect
    .poll(
      async () => {
        const [row] = await value.observer.sql<
          { waiting: boolean }[]
        >`select exists(select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock') as waiting`;
        return row?.waiting ?? false;
      },
      { timeout: 5_000, interval: 10 },
    )
    .toBe(true);
}
function inboundEvent(): NormalizedInboundImEvent {
  return {
    providerEventId: crypto.randomUUID(),
    externalAppId: "app-admission",
    externalTeamId: "team-admission",
    providerContext: { provider: "feishu", chatType: "p2p" },
    conversation: { externalId: "C-admission", kind: "dm" },
    message: {
      externalId: crypto.randomUUID(),
      revisionKey: "1",
      operation: "created",
      threadKey: null,
      replyToExternalId: null,
      author: { externalId: "human", kind: "human", displayName: "Human" },
      occurredAt: new Date(),
      content: { version: 1, fallbackText: "Check", blocks: [{ type: "text", text: "Check" }], truncated: false },
      resources: [],
    },
    mentions: [],
  };
}
function outcome(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return "committed";
  let error = result.reason;
  while (error?.cause) error = error.cause;
  return error?.code ?? String(error);
}

describe.each(["schedule", "inbound"] as const)("%s admission vs Computer management", (kind) => {
  it.each(["rebind", "issue", "exchange"] as const)("shares Agent-first order with %s", async (operation) => {
    const value = await fixture();
    const locked = deferred();
    const release = deferred();
    const pending: Promise<unknown>[] = [];
    let holding: Promise<unknown> | undefined;
    try {
      const repairInput = {
        mode: "repair" as const,
        targetComputerId: value.computer.computerId,
        targetAgentId: value.agent.id,
      };
      const issued =
        operation === "exchange" ? await value.machineAuth.issueForAccount(value.accountId, repairInput) : undefined;
      const sessionService = new SessionService(value.admission.database);
      const resolution = await sessionService.resolveScheduledMessageRoute(value.session.id, value.agent.id);
      assert(resolution.kind === "route");
      holding = value.gate.sql.begin(async (transaction) => {
        await transaction`select id from computers where id = ${value.computer.computerId} for update`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const auth = new MachineAuthService(value.management.database);
      const action =
        operation === "rebind"
          ? new AgentService(value.management.database).rebindById(
              value.accountId,
              value.agent.id,
              value.computer.computerId,
            )
          : operation === "issue"
            ? auth.issueForAccount(value.accountId, repairInput)
            : auth.exchangeConnectCode(exchangeInput(issued?.code ?? ""));
      const managed = Promise.allSettled([action]);
      pending.push(managed);
      await waitForLock(value, value.managementPid);
      const admission =
        kind === "schedule"
          ? sessionService.withScheduledDispatchAdmission(
              resolution.route,
              { scheduleId: value.schedule.id, revision: 1 },
              async (onDispatched) => {
                onDispatched();
                return "sent";
              },
            )
          : new ImMessageInbox(value.admission.database).ingest(value.binding.id, 1, inboundEvent());
      const admitted = Promise.allSettled([admission]);
      pending.push(admitted);
      await waitForLock(value, value.admissionPid);
      release.resolve();
      await holding;
      const [managementResult] = await managed;
      const [admissionResult] = await admitted;
      expect([managementResult, admissionResult].map(outcome)).toEqual(["committed", "committed"]);
      expect(admissionResult).toMatchObject(
        kind === "schedule"
          ? { status: "fulfilled", value: { admitted: true } }
          : { status: "fulfilled", value: { deliveryIds: [expect.any(String)] } },
      );
    } finally {
      release.resolve();
      await holding;
      await Promise.allSettled(pending);
      await value.close();
    }
  });
});
