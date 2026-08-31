import * as m from "../paraglide/messages.js";
import { intlLocale } from "./locale.js";

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const compactNumberFormatters = new Map<string, Intl.NumberFormat>();
const percentFormatters = new Map<string, Intl.NumberFormat>();
const collators = new Map<string, Intl.Collator>();

function dateTimeFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    dateTimeFormatters.set(locale, formatter);
  }
  return formatter;
}

function dayFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
    dayFormatters.set(locale, formatter);
  }
  return formatter;
}

function numberFormatter(locale: string): Intl.NumberFormat {
  let formatter = numberFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale);
    numberFormatters.set(locale, formatter);
  }
  return formatter;
}

function compactNumberFormatter(locale: string): Intl.NumberFormat {
  let formatter = compactNumberFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" });
    compactNumberFormatters.set(locale, formatter);
  }
  return formatter;
}

function percentFormatter(locale: string): Intl.NumberFormat {
  let formatter = percentFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: "percent" });
    percentFormatters.set(locale, formatter);
  }
  return formatter;
}

function collator(locale: string): Intl.Collator {
  let formatter = collators.get(locale);
  if (!formatter) {
    formatter = new Intl.Collator(locale);
    collators.set(locale, formatter);
  }
  return formatter;
}

export function formatDateTime(value: string | Date): string {
  return dateTimeFormatter(intlLocale()).format(typeof value === "string" ? new Date(value) : value);
}

export function formatDay(value: string): string {
  const date = value.length === 10 ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  return dayFormatter(intlLocale()).format(date);
}

export function formatNumber(value: number): string {
  return numberFormatter(intlLocale()).format(value);
}

export function formatCompactNumber(value: number): string {
  if (value < 1_000) return formatNumber(value);
  return compactNumberFormatter(intlLocale()).format(value);
}

export function formatPercent(value: number): string {
  return percentFormatter(intlLocale()).format(value);
}

export function formatRelativeTime(value: string | Date): string {
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - (typeof value === "string" ? new Date(value) : value).getTime()) / 1_000),
  );
  if (elapsedSeconds < 60) return m.format_just_now();
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return m.format_minutes_ago({ count: elapsedMinutes });
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return m.format_hours_ago({ count: elapsedHours });
  return m.format_days_ago({ count: Math.floor(elapsedHours / 24) });
}

export function formatElapsedCompact(value: string): string {
  const elapsedMinutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 60) return m.format_elapsed_minutes({ count: elapsedMinutes });
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return m.format_elapsed_hours({ count: elapsedHours });
  return m.format_elapsed_days({ count: Math.floor(elapsedHours / 24) });
}

export function compareText(left: string, right: string): number {
  return collator(intlLocale()).compare(left, right);
}

export function foldCase(value: string): string {
  return value.toLocaleLowerCase(intlLocale());
}

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "OT";
  const first = parts[0];
  if (!first) return "OT";
  if (parts.length === 1 && /\p{Script=Han}/u.test(first)) return [...first].slice(0, 2).join("");
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}
