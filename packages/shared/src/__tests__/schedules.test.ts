import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_SCHEDULE_LIST_LIMIT_DEFAULT,
  AGENT_SCHEDULE_LIST_LIMIT_MAX,
  AGENT_SCHEDULE_MIN_INTERVAL_SECONDS,
  AGENT_SCHEDULE_NAME_MAX_CODE_POINTS,
  AGENT_SCHEDULE_PREVIEW_MAX_COUNT,
  AGENT_SCHEDULE_PROMPT_MAX_BYTES,
  AgentScheduleDeleteQuerySchema,
  AgentScheduleInputSchema,
  AgentScheduleLastDispatchSchema,
  AgentScheduleListQuerySchema,
  AgentScheduleListResponseSchema,
  AgentScheduleNameSchema,
  AgentSchedulePreviewSchema,
  AgentSchedulePromptSchema,
  AgentScheduleRevisionRequestSchema,
  AgentScheduleRuleSchema,
  AgentScheduleSchema,
  CreateAgentScheduleRequestSchema,
  ErrorCodeSchema,
  PreviewAgentScheduleRequestSchema,
  parseAbsoluteInstant,
  SCHEDULE_ERROR_CODE_METADATA,
  SCHEDULE_ERROR_CODES,
  ScheduleUtcInstantSchema,
  SessionMessageScheduledOriginSchema,
  UpdateAgentScheduleRequestSchema,
} from "../index.js";

const T0 = "2026-09-28T01:00:00.000Z";

function fullSchedule() {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    target: {
      sessionId: randomUUID(),
      provider: "feishu",
      sessionKind: "channel",
      channelId: "oc_channel",
      threadKey: null,
    },
    name: "Daily check",
    prompt: "Check the build and report.",
    schedule: { kind: "cron", expression: "0 9 * * MON-FRI" },
    timezone: "Asia/Shanghai",
    enabled: true,
    nextTriggerAt: "2026-09-29T01:00:00.000Z",
    revision: 1,
    lastDispatch: null,
    detailUrl:
      "https://opentag.example.com/agents/00000000-0000-4000-8000-000000000001?schedule=00000000-0000-4000-8000-000000000002",
    createdAt: T0,
    updatedAt: T0,
  } as const;
}

