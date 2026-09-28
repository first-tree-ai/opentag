import {
  AGENT_SCHEDULE_PREVIEW_MAX_COUNT,
  type AgentScheduleInput,
  type AgentScheduleRule,
  parseAbsoluteInstant,
  ScheduleUtcInstantSchema,
} from "@opentag/shared";
import { Cron } from "croner";

/*
 * The single Server-side validator and calculator for Agent Schedule time rules. All of
 * creation, rule edits, resume, claim-time advancement, and preview go through these functions,
 * so a rule can never be stored in a shape the scheduler would interpret differently.
 *
 * Cron semantics are owned by Croner 10.0.1 (pinned), always constructed paused — the library is
 * an enumerator here, never an in-memory timer. On top of Croner this module enforces the
 * product grammar (exactly five fields; numbers, wildcards, lists, ranges, steps, and the
 * three-letter month/weekday aliases only) and the two DST rules: spring-forward wall times that
 * do not exist are skipped (Croner shifts them past the gap, so candidates whose local
 * hour/minute no longer match the expression are rejected), and fall-back wall times that occur
 * twice fire only at the first occurrence (Croner does this for 60-minute overlaps but not
 * shorter ones, so second occurrences are detected via the zone offset change and rejected).
 */

export type ScheduleRuleErrorCode = "invalid_rule" | "invalid_timezone" | "no_future_occurrence";

export class ScheduleRuleError extends Error {
  readonly code: ScheduleRuleErrorCode;
  constructor(code: ScheduleRuleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleRuleError";
    this.code = code;
  }
}

/** Iteration ceiling for gap/overlap filtering; a full shifted hour costs one iteration per minute. */
const MAX_ENUMERATION_STEPS = 400;
/** Date must stay representable: |t| <= 8.64e15 ms. */
const MAX_DATE_TIME_MS = 8_640_000_000_000_000;

/**
 * IANA names start with a letter and use letters, digits, `_`, `-`, `+`, and `/` only. This
 * rejects bare UTC offsets (`+08:00`), which modern `Intl` would otherwise resolve as fixed
 * offset zones: a schedule must name a real zone so calendar rules stay DST-correct.
 */
const IANA_TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Normalize an IANA timezone name via `Intl`, rejecting unknown zones and bare UTC offsets. */
export function normalizeIanaTimezone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 100 || !IANA_TIMEZONE_PATTERN.test(trimmed)) {
    throw new ScheduleRuleError("invalid_timezone", "A schedule requires an explicit IANA timezone");
  }
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    if (!resolved || !IANA_TIMEZONE_PATTERN.test(resolved)) throw new Error("empty");
    return resolved;
  } catch {
    throw new ScheduleRuleError("invalid_timezone", `Unrecognized IANA timezone: ${trimmed}`);
  }
}

/* ----------------------------------------------------------------------------------------------
 * Five-field cron narrowing
 * ------------------------------------------------------------------------------------------- */

