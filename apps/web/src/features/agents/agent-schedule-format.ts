import type { AgentScheduleRule } from "@opentag/shared/browser";
import { intlLocale } from "../../i18n/locale.js";
import * as m from "../../paraglide/messages.js";

/*
 * Schedule times are read in the schedule's own timezone: a plan that runs "every day at 09:00 Shanghai"
 * should say 09:00 even to a viewer in another zone. The zone is named only when it differs from the
 * viewer's, so the common case stays a short "Tomorrow 09:00" instead of a full date, seconds, and zone.
 */

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
const MINUTE_SECONDS = 60;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
}

function zonedDay(instant: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: timezone,
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

/** Whole calendar days from `now` to `instant`, both read in `timezone`. */
function calendarDayOffset(instant: Date, now: Date, timezone: string): number {
  const a = zonedDay(instant, timezone);
  const b = zonedDay(now, timezone);
  return Math.round(
    (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / (DAY_SECONDS * 1_000),
  );
}

function viewerTimezone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function clockTime(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(instant);
}

function zoneLabel(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat(intlLocale(), { timeZone: timezone, timeZoneName: "short" }).formatToParts(
    instant,
  );
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timezone;
}

/**
 * The compact form used in the schedule list: "Today 09:00", "Tomorrow 09:00", "Fri 17:30" within the
 * coming week, "Nov 5 09:00", or
 * "Jan 5, 2027 09:00" outside the current year. Seconds are never shown.
 */
export function formatScheduleTimeShort(instant: string, timezone: string, now: Date = new Date()): string {
  const date = new Date(instant);
  const time = clockTime(date, timezone);
  const offset = calendarDayOffset(date, now, timezone);
  let text: string;
  if (offset === 0) text = m.agents_schedules_today_at({ time });
  else if (offset === 1) text = m.agents_schedules_tomorrow_at({ time });
  else if (offset === -1) text = m.agents_schedules_yesterday_at({ time });
  else if (offset > 1 && offset < 7) {
    const weekday = new Intl.DateTimeFormat(intlLocale(), { weekday: "short", timeZone: timezone }).format(date);
    text = m.agents_schedules_day_at({ day: weekday, time });
  } else {
    const sameYear = zonedDay(date, timezone).year === zonedDay(now, timezone).year;
    const day = new Intl.DateTimeFormat(intlLocale(), {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
      timeZone: timezone,
    }).format(date);
    text = m.agents_schedules_day_at({ day, time });
  }
  return timezone === viewerTimezone() ? text : `${text} ${zoneLabel(date, timezone)}`;
}

/** The full form for details and hover text: date and minute, without seconds or the IANA zone name. */
export function formatScheduleTime(instant: string, timezone: string): string {
  const date = new Date(instant);
  const formatted = new Intl.DateTimeFormat(intlLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(date);
  return `${formatted} ${zoneLabel(date, timezone)}`;
}

const WEEKDAY_MESSAGES = [
  m.agents_schedules_weekday_sun,
  m.agents_schedules_weekday_mon,
  m.agents_schedules_weekday_tue,
  m.agents_schedules_weekday_wed,
  m.agents_schedules_weekday_thu,
  m.agents_schedules_weekday_fri,
  m.agents_schedules_weekday_sat,
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The common five-field cron shapes read as words; anything else keeps the expression, which is the
 * only faithful description of it.
 */
function cronSummary(expression: string): string {
  const fields = expression.trim().split(/\s+/u);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const numeric = (value: string | undefined, max: number) =>
    value !== undefined && /^\d{1,2}$/u.test(value) && Number(value) <= max ? Number(value) : undefined;
  const mm = numeric(minute, 59);
  const hh = numeric(hour, 23);
  if (fields.length === 5 && mm !== undefined && hh !== undefined && dayOfMonth === "*" && month === "*") {
    const time = `${pad(hh)}:${pad(mm)}`;
    if (dayOfWeek === "*") return m.agents_schedules_daily_at({ time });
    if (dayOfWeek === "1-5") return m.agents_schedules_weekdays_at({ time });
    const weekday = numeric(dayOfWeek, 7);
    const weekdayName = weekday === undefined ? undefined : WEEKDAY_MESSAGES[weekday % 7];
    if (weekdayName) return m.agents_schedules_weekly_at({ weekday: weekdayName(), time });
  }
  return m.agents_schedules_cron({ expression });
}

function intervalSummary(seconds: number): string {
  // Fixed intervals drift against the wall clock across DST, so day intervals do not claim a time of day.
  if (seconds % DAY_SECONDS === 0) {
    const days = seconds / DAY_SECONDS;
    return days === 1 ? m.agents_schedules_every_day() : m.agents_schedules_every_days({ count: String(days) });
  }
  if (seconds % HOUR_SECONDS === 0) {
    const hours = seconds / HOUR_SECONDS;
    return hours === 1 ? m.agents_schedules_every_hour() : m.agents_schedules_every_hours({ count: String(hours) });
  }
  if (seconds % MINUTE_SECONDS === 0) {
    const minutes = seconds / MINUTE_SECONDS;
    return minutes === 1
      ? m.agents_schedules_every_minute()
      : m.agents_schedules_every_minutes({ count: String(minutes) });
  }
  return m.agents_schedules_every({ seconds: String(seconds) });
}

/** One phrase for how often the plan runs, in the schedule's timezone. */
export function scheduleRuleSummary(rule: AgentScheduleRule, timezone: string, now: Date = new Date()): string {
  if (rule.kind === "at") return m.agents_schedules_once_at({ time: formatScheduleTimeShort(rule.at, timezone, now) });
  if (rule.kind === "every") return intervalSummary(rule.intervalSeconds);
  return cronSummary(rule.expression);
}
