import { OPENTAG_PLATFORM_INSTRUCTIONS } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import {
  DEFAULT_AGENT_RUNTIME_CONFIG,
  EffectiveRuntimeSnapshotAssembler,
  EffectiveRuntimeSnapshotAssemblerError,
} from "../services/runtime-config/index.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const sessionId = "b077f77b-ad35-4031-8628-aee73f9a7ca8";

function authority(overrides: Record<string, unknown> = {}) {
  return {
    agentDeletedAt: null,
    agentId,
    integrationStatus: "active",
    runtimeConfig: {
      revision: 7,
      model: "gpt-5",
      reasoningEffort: "high",
      instructions: "Review the change.",
      allowedTools: ["opentag_message_reply", "opentag_message_send"],
      maxDurationMs: 30_000,
    },
    runtimeProvider: "codex",
    sessionEndedAt: null,
    sessionId,
    ...overrides,
  };
}

function assembler(loadAuthority: (value: string) => Promise<ReturnType<typeof authority> | undefined>) {
  return new EffectiveRuntimeSnapshotAssembler({} as DatabaseClient, { loadAuthority });
}

describe("EffectiveRuntimeSnapshotAssembler", () => {
  it("compiles one deterministic effective snapshot from Server authority", async () => {
    const first = await assembler(async (value) => {
      expect(value).toBe(sessionId);
      return authority();
    }).assembleForSession(sessionId);
    const second = await assembler(async () => authority()).assembleForSession(sessionId);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      agentId,
      provider: "codex",
      model: "gpt-5",
      reasoningEffort: "high",
      instructions: { platform: OPENTAG_PLATFORM_INSTRUCTIONS, agent: "Review the change." },
      allowedTools: ["opentag_message_reply", "opentag_message_send"],
      budget: { maxDurationMs: 30_000 },
      revision: {
        agent: { sequence: 7, id: expect.stringMatching(/^[a-f0-9]{64}$/) },
        session: { sequence: 7, id: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
      workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
    });
  });

  it("uses versioned layer hashes and the config revision for both effective sequences", async () => {
    const original = await assembler(async () => authority()).assembleForSession(sessionId);
    const instructionsChanged = await assembler(async () =>
      authority({
        runtimeConfig: {
          ...(authority().runtimeConfig as Record<string, unknown>),
          revision: 8,
          instructions: "Changed",
        },
      }),
    ).assembleForSession(sessionId);
    const modelChanged = await assembler(async () =>
      authority({
        runtimeConfig: { ...(authority().runtimeConfig as Record<string, unknown>), revision: 9, model: "gpt-5.1" },
      }),
    ).assembleForSession(sessionId);

    expect(instructionsChanged.revision.agent.id).not.toBe(original.revision.agent.id);
    expect(instructionsChanged.revision.session.id).toBe(original.revision.session.id);
    expect(instructionsChanged.revision.agent.sequence).toBe(8);
    expect(instructionsChanged.revision.session.sequence).toBe(8);
    expect(modelChanged.revision.agent.id).toBe(original.revision.agent.id);
    expect(modelChanged.revision.session.id).not.toBe(original.revision.session.id);
    expect(modelChanged.revision.agent.sequence).toBe(9);
    expect(modelChanged.revision.session.sequence).toBe(9);
  });

  it("omits nullable runtime fields when compiling the stored default configuration", async () => {
    const snapshot = await assembler(async () =>
      authority({ runtimeConfig: { revision: 1, ...DEFAULT_AGENT_RUNTIME_CONFIG } }),
    ).assembleForSession(sessionId);

    expect(snapshot).not.toHaveProperty("model");
    expect(snapshot).not.toHaveProperty("reasoningEffort");
    expect(snapshot).not.toHaveProperty("budget");
    expect(snapshot.instructions.agent).toBe(DEFAULT_AGENT_RUNTIME_CONFIG.instructions);
    expect(snapshot.allowedTools).toEqual(DEFAULT_AGENT_RUNTIME_CONFIG.allowedTools);
  });

  it.each([
    ["missing", async () => undefined, "SESSION_NOT_FOUND"],
    ["ended Session", async () => authority({ sessionEndedAt: new Date() }), "AUTHORITY_INACTIVE"],
    ["inactive Integration", async () => authority({ integrationStatus: "disabled" }), "AUTHORITY_INACTIVE"],
    ["deleted Agent", async () => authority({ agentDeletedAt: new Date() }), "AUTHORITY_INACTIVE"],
    ["missing config", async () => authority({ runtimeConfig: null }), "RUNTIME_CONFIG_MISSING"],
    ["unsupported provider", async () => authority({ runtimeProvider: "claude-code" }), "UNSUPPORTED_PROVIDER"],
    [
      "invalid stored config",
      async () =>
        authority({ runtimeConfig: { ...(authority().runtimeConfig as Record<string, unknown>), revision: 0 } }),
      "INVALID_STORED_CONFIG",
    ],
    ["invalid effective snapshot", async () => authority({ agentId: "not-an-opaque-id!" }), "SNAPSHOT_INVALID"],
  ])("fails closed for %s authority", async (_label, loadAuthority, code) => {
    await expect(assembler(loadAuthority).assembleForSession(sessionId)).rejects.toMatchObject({
      name: "EffectiveRuntimeSnapshotAssemblerError",
      code,
    });
  });

  it("distinguishes database failures without including stored instructions", async () => {
    const failure = new Error("database unavailable: secret instructions");
    const result = assembler(async () => {
      throw failure;
    }).assembleForSession(sessionId);
    await expect(result).rejects.toBeInstanceOf(EffectiveRuntimeSnapshotAssemblerError);
    await expect(result).rejects.toMatchObject({ code: "DATABASE_FAILURE" });
    await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining("secret instructions"));
  });
});
