import { describe, expect, it } from "vitest";
import { cloudModelRetryAfter } from "../cloud-model-retry.js";

const NOW = Date.parse("Mon, 26 Oct 2026 12:00:00 GMT");

describe("Cloud model Retry-After validation", () => {
  it.each([
    ["30", "30"],
    ["0", "0"],
    [" 30 ", "30"],
    ["120", "120"],
    ["Mon, 26 Oct 2026 12:00:30 GMT", "30"],
    ["Mon, 26 Oct 2026 11:59:00 GMT", "0"],
    [null, undefined],
    ["", undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["Infinity", undefined],
    ["NaN", undefined],
    ["1e2", undefined],
    ["2026-10-26", undefined],
    ["30; upstream-secret", undefined],
    ["9".repeat(129), undefined],
  ])("normalizes %s without forwarding arbitrary upstream text", (input, expected) => {
    expect(cloudModelRetryAfter(input, NOW)).toBe(expected);
  });

  it("rounds an HTTP-date up instead of retrying before the requested instant", () => {
    expect(cloudModelRetryAfter("Mon, 26 Oct 2026 12:00:30 GMT", NOW + 100)).toBe("30");
  });
});
