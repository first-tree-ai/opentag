import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../admin/bootstrap.js";
import { slackInstallations, slackWebhookReceipts } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { expireInboundReceiptWork, InboundReceiptWorkStore } from "../services/im/inbound-receipt-work-store.js";
import { INBOUND_WORK_RETENTION_MS, InboundWorkSchema } from "../services/im/inbound-work.js";
import { SlackWebhookReceiptStore } from "../services/im-bindings/slack/webhook-receipt-store.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
beforeEach(async () => unit.reset());
afterAll(async () => unit.close());

async function fixture() {
  const clock = { now: new Date("2026-10-20T00:00:00.000Z") };
  const account = await bootstrapInitialAdmin(unit.database, { email: "work@example.test", displayName: "Work" });
  const agent = await new AgentService(unit.database).createForAccount(account.userId, {
    name: "work",
    displayName: "Work",
    runtimeProvider: "codex",
  });
  const [installation] = await unit.database
    .insert(slackInstallations)
    .values({
      agentId: agent.id,
      externalAppId: "A_WORK",
      externalTeamId: "T_WORK",
      externalBotId: "B_WORK",
      credentialGeneration: 1,
      credentialSchemaVersion: 1,
      encryptedCredential: "synthetic",
      activatedAt: clock.now,
    })
    .returning();
  assert(installation);
  const store = new SlackWebhookReceiptStore(unit.database, { now: () => clock.now });
  const work = InboundWorkSchema.parse({
    version: 1,
    provider: "slack",
    appId: "A_WORK",
    teamId: "T_WORK",
    botId: "B_WORK",
    botUserId: "U_WORK",
    eventId: "Ev_WORK",
    identityClosed: true,
    revokesBot: false,
    event: { type: "message", text: "hello", token: "discard-me" },
  });
  assert(work.provider === "slack");
  const claim = (eventId = "Ev_WORK", durable = true) =>
    store.claim({
      installationId: installation.id,
      credentialGeneration: 1,
      eventId,
      ...(durable ? { work: { ...work, eventId } } : {}),
    });
  const row = async (id: string) => {
    const [receipt] = await unit.database.select().from(slackWebhookReceipts).where(eq(slackWebhookReceipts.id, id));
    assert(receipt);
    return receipt;
  };
  return { clock, installation, store, work, claim, row };
}

it("requires both a due hint and an expired lease before reclaiming scoped work", async () => {
  const f = await fixture();
  const accepted = await f.claim();
  assert(accepted.receiptId);
  await unit.database
    .update(slackWebhookReceipts)
    .set({ nextAttemptAt: f.clock.now })
    .where(eq(slackWebhookReceipts.id, accepted.receiptId));
  await expect(f.store.recovery.claimNext()).resolves.toBeUndefined();
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  await expect(f.store.recovery.claimNext({ scopeId: randomUUID() })).resolves.toBeUndefined();
  const attempt = await f.store.recovery.claimNext({ scopeId: f.installation.id });
  assert(attempt);
  expect(attempt).toMatchObject({
    receiptId: accepted.receiptId,
    scopeId: f.installation.id,
    attempt: 2,
    credentialGeneration: 1,
    receivedAt: accepted.receivedAt,
  });
  expect(f.store.recovery.parse(attempt)).toMatchObject({ event: { type: "message", text: "hello" } });
  expect(JSON.stringify(attempt.payload)).not.toContain("discard-me");
  await expect(f.store.recovery.claimNext()).resolves.toBeUndefined();
});

it("backs off failed work and rejects old or unfenced settlement after reclamation", async () => {
  const f = await fixture();
  const accepted = await f.claim();
  assert(accepted.receiptId);
  await f.store.markFailed(accepted.receiptId, "TEMPORARY_FAILURE", 1);
  await expect(f.store.recovery.claimNext()).resolves.toBeUndefined();
  f.clock.now = new Date(f.clock.now.getTime() + 2_000);
  const attempt = await f.store.recovery.claimNext();
  assert(attempt);
  expect((await f.row(attempt.receiptId)).lastErrorCode).toBeNull();
  await f.store.markProcessed(attempt.receiptId, 1);
  await f.store.markFailed(attempt.receiptId, "OLD_ATTEMPT");
  expect(await f.row(attempt.receiptId)).toMatchObject({ status: "processing", attemptCount: 2 });
  await f.store.markProcessed(attempt.receiptId, attempt.attempt);
  await f.store.markFailed(attempt.receiptId, "LATE_FAILURE", 1);
  expect(await f.row(attempt.receiptId)).toMatchObject({
    status: "processed",
    workPayload: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
  });
  await expect(f.claim()).resolves.toMatchObject({ accepted: false, duplicate: true, status: "processed" });
});

