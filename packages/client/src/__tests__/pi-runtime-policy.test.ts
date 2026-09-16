import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { piRuntimePolicy, validatePiRuntimePolicy } from "../providers/pi/runtime-policy.js";

function snapshot(overrides: Partial<EffectiveRuntimeSnapshot["execution"]> = {}): EffectiveRuntimeSnapshot {
  return {
    contextTreeRepository: null,
    revision: { agent: { sequence: 1, id: "agent-rev" }, session: { sequence: 1, id: "session-rev" } },
    agentId: "agent-1",
    provider: "pi",
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never", networkAccess: true, ...overrides },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

describe("Pi runtime policy", () => {
  it("does not claim a filesystem sandbox and keeps network plus never-approvals", () => {
    expect(piRuntimePolicy(snapshot())).toEqual({
      fileSystem: "unrestricted",
      network: "enabled",
      approvals: "never",
      tools: { mode: "provider-default" },
    });
  });

  it("accepts never-approvals with network enabled", () => {
    expect(validatePiRuntimePolicy(snapshot())).toBeUndefined();
  });

  it("rejects disabled network instead of ignoring it", () => {
    expect(validatePiRuntimePolicy(snapshot({ networkAccess: false }))).toBe("configuration_unsupported");
  });

  it("rejects a runtime-invalid approval policy instead of ignoring it", () => {
    expect(
      validatePiRuntimePolicy({
        ...snapshot(),
        execution: { approvalPolicy: "on-request", networkAccess: true },
      } as unknown as EffectiveRuntimeSnapshot),
    ).toBe("configuration_unsupported");
  });
});
