import type { AgentSummary, Computer, ImBindingSummary, MeMembership } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import {
  canManageOnboarding,
  classifyOnboardingComputer,
  classifyOnboardingImBinding,
  deriveAgentName,
  deriveOnboardingState,
  type OnboardingFacts,
  selectOnboardingAgent,
} from "../flow.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";

const membership: MeMembership = { teamId, teamName: "example", teamDisplayName: "Example", role: "admin" };

function computer(overrides: Partial<Computer> = {}): Computer {
  return {
    id: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
    ownerUserId: userId,
    displayName: "Ada's Mac",
    platform: "darwin",
    arch: "arm64",
    clientVersion: "0.0.1",
    connectionStatus: "online",
    connectedAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
    teamId,
    name: "reviewer",
    displayName: "Reviewer",
    manager: { userId, displayName: "Ada" },
    computer: { id: computer().id, displayName: "Ada's Mac", platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Partial<ImBindingSummary> = {}): ImBindingSummary {
  return {
    id: "0b2e0f1e-2a1c-4a5d-9f0e-7c1a2b3c4d5e",
    agentId: agent().id,
    provider: "feishu",
    bindingState: "active",
    bot: { displayName: "Reviewer", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastOutboundAt: null,
    lastConfirmedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    role: "admin",
    membership,
    computers: [computer()],
    agents: [agent()],
    binding: binding(),
    acknowledgedComputerIds: [computer().id],
    ...overrides,
  };
}

describe("classifyOnboardingComputer", () => {
  it("reports none when the Team has no Computer", () => {
    expect(classifyOnboardingComputer([])).toEqual({ kind: "none" });
  });

  it("reports offline when every known Computer is disconnected", () => {
    const disconnected = computer({ connectionStatus: "offline" });
    expect(classifyOnboardingComputer([disconnected])).toEqual({ kind: "offline", computers: [disconnected] });
  });

  it("selects the only online Computer without asking", () => {
    const online = computer();
    const stale = computer({ id: "6f2a3d19-59ab-4f0a-9a3e-8f1d2c3b4a5e", connectionStatus: "offline" });
    expect(classifyOnboardingComputer([online, stale])).toEqual({ kind: "single", computer: online });
  });

  it("asks only when more than one online Computer is genuinely ambiguous", () => {
    const first = computer();
    const second = computer({ id: "6f2a3d19-59ab-4f0a-9a3e-8f1d2c3b4a5e", displayName: "Build box" });
    expect(classifyOnboardingComputer([first, second])).toEqual({ kind: "choice", computers: [first, second] });
  });
});

describe("classifyOnboardingImBinding", () => {
  it("reports none without a binding", () => {
    expect(classifyOnboardingImBinding(undefined)).toEqual({ kind: "none" });
  });

  it("reports provisioning while the bot is still being created", () => {
    const pending = binding({ bindingState: "provisioning" });
    expect(classifyOnboardingImBinding(pending)).toEqual({ kind: "provisioning", binding: pending });
  });

  it("reports active for a confirmed binding", () => {
    const confirmed = binding();
    expect(classifyOnboardingImBinding(confirmed)).toEqual({ kind: "active", binding: confirmed });
  });

  it.each(["reauthorization_required", "error", "disabled"] as const)("reports %s as attention", (bindingState) => {
    const degraded = binding({ bindingState });
    expect(classifyOnboardingImBinding(degraded)).toEqual({
      kind: "attention",
      binding: degraded,
      reason: bindingState,
    });
  });
});

describe("selectOnboardingAgent", () => {
  it("returns nothing when the Team has no Agent", () => {
    expect(selectOnboardingAgent([])).toBeUndefined();
  });

  it("picks the oldest Agent so the flow keeps describing the same one", () => {
    const first = agent({ createdAt: "2026-08-20T00:00:00.000Z" });
    const second = agent({ id: "2b74b32f-a7d8-4585-a2fb-5ebc1e677b35", createdAt: "2026-08-21T00:00:00.000Z" });
    expect(selectOnboardingAgent([second, first])).toBe(first);
  });
});

describe("deriveOnboardingState", () => {
  it("starts at the Team step without a membership", () => {
    const state = deriveOnboardingState(
      facts({ membership: undefined, computers: [], agents: [], binding: undefined }),
    );
    expect(state.step).toBe("team");
    expect(state.completed).toEqual([]);
  });

  it("asks for a Computer before anything else once the Team exists", () => {
    const state = deriveOnboardingState(
      facts({ computers: [], agents: [], binding: undefined, acknowledgedComputerIds: [] }),
    );
    expect(state.step).toBe("computer");
    expect(state.completed).toEqual(["team"]);
    expect(state.computer).toEqual({ kind: "none" });
  });

  it("stays on the Computer step while the only Computer is offline", () => {
    const state = deriveOnboardingState(
      facts({ computers: [computer({ connectionStatus: "offline" })], agents: [], binding: undefined }),
    );
    expect(state.step).toBe("computer");
  });

  it("asks the admin to confirm the provider CLI before creating an Agent", () => {
    const state = deriveOnboardingState(facts({ agents: [], binding: undefined, acknowledgedComputerIds: [] }));
    expect(state.step).toBe("provider");
    expect(state.completed).toEqual(["team", "computer"]);
  });

  it("moves to Agent creation once the provider is confirmed", () => {
    const state = deriveOnboardingState(facts({ agents: [], binding: undefined }));
    expect(state.step).toBe("agent");
    expect(state.agent).toBeUndefined();
    expect(state.agentReady).toBe(false);
  });

  it("moves to IM once an Agent exists without a binding", () => {
    const state = deriveOnboardingState(facts({ binding: undefined }));
    expect(state.step).toBe("im");
    expect(state.agentReady).toBe(true);
  });

  it("reaches Ready once the binding is active", () => {
    const state = deriveOnboardingState(facts());
    expect(state.step).toBe("ready");
    expect(state.completed).toEqual(["team", "computer", "provider", "agent", "im"]);
    expect(state.agentReady).toBe(true);
  });

  it("keeps the Agent ready when the optional IM binding needs attention", () => {
    const state = deriveOnboardingState(facts({ binding: binding({ bindingState: "error" }) }));
    expect(state.step).toBe("im");
    expect(state.agentReady).toBe(true);
    expect(state.im).toMatchObject({ kind: "attention", reason: "error" });
  });

  it("does not walk backwards when the Computer goes offline after the Agent exists", () => {
    const state = deriveOnboardingState(
      facts({ computers: [computer({ connectionStatus: "offline" })], binding: undefined }),
    );
    expect(state.step).toBe("im");
  });

  it("does not walk backwards when the provider was confirmed in another browser", () => {
    const state = deriveOnboardingState(facts({ binding: undefined, acknowledgedComputerIds: [] }));
    expect(state.step).toBe("im");
  });

  it("derives the same step for members as for admins", () => {
    const admin = deriveOnboardingState(facts({ binding: undefined }));
    const member = deriveOnboardingState(facts({ role: "member", binding: undefined }));
    expect(member.step).toBe(admin.step);
  });

  it("does not report a member as stuck on the Admin's browser-local confirmation", () => {
    const pending = { agents: [], binding: undefined, acknowledgedComputerIds: [] } as const;
    expect(deriveOnboardingState(facts({ ...pending })).step).toBe("provider");
    expect(deriveOnboardingState(facts({ ...pending, role: "member" })).step).toBe("agent");
  });
});

describe("canManageOnboarding", () => {
  it.each([
    ["admin", true],
    ["member", false],
  ] as const)("resolves %s to %s", (role, expected) => {
    expect(canManageOnboarding(role)).toBe(expected);
  });
});

describe("deriveAgentName", () => {
  it.each([
    ["Reviewer", "reviewer"],
    ["Release Captain", "release-captain"],
    ["  Build   Bot  ", "build-bot"],
    ["CI/CD Helper", "ci-cd-helper"],
    ["发布助手", "agent"],
    ["", "agent"],
    ["---", "agent"],
  ])("derives %s to %s", (displayName, expected) => {
    expect(deriveAgentName(displayName)).toBe(expected);
  });

  it("keeps the derived name inside the Agent name shape", () => {
    const name = deriveAgentName("A".repeat(200));
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe("deriveOnboardingState canManage", () => {
  it("lets a user with no Team drive their own first step", () => {
    const state = deriveOnboardingState(
      facts({ role: "member", membership: undefined, computers: [], agents: [], binding: undefined }),
    );
    expect(state.step).toBe("team");
    expect(state.canManage).toBe(true);
  });

  it("lets a Team Admin drive setup", () => {
    expect(deriveOnboardingState(facts()).canManage).toBe(true);
  });

  it("keeps a Team member read-only", () => {
    expect(deriveOnboardingState(facts({ role: "member" })).canManage).toBe(false);
  });
});

describe("provider confirmation is scoped to a Computer", () => {
  const other = computer({ id: "6f2a3d19-59ab-4f0a-9a3e-8f1d2c3b4a5e", displayName: "Build box" });

  it("still asks when only a different Computer was confirmed", () => {
    const state = deriveOnboardingState(
      facts({ computers: [other], agents: [], binding: undefined, acknowledgedComputerIds: [computer().id] }),
    );
    expect(state.step).toBe("provider");
  });

  it("skips the step for a second Team once that Computer is confirmed", () => {
    const state = deriveOnboardingState(
      facts({ agents: [], binding: undefined, acknowledgedComputerIds: [computer().id] }),
    );
    expect(state.step).toBe("agent");
  });

  it("defers to the Agent step while the Computer is still ambiguous", () => {
    // The confirmation cannot name a Computer yet, so it is made against the one
    // the admin actually picks, inside Agent creation.
    const state = deriveOnboardingState(
      facts({ computers: [computer(), other], agents: [], binding: undefined, acknowledgedComputerIds: [] }),
    );
    expect(state.step).toBe("agent");
  });
});