it("checks current installation identity without trusting the saved payload", async () => {
  const f = await fixture();
  const accepted = await f.claim();
  assert(accepted.receiptId);
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const attempt = await f.store.recovery.claimNext();
  assert(attempt);
  const expected = { id: f.installation.id, grantedCapabilities: f.installation.grantedCapabilities };
  await expect(f.store.recovery.findCurrentSlackInstallation(attempt)).resolves.toEqual(expected);
  await unit.database
    .update(slackInstallations)
    .set({ credentialGeneration: 2 })
    .where(eq(slackInstallations.id, f.installation.id));
  await expect(f.store.recovery.findCurrentSlackInstallation(attempt)).resolves.toBeUndefined();
  await expect(f.store.recovery.findCurrentSlackInstallation({ ...attempt, credentialGeneration: 2 })).resolves.toEqual(
    expected,
  );
  await unit.database
    .update(slackInstallations)
    .set({ status: "reauthorization_required" })
    .where(eq(slackInstallations.id, f.installation.id));
  await expect(
    f.store.recovery.findCurrentSlackInstallation({ ...attempt, credentialGeneration: 2 }),
  ).resolves.toBeUndefined();
});

it("requires a Feishu holder and rejects invalid or cross-provider work", async () => {
  const f = await fixture();
  const feishu = new InboundReceiptWorkStore(unit.database, "feishu", () => f.clock.now);
  await expect(feishu.claimNext()).rejects.toThrow("FEISHU_INBOUND_WORK_OWNER_REQUIRED");
  await expect(feishu.claimNext({ holderInstanceId: randomUUID() })).resolves.toBeUndefined();
  const accepted = await f.claim();
  assert(accepted.receiptId);
  f.clock.now = new Date(f.clock.now.getTime() + 61_000);
  const attempt = await f.store.recovery.claimNext();
  assert(attempt);
  expect(() => feishu.parse(attempt)).toThrow("IM_INBOUND_WORK_PROVIDER_MISMATCH");
  expect(() => f.store.recovery.parse({ ...attempt, payload: { version: 2 } })).toThrow();
});

it("expires only old unleased work and preserves legacy diagnostics", async () => {
  const f = await fixture();
  const expired = await f.claim("Ev_EXPIRED");
  const active = await f.claim("Ev_ACTIVE");
  const legacy = await f.claim("Ev_LEGACY", false);
  assert(expired.receiptId && active.receiptId && legacy.receiptId);
  f.clock.now = new Date(f.clock.now.getTime() + INBOUND_WORK_RETENTION_MS);
  await unit.database
    .update(slackWebhookReceipts)
    .set({ leaseExpiresAt: new Date(f.clock.now.getTime() + 60_000) })
    .where(eq(slackWebhookReceipts.id, active.receiptId));
  await expect(f.store.recovery.claimNext()).resolves.toBeUndefined();
  await expireInboundReceiptWork(unit.database, f.clock.now, 1);
  expect(await f.row(expired.receiptId)).toMatchObject({
    status: "failed",
    lastErrorCode: "IM_INBOUND_WORK_EXPIRED",
    workPayload: null,
    nextAttemptAt: null,
  });
  expect((await f.row(active.receiptId)).workPayload).not.toBeNull();
  expect(await f.row(legacy.receiptId)).toMatchObject({ status: "processing", attemptCount: 1, workPayload: null });
  f.clock.now = new Date(f.clock.now.getTime() + 60_000);
  await expireInboundReceiptWork(unit.database, f.clock.now, 1);
  expect((await f.row(active.receiptId)).workPayload).toBeNull();
});
