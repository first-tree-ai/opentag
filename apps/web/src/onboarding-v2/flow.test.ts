import { describe, expect, it } from "vitest";
import {
  type AgentDraft,
  type ConnectState,
  deriveChecks,
  deriveFlowState,
  type FlowFacts,
  formatRemaining,
  initialFacts,
  type ReadinessFacts,
  validateAgentName,
} from "./flow.js";

const draft: AgentDraft = { destination: "local", name: "opentag", runtime: "codex" };
const connected: ConnectState = { kind: "connected", command: "npm i -g open-tag", computerName: "MacBook Pro" };
const ready: ReadinessFacts = { runtime: "ready", messagingCli: "ready" };

function facts(overrides: Partial<FlowFacts> = {}): FlowFacts {
  return { ...initialFacts(), ...overrides };
}

describe("validateAgentName", () => {
  it("accepts lowercase names with digits and hyphens", () => {
    expect(validateAgentName("opentag")).toBeUndefined();
    expect(validateAgentName("agent-2")).toBeUndefined();
    expect(validateAgentName("7bots")).toBeUndefined();
  });

  it("rejects an empty name", () => {
    expect(validateAgentName("   ")).toBe("empty");
  });

  it("rejects uppercase, spaces and a leading hyphen", () => {
    expect(validateAgentName("OpenTag")).toBe("charset");
    expect(validateAgentName("open tag")).toBe("charset");
    expect(validateAgentName("-opentag")).toBe("charset");
  });

  it("rejects a name beyond the Server's limit", () => {
    expect(validateAgentName("a".repeat(65))).toBe("too-long");
    expect(validateAgentName("a".repeat(64))).toBeUndefined();
  });
});

describe("deriveFlowState", () => {
  it("starts on the destination page with nothing complete", () => {
    const state = deriveFlowState(initialFacts());
    expect(state.page).toBe("destination");
    expect(state.steps.map((step) => step.status)).toEqual(["current", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });

  it("stays on the agent page until the draft is explicitly confirmed", () => {
    expect(deriveFlowState(facts({ draft })).page).toBe("agent");
    expect(deriveFlowState(facts({ draft, draftConfirmed: true })).page).toBe("setup");
  });

  it("stays on the agent page while the name is invalid, even once confirmed", () => {
    const invalid = { ...draft, name: "Open Tag" };
    expect(deriveFlowState(facts({ draft: invalid, draftConfirmed: true })).page).toBe("agent");
  });

  it("keeps steps 3 and 4 on the same page", () => {
    const connecting = deriveFlowState(facts({ draft, draftConfirmed: true }));
    const checking = deriveFlowState(facts({ draft, draftConfirmed: true, connect: connected }));
    expect(connecting.page).toBe("setup");
    expect(checking.page).toBe("setup");
  });

  it("completes the connect step once the Computer arrives, without leaving the page", () => {
    const state = deriveFlowState(facts({ draft, draftConfirmed: true, connect: connected }));
    expect(state.steps.find((step) => step.id === "connect")?.status).toBe("complete");
    expect(state.steps.find((step) => step.id === "runtime")?.status).toBe("current");
    expect(state.page).toBe("setup");
  });

  it("holds the setup page until the Agent is actually created", () => {
    const passing = facts({ draft, draftConfirmed: true, connect: connected, readiness: ready });
    expect(deriveFlowState(passing).page).toBe("setup");
    expect(deriveFlowState({ ...passing, creation: "created" }).page).toBe("messaging");
  });

  it("is complete only once messaging is connected", () => {
    const base = facts({
      draft,
      draftConfirmed: true,
      connect: connected,
      readiness: ready,
      creation: "created",
    });
    expect(deriveFlowState(base).complete).toBe(false);
    expect(deriveFlowState({ ...base, messaging: { kind: "connected" } }).complete).toBe(true);
  });
});

describe("deriveChecks", () => {
  it("reports every row as pending before the first probe resolves", () => {
    expect(deriveChecks(undefined).map((check) => check.state)).toEqual(["pending", "pending", "pending"]);
  });

  it("passes both runtime rows when the runtime is ready", () => {
    expect(deriveChecks(ready).map((check) => check.state)).toEqual(["passed", "passed", "passed"]);
  });

  it("treats a sign-in failure as proof the CLI runs", () => {
    const checks = deriveChecks({ runtime: "sign-in", messagingCli: "ready" });
    expect(checks[0]).toEqual({ id: "runtime-cli", state: "passed" });
    expect(checks[1]).toEqual({ id: "runtime-auth", state: "failed" });
  });

  it("blocks the sign-in row when the CLI is missing, rather than guessing", () => {
    const checks = deriveChecks({ runtime: "install", messagingCli: "ready" });
    expect(checks[0]).toEqual({ id: "runtime-cli", state: "failed" });
    expect(checks[1]).toEqual({ id: "runtime-auth", state: "blocked" });
  });

  it("fails the messaging row on its own, independently of the runtime", () => {
    const checks = deriveChecks({ runtime: "ready", messagingCli: "install" });
    expect(checks[2]).toEqual({ id: "messaging-cli", state: "failed" });
  });
});

describe("formatRemaining", () => {
  it("renders minutes and zero-padded seconds", () => {
    expect(formatRemaining(15 * 60 * 1_000)).toBe("15:00");
    expect(formatRemaining(65_000)).toBe("1:05");
  });

  it("never renders a negative duration", () => {
    expect(formatRemaining(-1_000)).toBe("0:00");
  });
});
