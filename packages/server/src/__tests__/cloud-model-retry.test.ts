import { describe, expect, it, vi } from "vitest";
import { cloudModelRetryAfter, cloudModelRetryDelay, waitForCloudModelRetry } from "../cloud-model-retry.js";

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

describe("one proxy-owned retry budget", () => {
  it.each([
    ["0", 0],
    ["30", 30_000],
    ["60", 60_000],
    ["61", undefined],
    ["9".repeat(128), undefined],
  ])("never retries earlier than the validated hint %s", (hint, expected) =>
    expect(cloudModelRetryDelay(hint as string, 0)).toBe(expected),
  );

  it("uses three jittered backoffs and never resets the exhausted budget", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect([0, 1, 2, 3].map((retry) => cloudModelRetryDelay(undefined, retry))).toEqual([
        500,
        1_000,
        2_000,
        undefined,
      ]);
      expect(cloudModelRetryDelay("0", 3)).toBeUndefined();
      random.mockReturnValue(1);
      expect(cloudModelRetryDelay(undefined, 0)).toBe(375);
    } finally {
      random.mockRestore();
    }
  });

  it("interrupts a pending backoff on cancellation", async () => {
    const controller = new AbortController();
    const waiting = waitForCloudModelRetry(30_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
  });

  it("does not wait on an already revoked permission", async () => {
    expect(await waitForCloudModelRetry(30_000, AbortSignal.abort())).toBe(false);
  });
});
