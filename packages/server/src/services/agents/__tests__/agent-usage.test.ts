/**
 * Focused coverage for the bounded usage read and its arithmetic.
 *
 * These tests pin the contract the SQL rewrite must not move: which values count as reported, how the
 * Provider rule treats cached tokens, that a day without tasks is a zero bucket rather than a gap, that the
 * correction read is bounded and exactly equivalent, and that an Account with no Agent never reaches SQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { agents, imBindings, imMessageDeliveries, imMessages, sessions, users } from "../../../db/schema/index.js";
import {
  AGENT_USAGE_EXCEPTION_BATCH_SIZE,
  addUsageTokenCounts,
  deliveryUsageTokenCounts,
  parseAggregateCount,
  parseAggregateTokenTotal,
  readAgentUsageDaily,
  readAgentUsageSummaries,
} from "../agent-usage.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const START = new Date("2026-08-11T12:00:00.000Z");
const END = NOW;

let unit: UnitDatabase;

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unit?.close();
});

beforeEach(async () => {
  await unit.reset();
});

interface Fixture {
  agentId: string;
  bindingId: string;
  sessionId: string;
}

async function seed(provider: "codex" | "pi" | "claude-code" = "pi"): Promise<Fixture> {
  const accountId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  await unit.database.insert(users).values({
    id: accountId,
    email: `${accountId}@example.test`,
    displayName: "Owner",
  });
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: accountId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: provider,
  });
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "disabled",
    externalAppId: `app-${bindingId}`,
    externalBotId: "bot",
    credentialGeneration: 1,
    disabledAt: NOW,
  });
  await unit.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "C1",
    conversationKind: "dm",
    kind: "channel",
  });
  return { agentId, bindingId, sessionId };
}

/** One reported Delivery; `turnReport` stays raw so a test can write any stored shape. */
async function addDelivery(
  fixture: Fixture,
  input: { acceptedAt: Date; turnReport: unknown; executionOrigin?: "local" | "cloud" },
): Promise<string> {
  const [message] = await unit.database
    .insert(imMessages)
    .values({
      imBindingId: fixture.bindingId,
      providerEventId: `event-${randomUUID()}`,
      channelId: "C1",
      externalMessageId: `message-${randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "human",
      content: { version: 1, fallbackText: "x", blocks: [{ type: "text", text: "x" }], truncated: false },
      providerContext: { provider: "feishu", chatType: "dm" },
      occurredAt: input.acceptedAt,
    })
    .returning({ id: imMessages.id });
  if (!message) throw new Error("message fixture missing");
  const [delivery] = await unit.database
    .insert(imMessageDeliveries)
    .values({
      messageId: message.id,
      sessionId: fixture.sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      executionOrigin: input.executionOrigin ?? "local",
      inputHash: `input-${randomUUID()}`,
      turnId: `turn-${randomUUID()}`,
      reportOwnerInstanceId: randomUUID(),
      turnReport: input.turnReport as never,
      reportedAt: input.acceptedAt,
      acceptedAt: input.acceptedAt,
      expiresAt: new Date(input.acceptedAt.getTime() + 86_400_000),
      resultHash: "a".repeat(64),
    })
    .returning({ id: imMessageDeliveries.id });
  if (!delivery) throw new Error("delivery fixture missing");
  return delivery.id;
}

function read(fixture: Fixture, provider: "codex" | "pi" | "claude-code" = "pi") {
  return readAgentUsageDaily(unit.database, {
    agentId: fixture.agentId,
    provider,
    startedAt: START,
    endedAt: END,
  });
}

describe("readAgentUsageDaily", () => {
  it("returns one zero bucket per UTC day when the window has no tasks", async () => {
    const fixture = await seed();
    const usage = await read(fixture);
    expect(usage.daily).toHaveLength(31);
    expect(usage.daily.every((point) => point.tasks === 0 && point.tokens === 0)).toBe(true);
    expect(usage).toMatchObject({ tasks: 0, measuredTasks: 0, failed: 0, inputTokens: 0, tokens: 0 });
  });

  it("separates missing, zero and reported token values", async () => {
    const fixture = await seed("pi");
    // No `usage` object at all: the task counts, nothing is measured.
    await addDelivery(fixture, { acceptedAt: new Date("2026-08-12T01:00:00Z"), turnReport: { outcome: "completed" } });
    // Explicit zeros are reported values, so the task is measured and contributes nothing.
    await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-13T01:00:00Z"),
      turnReport: { outcome: "completed", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
    });
    // A null field is not reported, the sibling field still makes the task measured.
    await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-14T01:00:00Z"),
      turnReport: { outcome: "completed", usage: { inputTokens: null, outputTokens: 7 } },
    });

    const usage = await read(fixture);
    expect(usage).toMatchObject({ tasks: 3, measuredTasks: 2, inputTokens: 0, outputTokens: 7, tokens: 7 });
    expect(usage.daily.find((point) => point.date === "2026-08-12")).toMatchObject({ tasks: 1, measuredTasks: 0 });
    expect(usage.daily.find((point) => point.date === "2026-08-13")).toMatchObject({ tasks: 1, measuredTasks: 1 });
    expect(usage.daily.find((point) => point.date === "2026-08-14")).toMatchObject({ tasks: 1, measuredTasks: 1 });
  });

  it("applies the Codex cached-token rule and keeps the breakdown consistent", async () => {
    const fixture = await seed("codex");
    await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-15T01:00:00Z"),
      turnReport: { outcome: "completed", usage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5 } },
    });
    // Codex already includes cached tokens in its input count, so 10 + 5 = 15 and the 20 stay separate.
    await expect(read(fixture, "codex")).resolves.toMatchObject({
      tasks: 1,
      inputTokens: 10,
      cachedInputTokens: 20,
      outputTokens: 5,
      tokens: 15,
    });
    // The same stored report read as Pi adds the cached tokens again, which is the rule for that Provider.
    await expect(read(fixture, "pi")).resolves.toMatchObject({
      inputTokens: 30,
      cachedInputTokens: 20,
      outputTokens: 5,
      tokens: 35,
    });
  });

  it("keeps Cloud reports out of the token arithmetic", async () => {
    const fixture = await seed("pi");
    await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-16T01:00:00Z"),
      executionOrigin: "cloud",
      turnReport: { outcome: "failed", usage: { inputTokens: 900, cachedInputTokens: 900, outputTokens: 900 } },
    });
    await expect(read(fixture, "pi")).resolves.toMatchObject({
      tasks: 1,
      failed: 1,
      measuredTasks: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      tokens: 0,
    });
  });

  it("recomputes values the aggregate cannot prove, and counts them once", async () => {
    const fixture = await seed("pi");
    const deliveryId = await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-17T01:00:00Z"),
      turnReport: { outcome: "completed", usage: {} },
    });
    // `1e3` is a safe integer to Number() but not a canonical decimal, so the fallback must add it.
    await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
      deliveryId,
      JSON.stringify({ outcome: "completed", usage: { inputTokens: "1e3", outputTokens: 1 } }),
    ]);
    const usage = await read(fixture);
    expect(usage).toMatchObject({ tasks: 1, measuredTasks: 1, inputTokens: 1_000, outputTokens: 1, tokens: 1_001 });
    expect(usage.daily.find((point) => point.date === "2026-08-17")).toMatchObject({ tasks: 1, tokens: 1_001 });
  });

  it("treats a leading-zero integer as a reported value", async () => {
    const fixture = await seed("pi");
    const deliveryId = await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-18T01:00:00Z"),
      turnReport: { outcome: "completed", usage: {} },
    });
    await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
      deliveryId,
      JSON.stringify({ outcome: "completed", usage: { inputTokens: "00012" } }),
    ]);
    await expect(read(fixture, "pi")).resolves.toMatchObject({
      tasks: 1,
      measuredTasks: 1,
      inputTokens: 12,
      tokens: 12,
    });
  });

  it.each([
    ["a decimal string", "1.5"],
    ["a negative integer", -5],
    ["malformed text", "not-a-number"],
    ["a boolean", true],
    ["an object", { value: 1 }],
    ["above the safe integer range", 9_007_199_254_740_992],
  ])("rejects %s rather than approximating it", async (_label, value) => {
    const fixture = await seed("pi");
    const deliveryId = await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-19T01:00:00Z"),
      turnReport: { outcome: "completed", usage: {} },
    });
    await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
      deliveryId,
      JSON.stringify({ outcome: "completed", usage: { inputTokens: value } }),
    ]);
    await expect(read(fixture, "pi")).rejects.toThrow("invalid token count");
  });

  it("recomputes more than one batch of valid non-canonical reports", async () => {
    const fixture = await seed("pi");
    const reports = AGENT_USAGE_EXCEPTION_BATCH_SIZE * 2 + 7;
    // `1000.00` is a valid `Number()` and a valid safe integer; it is only non-canonical text, so every one of
    // these reports must be summed instead of rejected.
    for (let index = 0; index < reports; index += 1) {
      const deliveryId = await addDelivery(fixture, {
        acceptedAt: new Date("2026-08-20T00:00:00Z"),
        turnReport: { outcome: "completed", usage: {} },
      });
      await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
        deliveryId,
        JSON.stringify({ outcome: "completed", usage: { inputTokens: "1000.00", outputTokens: "0.00" } }),
      ]);
    }
    const usage = await read(fixture, "pi");
    expect(usage).toMatchObject({
      tasks: reports,
      measuredTasks: reports,
      inputTokens: reports * 1_000,
      outputTokens: 0,
      tokens: reports * 1_000,
    });
    expect(usage.daily.find((point) => point.date === "2026-08-20")).toMatchObject({
      tasks: reports,
      inputTokens: reports * 1_000,
    });
  }, 240_000);

  it("fails a batch walk that meets invalid text, and keeps provider and safe-integer semantics", async () => {
    const fixture = await seed("pi");
    // One invalid report arrives in a later batch than the first: it must still fail the whole read.
    const reports = AGENT_USAGE_EXCEPTION_BATCH_SIZE + 3;
    let lastDeliveryId = "";
    for (let index = 0; index < reports; index += 1) {
      lastDeliveryId = await addDelivery(fixture, {
        acceptedAt: new Date("2026-08-21T00:00:00Z"),
        turnReport: { outcome: "completed", usage: {} },
      });
      await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
        lastDeliveryId,
        JSON.stringify({ outcome: "completed", usage: { inputTokens: "1000.00" } }),
      ]);
    }
    await expect(read(fixture, "pi")).resolves.toMatchObject({ tasks: reports, inputTokens: reports * 1_000 });
    await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
      lastDeliveryId,
      JSON.stringify({ outcome: "completed", usage: { inputTokens: "not-a-number" } }),
    ]);
    await expect(read(fixture, "pi")).rejects.toThrow("invalid token count");
    // A per-row total beyond the safe integer range fails the same way, wherever it sits in the walk.
    await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
      lastDeliveryId,
      JSON.stringify({ outcome: "completed", usage: { inputTokens: 9_007_199_254_740_992 } }),
    ]);
    await expect(read(fixture, "pi")).rejects.toThrow("invalid token count");
  }, 240_000);

  it("applies the Codex rule across a batch boundary", async () => {
    const fixture = await seed("codex");
    const reports = AGENT_USAGE_EXCEPTION_BATCH_SIZE + 1;
    for (let index = 0; index < reports; index += 1) {
      const deliveryId = await addDelivery(fixture, {
        acceptedAt: new Date("2026-08-22T00:00:00Z"),
        turnReport: { outcome: "completed", usage: {} },
      });
      await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
        deliveryId,
        JSON.stringify({
          outcome: "completed",
          usage: { inputTokens: "10.00", cachedInputTokens: "20.00", outputTokens: "5.00" },
        }),
      ]);
    }
    // Codex reports cached tokens inside its input count, so a batch of such reports still adds input+output.
    await expect(read(fixture, "codex")).resolves.toMatchObject({
      tasks: reports,
      inputTokens: reports * 10,
      cachedInputTokens: reports * 20,
      outputTokens: reports * 5,
      tokens: reports * 15,
    });
  }, 240_000);

  it("sums two deliveries on the same UTC day into one bucket", async () => {
    const fixture = await seed("pi");
    await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-21T00:30:00Z"),
      turnReport: { outcome: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
    });
    await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-21T23:30:00Z"),
      turnReport: { outcome: "failed", usage: { inputTokens: 2, outputTokens: 2 } },
    });
    const usage = await read(fixture, "pi");
    // The daily point carries counts and tokens; `failed` is a window total only.
    expect(usage).toMatchObject({ tasks: 2, failed: 1 });
    expect(usage.daily.find((point) => point.date === "2026-08-21")).toMatchObject({
      tasks: 2,
      inputTokens: 3,
      outputTokens: 3,
      tokens: 6,
    });
  });
});

describe("readAgentUsageSummaries", () => {
  it("returns an empty result for an empty Agent list without issuing SQL", async () => {
    // `in ()` is invalid SQL, so the boundary must be handled before the statement is built.
    const executor = {
      execute: async () => {
        throw new Error("SQL must not run for an empty Agent list");
      },
    };
    await expect(
      readAgentUsageSummaries(executor as never, { agentIds: [], startedAt: START, endedAt: END }),
    ).resolves.toEqual([]);
  });

  it("aggregates per Agent and flags an unusable token count", async () => {
    const fixture = await seed("codex");
    await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-22T01:00:00Z"),
      turnReport: { outcome: "failed", usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 } },
    });
    const rows = await readAgentUsageSummaries(unit.database, {
      agentIds: [fixture.agentId],
      startedAt: START,
      endedAt: END,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: fixture.agentId,
      tasks: "1",
      failed: "1",
      inputTokens: "10",
      cachedInputTokens: "5",
      outputTokens: "2",
      invalidTokenCount: false,
    });

    const deliveryId = await addDelivery(fixture, {
      acceptedAt: new Date("2026-08-22T02:00:00Z"),
      turnReport: { outcome: "completed", usage: {} },
    });
    await unit.engine.query(`update im_message_deliveries set turn_report = $2::jsonb where id = $1`, [
      deliveryId,
      JSON.stringify({ usage: { inputTokens: "1e3" } }),
    ]);
    const [flagged] = await readAgentUsageSummaries(unit.database, {
      agentIds: [fixture.agentId],
      startedAt: START,
      endedAt: END,
    });
    expect(flagged?.invalidTokenCount).toBe(true);
    expect(flagged?.tasks).toBe("2");
  });
});

describe("usage arithmetic helpers", () => {
  it("reports the Provider token rule per row", () => {
    expect(deliveryUsageTokenCounts("codex", "10", "20", "5")).toEqual({
      inputTokens: 10,
      cachedInputTokens: 20,
      outputTokens: 5,
      tokens: 15,
      measured: true,
    });
    expect(deliveryUsageTokenCounts("pi", "10", "20", "5")).toMatchObject({ inputTokens: 30, tokens: 35 });
    expect(deliveryUsageTokenCounts("claude-code", null, null, null)).toMatchObject({ measured: false, tokens: 0 });
    expect(() => deliveryUsageTokenCounts("pi", "1.5", null, null)).toThrow("invalid token count");
  });

  it("rejects aggregate totals outside the supported range", () => {
    expect(parseAggregateCount("7", "task")).toBe(7);
    expect(parseAggregateCount(null, "task")).toBe(0);
    expect(() => parseAggregateCount("-1", "task")).toThrow("task total exceeds the safe integer range");
    expect(() => parseAggregateTokenTotal("9007199254740992")).toThrow("token total exceeds the safe integer range");
    expect(parseAggregateTokenTotal("9007199254740991")).toBe(9_007_199_254_740_991);
  });

  it("refuses a running total that leaves the safe-integer range", () => {
    const target = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, tokens: 0 };
    addUsageTokenCounts(target, { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, tokens: 3 });
    expect(target).toEqual({ inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, tokens: 3 });
    expect(() =>
      addUsageTokenCounts(target, {
        inputTokens: Number.MAX_SAFE_INTEGER,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: 1,
      }),
    ).toThrow("token total exceeds the safe integer range");
  });
});
