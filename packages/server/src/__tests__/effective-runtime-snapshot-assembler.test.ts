import { computeRuntimeSnapshotHashes, renderPlatformInstructions } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import {
  DEFAULT_AGENT_RUNTIME_CONFIG,
  EffectiveRuntimeSnapshotAssembler,
  EffectiveRuntimeSnapshotAssemblerError,
} from "../services/runtime-config/index.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const sessionId = "b077f77b-ad35-4031-8628-aee73f9a7ca8";
const agentName = "code-reviewer";

function authority(overrides: Record<string, unknown> = {}) {
  return {
    agentStatus: "active",
    agentId,
    agentName,
    imBindingStatus: "active",
    runtimeConfig: {
      revision: 7,
      model: "gpt-5",
      reasoningEffort: "high",
      instructions: "Review the change.",
      maxDurationMs: 30_000,
    },
    runtimeProvider: "codex",
    sessionEndedAt: null,
    sessionId,
    sessionKind: "channel" as const,
    sessionRuntimeModel: null,
    sessionRuntimeReasoningEffort: null,
    sessionRuntimeMaxDurationMs: null,
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
      instructions: { platform: renderPlatformInstructions({ agentSlug: agentName }), agent: "Review the change." },
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

  it("renders the Agent slug into the platform layer and folds it into Agent revision identity", async () => {
    const original = await assembler(async () => authority()).assembleForSession(sessionId);
    const renamed = await assembler(async () => authority({ agentName: "researcher-agent" })).assembleForSession(
      sessionId,
    );

    expect(original.instructions.platform).toContain(`OpenTag Agent slug: ${agentName}`);
    expect(renamed.instructions.platform).toContain("OpenTag Agent slug: researcher-agent");
    // Two Agents must never share an Agent revision, or one could resume against the other's
    // identity and write to the wrong `members/<agent-slug>/` directory in a shared tree.
    expect(renamed.revision.agent.id).not.toBe(original.revision.agent.id);
    expect(renamed.revision.session.id).toBe(original.revision.session.id);
  });

  it("changes the effective snapshot hash when only the Agent slug differs", async () => {
    const original = await assembler(async () => authority()).assembleForSession(sessionId);
    const renamed = await assembler(async () => authority({ agentName: "researcher-agent" })).assembleForSession(
      sessionId,
    );

    expect(computeRuntimeSnapshotHashes(renamed).agentConfigHash).not.toBe(
      computeRuntimeSnapshotHashes(original).agentConfigHash,
    );
    expect(computeRuntimeSnapshotHashes(renamed).effectiveSnapshotHash).not.toBe(
      computeRuntimeSnapshotHashes(original).effectiveSnapshotHash,
    );
  });

  it("fails closed when the stored Agent name is not a usable slug", async () => {
    await expect(
      assembler(async () => authority({ agentName: "Not A Slug" })).assembleForSession(sessionId),
    ).rejects.toBeInstanceOf(EffectiveRuntimeSnapshotAssemblerError);
  });

  it("omits nullable runtime fields when compiling the stored default configuration", async () => {
    const snapshot = await assembler(async () =>
      authority({ runtimeConfig: { revision: 1, ...DEFAULT_AGENT_RUNTIME_CONFIG } }),
    ).assembleForSession(sessionId);

    expect(snapshot).not.toHaveProperty("model");
    expect(snapshot).not.toHaveProperty("reasoningEffort");
    expect(snapshot).not.toHaveProperty("budget");
    expect(snapshot.instructions.agent).toBe(DEFAULT_AGENT_RUNTIME_CONFIG.instructions);
  });

  it("compiles the reviewed Claude Code execution policy without changing the snapshot contract", async () => {
    const snapshot = await assembler(async () => authority({ runtimeProvider: "claude-code" })).assembleForSession(
      sessionId,
    );

    expect(snapshot).toMatchObject({
      provider: "claude-code",
      execution: { approvalPolicy: "never", networkAccess: true },
    });
  });

  it("applies immutable internal overrides in the Session layer without changing visible Session projection", async () => {
    const visible = await assembler(async () => authority()).assembleForSession(sessionId);
    const visibleWithStoredFields = await assembler(async () =>
      authority({
        sessionRuntimeModel: "ignored-model",
        sessionRuntimeReasoningEffort: "ignored-effort",
        sessionRuntimeMaxDurationMs: 1,
      }),
    ).assembleForSession(sessionId);
    expect(visibleWithStoredFields).toEqual(visible);

    const internal = await assembler(async () =>
      authority({
        sessionKind: "internal",
        sessionRuntimeModel: "internal-model",
        sessionRuntimeReasoningEffort: "medium",
        sessionRuntimeMaxDurationMs: 5_000,
      }),
    ).assembleForSession(sessionId);
    expect(internal).toMatchObject({
      model: "internal-model",
      reasoningEffort: "medium",
      budget: { maxDurationMs: 5_000 },
      revision: { agent: { sequence: 7 }, session: { sequence: 7 } },
    });
    expect(internal.revision.agent).toEqual(visible.revision.agent);
    expect(internal.revision.session.id).not.toBe(visible.revision.session.id);
  });

  it("advances internal Session revision with inherited Agent defaults while preserving explicit overrides", async () => {
    const initial = await assembler(async () => authority({ sessionKind: "internal" })).assembleForSession(sessionId);
    const updatedConfig = {
      ...(authority().runtimeConfig as Record<string, unknown>),
      revision: 8,
      model: "gpt-5.1",
      reasoningEffort: "medium",
      maxDurationMs: 45_000,
    };
    const inherited = await assembler(async () =>
      authority({ sessionKind: "internal", runtimeConfig: updatedConfig }),
    ).assembleForSession(sessionId);
    expect(inherited).toMatchObject({
      model: "gpt-5.1",
      reasoningEffort: "medium",
      budget: { maxDurationMs: 45_000 },
      revision: { session: { sequence: 8 } },
    });
    expect(inherited.revision.session.id).not.toBe(initial.revision.session.id);

    const explicitBefore = await assembler(async () =>
      authority({
        sessionKind: "internal",
        sessionRuntimeModel: "internal-model",
        sessionRuntimeReasoningEffort: "high",
        sessionRuntimeMaxDurationMs: 5_000,
      }),
    ).assembleForSession(sessionId);
    const explicitAfter = await assembler(async () =>
      authority({
        sessionKind: "internal",
        runtimeConfig: updatedConfig,
        sessionRuntimeModel: "internal-model",
        sessionRuntimeReasoningEffort: "high",
        sessionRuntimeMaxDurationMs: 5_000,
      }),
    ).assembleForSession(sessionId);
    expect(explicitAfter).toMatchObject({
      model: "internal-model",
      reasoningEffort: "high",
      budget: { maxDurationMs: 5_000 },
      revision: { session: { sequence: 8 } },
    });
    expect(explicitAfter.revision.session.id).toBe(explicitBefore.revision.session.id);
  });

  it.each([
    ["missing", async () => undefined, "SESSION_NOT_FOUND"],
    ["ended Session", async () => authority({ sessionEndedAt: new Date() }), "AUTHORITY_INACTIVE"],
    ["inactive ImBinding", async () => authority({ imBindingStatus: "disabled" }), "AUTHORITY_INACTIVE"],
    ["suspended Agent", async () => authority({ agentStatus: "suspended" }), "AUTHORITY_INACTIVE"],
    ["deleted Agent", async () => authority({ agentStatus: "deleted" }), "AUTHORITY_INACTIVE"],
    ["missing config", async () => authority({ runtimeConfig: null }), "RUNTIME_CONFIG_MISSING"],
    ["unsupported provider", async () => authority({ runtimeProvider: "pi" }), "UNSUPPORTED_PROVIDER"],
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
