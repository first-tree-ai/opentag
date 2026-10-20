import { RUNTIME_DEFAULT_MAX_DURATION_MS } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { turnTimeoutMs } from "../runtime/turn-timeout.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

describe("Turn runtime budget", () => {
  it.each([
    { budget: undefined, remaining: 7 * 86_400_000, expected: RUNTIME_DEFAULT_MAX_DURATION_MS },
    { budget: undefined, remaining: undefined, expected: RUNTIME_DEFAULT_MAX_DURATION_MS },
    { budget: undefined, remaining: 60_000, expected: 60_000 },
    { budget: 5_000, remaining: 7 * 86_400_000, expected: 5_000 },
    { budget: 3_600_000, remaining: 7 * 86_400_000, expected: 3_600_000 },
    { budget: 3_600_000, remaining: undefined, expected: 3_600_000 },
    { budget: 5_000, remaining: 3_000, expected: 3_000 },
    { budget: undefined, remaining: -1, expected: 1 },
  ])("uses budget $budget with deadline remaining $remaining", ({ budget, remaining, expected }) => {
    const now = Date.parse("2026-10-19T00:00:00Z");
    const request = cloudDeliveryFixture();
    request.runtime.budget = budget === undefined ? undefined : { maxDurationMs: budget };
    request.deadlineAt = remaining === undefined ? undefined : new Date(now + remaining).toISOString();
    const original = JSON.stringify(request);
    expect(turnTimeoutMs(request, now)).toBe(expected);
    expect(JSON.stringify(request)).toBe(original);
  });
});
