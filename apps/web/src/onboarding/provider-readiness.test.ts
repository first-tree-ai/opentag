import { describe, expect, it } from "vitest";
import { normalizeOnboardingProviders } from "./provider-readiness.js";

describe("normalizeOnboardingProviders", () => {
  it("maps every Computer and Provider route without treating non-ready states as runnable", () => {
    expect(
      normalizeOnboardingProviders([
        {
          id: "computer-a",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
          ],
        },
        {
          id: "computer-b",
          providerReadiness: [{ provider: "codex", status: "checking", observedAt: null }],
        },
      ]),
    ).toEqual([
      { computerId: "computer-a", provider: "codex", runtimeReady: true },
      { computerId: "computer-a", provider: "claude-code", runtimeReady: false },
      { computerId: "computer-b", provider: "codex", runtimeReady: false },
    ]);
  });

  it("does not invent routes when an older Server omits readiness", () => {
    expect(normalizeOnboardingProviders([{ id: "computer-a" }])).toEqual([]);
  });
});
