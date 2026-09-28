import type { AgentScheduleRule } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  formatScheduleLocal,
  nextScheduleOccurrence,
  normalizeCronExpression,
  normalizeIanaTimezone,
  previewSchedule,
  requireFutureOccurrence,
  ScheduleRuleError,
  scheduleRuleFromInput,
} from "../services/schedules/calculator.js";

/** The shared scheduling test baseline: `2026-09-28T01:00:00.000Z` is Monday 09:00 in Shanghai. */
const T0 = new Date("2026-09-28T01:00:00.000Z");
const SHANGHAI = "Asia/Shanghai";
const NEW_YORK = "America/New_York";

const every60: AgentScheduleRule = { kind: "every", intervalSeconds: 60, anchorAt: T0.toISOString() };

function nextIso(rule: AgentScheduleRule, timezone: string, after: Date): string | null {
  return nextScheduleOccurrence(rule, timezone, after)?.toISOString() ?? null;
}

function previewItems(rule: AgentScheduleRule, timezone: string, after: Date, count?: number): string[] {
  return previewSchedule(rule, timezone, after, count).items.map((item) => item.at);
}

function expectRuleError(fn: () => unknown, code: ScheduleRuleError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleRuleError);
    expect((error as ScheduleRuleError).code).toBe(code);
    return;
  }
  expect.unreachable(`Expected a ScheduleRuleError(${code})`);
}

describe("schedule calculator: at", () => {
  it("T01 normalizes offset and Z inputs to the same UTC instant with a single-item preview", () => {
    const fromOffset = scheduleRuleFromInput({ kind: "at", at: "2026-09-29T09:00:00+08:00" }, SHANGHAI, T0);
    const fromZulu = scheduleRuleFromInput({ kind: "at", at: "2026-09-29T01:00:00Z" }, SHANGHAI, T0);
    expect(fromOffset.rule).toEqual({ kind: "at", at: "2026-09-29T01:00:00.000Z" });
    expect(fromZulu.rule).toEqual(fromOffset.rule);
    for (const rule of [fromOffset.rule, fromZulu.rule]) {
      const preview = previewSchedule(rule, SHANGHAI, T0);
      expect(preview.items).toHaveLength(1);
      expect(preview.items[0]).toEqual({
        at: "2026-09-29T01:00:00.000Z",
        local: "2026-09-29 09:00:00 +08:00",
        timezone: SHANGHAI,
      });
    }
  });

  it("T02 rejects past instants and never parses offset-less or natural-language times", () => {
    expect(nextIso({ kind: "at", at: T0.toISOString() }, "UTC", T0)).toBeNull();
    expect(nextIso({ kind: "at", at: new Date(T0.getTime() - 1).toISOString() }, "UTC", T0)).toBeNull();
    expect(nextIso({ kind: "at", at: new Date(T0.getTime() + 1).toISOString() }, "UTC", T0)).toBe(
      "2026-09-28T01:00:00.001Z",
    );
    expectRuleError(() => scheduleRuleFromInput({ kind: "at", at: "2026-09-29T09:00:00" }, "UTC", T0), "invalid_rule");
    expectRuleError(() => scheduleRuleFromInput({ kind: "at", at: "in two hours" }, "UTC", T0), "invalid_rule");
  });

  it("keeps an at instant absolute when only the display timezone changes (T15)", () => {
    const rule: AgentScheduleRule = { kind: "at", at: "2026-09-29T01:00:00.000Z" };
    expect(nextIso(rule, SHANGHAI, T0)).toBe("2026-09-29T01:00:00.000Z");
    expect(nextIso(rule, NEW_YORK, T0)).toBe("2026-09-29T01:00:00.000Z");
    // An exhausted one-time schedule stays exhausted instead of firing on read.
    expect(previewSchedule(rule, SHANGHAI, new Date("2026-09-29T01:00:00.000Z")).items).toEqual([]);
  });
});

