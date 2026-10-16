import { describe, expect, it } from "vitest";
import { cloudDispatchRetryDelayMs } from "../runtime/im-delivery-cloud.js";
import { cappedRetryDelayMs } from "../runtime/im-delivery-retry.js";

describe("cappedRetryDelayMs", () => {
  it("doubles from 2 s per attempt and stops growing at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6].map(cappedRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(cappedRetryDelayMs(10_000)).toBe(30_000);
  });

  it("treats missing or non-integer attempt counts as the first attempt", () => {
    expect(cappedRetryDelayMs(0)).toBe(2_000);
    expect(cappedRetryDelayMs(-3)).toBe(2_000);
    expect(cappedRetryDelayMs(2.9)).toBe(4_000);
  });

  it("keeps the Cloud dispatch backoff on the same schedule", () => {
    expect(cloudDispatchRetryDelayMs).toBe(cappedRetryDelayMs);
  });
});
