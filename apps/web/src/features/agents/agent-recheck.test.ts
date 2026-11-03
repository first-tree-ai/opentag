import { describe, expect, it } from "vitest";
import { agentListItem } from "../../__tests__/support/app-fixtures.js";
import {
  AGENT_STATUS_REFRESHING_AFTER_MS,
  type AgentDetailStatusMemory,
  observeAgentDetailStatus,
} from "./agent-list-status.js";
import type { AgentDetailView } from "./agent-model.js";
import { AGENT_RECHECK_MIN_INTERVAL_MS, agentHomeNeedsRecheck, claimAgentRecheck } from "./agent-recheck.js";

const { usage: _usage, ...detail } = agentListItem;
const dependencies: AgentDetailView["availability"]["dependencies"] = {
  computer: { state: "ready", lastConfirmedAt: agentListItem.updatedAt },
  runtime: { provider: "codex", status: "ready" },
  channel: { state: "connected", provider: "feishu", botDisplayName: "Reviewer" },
  handoff: { state: "ready", lastConfirmedAt: agentListItem.updatedAt },
};
const ready: AgentDetailView = {
  ...detail,
  availability: { state: "ready", reason: null, lastConfirmedAt: agentListItem.updatedAt, dependencies },
  messaging: { kind: "ready", value: undefined },
  computerKind: "local",
  computerConnectionStatus: "online",
};

function withRuntime(status: AgentDetailView["availability"]["dependencies"]["runtime"]["status"]): AgentDetailView {
  return {
    ...ready,
    availability: {
      ...ready.availability,
      state: status === "ready" ? "ready" : "action_required",
      reason: status === "ready" ? null : "runtime_unavailable",
      dependencies: { ...dependencies, runtime: { provider: "codex", status } },
    },
  };
}

describe("agentHomeNeedsRecheck", () => {
  it("asks only for a running Local Agent on an online Computer whose runtime is not ready", () => {
    expect(agentHomeNeedsRecheck(ready)).toBe(false);
    expect(agentHomeNeedsRecheck(withRuntime("install"))).toBe(true);
    expect(agentHomeNeedsRecheck(withRuntime("sign-in"))).toBe(true);
    expect(agentHomeNeedsRecheck(withRuntime(null))).toBe(true);
    // A probe already running needs no second one.
    expect(agentHomeNeedsRecheck(withRuntime("checking"))).toBe(false);
    expect(agentHomeNeedsRecheck({ ...withRuntime("install"), computerKind: "cloud" })).toBe(false);
    expect(agentHomeNeedsRecheck({ ...withRuntime("install"), computerConnectionStatus: "offline" })).toBe(false);
    expect(agentHomeNeedsRecheck({ ...withRuntime("install"), status: "suspended" })).toBe(false);
  });
});

describe("claimAgentRecheck", () => {
  it("allows one re-check per Agent per minute", () => {
    expect(claimAgentRecheck("agent-a", 1_000)).toBe(true);
    expect(claimAgentRecheck("agent-a", 1_000 + AGENT_RECHECK_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(claimAgentRecheck("agent-b", 2_000)).toBe(true);
    expect(claimAgentRecheck("agent-a", 1_000 + AGENT_RECHECK_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe("observeAgentDetailStatus", () => {
  it("holds the last settled states through a check and flags a held card after one interval", () => {
    const memory: AgentDetailStatusMemory = {};
    expect(observeAgentDetailStatus(memory, ready, 0)).toEqual({ shown: ready, refreshing: false });

    const checking = withRuntime("checking");
    const held = observeAgentDetailStatus(memory, checking, 10);
    expect(held.shown.availability).toBe(ready.availability);
    expect(held.refreshing).toBe(false);
    expect(observeAgentDetailStatus(memory, checking, 10 + AGENT_STATUS_REFRESHING_AFTER_MS).refreshing).toBe(true);

    const unconfirmed: AgentDetailView = { ...ready, messaging: { kind: "unconfirmed" } };
    expect(observeAgentDetailStatus(memory, unconfirmed, 20).shown.messaging).toBe(ready.messaging);
  });

  it("shows a confirmed problem at once and the current read when nothing is settled", () => {
    const memory: AgentDetailStatusMemory = {};
    observeAgentDetailStatus(memory, ready, 0);
    const broken = withRuntime("install");
    expect(observeAgentDetailStatus(memory, broken, 5)).toEqual({ shown: broken, refreshing: false });

    const fresh: AgentDetailStatusMemory = {};
    const checking = withRuntime("checking");
    expect(observeAgentDetailStatus(fresh, checking, 0)).toEqual({ shown: checking, refreshing: false });
  });

  it("never lets an unreadable messaging answer hide a runtime problem the same read confirmed", () => {
    const memory: AgentDetailStatusMemory = {};
    observeAgentDetailStatus(memory, ready, 0);
    const mixed: AgentDetailView = { ...withRuntime("install"), messaging: { kind: "unconfirmed" } };
    const { shown } = observeAgentDetailStatus(memory, mixed, 5);
    expect(shown.availability.reason).toBe("runtime_unavailable");
    expect(shown.availability.dependencies.runtime.status).toBe("install");
    // Only the messaging part, which this read could not answer, is held.
    expect(shown.messaging).toBe(ready.messaging);
  });
});
