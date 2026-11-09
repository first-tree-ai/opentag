import type { AgentScheduleRule } from "@opentag/shared/browser";
import { intlLocale } from "../../i18n/locale.js";
import * as m from "../../paraglide/messages.js";

/**
 * A schedule rule in the reader's words: "Every weekday at 9:00", "每月 1 日 18:00".
 *
 * Only the cron shapes people actually write by hand are phrased — fixed minute and hour with a
 * day-of-week set, a day-of-month set, or every day — plus fixed intervals and one-off times.
 * Anything else keeps its raw expression, which stays exact rather than guessed.
 */
export function scheduleRuleText(rule: AgentScheduleRule, timezone: string): string {
  if (rule.kind === "at") return m.agents_schedules_at({ time: shortScheduleTime(rule.at, timezone) });
  if (rule.kind === "every") return intervalText(rule.intervalSeconds);
  return cronText(rule.expression) ?? m.agents_schedules_cron({ expression: rule.expression });
}

/** The zone's offset from UTC, in minutes, at one instant (so daylight saving time is honoured). */
function utcOffsetMinutes(timeZone: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * Whether a schedule's zone reads the same clock as the reader's at the given instant. Zones are
 * compared by their UTC offset at that instant rather than by name, so Asia/Shanghai and
 * Asia/Singapore are the same to a reader, while a zone that shifts for daylight saving time
 * differs on the dates it shifts and not on others.
 */
export function sameClockAt(scheduleZone: string, instant: string | Date, readerZone = currentZone()): boolean {
  if (scheduleZone === readerZone) return true;
  const at = typeof instant === "string" ? new Date(instant) : instant;
  return utcOffsetMinutes(scheduleZone, at) === utcOffsetMinutes(readerZone, at);
}

function currentZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Month, day, weekday, and time in the schedule's zone, with the hour unpadded like the rules
 * ("9:00"). The zone follows the time ("9:30 (GMT+8)") only when the reader's clock reads a
 * different time at that instant.
 */
export function shortScheduleTime(instant: string, timezone: string, readerZone = currentZone()): string {
  const at = new Date(instant);
  const time = new Intl.DateTimeFormat(intlLocale(), {
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  })
    .formatToParts(at)
    // Some locales pad a 24-hour hour even when asked for "numeric".
    .map((part) => (part.type === "hour" ? String(Number(part.value)) : part.value))
    .join("");
  if (sameClockAt(timezone, at, readerZone)) return time;
  const zone =
    new Intl.DateTimeFormat(intlLocale(), { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? timezone;
  return m.agents_schedules_time_with_zone({ time, zone });
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
  const hours = /^(\d{1,2})-(\d{1,2})$/.exec(hour);
  if (hours) return hourlyRangeText(minute, Number(hours[1]), Number(hours[2]), dayOfMonth, dayOfWeek);
  if (!inRange(minute, 59) || !inRange(hour, 23)) return undefined;
  return dayText(`${Number(hour)}:${minute.padStart(2, "0")}`, dayOfMonth, dayOfWeek);
}

/** `*\/N * * * *` and `M * * * *`. */
function subHourlyText(minute: string): string | undefined {
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step) {
    // A minute step restarts each hour, so it is a uniform interval only when it divides 60:
    // `*/45` fires at :00 and :45, gaps of 45 then 15 minutes, and keeps its exact form.
    const count = Number(step[1]);
    if (count < 1 || count >= 60 || 60 % count !== 0) return undefined;
    return count === 1 ? m.agents_schedules_every_minute() : m.agents_schedules_every_minutes({ count: String(count) });
  }
  return inRange(minute, 59) ? m.agents_schedules_hourly({ minute: minute.padStart(2, "0") }) : undefined;
}

/** `M A-B * * *` and `M A-B * * 1-5`: hourly within a window, every day or on weekdays. */
function hourlyRangeText(
  minute: string,
  start: number,
  end: number,
  dayOfMonth: string,
  dayOfWeek: string,
): string | undefined {
  if (!inRange(minute, 59) || start >= end || end > 23 || dayOfMonth !== "*") return undefined;
  const padded = minute.padStart(2, "0");
  const window = { start: `${start}:${padded}`, end: `${end}:${padded}` };
  if (dayOfWeek === "*") return m.agents_schedules_daily_hourly(window);
  return weekdays(dayOfWeek)?.join() === "1,2,3,4,5" ? m.agents_schedules_weekdays_hourly(window) : undefined;
}

function dayText(time: string, dayOfMonth: string, dayOfWeek: string): string | undefined {
  if (dayOfMonth === "*" && dayOfWeek === "*") return m.agents_schedules_daily({ time });
  if (dayOfMonth === "*") return weekdayText(time, dayOfWeek);
  if (dayOfWeek !== "*") return undefined;
  const days = numberSet(dayOfMonth, 1, 31);
  if (!days) return undefined;
  if (days.length === 1) return m.agents_schedules_monthly({ day: String(days[0]), time });
  return m.agents_schedules_monthly_days({ days: dayOfMonthList(days), time });
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

/** A day-of-week field as sorted, distinct days (0 = Sunday, 7 folded into it). */
function weekdays(field: string): number[] | undefined {
  const days = numberSet(field, 0, 7);
  return days && [...new Set(days.map((day) => day % 7))].sort((left, right) => left - right);
}

/** A plain cron list of numbers and ranges within bounds as sorted, distinct values; undefined otherwise. */
function numberSet(field: string, min: number, max: number): number[] | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(part);
    if (!range) return undefined;
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    if (start < min || end > max || end < start) return undefined;
    for (let value = start; value <= end; value += 1) values.add(value);
  }
  return [...values].sort((left, right) => left - right);
}

/** Days of the month with consecutive runs of three or more as ranges: "1、15、28–31", "1, 15 and 28–31". */
function dayOfMonthList(days: readonly number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < days.length; ) {
    let end = index;
    while (end + 1 < days.length && days[end + 1] === (days[end] ?? 0) + 1) end += 1;
    if (end - index >= 2) {
      parts.push(`${days[index]}–${days[end]}`);
      index = end + 1;
    } else {
      parts.push(String(days[index]));
      index += 1;
    }
  }
  const locale = intlLocale();
  return locale.startsWith("zh")
    ? parts.join("、")
    : new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
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
