import { describe, expect, it } from "vitest";
import { deriveOnboardingState } from "./flow.js";
import { normalizeOnboardingProviders } from "./provider-readiness.js";

describe("normalizeOnboardingProviders", () => {
  it("maps every Computer and Provider route without treating non-ready states as runnable", () => {
    expect(
      normalizeOnboardingProviders([
        {
          computerId: "computer-a",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
          ],
        },
        {
          computerId: "computer-b",
          providerReadiness: [{ provider: "codex", status: "checking", observedAt: null }],
        },
      ]),
    ).toEqual([
      { computerId: "computer-a", provider: "codex", runtimeReady: true, status: "ready" },
      { computerId: "computer-a", provider: "claude-code", runtimeReady: false, status: "sign-in" },
      { computerId: "computer-b", provider: "codex", runtimeReady: false, status: "checking" },
    ]);
  });

  it("does not invent routes when an older Server omits readiness", () => {
    expect(normalizeOnboardingProviders([{ computerId: "computer-a" }])).toEqual([]);
  });

  it("feeds the onboarding state model only complete, runnable Computer and Provider routes", () => {
    const computers = [
      { id: "computer-a", displayName: "Computer A", connectionStatus: "online" as const },
      { id: "computer-b", displayName: "Computer B", connectionStatus: "online" as const },
    ];
    const providers = normalizeOnboardingProviders([
      {
        computerId: "computer-a",
        providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
      },
      {
        computerId: "computer-b",
        providerReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
      },
    ]);

    expect(
      deriveOnboardingState({
        workspace: {},
        computers,
        providers,
        agent: undefined,
        handoff: undefined,
      }).currentState,
    ).toMatchObject({
      kind: "agent",
      computer: { id: "computer-a" },
      provider: { computerId: "computer-a", provider: "codex", runtimeReady: true },
    });
  });
});
