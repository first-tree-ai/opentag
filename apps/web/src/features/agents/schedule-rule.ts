import type { AgentScheduleRule } from "@opentag/shared/browser";
import { intlLocale } from "../../i18n/locale.js";
import * as m from "../../paraglide/messages.js";

/**
 * A schedule rule in the reader's words: "Every weekday at 9:00", "每月 1 日 18:00".
 *
 * Only the cron shapes people actually write by hand are phrased — fixed minute and hour with a
 * day-of-week set, a single day of the month, or every day — plus fixed intervals and one-off
 * times. Anything else keeps its raw expression, which stays exact rather than guessed.
 */
export function scheduleRuleText(rule: AgentScheduleRule, timezone: string): string {
  if (rule.kind === "at") return m.agents_schedules_at({ time: shortScheduleTime(rule.at, timezone) });
  if (rule.kind === "every") return intervalText(rule.intervalSeconds);
  return cronText(rule.expression) ?? m.agents_schedules_cron({ expression: rule.expression });
}

/** Month, day, weekday, and time in the schedule's zone; the zone is named only when it is not the reader's. */
export function shortScheduleTime(instant: string, timezone: string): string {
  const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(intlLocale(), {
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
    ...(timezone === reader ? {} : { timeZoneName: "short" }),
  }).format(new Date(instant));
}

function intervalText(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const count = seconds / 86_400;
    return count === 1
      ? m.agents_schedules_every_day_interval()
      : m.agents_schedules_every_days({ count: String(count) });
  }
  if (seconds % 3_600 === 0) {
    const count = seconds / 3_600;
    return count === 1 ? m.agents_schedules_every_hour() : m.agents_schedules_every_hours({ count: String(count) });
  }
  if (seconds % 60 === 0) {
    const count = seconds / 60;
    return count === 1 ? m.agents_schedules_every_minute() : m.agents_schedules_every_minutes({ count: String(count) });
  }
  return m.agents_schedules_every({ seconds: String(seconds) });
}

const NUMBER = /^\d+$/;

function cronText(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[3] !== "*") return undefined;
  const [minute = "", hour = "", dayOfMonth = "", , dayOfWeek = ""] = fields;
  const everyDay = dayOfMonth === "*" && dayOfWeek === "*";
  if (hour === "*") return everyDay ? subHourlyText(minute) : undefined;
  if (!inRange(minute, 59) || !inRange(hour, 23)) return undefined;
  return dayText(`${Number(hour)}:${minute.padStart(2, "0")}`, dayOfMonth, dayOfWeek);
}

/** `*\/N * * * *` and `M * * * *`. */
function subHourlyText(minute: string): string | undefined {
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step) {
    const count = Number(step[1]);
    return count === 1 ? m.agents_schedules_every_minute() : m.agents_schedules_every_minutes({ count: String(count) });
  }
  return inRange(minute, 59) ? m.agents_schedules_hourly({ minute: minute.padStart(2, "0") }) : undefined;
}

function dayText(time: string, dayOfMonth: string, dayOfWeek: string): string | undefined {
  if (dayOfMonth === "*" && dayOfWeek === "*") return m.agents_schedules_daily({ time });
  if (dayOfMonth === "*") return weekdayText(time, dayOfWeek);
  if (dayOfWeek === "*" && inRange(dayOfMonth, 31) && Number(dayOfMonth) >= 1) {
    return m.agents_schedules_monthly({ day: String(Number(dayOfMonth)), time });
  }
  return undefined;
}

function weekdayText(time: string, dayOfWeek: string): string | undefined {
  const days = weekdays(dayOfWeek);
  if (!days) return undefined;
  if (days.join() === "1,2,3,4,5") return m.agents_schedules_weekdays({ time });
  if (days.join() === "0,6") return m.agents_schedules_weekends({ time });
  return m.agents_schedules_weekly({ days: weekdayList(days), time });
}

function inRange(field: string, max: number): boolean {
  return NUMBER.test(field) && Number(field) <= max;
}

/** A day-of-week field as sorted, distinct days (0 = Sunday), or undefined when it is not a plain list or range. */
function weekdays(field: string): number[] | undefined {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);
    if (!range) return undefined;
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    if (start > 7 || end > 7 || end < start) return undefined;
    for (let day = start; day <= end; day += 1) days.add(day % 7);
  }
  return [...days].sort((left, right) => left - right);
}

function weekdayList(days: readonly number[]): string {
  const locale = intlLocale();
  // Chinese reads "每周一和周四"; English reads "Every Monday and Thursday".
  const name = new Intl.DateTimeFormat(locale, {
    weekday: locale.startsWith("zh") ? "short" : "long",
    timeZone: "UTC",
  });
  // 2023-01-01 was a Sunday, so day N of that week is weekday N.
  const names = days.map((day) => name.format(new Date(Date.UTC(2023, 0, 1 + day))));
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
}