const MONTH_ALIAS = /^(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/i;
const WEEKDAY_ALIAS = /^(?:SUN|MON|TUE|WED|THU|FRI|SAT)$/i;

type CronFieldSpec = {
  name: string;
  min: number;
  /** Inclusive upper bound used both for validation and for rewriting `N/S` into `N-max/S`. */
  max: number;
  aliases?: RegExp;
};

const MINUTE_FIELD: CronFieldSpec = { name: "minute", min: 0, max: 59 };
const HOUR_FIELD: CronFieldSpec = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH_FIELD: CronFieldSpec = { name: "day-of-month", min: 1, max: 31 };
const MONTH_FIELD: CronFieldSpec = { name: "month", min: 1, max: 12, aliases: MONTH_ALIAS };
/** Both 0 and 7 are Sunday, so a numeric `N/S` weekday step expands against 7. */
const DAY_OF_WEEK_FIELD: CronFieldSpec = { name: "day-of-week", min: 0, max: 7, aliases: WEEKDAY_ALIAS };
const CRON_FIELDS = [MINUTE_FIELD, HOUR_FIELD, DAY_OF_MONTH_FIELD, MONTH_FIELD, DAY_OF_WEEK_FIELD] as const;

export function normalizeCronWhitespace(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function invalidCron(message: string): ScheduleRuleError {
  return new ScheduleRuleError("invalid_rule", message);
}

function parseCronAtom(atom: string, field: CronFieldSpec): number | null {
  if (!/^\d+$/.test(atom)) return null;
  const value = Number(atom);
  return value >= field.min && value <= field.max ? value : null;
}

function parseCronStep(stepRaw: string | undefined, spec: CronFieldSpec, token: string): number | null {
  if (stepRaw === undefined) return null;
  if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) {
    throw invalidCron(`Illegal step in the ${spec.name} field: ${token}`);
  }
  return Number(stepRaw);
}

function normalizeCronRange(base: string, step: number | null, spec: CronFieldSpec, token: string): string {
  const rangeParts = base.split("-");
  if (rangeParts.length > 2) throw invalidCron(`Illegal range in the ${spec.name} field: ${token}`);
  const [startRaw, endRaw] = rangeParts as [string, string];
  const startNumber = parseCronAtom(startRaw, spec);
  const endNumber = parseCronAtom(endRaw, spec);
  const aliasRange = spec.aliases?.test(startRaw) === true && spec.aliases.test(endRaw);
  if (!aliasRange && (startNumber === null || endNumber === null)) {
    // Mixed alias/number ranges and unknown letters (including full names) land here.
    throw invalidCron(`Illegal range in the ${spec.name} field: ${token}`);
  }
  if (startNumber !== null && endNumber !== null && startNumber > endNumber) {
    throw invalidCron(`Reversed range in the ${spec.name} field: ${token}`);
  }
  return step === null ? base : `${base}/${step}`;
}

function normalizeCronSingle(base: string, step: number | null, spec: CronFieldSpec, token: string): string {
  const single = parseCronAtom(base, spec);
  if (single !== null) {
    // Croner only accepts steps on wildcards and ranges, so `N/S` becomes `N-max/S`.
    return step === null ? base : `${base}-${spec.max}/${step}`;
  }
  if (spec.aliases?.test(base)) {
    if (step !== null) throw invalidCron(`Illegal step on a name in the ${spec.name} field: ${token}`);
    return base;
  }
  throw invalidCron(`Illegal value in the ${spec.name} field: ${token}`);
}

function normalizeCronToken(token: string, spec: CronFieldSpec): string {
  if (!token) throw invalidCron(`Empty entry in the ${spec.name} field`);
  const slashParts = token.split("/");
  if (slashParts.length > 2) throw invalidCron(`Illegal step in the ${spec.name} field: ${token}`);
  const [base, stepRaw] = slashParts as [string, string?];
  const step = parseCronStep(stepRaw, spec, token);
  if (base === "*") return step === null ? "*" : `*/${step}`;
  if (base.includes("-")) return normalizeCronRange(base, step, spec, token);
  return normalizeCronSingle(base, step, spec, token);
}

/**
 * Validate and normalize one cron field. Rejects seconds/year columns, macros, and the
 * `L/W/#/+/?/H` extensions by construction: only `*`, numbers, ranges, lists, steps, and the
 * field's three-letter aliases survive. Croner refuses numeric-prefix steps (`5/10`), so those
 * are rewritten to the equivalent `N-max/S` here.
 */
function normalizeCronField(field: string, spec: CronFieldSpec): string {
  if (!field) throw invalidCron(`Empty ${spec.name} field`);
  return field
    .split(",")
    .map((token) => normalizeCronToken(token, spec))
    .join(",");
}

/**
 * Narrow a raw expression to the supported five-field grammar and return the normalized form
 * Croner understands. Nothing about day/month/weekday semantics is reinterpreted here.
 */
export function normalizeCronExpression(raw: string): string {
  const collapsed = normalizeCronWhitespace(raw);
  const fields = collapsed.split(" ");
  if (fields.length !== 5) {
    throw invalidCron(
      "A schedule expression must be exactly five cron fields: minute hour day-of-month month day-of-week",
    );
  }
  return fields.map((field, index) => normalizeCronField(field, CRON_FIELDS[index] as CronFieldSpec)).join(" ");
}

/* ----------------------------------------------------------------------------------------------
 * Local wall-clock helpers (Intl only; the timezone is always explicit)
 * ------------------------------------------------------------------------------------------- */

function localWallClock(
  at: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    second: Number(value("second")),
  };
}