describe("schedule calculator: every", () => {
  it("T03/T04 anchors the fixed cadence and never back-fills missed points", () => {
    // The first fire is exactly one interval after the anchor; creation itself never fires.
    expect(nextIso(every60, "UTC", T0)).toBe("2026-09-28T01:01:00.000Z");
    expect(nextIso(every60, "UTC", new Date(T0.getTime() + 59_000))).toBe("2026-09-28T01:01:00.000Z");
    // Both an exact boundary and a later catch-up land strictly after `after` on the same anchor.
    expect(nextIso(every60, "UTC", new Date(T0.getTime() + 180_000))).toBe("2026-09-28T01:04:00.000Z");
    expect(nextIso(every60, "UTC", new Date(T0.getTime() + 185_000))).toBe("2026-09-28T01:04:00.000Z");
    const preview = previewItems(every60, "UTC", new Date(T0.getTime() + 185_000));
    expect(preview).toEqual([
      "2026-09-28T01:04:00.000Z",
      "2026-09-28T01:05:00.000Z",
      "2026-09-28T01:06:00.000Z",
      "2026-09-28T01:07:00.000Z",
      "2026-09-28T01:08:00.000Z",
    ]);
  });

  it("T15 keeps the elapsed-duration semantics independent of timezone and DST", () => {
    const daily: AgentScheduleRule = {
      kind: "every",
      intervalSeconds: 86_400,
      anchorAt: "2026-03-01T14:00:00.000Z",
    };
    // Across the America/New_York spring forward the UTC cadence stays exactly 86400 seconds,
    // unlike a "every day at 09:00 local" cron rule.
    expect(nextIso(daily, NEW_YORK, new Date("2026-03-07T14:00:00.000Z"))).toBe("2026-03-08T14:00:00.000Z");
    expect(nextIso(daily, NEW_YORK, new Date("2026-03-08T14:00:00.000Z"))).toBe("2026-03-09T14:00:00.000Z");
    expect(nextIso(daily, SHANGHAI, new Date("2026-03-07T14:00:00.000Z"))).toBe("2026-03-08T14:00:00.000Z");
    const cronNine: AgentScheduleRule = { kind: "cron", expression: "0 9 * * *" };
    expect(nextIso(cronNine, NEW_YORK, new Date("2026-03-07T14:00:00.000Z"))).toBe("2026-03-08T13:00:00.000Z");
    expect(nextIso(cronNine, NEW_YORK, new Date("2026-03-08T14:00:00.000Z"))).toBe("2026-03-09T13:00:00.000Z");
  });

  it("rejects rules whose arithmetic leaves the representable range", () => {
    expectRuleError(
      () =>
        nextScheduleOccurrence(
          { kind: "every", intervalSeconds: Number.MAX_SAFE_INTEGER, anchorAt: T0.toISOString() },
          "UTC",
          T0,
        ),
      "invalid_rule",
    );
    expect(
      nextIso(
        { kind: "every", intervalSeconds: 60, anchorAt: "2026-09-28T01:00:00.000Z" },
        "UTC",
        new Date(MAX_DATE_MS),
      ),
    ).toBeNull();
  });
});

const MAX_DATE_MS = 8_640_000_000_000_000;

