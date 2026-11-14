import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { agents, computers } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import {
  ComputerOfflineAlertStore,
  ComputerOfflineAlertWorker,
} from "../services/computers/computer-offline-alerts.js";
import { ApplicationCipher } from "../services/crypto.js";
import { FeedbackProviderError } from "../services/im/im-feedback-messenger.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unitDatabase: UnitDatabase;
const NOW = new Date("2026-11-14T12:00:00.000Z");
const THRESHOLD_MS = 15 * 60_000;
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);
afterAll(async () => unitDatabase?.close());
beforeEach(async () => unitDatabase?.reset());

async function fixture(options: { ownerOpenId?: string | null; lastSeenAt?: Date | null } = {}) {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Owner",
    email: `offline-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "Studio Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      lastSeenAt: options.lastSeenAt === undefined ? minutesAgo(20) : options.lastSeenAt,
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, {
    name: "offline-agent",
    displayName: "Offline Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const bindings = new ImBindingService(unitDatabase.database, new ApplicationCipher(Buffer.alloc(32, 7)), {
    now: () => NOW,
  });
  const ownerOpenId = options.ownerOpenId === undefined ? "ou_owner" : options.ownerOpenId;
  const bindingId = await bindings.activateFeishu({
    agentId: agent.id,
    appId: "cli_offline",
    teamId: "tenant_offline",
    botOpenId: "ou_bot",
    appSecret: "secret",
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    ...(ownerOpenId ? { ownerExternalUserId: ownerOpenId } : {}),
  });
  const sends: Array<{ userId: string; text: string; requestId: string }> = [];
  const messenger = {
    postDirectText: vi.fn(async (target: { userId: string }, text: string, requestId: string) => {
      sends.push({ userId: target.userId, text, requestId });
      return "om_sent";
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const worker = (thresholdMs = THRESHOLD_MS) =>
    new ComputerOfflineAlertWorker({
      store: new ComputerOfflineAlertStore(unitDatabase.database),
      bindings,
      messenger,
      publicUrl: "https://opentag.example",
      thresholdMs,
      logger,
      now: () => NOW,
    });
  const updateComputer = (values: Partial<typeof computers.$inferInsert>) =>
    unitDatabase.database.update(computers).set(values).where(eq(computers.id, computer.id));
  /** Offline Computers of the same owner that have no Agent, so no Bot can reach the owner for them. */
  const addUnreachableComputers = (count: number, lastSeenAt: Date) =>
    unitDatabase.database.insert(computers).values(
      Array.from({ length: count }, (_, index) => ({
        ownerAccountId: bootstrap.userId,
        currentInstallationId: crypto.randomUUID(),
        displayName: `unreachable-${index}`,
        platform: "linux" as const,
        arch: "x64",
        clientVersion: "0.0.1",
        lastSeenAt,
      })),
    );
  return { addUnreachableComputers, agent, bindingId, computer, logger, messenger, sends, updateComputer, worker };
}

describe("Computer offline alerts", () => {
  it("messages the owner once after the threshold and once more when the Computer reconnects", async () => {
    const value = await fixture();
    const worker = value.worker();
    await worker.runOnce();
    await worker.runOnce();
    expect(value.sends).toHaveLength(1);
    expect(value.sends[0]).toMatchObject({ userId: "ou_owner" });
    expect(value.sends[0]?.text).toContain("「Studio Mac」已离线 20 分钟");
    expect(value.sends[0]?.text).toContain("https://opentag.example/agents/computers");

    await value.updateComputer({ lastSeenAt: NOW, connectedAt: minutesAgo(1), currentInstanceId: crypto.randomUUID() });
    await worker.runOnce();
    await worker.runOnce();
    expect(value.sends).toHaveLength(2);
    expect(value.sends[1]?.text).toContain("「Studio Mac」已恢复在线（离线 19 分钟）");

    // A later outage is a new period and alerts again.
    await value.updateComputer({ lastSeenAt: minutesAgo(16), currentInstanceId: null });
    await worker.runOnce();
    expect(value.sends).toHaveLength(3);
  });

  it("waits for the threshold", async () => {
    const value = await fixture({ lastSeenAt: minutesAgo(10) });
    await value.worker().runOnce();
    expect(value.sends).toHaveLength(0);
  });

  it("sends one alert when several Server instances sweep at once", async () => {
    const value = await fixture();
    await Promise.all([value.worker().runOnce(), value.worker().runOnce(), value.worker().runOnce()]);
    expect(value.sends).toHaveLength(1);
  });

  it("skips and logs once a Computer whose Agents have no known owner identity", async () => {
    const value = await fixture({ ownerOpenId: null });
    const worker = value.worker();
    await worker.runOnce();
    await worker.runOnce();
    expect(value.sends).toHaveLength(0);
    expect(value.logger.info).toHaveBeenCalledTimes(1);
    expect(value.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: "COMPUTER_OFFLINE_ALERT_NO_OWNER_CONTACT", computerId: value.computer.id }),
      expect.any(String),
    );
  });

  it.each([
    ["a Cloud Computer", { kind: "cloud" as const }],
    ["a Computer that never connected", { lastSeenAt: null }],
    ["a deleted Computer", { deletedAt: minutesAgo(5) }],
    ["a revoked Computer", { disconnectedAt: minutesAgo(5) }],
    ["an outage that began more than a day ago", { lastSeenAt: minutesAgo(15 + 24 * 60 + 1) }],
  ])("never alerts for %s", async (_name, values) => {
    const value = await fixture();
    await value.updateComputer(values);
    await value.worker().runOnce();
    expect(value.sends).toHaveLength(0);
  });

  it("never alerts through an Agent that is not active", async () => {
    const value = await fixture();
    await unitDatabase.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
    await value.worker().runOnce();
    expect(value.sends).toHaveLength(0);
  });

  it("clears the alert without a recovery notice when the Computer is deleted while offline", async () => {
    const value = await fixture();
    const worker = value.worker();
    await worker.runOnce();
    await value.updateComputer({ deletedAt: NOW });
    await worker.runOnce();
    expect(value.sends).toHaveLength(1);
    const [row] = await unitDatabase.database.select().from(computers).where(eq(computers.id, value.computer.id));
    expect(row?.offlineAlertPeriodStart).toBeNull();
  });

  it("retries a send the provider definitely did not apply", async () => {
    const value = await fixture();
    const worker = value.worker();
    value.messenger.postDirectText.mockRejectedValueOnce(new FeedbackProviderError("IM_PROVIDER_CIRCUIT_OPEN", true));
    await worker.runOnce();
    await worker.runOnce();
    expect(value.messenger.postDirectText).toHaveBeenCalledTimes(2);
    expect(value.sends).toHaveLength(1);
  });

  it("never repeats a send the provider rejected or may have applied", async () => {
    const value = await fixture();
    const worker = value.worker();
    value.messenger.postDirectText.mockRejectedValueOnce(
      new FeedbackProviderError("IM_FEEDBACK_SEND_REJECTED", true, true),
    );
    await worker.runOnce();
    await value.updateComputer({ lastSeenAt: NOW, connectedAt: NOW, currentInstanceId: crypto.randomUUID() });
    await worker.runOnce();
    await value.updateComputer({ lastSeenAt: minutesAgo(16), currentInstanceId: null });
    value.messenger.postDirectText.mockRejectedValueOnce(new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false));
    await worker.runOnce();
    await worker.runOnce();
    // The rejected alert gets no recovery notice; the unknown-outcome alert of the next outage is not retried.
    expect(value.messenger.postDirectText).toHaveBeenCalledTimes(2);
  });

  it("never lets Computers without an owner contact starve a reachable one", async () => {
    const value = await fixture();
    await value.addUnreachableComputers(150, minutesAgo(30));
    const worker = value.worker();
    await worker.runOnce();
    expect(value.sends).toHaveLength(1);
    expect(value.sends[0]?.text).toContain("Studio Mac");
    // Each unreachable Computer is logged once by the reserving pass, not on every sweep.
    await worker.runOnce();
    expect(value.logger.info).toHaveBeenCalledTimes(150);
  });

  it("retries a recovery notice the provider definitely did not apply", async () => {
    const value = await fixture();
    const worker = value.worker();
    await worker.runOnce();
    await value.updateComputer({ lastSeenAt: NOW, connectedAt: NOW, currentInstanceId: crypto.randomUUID() });
    value.messenger.postDirectText.mockRejectedValueOnce(
      new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, 30_000),
    );
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    expect(value.messenger.postDirectText).toHaveBeenCalledTimes(3);
    expect(value.sends.map((send) => send.text)).toEqual([
      expect.stringContaining("已离线"),
      expect.stringContaining("已恢复在线"),
    ]);
  });

  it("sends no recovery notice through an Agent suspended while its Computer was offline", async () => {
    const value = await fixture();
    const worker = value.worker();
    await worker.runOnce();
    await unitDatabase.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
    await value.updateComputer({ lastSeenAt: NOW, connectedAt: NOW, currentInstanceId: crypto.randomUUID() });
    await worker.runOnce();
    expect(value.sends).toHaveLength(1);
  });

  it("does nothing when disabled", async () => {
    const value = await fixture();
    const worker = value.worker(0);
    expect(worker.enabled).toBe(false);
    await worker.runOnce();
    expect(value.sends).toHaveLength(0);
  });
});
