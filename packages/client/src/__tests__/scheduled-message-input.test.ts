import { expect, it } from "vitest";
import { formatScheduleLocalTime, normalizeScheduleTaskPreview } from "../runtime/scheduled-message-input.js";

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
