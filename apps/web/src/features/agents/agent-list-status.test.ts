import { describe, expect, it } from "vitest";
import { agentListItem } from "../../__tests__/support/app-fixtures.js";
import {
  AGENT_STATUS_REFRESHING_AFTER_MS,
  type AgentListStatusMemory,
  isTransientAgentAvailability,
  observeAgentListStatus,
  steadyAgentListItem,
} from "./agent-list-status.js";
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

  it("passes the current read through when nothing is settled", () => {
    expect(steadyAgentListItem(checking, undefined)).toBe(checking);
    expect(steadyAgentListItem(unreadable, undefined)).toBe(unreadable);
  });
});

describe("observeAgentListStatus", () => {
  const checking = variant({ state: "setting_up", reason: "handoff_checking" });
  const unreadable = variant({ state: "unconfirmed", reason: "agent_unconfirmed" }, false);

  it("notes a held status as refreshing only once transient evidence outlasts one refresh interval", () => {
    const memory: AgentListStatusMemory = new Map();
    expect(observeAgentListStatus(memory, ready, 0)).toEqual({ shown: ready, refreshing: false, checking: false });
    expect(observeAgentListStatus(memory, unreadable, 1_000)).toMatchObject({ refreshing: false });
    expect(observeAgentListStatus(memory, unreadable, 1_000 + AGENT_STATUS_REFRESHING_AFTER_MS - 1)).toMatchObject({
      refreshing: false,
    });
    const held = observeAgentListStatus(memory, checking, 1_000 + AGENT_STATUS_REFRESHING_AFTER_MS);
    expect(held.refreshing).toBe(true);
    expect(held.shown.availability).toBe(ready.availability);

    expect(observeAgentListStatus(memory, ready, 100_000)).toEqual({
      shown: ready,
      refreshing: false,
      checking: false,
    });
    expect(observeAgentListStatus(memory, unreadable, 100_001)).toMatchObject({ refreshing: false });
  });

  it("adds no note to a row with nothing settled, which already reads as unknown", () => {
    const memory: AgentListStatusMemory = new Map();
    observeAgentListStatus(memory, unreadable, 0);
    expect(observeAgentListStatus(memory, unreadable, 10 * AGENT_STATUS_REFRESHING_AFTER_MS)).toEqual({
      shown: unreadable,
      refreshing: false,
      checking: false,
    });
  });

  it("marks a running check as checking only until a first answer settles", () => {
    const memory: AgentListStatusMemory = new Map();
    expect(observeAgentListStatus(memory, checking, 0)).toEqual({ shown: checking, refreshing: false, checking: true });
    observeAgentListStatus(memory, ready, 1);
    expect(observeAgentListStatus(memory, checking, 2)).toMatchObject({ checking: false });
  });
});