/** The zone's UTC offset (local minus UTC) at an instant, in whole milliseconds. */
function timeZoneOffsetMs(timezone: string, at: Date): number {
  const wall = localWallClock(at, timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * True when `at` is the SECOND occurrence of an ambiguous fall-back wall time: the zone offset
 * shrank within the window before `at` and the same wall clock genuinely occurred earlier.
 * Sampling two hours back covers every IANA transition step (at most 60 minutes) plus margin.
 */
function earlierAmbiguousSibling(timezone: string, at: Date): Date | null {
  const spanMs = 2 * 60 * 60 * 1000;
  const offsetHere = timeZoneOffsetMs(timezone, at);
  const offsetBefore = timeZoneOffsetMs(timezone, new Date(at.getTime() - spanMs));
  if (offsetBefore <= offsetHere) return null;
  const sibling = new Date(at.getTime() - (offsetBefore - offsetHere));
  if (timeZoneOffsetMs(timezone, sibling) !== offsetBefore) return null;
  const currentWall = localWallClock(at, timezone);
  const siblingWall = localWallClock(sibling, timezone);
  const sameWallTime =
    currentWall.year === siblingWall.year &&
    currentWall.month === siblingWall.month &&
    currentWall.day === siblingWall.day &&
    currentWall.hour === siblingWall.hour &&
    currentWall.minute === siblingWall.minute &&
    currentWall.second === siblingWall.second;
  return sameWallTime ? sibling : null;
}

/** Match a normalized minute/hour field against a civil clock value; gap artifacts fail this. */
function clockFieldMatches(field: string, value: number): boolean {
  return field.split(",").some((token) => {
    const [base, stepRaw] = token.split("/") as [string, string?];
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (base === "*") return value % step === 0;
    if (base.includes("-")) {
      const [startRaw, endRaw] = base.split("-") as [string, string];
      const start = Number(startRaw);
      const end = Number(endRaw);
      return value >= start && value <= end && (value - start) % step === 0;
    }
    return Number(base) === value;
  });
}

/**
 * Verify that a Croner-proposed instant still lands on the expression's minute/hour in the
 * schedule's civil time. Spring-forward gap shifts (e.g. 02:30 proposed as 03:30) fail here and
 * are skipped; day/month/weekday matching stays with Croner.
 */
function matchesCronWallTime(expression: string, timezone: string, at: Date): boolean {
  const [minuteField, hourField] = expression.split(" ") as [string, string, string, string, string];
  const wall = localWallClock(at, timezone);
  return clockFieldMatches(minuteField, wall.minute) && clockFieldMatches(hourField, wall.hour);
}

/* ----------------------------------------------------------------------------------------------
 * Rule normalization and enumeration
 * ------------------------------------------------------------------------------------------- */

export interface NormalizedScheduleRule {
  rule: AgentScheduleRule;
  timezone: string;
}

function parseUtcInstant(raw: string, field: string): number {
  const parsed = ScheduleUtcInstantSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidCron(`A schedule ${field} must be a UTC instant with millisecond precision`);
  }
  return Date.parse(parsed.data);
}

/**
 * Validate a persisted rule and timezone, returning the canonical forms. This does not prove a
 * future occurrence exists — use {@link nextScheduleOccurrence} for that. Thrown errors are the
 * stable `invalid_rule` / `invalid_timezone` codes the scanner maps to auto-disable outcomes.
 */
export function normalizeAndValidateRule(rule: AgentScheduleRule, timezone: string): NormalizedScheduleRule {
  const normalizedTimezone = normalizeIanaTimezone(timezone);
  switch (rule.kind) {
    case "at":
      return {
        rule: { kind: "at", at: new Date(parseUtcInstant(rule.at, "time")).toISOString() },
        timezone: normalizedTimezone,
      };
    case "every": {
      parseUtcInstant(rule.anchorAt, "anchor");
      const intervalMs = rule.intervalSeconds * 1000;
      if (!Number.isSafeInteger(intervalMs)) {
        throw invalidCron("A schedule interval is outside the safe integer range");
      }
      return {
        rule: { kind: "every", intervalSeconds: rule.intervalSeconds, anchorAt: rule.anchorAt },
        timezone: normalizedTimezone,
      };
    }
    case "cron":
      return {
        rule: { kind: "cron", expression: normalizeCronExpression(rule.expression) },
        timezone: normalizedTimezone,
      };
  }
}

/**
 * Build the persisted rule for a management request. `anchor` is the Server's transaction time
 * for `every`; callers never supply one. The rule is normalized but NOT checked for a future
 * occurrence — that decision belongs to the caller with its own reference time.
 */
export function scheduleRuleFromInput(
  input: AgentScheduleInput,
  timezone: string,
  anchor: Date,
): NormalizedScheduleRule {
  const normalizedTimezone = normalizeIanaTimezone(timezone);
  switch (input.kind) {
    case "at": {
      const at = parseAbsoluteInstant(input.at);
      if (!at) throw invalidCron("A one-time schedule requires an ISO 8601 instant with an explicit UTC offset or Z");
      return { rule: { kind: "at", at: at.toISOString() }, timezone: normalizedTimezone };
    }
    case "every":
      return {
        rule: { kind: "every", intervalSeconds: input.intervalSeconds, anchorAt: anchor.toISOString() },
        timezone: normalizedTimezone,
      };
    case "cron":
      return {
        rule: { kind: "cron", expression: normalizeCronExpression(input.expression) },
        timezone: normalizedTimezone,
      };
  }
}

type CronCandidate = { kind: "fire"; atMs: number } | { kind: "skip"; cursor: number } | { kind: "exhausted" };

/** Classify one Croner proposal: fire it, skip past it, or stop when the rule is exhausted. */
function classifyCronCandidate(cron: Cron, expression: string, timezone: string, cursor: number): CronCandidate {
  const next = cron.nextRun(new Date(cursor));
  if (!next) return { kind: "exhausted" };
  const nextMs = next.getTime();
  if (nextMs <= cursor) return { kind: "skip", cursor: cursor + 1 };
  // Spring-forward gap shifts (e.g. 02:30 proposed as 03:30) fail the wall-time check.
  if (!matchesCronWallTime(expression, timezone, next)) return { kind: "skip", cursor: nextMs };
  // Croner can propose only the second occurrence in shorter (30-minute) overlaps. Return
  // its earlier matching twin when it is still future; after the first twin, skip the second.
  const firstTwin = earlierAmbiguousSibling(timezone, next);
  if (firstTwin) {
    return firstTwin.getTime() > cursor
      ? { kind: "fire", atMs: firstTwin.getTime() }
      : { kind: "skip", cursor: nextMs };
  }
  return { kind: "fire", atMs: nextMs };
}

function nextCronOccurrence(expression: string, timezone: string, afterMs: number): number | null {
  let cron: Cron;
  try {
    cron = new Cron(expression, { paused: true, timezone, domAndDow: false });
  } catch (error) {
    throw invalidCron(error instanceof Error ? error.message : "Invalid cron expression");
  }
  let cursor = afterMs;
  for (let step = 0; step < MAX_ENUMERATION_STEPS; step += 1) {
    let candidate: CronCandidate;
    try {
      candidate = classifyCronCandidate(cron, expression, timezone, cursor);
    } catch (error) {
      throw invalidCron(error instanceof Error ? error.message : "Invalid cron expression");
    }
    if (candidate.kind === "exhausted") return null;
    if (candidate.kind === "fire") return candidate.atMs;
    cursor = candidate.cursor;
  }
  // Fail closed rather than loop forever on pathological DST artifacts.
  return null;
}

/**
 * The first occurrence strictly after `after`, or null when the rule has none (`at` in the past,
 * an exhausted calendar rule, or an unrepresentable result). Throws {@link ScheduleRuleError}
 * for malformed rules and timezones.
 */
export function nextScheduleOccurrence(rule: AgentScheduleRule, timezone: string, after: Date): Date | null {
  const normalized = normalizeAndValidateRule(rule, timezone);
  const afterMs = after.getTime();
  let nextMs: number | null;
  switch (normalized.rule.kind) {
    case "at": {
      const atMs = parseUtcInstant(normalized.rule.at, "time");
      nextMs = atMs > afterMs ? atMs : null;
      break;
    }
    case "every": {
      const anchorMs = parseUtcInstant(normalized.rule.anchorAt, "anchor");
      const intervalMs = normalized.rule.intervalSeconds * 1000;
      const steps = Math.max(1, Math.floor((afterMs - anchorMs) / intervalMs) + 1);
      const candidate = anchorMs + steps * intervalMs;
      nextMs = Number.isSafeInteger(candidate) && Math.abs(candidate) <= MAX_DATE_TIME_MS ? candidate : null;
      break;
    }
    case "cron":
      nextMs = nextCronOccurrence(normalized.rule.expression, normalized.timezone, afterMs);
      break;
  }
  return nextMs === null ? null : new Date(nextMs);
}

/** {@link nextScheduleOccurrence} that turns "no future point" into the stable error code. */
export function requireFutureOccurrence(rule: AgentScheduleRule, timezone: string, after: Date): Date {
  const next = nextScheduleOccurrence(rule, timezone, after);
  if (!next) {
    throw new ScheduleRuleError("no_future_occurrence", "The schedule has no future occurrence");
  }
  return next;
}

export interface SchedulePreviewItem {
  /** UTC ISO instant with millisecond precision. */
  at: string;
  /** The same instant in the schedule timezone: `YYYY-MM-DD HH:mm:ss ±HH:MM`. */
  local: string;
  timezone: string;
}

export interface SchedulePreview {
  calculatedAt: Date;
  rule: AgentScheduleRule;
  timezone: string;
  items: SchedulePreviewItem[];
}

/** Format one instant in the schedule timezone with its numeric offset for unambiguous display. */
export function formatScheduleLocal(at: Date, timezone: string): string {
  const offsetMs = timeZoneOffsetMs(timezone, at);
  const wall = new Date(at.getTime() + offsetMs);
  const iso = wall.toISOString();
  const sign = offsetMs < 0 ? "-" : "+";
  const absMinutes = Math.round(Math.abs(offsetMs) / 60_000);
  const offset = `${sign}${String(Math.floor(absMinutes / 60)).padStart(2, "0")}:${String(absMinutes % 60).padStart(2, "0")}`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} ${offset}`;
}

/**
 * Preview up to `count` future occurrences (one for a future `at`, zero for an exhausted one).
 * Enumerates through the same {@link nextScheduleOccurrence} the scanner advances with, so a
 * preview can never disagree with execution.
 */
export function previewSchedule(
  rule: AgentScheduleRule,
  timezone: string,
  at: Date,
  count = AGENT_SCHEDULE_PREVIEW_MAX_COUNT,
): SchedulePreview {
  const normalized = normalizeAndValidateRule(rule, timezone);
  const items: SchedulePreviewItem[] = [];
  let cursor = at;
  const limit = Math.max(0, Math.min(count, AGENT_SCHEDULE_PREVIEW_MAX_COUNT));
  for (let index = 0; index < limit; index += 1) {
    const next = nextScheduleOccurrence(normalized.rule, normalized.timezone, cursor);
    if (!next) break;
    items.push({
      at: next.toISOString(),
      local: formatScheduleLocal(next, normalized.timezone),
      timezone: normalized.timezone,
    });
    cursor = next;
  }
  return { calculatedAt: at, rule: normalized.rule, timezone: normalized.timezone, items };
}
