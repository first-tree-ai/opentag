import { describe, expect, it } from "vitest";
import {
  type AgentDraft,
  deriveFlowState,
  type FlowFacts,
  initialFacts,
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
/** The facts after the Agent step's durable create has completed. */
const confirmed = { draft, destinationConfirmed: true, draftConfirmed: true, creation: "created" } as const;
const selectedComputerId = "computer-1";
const ready: ReadinessFacts = { runtime: "ready", messagingCli: { feishu: "ready", slack: "ready" } };

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
    expect(deriveFlowState(facts({ ...confirmed, creation: "creating" })).page).toBe("agent");
    expect(deriveFlowState(facts(confirmed)).page).toBe("computer");
  });

  it("stays on the agent page while the name is invalid, even once confirmed", () => {
    const invalid = { ...draft, name: "Open Tag" };
    expect(deriveFlowState(facts({ ...confirmed, draft: invalid })).page).toBe("agent");
  });

  it("keeps connecting and checking on one step", () => {
    // The check settles within about 100ms of the Computer arriving, so it is not its own step.
    expect(deriveFlowState(facts({ ...confirmed })).page).toBe("computer");
    expect(deriveFlowState(facts({ ...confirmed, selectedComputerId })).page).toBe("computer");
    expect(deriveFlowState(facts({ ...confirmed, selectedComputerId, readiness: ready })).page).toBe("computer");
    expect(deriveFlowState(facts({ ...confirmed })).steps.map((step) => step.id)).toEqual([
      "agent",
      "computer",
      "messaging",
    ]);
  });

  it("holds the computer step until the reader explicitly continues", () => {
    const passing = facts({ ...confirmed, selectedComputerId, readiness: ready });
    expect(deriveFlowState(passing).page).toBe("computer");
    expect(deriveFlowState({ ...passing, computerConfirmed: true }).page).toBe("messaging");
  });

  it("is complete only once messaging is connected", () => {
    const base = facts({ ...confirmed, selectedComputerId, readiness: ready, computerConfirmed: true });
    expect(deriveFlowState(base).complete).toBe(false);
    expect(deriveFlowState({ ...base, messaging: { kind: "connected" } }).complete).toBe(true);
  });
});

describe("readinessPassed", () => {
  it("does not wait on the messaging CLI: its provider is not chosen yet", () => {
    // A missing lark-cli used to block a user who was going to pick Slack.
    expect(readinessPassed({ runtime: "ready", messagingCli: { feishu: "install", slack: "install" } })).toBe(true);
    expect(readinessPassed({ runtime: "ready", messagingCli: { feishu: "unavailable", slack: "checking" } })).toBe(
      true,
    );
  });
});
