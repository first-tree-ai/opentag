import { describe, expect, it } from "vitest";
import {
  deriveOnboardingState,
  type OnboardingAgent,
  type OnboardingComputer,
  type OnboardingFacts,
  type OnboardingHandoff,
  type OnboardingProvider,
} from "./flow.js";

const computerA: OnboardingComputer = {
  id: "computer-a",
  displayName: "Computer A",
  connectionStatus: "online",
};

const computerB: OnboardingComputer = {
  id: "computer-b",
  displayName: "Computer B",
  connectionStatus: "online",
};

const codex: OnboardingProvider = {
  computerId: computerA.id,
  provider: "codex",
  runtimeReady: true,
};

const agent: OnboardingAgent = {
  id: "agent-a",
  computerId: computerA.id,
  runtimeProvider: "codex",
};

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    team: { role: "admin" },
    computers: [computerA],
    providers: [codex],
    agent: undefined,
    handoff: undefined,
    ...overrides,
  };
}

describe("deriveOnboardingState", () => {
  it("starts with Team creation when no Team exists", () => {
    expect(deriveOnboardingState(facts({ team: undefined }))).toEqual({
      currentState: { kind: "team" },
      runtimeReady: false,
      handoffReady: false,
      canManage: true,
    });
  });

  it("distinguishes no Computers from only offline Computers", () => {
    expect(deriveOnboardingState(facts({ computers: [] })).currentState).toEqual({
      kind: "computer",
      availability: "none",
    });

    const offline = { ...computerA, connectionStatus: "offline" as const };
    expect(deriveOnboardingState(facts({ computers: [offline] })).currentState).toEqual({
      kind: "computer",
      availability: "offline",
      computers: [offline],
    });
  });

  it("automatically uses the single online Computer and ignores offline alternatives", () => {
    const offline = { ...computerB, connectionStatus: "offline" as const };
    expect(deriveOnboardingState(facts({ computers: [offline, computerA] }))).toMatchObject({
      currentState: { kind: "agent", computer: computerA, provider: codex, alternatives: [] },
      runtimeReady: true,
    });
  });

  it("automatically uses the only Computer with a runnable Provider", () => {
    expect(deriveOnboardingState(facts({ computers: [computerA, computerB] })).currentState).toEqual({
      kind: "agent",
      computer: computerA,
      provider: codex,
      alternatives: [],
    });
  });

  it("asks among multiple eligible Computers without listing ineligible ones", () => {
    const computerC = { ...computerB, id: "computer-c", displayName: "Computer C" };
    const codexOnB = { ...codex, computerId: computerB.id };
    expect(
      deriveOnboardingState(facts({ computers: [computerA, computerB, computerC], providers: [codex, codexOnB] }))
        .currentState,
    ).toEqual({
      kind: "computer",
      availability: "choice",
      computers: [computerA, computerB],
    });
  });

  it("asks which online Computer to prepare when none has a runnable Provider", () => {
    expect(deriveOnboardingState(facts({ computers: [computerA, computerB], providers: [] })).currentState).toEqual({
      kind: "computer",
      availability: "choice",
      computers: [computerA, computerB],
    });
  });

  it("reports no runnable Provider for the selected Computer", () => {
    const unavailable = { ...codex, runtimeReady: false };
    const readyElsewhere = { ...codex, computerId: computerB.id };
    expect(deriveOnboardingState(facts({ providers: [unavailable, readyElsewhere] }))).toMatchObject({
      currentState: { kind: "provider", availability: "none", computer: computerA },
      runtimeReady: false,
    });
  });

  it("automatically uses one runnable Provider", () => {
    expect(deriveOnboardingState(facts())).toMatchObject({
      currentState: { kind: "agent", computer: computerA, provider: codex, alternatives: [] },
      runtimeReady: true,
    });
  });

  it("selects Codex by default regardless of Provider input order", () => {
    const claude = { ...codex, provider: "claude-code" as const };
    expect(deriveOnboardingState(facts({ providers: [claude, codex] }))).toMatchObject({
      currentState: {
        kind: "agent",
        computer: computerA,
        provider: codex,
      },
      runtimeReady: true,
    });
  });

  it("preserves an explicit Claude Code selection while it remains runnable", () => {
    const claude = { ...codex, provider: "claude-code" as const };
    expect(
      deriveOnboardingState(
        facts({
          providers: [codex, claude],
          providerSelection: { computerId: computerA.id, provider: "claude-code" },
        }),
      ).currentState,
    ).toMatchObject({ kind: "agent", provider: claude });
  });

  it("falls back to Codex when an explicit selection is stale", () => {
    const claude = { ...codex, provider: "claude-code" as const };
    const unavailableClaude = { ...codex, provider: "claude-code" as const, runtimeReady: false };
    const unavailable = deriveOnboardingState(
      facts({
        providers: [unavailableClaude, codex],
        providerSelection: { computerId: computerA.id, provider: "claude-code" },
      }),
    ).currentState;
    const wrongComputer = deriveOnboardingState(
      facts({
        providers: [claude, codex],
        providerSelection: { computerId: computerB.id, provider: "claude-code" },
      }),
    ).currentState;
    expect(unavailable).toMatchObject({ kind: "agent", provider: codex });
    expect(wrongComputer).toMatchObject({ kind: "agent", provider: codex });
  });

  it("returns only the remaining runnable Providers as alternatives", () => {
    const claude = { ...codex, provider: "claude-code" as const };
    expect(
      deriveOnboardingState(
        facts({
          providers: [codex, claude],
          providerSelection: { computerId: computerA.id, provider: "claude-code" },
        }),
      ).currentState,
    ).toEqual({ kind: "agent", computer: computerA, provider: claude, alternatives: [codex] });
  });

  it("does not move an existing Agent back when its Computer goes offline", () => {
    const offline = { ...computerA, connectionStatus: "offline" as const };
    const unavailable = { ...codex, runtimeReady: false };
    expect(deriveOnboardingState(facts({ computers: [offline], providers: [unavailable], agent }))).toMatchObject({
      currentState: { kind: "agent-runtime", agent },
      runtimeReady: false,
      handoffReady: false,
    });
  });

  it("does not announce Ready when handoff readiness outlives runtime readiness", () => {
    const offline = { ...computerA, connectionStatus: "offline" as const };
    const unavailable = { ...codex, runtimeReady: false };
    const handoff: OnboardingHandoff = { bindingState: "active", handoffReady: true };
    expect(
      deriveOnboardingState(facts({ computers: [offline], providers: [unavailable], agent, handoff })),
    ).toMatchObject({
      currentState: { kind: "agent-runtime", agent },
      runtimeReady: false,
      handoffReady: true,
    });
  });

  it("continues to handoff after an existing Agent runtime becomes ready again", () => {
    const blocked = deriveOnboardingState(facts({ providers: [{ ...codex, runtimeReady: false }], agent }));
    const recovered = deriveOnboardingState(facts({ agent }));
    expect(blocked.currentState).toEqual({ kind: "agent-runtime", agent });
    expect(recovered.currentState).toEqual({ kind: "handoff", agent, progress: { kind: "none" } });
  });

  it.each([
    [undefined, { kind: "none" }],
    [{ bindingState: "provisioning" as const, handoffReady: false as const }, { kind: "provisioning" }],
    [{ bindingState: "active" as const, handoffReady: false as const }, { kind: "active-not-ready" }],
    [
      { bindingState: "reauthorization_required" as const, handoffReady: false as const },
      { kind: "attention", bindingState: "reauthorization_required" },
    ],
  ])("keeps a non-ready IM handoff in progress", (handoff, progress) => {
    expect(deriveOnboardingState(facts({ agent, handoff })).currentState).toEqual({
      kind: "handoff",
      agent,
      progress,
    });
  });

  it("enters Ready only from authoritative handoff readiness", () => {
    const handoff: OnboardingHandoff = { bindingState: "active", handoffReady: true };
    const blocked = deriveOnboardingState(facts({ providers: [{ ...codex, runtimeReady: false }], agent, handoff }));
    const ready = deriveOnboardingState(facts({ agent, handoff }));
    expect(blocked.currentState).toEqual({ kind: "agent-runtime", agent });
    expect(ready).toMatchObject({
      currentState: { kind: "ready", agent, handoff },
      runtimeReady: true,
      handoffReady: true,
    });
  });

  it("derives identical progress with read-only controls for members", () => {
    const admin = deriveOnboardingState(facts({ agent }));
    const member = deriveOnboardingState(facts({ team: { role: "member" }, agent }));
    expect(member.currentState).toEqual(admin.currentState);
    expect(member.canManage).toBe(false);
    expect(admin.canManage).toBe(true);
  });
});
