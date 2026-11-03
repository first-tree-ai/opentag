import { describe, expect, it } from "vitest";
import { agentListItem } from "../../__tests__/support/app-fixtures.js";
import { isTransientAgentAvailability, steadyAgentListItem } from "./agent-list-status.js";
import type { AgentListItem } from "./agent-model.js";

const ready: AgentListItem = {
  ...agentListItem,
  evidenceConfirmed: true,
  availability: {
    state: "ready",
    reason: null,
    lastConfirmedAt: agentListItem.updatedAt,
    dependencies: {
      computer: { state: "ready", lastConfirmedAt: agentListItem.updatedAt },
      runtime: { provider: "codex", status: "ready" },
      channel: { state: "connected", provider: "feishu", botDisplayName: "Reviewer" },
      handoff: { state: "ready", lastConfirmedAt: agentListItem.updatedAt },
    },
  },
};

function variant(availability: Partial<AgentListItem["availability"]>, evidenceConfirmed = true): AgentListItem {
  return { ...ready, evidenceConfirmed, availability: { ...ready.availability, ...availability } };
}

describe("isTransientAgentAvailability", () => {
  it("treats checks and unreadable evidence as transient, and answers as settled", () => {
    expect(isTransientAgentAvailability(ready)).toBe(false);
    expect(isTransientAgentAvailability(variant({}, false))).toBe(true);
    expect(isTransientAgentAvailability(variant({ state: "unconfirmed", reason: "computer_unconfirmed" }))).toBe(true);
    expect(isTransientAgentAvailability(variant({ state: "setting_up", reason: "handoff_checking" }))).toBe(true);
    expect(
      isTransientAgentAvailability(
        variant({
          state: "action_required",
          reason: "runtime_unavailable",
          dependencies: { ...ready.availability.dependencies, runtime: { provider: "codex", status: "checking" } },
        }),
      ),
    ).toBe(true);
    expect(
      isTransientAgentAvailability(
        variant({
          state: "action_required",
          reason: "runtime_unavailable",
          dependencies: { ...ready.availability.dependencies, runtime: { provider: "codex", status: "sign-in" } },
        }),
      ),
    ).toBe(false);
    expect(isTransientAgentAvailability(variant({ state: "action_required", reason: "computer_offline" }))).toBe(false);
    expect(isTransientAgentAvailability(variant({ state: "setting_up", reason: "im_provisioning" }))).toBe(false);
  });
});

describe("steadyAgentListItem", () => {
  const offline = variant({ state: "action_required", reason: "computer_offline" });
  const checking = variant({ state: "setting_up", reason: "handoff_checking" });
  const unreadable = variant({ state: "unconfirmed", reason: "agent_unconfirmed" }, false);

  it("passes a settled answer through unchanged", () => {
    expect(steadyAgentListItem(offline, ready)).toBe(offline);
  });

  it("holds the last settled availability but keeps current activity", () => {
    const working = { ...unreadable, activity: { state: "working" as const, startedAt: agentListItem.updatedAt } };
    const shown = steadyAgentListItem(working, offline);
    expect(shown.availability).toBe(offline.availability);
    expect(shown.evidenceConfirmed).toBe(true);
    expect(shown.activity).toEqual(working.activity);
  });

  it("presents a check with nothing settled as ready and leaves unknown evidence unknown", () => {
    expect(steadyAgentListItem(checking, undefined).availability).toMatchObject({ state: "ready", reason: null });
    expect(steadyAgentListItem(unreadable, undefined)).toBe(unreadable);
  });
});