describe("schedule calculator: cron", () => {
  it("T05 enumerates weekday mornings strictly after the baseline", () => {
    expect(previewItems({ kind: "cron", expression: "0 9 * * MON-FRI" }, SHANGHAI, T0)).toEqual([
      "2026-09-29T01:00:00.000Z",
      "2026-09-30T01:00:00.000Z",
      "2026-10-01T01:00:00.000Z",
      "2026-10-02T01:00:00.000Z",
      "2026-10-05T01:00:00.000Z",
    ]);
  });

  it("T06 combines day-of-month and day-of-week with OR semantics", () => {
    expect(
      previewItems({ kind: "cron", expression: "0 9 1 * MON" }, "UTC", new Date("2026-03-01T00:00:00.000Z"), 2),
    ).toEqual([
      "2026-03-01T09:00:00.000Z", // the 1st
      "2026-03-02T09:00:00.000Z", // Monday
    ]);
  });

  it("T07 supports lists, ranges, steps, aliases, and treats 0 and 7 as Sunday", () => {
    expect(nextIso({ kind: "cron", expression: "0 0 * * 0" }, "UTC", T0)).toBe(
      nextIso({ kind: "cron", expression: "0 0 * * 7" }, "UTC", T0),
    );
    expect(nextIso({ kind: "cron", expression: "0 0 */2 * *" }, "UTC", new Date("2026-07-01T12:00:00.000Z"))).toBe(
      "2026-07-03T00:00:00.000Z",
    );
    expect(nextIso({ kind: "cron", expression: "0 0 1 */2 *" }, "UTC", new Date("2026-01-15T00:00:00.000Z"))).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    // Numeric-prefix steps follow standard `N-max/S` semantics: 05/15/25..., not just 05.
    expect(
      previewItems({ kind: "cron", expression: "5/10 * * * *" }, "UTC", new Date("2026-09-28T01:00:00.000Z"), 3),
    ).toEqual(["2026-09-28T01:05:00.000Z", "2026-09-28T01:15:00.000Z", "2026-09-28T01:25:00.000Z"]);
    expect(nextIso({ kind: "cron", expression: "0 5,20 1-6 JAN,JUL WED" }, "UTC", T0)).not.toBeNull();
    expect(nextIso({ kind: "cron", expression: "0 0 * jul wed" }, "UTC", T0)).not.toBeNull();
    expect(nextIso({ kind: "cron", expression: "0 0 * JUL WED" }, "UTC", new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(normalizeCronExpression("  0   9  *  *   MON-FRI ")).toBe("0 9 * * MON-FRI");
  });

  it("T08 rejects seconds/year columns, macros, extensions, full names, and bad values", () => {
    const rejected = [
      "0 0 9 * * *", // six fields
      "0 0 0 9 * * *", // seven fields
      "@daily",
      "0 0 L * *",
      "0 0 15W * *",
      "0 0 * * 5#2",
      "0 0 * * +MON",
      "0 0 * ? *",
      "0 0 * * MONDAY",
      "0 0 * JANUARY *",
      "61 * * * *",
      "0 24 * * *",
      "*/0 * * * *",
      "5-1 * * * *", // reversed range
      "0 0 * * MON/2", // a bare alias cannot carry a step
      "0 0 * JAN-3 *", // mixed alias/number range
    ];
    for (const expression of rejected) {
      expectRuleError(() => nextScheduleOccurrence({ kind: "cron", expression }, "UTC", T0), "invalid_rule");
    }
    // A grammatically valid rule without any future occurrence fails closed instead of looping.
    expect(nextIso({ kind: "cron", expression: "0 0 31 2 *" }, "UTC", T0)).toBeNull();
    expectRuleError(
      () => requireFutureOccurrence({ kind: "cron", expression: "0 0 31 2 *" }, "UTC", T0),
      "no_future_occurrence",
    );
  });

  it("T16 computes leap-day rules and reports calculator failures with stable codes", () => {
    expect(nextIso({ kind: "cron", expression: "0 9 29 2 *" }, "UTC", new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "2028-02-29T09:00:00.000Z",
    );
    expect(nextIso({ kind: "cron", expression: "0 9 29 2 *" }, "UTC", new Date("2028-02-29T09:00:00.000Z"))).toBe(
      "2032-02-29T09:00:00.000Z",
    );
    // A persisted rule corrupted after validation surfaces invalid_rule, not a crash loop.
    expectRuleError(
      () => nextScheduleOccurrence({ kind: "cron", expression: "not a rule" }, "UTC", T0),
      "invalid_rule",
    );
    expectRuleError(
      () => nextScheduleOccurrence({ kind: "cron", expression: "0 9 * * *" }, "Mars/Olympus", T0),
      "invalid_timezone",
    );
  });
});

describe("schedule calculator: timezones", () => {
  it("T09 requires an explicit IANA timezone and ignores the machine zone", () => {
    expect(normalizeIanaTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(normalizeIanaTimezone("UTC")).toBe("UTC");
    expect(normalizeIanaTimezone("Etc/GMT+8")).toBe("Etc/GMT+8");
    for (const bad of ["", "   ", "Mars/Olympus", "+08:00", "-05:00", "0800"]) {
      expectRuleError(() => normalizeIanaTimezone(bad), "invalid_timezone");
    }
    const previousTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const eastern = previewItems({ kind: "cron", expression: "0 9 * * MON-FRI" }, SHANGHAI, T0);
      process.env.TZ = "Pacific/Kiritimati";
      const kiritimati = previewItems({ kind: "cron", expression: "0 9 * * MON-FRI" }, SHANGHAI, T0);
      expect(eastern).toEqual(kiritimati);
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });
});

describe("schedule calculator: DST boundaries", () => {
  it("T10 skips spring-forward wall times that do not exist instead of shifting them", () => {
    // 2026-03-08 02:30 never happens in New York; the fire moves to the next day outright.
    expect(
      previewItems({ kind: "cron", expression: "30 2 * * *" }, NEW_YORK, new Date("2026-03-08T00:00:00.000Z"), 2),
    ).toEqual(["2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  });

  it("T11 fires fall-back wall times only at their first occurrence", () => {
    // 2026-11-01 01:30 happens twice in New York (05:30Z and 06:30Z); only the first counts.
    expect(
      previewItems({ kind: "cron", expression: "30 1 * * *" }, NEW_YORK, new Date("2026-11-01T00:00:00.000Z"), 2),
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });

  it("T12 never re-runs the second fall-back occurrence when the cursor lands between them", () => {
    expect(nextIso({ kind: "cron", expression: "30 1 * * *" }, NEW_YORK, new Date("2026-11-01T05:45:00.000Z"))).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  it("keeps the first 02:30 after fall-back because that wall time is not repeated", () => {
    expect(nextIso({ kind: "cron", expression: "30 2 * * *" }, NEW_YORK, new Date("2026-11-01T05:45:00.000Z"))).toBe(
      "2026-11-01T07:30:00.000Z",
    );
  });

  it("T13 handles London fall-back and 30-minute overlaps like hour-long ones", () => {
    expect(
      previewItems(
        { kind: "cron", expression: "30 1 * * *" },
        "Europe/London",
        new Date("2026-10-24T23:00:00.000Z"),
        2,
      ),
    ).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
    // Lord Howe shifts only 30 minutes; the second 01:45 (2026-04-04T15:15Z) must not fire.
    const lordHowe = "Australia/Lord_Howe";
    expect(nextIso({ kind: "cron", expression: "45 1 * * *" }, lordHowe, new Date("2026-04-04T14:00:00.000Z"))).toBe(
      "2026-04-04T14:45:00.000Z",
    );
    expect(nextIso({ kind: "cron", expression: "45 1 * * *" }, lordHowe, new Date("2026-04-04T15:00:00.000Z"))).toBe(
      "2026-04-05T15:15:00.000Z",
    );
    expect(nextIso({ kind: "cron", expression: "45 1 * * *" }, lordHowe, new Date("2026-04-04T15:20:00.000Z"))).toBe(
      "2026-04-05T15:15:00.000Z",
    );
    // Spring forward 02:00 -> 02:30: 02:15 on 2026-10-04 does not exist and is skipped.
    expect(nextIso({ kind: "cron", expression: "15 2 * * *" }, lordHowe, new Date("2026-10-03T15:00:00.000Z"))).toBe(
      "2026-10-04T15:15:00.000Z",
    );
  });
});

describe("schedule calculator: preview contract", () => {
  it("T14 keeps preview, next, and rule normalization consistent for every time type", () => {
    const cases: Array<{ rule: AgentScheduleRule; timezone: string; after: Date }> = [
      { rule: { kind: "at", at: "2026-09-29T01:00:00.000Z" }, timezone: SHANGHAI, after: T0 },
      { rule: every60, timezone: "UTC", after: new Date(T0.getTime() + 185_000) },
      { rule: { kind: "cron", expression: "0 9 * * MON-FRI" }, timezone: SHANGHAI, after: T0 },
    ];
    for (const { rule, timezone, after } of cases) {
      const preview = previewSchedule(rule, timezone, after);
      const next = nextScheduleOccurrence(rule, timezone, after);
      expect(preview.items.length).toBeGreaterThan(0);
      expect(preview.items[0]?.at).toBe(next?.toISOString());
      expect(preview.calculatedAt).toBe(after);
      expect(preview.timezone).toBe(normalizeIanaTimezone(timezone));
      for (const item of preview.items) {
        expect(item.timezone).toBe(preview.timezone);
        expect(item.local).toBe(formatScheduleLocal(new Date(item.at), timezone));
      }
    }
    // A one-time rule returns at most one item and is never padded to five.
    expect(previewSchedule({ kind: "at", at: "2026-09-29T01:00:00.000Z" }, SHANGHAI, T0).items).toHaveLength(1);
    expect(previewSchedule(every60, "UTC", T0).items).toHaveLength(5);
    expect(previewSchedule(every60, "UTC", T0, 3).items).toHaveLength(3);
    // An exhausted one-time rule previews empty.
    expect(previewSchedule({ kind: "at", at: T0.toISOString() }, "UTC", T0).items).toEqual([]);
  });

  it("T15 recomputes cron against the new timezone when only the timezone changes", () => {
    const cron: AgentScheduleRule = { kind: "cron", expression: "0 9 * * *" };
    expect(nextIso(cron, SHANGHAI, T0)).toBe("2026-09-29T01:00:00.000Z");
    expect(nextIso(cron, "UTC", T0)).toBe("2026-09-28T09:00:00.000Z");
  });
});
