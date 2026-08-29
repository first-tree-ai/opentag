import { describe, expect, it } from "vitest";
import {
  type AgentDraft,
  type ConnectState,
  deriveChecks,
  deriveFlowState,
  type FlowFacts,
  formatRemaining,
  initialFacts,
  messagingCliCheck,
  type ReadinessFacts,
  readinessPassed,
  validateAgentName,
} from "./flow.js";

const draft: AgentDraft = {
  destination: "local",
  name: "opentag",
  runtime: "codex",
  cloudRuntime: undefined,
  tokenSource: undefined,
};
/** The facts of a user who has confirmed both of the steps they drive themselves. */
const confirmed = { draft, destinationConfirmed: true, draftConfirmed: true } as const;
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
    // The fork decides how many steps follow, so it has none of its own to show.
    expect(state.steps).toEqual([]);
  });

  it("stays on the destination page until the choice is confirmed", () => {
    expect(deriveFlowState(facts({ draft })).page).toBe("destination");
    expect(deriveFlowState(facts({ draft, destinationConfirmed: true })).page).toBe("agent");
  });

  it("stays on the agent page until the draft is explicitly confirmed", () => {
    expect(deriveFlowState(facts({ draft, destinationConfirmed: true })).page).toBe("agent");
    expect(deriveFlowState(facts(confirmed)).page).toBe("computer");
  });

  it("stays on the agent page while the name is invalid, even once confirmed", () => {
    const invalid = { ...draft, name: "Open Tag" };
    expect(deriveFlowState(facts({ ...confirmed, draft: invalid })).page).toBe("agent");
  });

  it("keeps connecting and checking on one step", () => {
    // The check settles within about 100ms of the Computer arriving, so it is not its own step.
    expect(deriveFlowState(facts({ ...confirmed })).page).toBe("computer");
    expect(deriveFlowState(facts({ ...confirmed, connect: connected })).page).toBe("computer");
    expect(deriveFlowState(facts({ ...confirmed, connect: connected, readiness: ready })).page).toBe("computer");
    expect(deriveFlowState(facts({ ...confirmed })).steps.map((step) => step.id)).toEqual([
      "agent",
      "computer",
      "messaging",
    ]);
  });

  it("holds the computer step until the Agent is actually created", () => {
    const passing = facts({ ...confirmed, connect: connected, readiness: ready });
    expect(deriveFlowState(passing).page).toBe("computer");
    expect(deriveFlowState({ ...passing, creation: "created" }).page).toBe("messaging");
  });

  it("is complete only once messaging is connected", () => {
    const base = facts({ ...confirmed, connect: connected, readiness: ready, creation: "created" });
    expect(deriveFlowState(base).complete).toBe(false);
    expect(deriveFlowState({ ...base, messaging: { kind: "connected" } }).complete).toBe(true);
  });
});

describe("deriveChecks", () => {
  it("reports every row as pending before the first probe resolves", () => {
    expect(deriveChecks(undefined).map((check) => check.state)).toEqual(["pending", "pending"]);
  });

  it("passes both runtime rows when the runtime is ready", () => {
    expect(deriveChecks(ready).map((check) => check.state)).toEqual(["passed", "passed"]);
  });

  it("leaves the messaging CLI out: its provider is not chosen yet", () => {
    // A missing lark-cli used to block a user who was going to pick Slack.
    expect(deriveChecks(ready).map((check) => check.id)).toEqual(["runtime-cli", "runtime-auth"]);
    expect(readinessPassed({ runtime: "ready", messagingCli: "install" })).toBe(true);
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

  it("reports the chosen provider's CLI separately, at handoff", () => {
    expect(messagingCliCheck({ runtime: "ready", messagingCli: "install" })).toBe("failed");
    expect(messagingCliCheck({ runtime: "ready", messagingCli: "ready" })).toBe("passed");
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
