import { expect, it } from "vitest";
import {
  buildScheduleStartNotification,
  filterEmojiForDisplay,
  formatScheduleLocalTime,
  normalizeScheduleTaskPreview,
} from "../runtime/scheduled-message-input.js";

it("normalizes a scheduled preview by Unicode code point without splitting surrogate pairs", () => {
  expect(normalizeScheduleTaskPreview("  Check\n\tbuild  status ")).toBe("Check build status");
  const source = "🐈".repeat(121);
  const preview = normalizeScheduleTaskPreview(source);
  expect([...preview]).toHaveLength(120);
  expect(preview).toBe(`${"🐈".repeat(119)}…`);
});

it("formats the same wall time with the correct DST offset for each occurrence", () => {
  expect(formatScheduleLocalTime(new Date("2026-11-01T05:30:00.000Z"), "America/New_York")).toBe(
    "2026-11-01 01:30:00 -04:00",
  );
  expect(formatScheduleLocalTime(new Date("2026-11-01T06:30:00.000Z"), "America/New_York")).toBe(
    "2026-11-01 01:30:00 -05:00",
  );
});

it("removes emoji only from the composed start notice display", () => {
  const name = "Daily 🐈 check";
  const preview = "Inspect ✅ build #1";
  const notice = buildScheduleStartNotification({
    name,
    preview,
    scheduledFor: new Date("2026-09-28T01:00:00.000Z"),
    processedAt: new Date("2026-09-28T01:12:34.000Z"),
    timezone: "Asia/Shanghai",
    detailUrl: "https://example.test/schedules/detail",
  });
  expect(notice).toContain("Daily check");
  expect(notice).toContain("Inspect build #1");
  expect(notice).toContain("2026-09-28 09:00:00 +08:00");
  expect(notice).toContain("2026-09-28 09:12:34 +08:00");
  expect(notice).not.toContain("🐈");
  expect(notice).not.toContain("✅");
  expect(filterEmojiForDisplay(name)).toBe("Daily check");
  expect(name).toBe("Daily 🐈 check");
  expect(preview).toBe("Inspect ✅ build #1");
});
