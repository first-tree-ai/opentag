import type { AgentScheduleRule } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { withLocale } from "../../__tests__/support/with-locale.js";
import { scheduleRuleText, shortScheduleTime } from "./schedule-rule.js";

const cron = (expression: string): AgentScheduleRule => ({ kind: "cron", expression });
const every = (intervalSeconds: number): AgentScheduleRule => ({
  kind: "every",
  intervalSeconds,
  anchorAt: "2026-11-01T00:00:00.000Z",
});

describe("scheduleRuleText", () => {
  it.each([
    [cron("0 9 * * 1-5"), "Every weekday at 9:00", "每个工作日 9:00"],
    [cron("30 9 * * 1"), "Every Monday at 9:30", "每周一 9:30"],
    [cron("0 16 * * 1,4"), "Every Monday and Thursday at 16:00", "每周一和周四 16:00"],
    [cron("0 10 * * 0,6"), "Every weekend at 10:00", "每个周末 10:00"],
    [cron("0 10 * * 7"), "Every Sunday at 10:00", "每周日 10:00"],
    [cron("0 8 * * *"), "Every day at 8:00", "每天 8:00"],
    [cron("0 18 1 * *"), "Monthly on day 1 at 18:00", "每月 1 日 18:00"],
    [cron("0 18 28-31 * *"), "Monthly on days 28–31 at 18:00", "每月 28–31 日 18:00"],
    [cron("0 9 1,15 * *"), "Monthly on days 1 and 15 at 9:00", "每月 1、15 日 9:00"],
    [cron("5 * * * *"), "Every hour at :05", "每小时第 05 分"],
    [cron("0 9-17 * * 1-5"), "Weekdays, hourly 9:00–17:00", "工作日 9:00–17:00 每小时"],
    [cron("30 8-20 * * *"), "Daily, hourly 8:30–20:30", "每天 8:30–20:30 每小时"],
    [cron("*/15 * * * *"), "Every 15 minutes", "每 15 分钟"],
    [every(60), "Every minute", "每分钟"],
    [every(7_200), "Every 2 hours", "每 2 小时"],
    [every(86_400), "Every day", "每天"],
  ])("phrases %j in both languages", (rule, english, chinese) => {
    withLocale("en", () => expect(scheduleRuleText(rule, "Asia/Shanghai")).toBe(english));
    withLocale("zh", () => expect(scheduleRuleText(rule, "Asia/Shanghai")).toBe(chinese));
  });

  it.each(["0 9 1 1 *", "0 9-17 * * 1,3", "0 17-9 * * *", "0 9-17 1 * *", "0 9 * * MON", "0 9 1 * 1", "@daily"])(
    "keeps the exact expression for %j instead of guessing",
    (expression) => {
      withLocale("en", () => expect(scheduleRuleText(cron(expression), "UTC")).toBe(`Cron: ${expression}`));
    },
  );
});

describe("shortScheduleTime", () => {
  it("leaves the hour unpadded, like the rules", () => {
    withLocale("zh", () =>
      expect(shortScheduleTime("2026-11-04T01:00:00.000Z", "Asia/Shanghai")).toMatch(/ 9:00(?!\d)/),
    );
    withLocale("en", () => expect(shortScheduleTime("2026-11-04T01:00:00.000Z", "Asia/Shanghai")).toMatch(/ 9:00/));
  });
});