describe("schedule rule schemas", () => {
  it("T01 normalizes both offset and Z one-time instants to the same UTC millisecond form", () => {
    const withOffset = parseAbsoluteInstant("2026-09-29T09:00:00+08:00");
    const withZulu = parseAbsoluteInstant("2026-09-29T01:00:00Z");
    expect(withOffset?.toISOString()).toBe("2026-09-29T01:00:00.000Z");
    expect(withZulu?.toISOString()).toBe("2026-09-29T01:00:00.000Z");
    expect(AgentScheduleInputSchema.parse({ kind: "at", at: "2026-09-29T09:00:00+08:00" })).toEqual({
      kind: "at",
      at: "2026-09-29T09:00:00+08:00",
    });
  });

  it("T02 rejects offset-less and natural-language one-time instants at the boundary", () => {
    expect(AgentScheduleInputSchema.safeParse({ kind: "at", at: "2026-09-29T09:00:00" }).success).toBe(false);
    expect(AgentScheduleInputSchema.safeParse({ kind: "at", at: "in two hours" }).success).toBe(false);
    expect(AgentScheduleInputSchema.safeParse({ kind: "at", at: "2026-02-31T09:00:00Z" }).success).toBe(false);
    expect(AgentScheduleInputSchema.safeParse({ kind: "at", at: "2026-09-29T09:00:00.1234Z" }).success).toBe(false);
  });

  it("T03 accepts only safe integer intervals of at least 60 seconds", () => {
    const every = (intervalSeconds: unknown) => AgentScheduleInputSchema.safeParse({ kind: "every", intervalSeconds });
    expect(every(AGENT_SCHEDULE_MIN_INTERVAL_SECONDS - 1).success).toBe(false);
    expect(every(59).success).toBe(false);
    expect(every(60).success).toBe(true);
    expect(every(60.5).success).toBe(false);
    expect(every(0).success).toBe(false);
    expect(every(-60).success).toBe(false);
    expect(every(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(every(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(every("60").success).toBe(false);
  });

  it("keeps the persisted every rule Server-anchored: caller input cannot carry anchorAt", () => {
    expect(
      AgentScheduleInputSchema.safeParse({
        kind: "every",
        intervalSeconds: 3600,
        anchorAt: T0,
      }).success,
    ).toBe(false);
    expect(
      AgentScheduleRuleSchema.parse({
        kind: "every",
        intervalSeconds: 3600,
        anchorAt: T0,
      }),
    ).toEqual({ kind: "every", intervalSeconds: 3600, anchorAt: T0 });
  });

  it("rejects unknown rule kinds and unknown fields", () => {
    expect(AgentScheduleInputSchema.safeParse({ kind: "daily", at: T0 }).success).toBe(false);
    expect(
      AgentScheduleInputSchema.safeParse({ kind: "cron", expression: "0 9 * * *", targetSessionId: randomUUID() })
        .success,
    ).toBe(false);
  });

  it("validates the UTC millisecond instant shape strictly", () => {
    expect(ScheduleUtcInstantSchema.safeParse(T0).success).toBe(true);
    expect(ScheduleUtcInstantSchema.safeParse("2026-09-28T01:00:00Z").success).toBe(false);
    expect(ScheduleUtcInstantSchema.safeParse("2026-09-28T09:00:00.000+08:00").success).toBe(false);
    expect(ScheduleUtcInstantSchema.safeParse("2026-02-31T00:00:00.000Z").success).toBe(false);
  });
});

describe("schedule name and prompt bounds (M02)", () => {
  it("accepts a trimmed name of 1-120 Unicode code points", () => {
    expect(AgentScheduleNameSchema.parse("  Daily check  ")).toBe("Daily check");
    expect(AgentScheduleNameSchema.safeParse("").success).toBe(false);
    expect(AgentScheduleNameSchema.safeParse("   ").success).toBe(false);
    expect(AgentScheduleNameSchema.safeParse("x".repeat(AGENT_SCHEDULE_NAME_MAX_CODE_POINTS)).success).toBe(true);
    expect(AgentScheduleNameSchema.safeParse("x".repeat(AGENT_SCHEDULE_NAME_MAX_CODE_POINTS + 1)).success).toBe(false);
    // Code points, not UTF-16 units: a non-BMP character counts once.
    expect(AgentScheduleNameSchema.safeParse("🚀".repeat(AGENT_SCHEDULE_NAME_MAX_CODE_POINTS)).success).toBe(true);
    expect(AgentScheduleNameSchema.safeParse("🚀".repeat(AGENT_SCHEDULE_NAME_MAX_CODE_POINTS + 1)).success).toBe(false);
    expect(AgentScheduleNameSchema.safeParse(`计划${"检".repeat(118)}`).success).toBe(true);
  });

  it("accepts prompts of 1-16384 UTF-8 bytes and rejects the rest", () => {
    expect(AgentSchedulePromptSchema.safeParse("").success).toBe(false);
    expect(AgentSchedulePromptSchema.safeParse("x").success).toBe(true);
    expect(AgentSchedulePromptSchema.safeParse("x".repeat(AGENT_SCHEDULE_PROMPT_MAX_BYTES)).success).toBe(true);
    expect(AgentSchedulePromptSchema.safeParse("x".repeat(AGENT_SCHEDULE_PROMPT_MAX_BYTES + 1)).success).toBe(false);
    // 16384 bytes of CJK text is 5461 full characters plus one ASCII byte.
    expect(AgentSchedulePromptSchema.safeParse(`${"你".repeat(5461)}x`).success).toBe(true);
    expect(AgentSchedulePromptSchema.safeParse("你".repeat(5462)).success).toBe(false);
    // A non-BMP character is 4 UTF-8 bytes; JS UTF-16 length would miscount it as one half.
    expect(AgentSchedulePromptSchema.safeParse("🚀".repeat(AGENT_SCHEDULE_PROMPT_MAX_BYTES / 4)).success).toBe(true);
    expect(AgentSchedulePromptSchema.safeParse("🚀".repeat(AGENT_SCHEDULE_PROMPT_MAX_BYTES / 4 + 1)).success).toBe(
      false,
    );
  });
});

describe("schedule management requests", () => {
  it("accepts a create request with exactly name, prompt, schedule, timezone", () => {
    const request = {
      name: "Daily check",
      prompt: "Check the build.",
      schedule: { kind: "cron", expression: "0 9 * * MON-FRI" },
      timezone: "Asia/Shanghai",
    };
    expect(CreateAgentScheduleRequestSchema.parse(request)).toEqual(request);
    // Client-forged targets, origins, anchors, and unknown fields are rejected outright.
    expect(CreateAgentScheduleRequestSchema.safeParse({ ...request, targetSessionId: randomUUID() }).success).toBe(
      false,
    );
    expect(CreateAgentScheduleRequestSchema.safeParse({ ...request, agentId: randomUUID() }).success).toBe(false);
    expect(CreateAgentScheduleRequestSchema.safeParse({ ...request, scheduledOrigin: null }).success).toBe(false);
    expect(CreateAgentScheduleRequestSchema.safeParse({ ...request, timezone: "" }).success).toBe(false);
  });

  it("requires an expected revision and at least one updated field on update", () => {
    expect(UpdateAgentScheduleRequestSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(UpdateAgentScheduleRequestSchema.safeParse({ expectedRevision: 0, name: "x" }).success).toBe(false);
    expect(
      UpdateAgentScheduleRequestSchema.parse({
        expectedRevision: 3,
        schedule: { kind: "every", intervalSeconds: 120 },
      }),
    ).toMatchObject({ expectedRevision: 3 });
    expect(UpdateAgentScheduleRequestSchema.safeParse({ expectedRevision: 1, name: "x", enabled: false }).success).toBe(
      false,
    );
    expect(AgentScheduleRevisionRequestSchema.parse({ expectedRevision: 2 })).toEqual({ expectedRevision: 2 });
    expect(AgentScheduleRevisionRequestSchema.safeParse({}).success).toBe(false);
    expect(AgentScheduleDeleteQuerySchema.parse({ expectedRevision: "4" })).toEqual({ expectedRevision: 4 });
    expect(AgentScheduleDeleteQuerySchema.safeParse({ expectedRevision: "0" }).success).toBe(false);
  });

  it("applies the list limit contract and opaque cursor", () => {
    expect(AgentScheduleListQuerySchema.parse({})).toEqual({ limit: AGENT_SCHEDULE_LIST_LIMIT_DEFAULT });
    expect(AgentScheduleListQuerySchema.parse({ limit: "100", cursor: "abc" })).toEqual({ limit: 100, cursor: "abc" });
    expect(AgentScheduleListQuerySchema.safeParse({ limit: String(AGENT_SCHEDULE_LIST_LIMIT_MAX + 1) }).success).toBe(
      false,
    );
    expect(AgentScheduleListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("admits exactly the two preview forms", () => {
    expect(PreviewAgentScheduleRequestSchema.parse({ scheduleId: randomUUID() })).toBeDefined();
    expect(
      PreviewAgentScheduleRequestSchema.parse({
        schedule: { kind: "every", intervalSeconds: 60 },
        timezone: "UTC",
      }),
    ).toBeDefined();
    expect(
      PreviewAgentScheduleRequestSchema.safeParse({
        scheduleId: randomUUID(),
        schedule: { kind: "every", intervalSeconds: 60 },
        timezone: "UTC",
      }).success,
    ).toBe(false);
    expect(PreviewAgentScheduleRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("schedule DTOs", () => {
  it("round-trips the full DTO and drops the prompt from list items", () => {
    const schedule = fullSchedule();
    expect(AgentScheduleSchema.parse(schedule)).toEqual(schedule);
    const { prompt: _prompt, detailUrl: _detailUrl, ...item } = schedule;
    const list = { items: [item], nextCursor: null };
    expect(AgentScheduleListResponseSchema.parse(list)).toEqual(list);
    // A list item must not be able to smuggle the full prompt back in.
    expect(AgentScheduleListResponseSchema.safeParse({ items: [schedule], nextCursor: null }).success).toBe(false);
  });

  it("validates the latest-dispatch summary shape including the skipped outcome", () => {
    const base = {
      scheduledFor: T0,
      attemptedAt: T0,
      messageId: randomUUID(),
      outcome: "unknown",
      code: null,
    };
    for (const outcome of ["unknown", "accepted", "unreachable", "rejected", "skipped"] as const) {
      expect(AgentScheduleLastDispatchSchema.parse({ ...base, outcome })).toMatchObject({ outcome });
    }
    expect(AgentScheduleLastDispatchSchema.safeParse({ ...base, outcome: "succeeded" }).success).toBe(false);
    expect(
      AgentScheduleLastDispatchSchema.parse({
        ...base,
        attemptedAt: null,
        messageId: null,
        outcome: "skipped",
        code: "late",
      }),
    ).toMatchObject({ outcome: "skipped", code: "late" });
    expect(AgentScheduleLastDispatchSchema.safeParse({ ...base, code: "Schedule_Changed" }).success).toBe(false);
  });

  it("bounds the preview response to the normalized rule and at most five items", () => {
    const preview = {
      calculatedAt: T0,
      schedule: { kind: "every", intervalSeconds: 60, anchorAt: T0 },
      timezone: "Asia/Shanghai",
      items: Array.from({ length: AGENT_SCHEDULE_PREVIEW_MAX_COUNT }, () => ({
        at: T0,
        local: "2026-09-28 09:01:00 +08:00",
        timezone: "Asia/Shanghai",
      })),
    };
    expect(AgentSchedulePreviewSchema.parse(preview)).toEqual(preview);
    expect(
      AgentSchedulePreviewSchema.safeParse({
        ...preview,
        items: [...preview.items, preview.items[0]],
      }).success,
    ).toBe(false);
  });

  it("validates the scheduled message origin snapshot", () => {
    const origin = {
      scheduleId: randomUUID(),
      scheduledFor: T0,
      timezone: "Asia/Shanghai",
      name: "Daily check",
    };
    expect(SessionMessageScheduledOriginSchema.parse(origin)).toEqual(origin);
    expect(SessionMessageScheduledOriginSchema.safeParse({ ...origin, scheduleId: "not-a-uuid" }).success).toBe(false);
    expect(
      SessionMessageScheduledOriginSchema.safeParse({ ...origin, scheduledFor: "2026-09-28T01:00:00Z" }).success,
    ).toBe(false);
    expect(SessionMessageScheduledOriginSchema.safeParse({ ...origin, proof: "secret" }).success).toBe(false);
    expect(SessionMessageScheduledOriginSchema.safeParse(null).success).toBe(false);
    expect(SessionMessageScheduledOriginSchema.safeParse({ ...origin, name: "" }).success).toBe(false);
  });
});

describe("schedule error codes", () => {
  it("registers every SCHEDULE_* code in the shared error enum with the documented statuses", () => {
    for (const code of Object.values(SCHEDULE_ERROR_CODES)) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(SCHEDULE_ERROR_CODE_METADATA[SCHEDULE_ERROR_CODES.INVALID_REQUEST].statusCode).toBe(400);
    expect(SCHEDULE_ERROR_CODE_METADATA[SCHEDULE_ERROR_CODES.INVALID_RULE].statusCode).toBe(400);
    expect(SCHEDULE_ERROR_CODE_METADATA[SCHEDULE_ERROR_CODES.INVALID_TIMEZONE].statusCode).toBe(400);
    expect(SCHEDULE_ERROR_CODE_METADATA[SCHEDULE_ERROR_CODES.TARGET_REQUIRED].statusCode).toBe(409);
    expect(SCHEDULE_ERROR_CODE_METADATA[SCHEDULE_ERROR_CODES.TARGET_INVALID].statusCode).toBe(409);
    expect(SCHEDULE_ERROR_CODE_METADATA[SCHEDULE_ERROR_CODES.NO_FUTURE_OCCURRENCE].statusCode).toBe(409);
    expect(SCHEDULE_ERROR_CODE_METADATA[SCHEDULE_ERROR_CODES.REVISION_CONFLICT].statusCode).toBe(409);
  });
});
