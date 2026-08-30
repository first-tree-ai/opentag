import { afterEach, describe, expect, it, vi } from "vitest";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import {
  compareText,
  foldCase,
  formatCompactNumber,
  formatDateTime,
  formatDay,
  formatElapsedCompact,
  formatNumber,
  formatRelativeTime,
  initials,
} from "./format.js";

function withLocale(locale: "en" | "zh", callback: () => void): void {
  overwriteGetLocale(() => locale);
  try {
    callback();
  } finally {
    overwriteGetLocale(() => "en");
  }
}

describe("locale-aware formatters", () => {
  const instant = new Date("2025-02-03T12:34:00.000Z");

  afterEach(() => {
    overwriteGetLocale(() => "en");
    vi.useRealTimers();
  });

  it("keeps English date, number, and relative-time output compatible", () => {
    withLocale("en", () => {
      vi.setSystemTime(new Date("2025-02-03T12:35:30.000Z"));
      expect(formatDateTime(instant)).toBe(
        new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(instant),
      );
      expect(formatDay("2025-02-03")).toBe("Feb 3");
      expect(formatNumber(1_234_567)).toBe("1,234,567");
      expect(formatCompactNumber(428_000)).toBe("428K");
      expect(formatRelativeTime(instant)).toBe("1 minute ago");
      expect(formatElapsedCompact("2025-02-03T12:30:00.000Z")).toBe("5m");
    });
  });

  it("uses Simplified Chinese for dates, numbers, and messages", () => {
    withLocale("zh", () => {
      vi.setSystemTime(new Date("2025-02-03T12:35:30.000Z"));
      expect(formatDateTime(instant)).toBe("2025年2月3日 20:34");
      expect(formatDay("2025-02-03")).toBe("2月3日");
      expect(formatNumber(1_234_567)).toBe("1,234,567");
      expect(formatCompactNumber(428_000)).toBe("42.8万");
      expect(formatRelativeTime(instant)).toBe("1分钟前");
      expect(formatElapsedCompact("2025-02-03T12:30:00.000Z")).toBe("5分钟");
    });
  });

  it("switches relative-time plural messages at each boundary", () => {
    withLocale("en", () => {
      vi.setSystemTime(new Date("2025-02-05T14:35:30.000Z"));
      expect(formatRelativeTime("2025-02-05T14:35:00.000Z")).toBe("just now");
      expect(formatRelativeTime("2025-02-05T14:34:00.000Z")).toBe("1 minute ago");
      expect(formatRelativeTime("2025-02-05T13:35:00.000Z")).toBe("1 hour ago");
      expect(formatRelativeTime("2025-02-04T14:35:00.000Z")).toBe("1 day ago");
      expect(formatRelativeTime("2025-02-03T14:35:00.000Z")).toBe("2 days ago");
    });
  });

  it("uses locale-aware collation and case folding", () => {
    withLocale("en", () => {
      expect(compareText("Ada", "Bob")).toBeLessThan(0);
      expect(foldCase("OpenTag")).toBe("opentag");
    });
    withLocale("zh", () => {
      expect(compareText("阿", "张")).toBeLessThan(0);
      expect(foldCase("OpenTag")).toBe("opentag");
    });
  });

  it("keeps English initials and gives compact CJK names two characters", () => {
    withLocale("en", () => {
      expect(initials("Ada Lovelace")).toBe("AL");
      expect(initials("Ada")).toBe("A");
      expect(initials("   ")).toBe("OT");
      expect(initials("张伟")).toBe("张伟");
    });
  });
});
