import { RUNTIME_MAX_DURATION_MS } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { cloudDispatchRetryDelayMs } from "../runtime/im-delivery-cloud.js";
import {
  ACCEPTED_REPORT_GRACE_MS,
  acceptedReportDeadlineMs,
  cappedRetryDelayMs,
  deliveryRetryDelayMs,
  MAX_OPERATION_TIMEOUT_ATTEMPTS,
  operationTimeoutExhausted,
} from "../runtime/im-delivery-retry.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The offline backoff ceiling, so a permanently offline Computer cannot exceed it. */
const RETRY_CEILING = 30 * MINUTE;

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

describe("deliveryRetryDelayMs", () => {
  it("is the exponential attempt schedule while the placement Computer is live", () => {
    expect(deliveryRetryDelayMs(1, 0)).toBe(2_000);
    expect(deliveryRetryDelayMs(3, 0)).toBe(8_000);
    expect(deliveryRetryDelayMs(50, 0)).toBe(30_000);
  });

  it("grows with how long the Computer has been silent", () => {
    const delays = [0, 16_000, 10 * MINUTE, HOUR, 4 * HOUR].map((offlineMs) => deliveryRetryDelayMs(1, offlineMs));
    expect(delays).toEqual([2_000, 2_000, 75_000, 450_000, 30 * MINUTE]);
    // Monotonic in silence: a permanently offline Computer is retried at a falling rate.
    expect(delays).toEqual([...delays].sort((left, right) => left - right));
  });

  it("caps a Computer that was never seen, and never drops below the attempt schedule", () => {
    expect(deliveryRetryDelayMs(1, Number.POSITIVE_INFINITY)).toBe(RETRY_CEILING);
    expect(deliveryRetryDelayMs(50, 5 * HOUR)).toBe(RETRY_CEILING);
  });

  it("stays bounded over a simulated day of silence", () => {
    // Walk 24 h of a permanently offline Computer and count the attempts the schedule produces.
    let elapsed = 0;
    let attempts = 0;
    while (elapsed < 24 * HOUR) {
      elapsed += deliveryRetryDelayMs(attempts + 1, elapsed);
      attempts += 1;
    }
    // ~86 today against 43,200 for the retired fixed 2 s cadence: the count is bounded by the schedule.
    expect(attempts).toBeLessThan(100);
    expect(attempts).toBeGreaterThan(8);
  });
});

describe("operation timeout exhaustion", () => {
  it("settles only after the whole operation budget has been spent repeatedly", () => {
    expect(MAX_OPERATION_TIMEOUT_ATTEMPTS).toBe(8);
    expect([1, 7].map(operationTimeoutExhausted)).toEqual([false, false]);
    expect([8, 9, 100].map(operationTimeoutExhausted)).toEqual([true, true, true]);
  });
});

describe("acceptedReportDeadlineMs", () => {
  it("closes the report window at the platform maximum runtime plus the grace", () => {
    const acceptedAt = Date.parse("2026-01-01T00:00:00.000Z");
    expect(acceptedReportDeadlineMs(acceptedAt)).toBe(acceptedAt + RUNTIME_MAX_DURATION_MS + ACCEPTED_REPORT_GRACE_MS);
    expect(ACCEPTED_REPORT_GRACE_MS).toBe(HOUR);
  });
});
